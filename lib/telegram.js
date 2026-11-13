// 📣 Отправка в Telegram-каналы через Bot API.
// • у каждого канала своя очередь: не чаще одного поста в 3 секунды (лимит Telegram — 20 в минуту на канал);
// • «слишком часто» (429) — ждём, сколько сказал Telegram, и повторяем; сбой сети или Telegram — повтор через
//   10 с, 1 мин и 5 мин; ошибка в самом сообщении (400) — без повторов, чтобы не застрять;
// • текст длиннее 4096 знаков делится на части по абзацам; график уходит фотографией с подписью;
// • токен бота нигде не печатается: в ошибках и журнале он заменяется на «***».
import { sleep } from './http.js';

const API = 'https://api.telegram.org';
const MAX_TEXT = 4096, MAX_CAPTION = 1024;
const RETRY_MS = [10e3, 60e3, 300e3];

/** Разбить длинный текст на части не длиннее max — по пустым строкам, потом по строкам */
export function splitText(text, max = MAX_TEXT) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = '';
  const push = () => { if (cur) out.push(cur); cur = ''; };
  for (const block of text.split('\n\n')) {
    const add = cur ? `${cur}\n\n${block}` : block;
    if (add.length <= max) { cur = add; continue; }
    push();
    if (block.length <= max) { cur = block; continue; }
    for (const line of block.split('\n')) {
      const a2 = cur ? `${cur}\n${line}` : line;
      if (a2.length <= max) { cur = a2; continue; }
      push();
      cur = line.length <= max ? line : line.slice(0, max - 1) + '…';
    }
  }
  push();
  return out;
}

export class Telegram {
  /**
   * @param {{ token: string, fetchImpl?: typeof fetch, gapMs?: number, log?: (s: string) => void, retryMs?: number[] }} o
   */
  constructor({ token, fetchImpl = globalThis.fetch, gapMs = 3100, log = console.error, retryMs = RETRY_MS } = {}) {
    this.token = String(token ?? '').trim();
    this.fetch = fetchImpl;
    this.gapMs = gapMs;
    this.retryMs = retryMs;
    this.log = log;
    this.queues = new Map(); // канал → { items: [], busy, last }
    this.stats = { sent: 0, errors: 0, lost: 0, lastError: null, lastOkAt: null };
  }

  ready() { return /^\d+:[\w-]{20,}$/.test(this.token); }

  /** Убрать токен из любого текста (ошибки fetch содержат адрес запроса) */
  hide(s) { return this.token ? String(s).split(this.token).join('***') : String(s); }

  async call(method, body) {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    let res;
    try {
      res = await this.fetch(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'content-type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(30e3),
      });
    } catch (e) {
      const err = new Error(`нет связи с Telegram: ${this.hide(e?.message ?? e)}`);
      err.retry = true;
      throw err;
    }
    let j = null;
    try { j = await res.json(); } catch { /* не JSON */ }
    if (res.ok && j?.ok) return j.result;
    const err = new Error(`Telegram ${res.status}: ${this.hide(j?.description ?? 'ошибка')}`);
    err.status = res.status;
    err.retryAfter = j?.parameters?.retry_after ?? null;
    err.retry = res.status === 429 || res.status >= 500;
    throw err;
  }

  /** Проверка: бот существует и может писать в канал. Возвращает { ok, text } */
  async check(chat) {
    try {
      const me = await this.call('getMe', {});
      const c = await this.call('getChat', { chat_id: chat });
      const m = await this.call('getChatMember', { chat_id: chat, user_id: me.id });
      const canPost = m.status === 'creator' || (m.status === 'administrator' && m.can_post_messages !== false);
      return { ok: canPost, text: `${c.title ?? chat}: бот @${me.username} ${canPost ? 'может публиковать' : 'НЕ администратор канала с правом публиковать сообщения'}` };
    } catch (e) { return { ok: false, text: `${chat}: ${e.message}` }; }
  }

  /**
   * Поставить пост в очередь канала.
   * @param {string} chat — @имя_канала или числовой id (-100…)
   * @param {{ text: string, photo?: Buffer|null, silent?: boolean }} post — text в разметке HTML Telegram
   */
  post(chat, { text, photo = null, silent = false }) {
    if (!this.ready() || !chat || !text) return;
    let q = this.queues.get(chat);
    if (!q) { q = { items: [], busy: false, last: 0 }; this.queues.set(chat, q); }
    if (q.items.length >= 200) { q.items.shift(); this.stats.lost++; } // очередь не растёт бесконечно, если Telegram недоступен
    q.items.push({ text, photo, silent, tries: 0 });
    this.pump(chat, q);
  }

  async pump(chat, q) {
    if (q.busy) return;
    q.busy = true;
    try {
      while (q.items.length) {
        const it = q.items[0];
        const wait = q.last + this.gapMs - Date.now();
        if (wait > 0) await sleep(wait);
        try {
          await this.deliver(chat, it);
          q.items.shift();
          this.stats.sent++;
          this.stats.lastOkAt = Date.now();
        } catch (e) {
          this.stats.errors++;
          this.stats.lastError = e.message;
          if (e.retry && it.tries < this.retryMs.length) {
            const ms = e.retryAfter ? (e.retryAfter + 1) * 1000 : this.retryMs[it.tries];
            it.tries++;
            this.log(`📣 Telegram ${chat}: ${e.message} — повтор через ${Math.round(ms / 1000)} с`);
            q.last = Date.now();
            await sleep(ms);
            continue;
          }
          this.log(`📣 Telegram ${chat}: пост не отправлен — ${e.message}`);
          q.items.shift();
          this.stats.lost++;
        }
        q.last = Date.now();
      }
    } finally { q.busy = false; }
  }

  async deliver(chat, it) {
    const parts = splitText(it.text);
    const base = { chat_id: chat, parse_mode: 'HTML', disable_notification: it.silent || undefined };
    let start = it.sent ?? 0; // при повторе не публикуем уже ушедшие части второй раз
    if (it.photo && !start) {
      const caption = parts[0].length <= MAX_CAPTION ? parts.shift() : null;
      const fd = new FormData();
      fd.append('chat_id', String(chat));
      fd.append('photo', new Blob([it.photo], { type: 'image/png' }), 'chart.png');
      if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
      if (it.silent) fd.append('disable_notification', 'true');
      await this.call('sendPhoto', fd);
      it.photo = null;
      it.text = parts.join('\n\n');
      if (!parts.length) return;
      it.sent = 0;
      start = 0;
      await sleep(Math.min(this.gapMs, 1000));
    }
    const all = it.photo ? parts : splitText(it.text);
    for (let i = start; i < all.length; i++) {
      await this.call('sendMessage', { ...base, text: all[i], link_preview_options: { is_disabled: true } });
      it.sent = i + 1;
    }
  }

  /** Дождаться, пока очереди опустеют (для команды проверки и остановки программы) */
  async drain(timeoutMs = 30e3) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && [...this.queues.values()].some((q) => q.items.length || q.busy)) await sleep(200);
  }

  status() {
    return { ready: this.ready(), ...this.stats, queued: [...this.queues.values()].reduce((s, q) => s + q.items.length, 0) };
  }
}
