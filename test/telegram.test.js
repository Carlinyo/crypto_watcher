// 📣 Telegram-каналы: отправка (очередь, повторы, токен скрыт) и посты для платного и бесплатного каналов
import test from 'node:test';
import assert from 'node:assert/strict';
import { Telegram, splitText } from '../lib/telegram.js';
import * as TG from '../lib/channel.js';
import { analyze } from '../lib/analyzer.js';
import { validateConfig } from '../lib/validate.js';
import { candlesFrom, rng } from './helpers.js';
import cfg from '../config.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

/** Заглушка Bot API: запоминает вызовы, отвечает по сценарию */
function mockApi(script = () => null) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const method = url.split('/').pop();
    let body = opts.body;
    if (body instanceof FormData) body = Object.fromEntries([...body.entries()].map(([k, v]) => [k, v instanceof Blob ? `blob:${v.size}` : v]));
    else body = JSON.parse(body);
    calls.push({ url, method, body });
    const s = script(method, body, calls.length);
    if (s instanceof Error) throw s;
    const { status = 200, json = { ok: true, result: { message_id: calls.length } } } = s ?? {};
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const mk = (script, o = {}) => {
  const api = mockApi(script);
  const logs = [];
  const t = new Telegram({ token: TOKEN, fetchImpl: api.fetchImpl, gapMs: 5, retryMs: [20, 20, 20], log: (s) => logs.push(s), ...o });
  return { t, api, logs };
};

test('Telegram: пост уходит в канал в разметке HTML, посты одного канала — по очереди', async () => {
  const { t, api } = mk();
  assert.equal(t.ready(), true);
  assert.equal(new Telegram({ token: '' }).ready(), false);
  assert.equal(new Telegram({ token: 'abc' }).ready(), false);
  t.post('@paid_channel', { text: '<b>1</b>' });
  t.post('@paid_channel', { text: '2', silent: true });
  t.post('@free_channel', { text: '3' });
  await t.drain(2000);
  assert.deepEqual(api.calls.map((c) => [c.method, c.body.chat_id, c.body.text]), [
    ['sendMessage', '@paid_channel', '<b>1</b>'], ['sendMessage', '@free_channel', '3'], ['sendMessage', '@paid_channel', '2'],
  ].sort((a, b) => api.calls.findIndex((c) => c.body.text === a[2]) - api.calls.findIndex((c) => c.body.text === b[2])));
  assert.equal(api.calls[0].body.parse_mode, 'HTML');
  assert.equal(api.calls.find((c) => c.body.text === '2').body.disable_notification, true);
  assert.ok(api.calls[0].url.endsWith(`/bot${TOKEN}/sendMessage`));
  assert.equal(t.status().sent, 3);
});

test('Telegram: «слишком часто» и сбой — повтор; ошибка в сообщении — без повторов; токен не попадает в журнал', async () => {
  let n = 0;
  const { t, api, logs } = mk((method) => {
    n++;
    if (n === 1) return { status: 429, json: { ok: false, description: 'Too Many Requests: retry after 0', parameters: { retry_after: 0 } } };
    if (n === 2) return new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`);
    if (n === 4) return { status: 400, json: { ok: false, description: "Bad Request: can't parse entities" } };
    return null;
  });
  t.post('@c1', { text: 'первый' });
  t.post('@c1', { text: 'второй' });
  await t.drain(5000);
  assert.deepEqual(api.calls.map((c) => c.body.text), ['первый', 'первый', 'первый', 'второй']);
  const st = t.status();
  assert.deepEqual([st.sent, st.lost, st.errors], [1, 1, 3]);
  assert.match(st.lastError, /can't parse entities/);
  const all = logs.join('\n') + st.lastError;
  assert.ok(!all.includes(TOKEN), 'токен скрыт');
  assert.match(logs.join('\n'), /bot\*\*\*\/sendMessage/);
  assert.match(logs.join('\n'), /повтор через/);
});

test('Telegram: график — фото с подписью; длинный текст — частями; проверка канала', async () => {
  const { t, api } = mk((method) => {
    if (method === 'getMe') return { json: { ok: true, result: { id: 77, username: 'cw_bot' } } };
    if (method === 'getChat') return { json: { ok: true, result: { title: 'Сигналы PRO' } } };
    if (method === 'getChatMember') return { json: { ok: true, result: { status: 'administrator', can_post_messages: true } } };
    return null;
  });
  t.post('@c', { text: 'коротко', photo: Buffer.from('png') });
  const long = Array.from({ length: 60 }, (_, i) => `абзац ${i} ${'х'.repeat(100)}`).join('\n\n');
  t.post('@c', { text: long, photo: Buffer.from('png') });
  await t.drain(3000);
  assert.deepEqual(api.calls.map((c) => c.method), ['sendPhoto', 'sendPhoto', 'sendMessage', 'sendMessage']);
  assert.deepEqual([api.calls[0].body.caption, api.calls[0].body.photo, api.calls[0].body.parse_mode], ['коротко', 'blob:3', 'HTML']);
  assert.equal(api.calls[1].body.caption, undefined, 'длинный текст в подпись не влезает — фото без подписи');
  assert.equal(api.calls.slice(2).map((c) => c.body.text).join('\n\n'), long, 'текст целиком, без потерь');
  assert.ok(api.calls.slice(2).every((c) => c.body.text.length <= 4096));
  const ok = await t.check('@c');
  assert.deepEqual(ok, { ok: true, text: 'Сигналы PRO: бот @cw_bot может публиковать' });
  const no = mk((method) => (method === 'getMe' ? { json: { ok: true, result: { id: 1, username: 'b' } } } : method === 'getChat' ? { json: { ok: true, result: { title: 'X' } } } : { json: { ok: true, result: { status: 'member' } } }));
  assert.match((await no.t.check('@x')).text, /НЕ администратор/);
  const gone = mk(() => ({ status: 400, json: { ok: false, description: 'Bad Request: chat not found' } }));
  assert.deepEqual(await gone.t.check('@nope'), { ok: false, text: '@nope: Telegram 400: Bad Request: chat not found' });
  assert.deepEqual(splitText('a\n\nb', 10), ['a\n\nb']);
  assert.deepEqual(splitText('aaaa\n\nbbbb', 6), ['aaaa', 'bbbb']);
});

// настоящий результат анализа на синтетических данных, повёрнутый в сигнал покупки
function signal() {
  const mkt = (n, seed, drift) => { const r = rng(seed); const c = [100]; for (let i = 1; i < n; i++) c.push(c[i - 1] * (1 + drift + (r() - 0.5) * 0.02)); return c; };
  const r = analyze({ symbol: 'SOLUSDT', candles: {
    m15: candlesFrom(mkt(420, 10, 0.0002), { step: 900e3, wick: 0.2 }), h1: candlesFrom(mkt(520, 7, 0.0008), { wick: 0.4 }),
    h4: candlesFrom(mkt(520, 8, 0.002), { step: 4 * 3600e3, wick: 1 }), d1: candlesFrom(mkt(400, 9, 0.003), { step: 86400e3, wick: 2 }),
  } }, cfg);
  r.action = r.plan.dir;
  r.plan.size = { qty: 12.5, notional: 1875, riskUsd: 200, leverage: 1 };
  r.exec = { status: 'opened', mode: 'demo', trade: { side: 'Buy', notional: 1875 } };
  r.reasons.pro.unshift({ text: 'новость <script>alert(1)</script> & прочее' });
  return r;
}
const stats = { closed: 24, winRate: 0.58, avgR: 0.41, sumR: 9.8, total: 26, open: 2 };

test('Посты: платный — полный разбор, бесплатный — кратко со ссылкой; данных счёта нет нигде', () => {
  const r = signal();
  const paid = TG.signalPost(r, 'paid', { zone: true, stats });
  const free = TG.signalPost(r, 'free', { zone: true, stats, paidLink: 'https://t.me/+AbCdEf' });
  for (const s of [paid, free]) {
    assert.match(s, /#SOL/);
    assert.match(s, /🛑 Стоп: <b>/);
    assert.match(s, /🎯 Цель 1: <b>/);
    assert.match(s, /Не является инвестиционной рекомендацией/);
    assert.doesNotMatch(s, /1 875|1875|\$200|Bybit|демо|баланс|Размер позиции/, 'ничего о счёте владельца');
  }
  assert.match(paid, /<b>За:<\/b>/);
  assert.match(paid, /<b>Уровни:<\/b>/);
  assert.match(paid, /новость &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; прочее/, 'текст извне экранирован');
  assert.match(paid, /📊 Сигналы за 30 дней: 24 закрытых сигнала, успешных 58%, в среднем \+0\.41R, итого \+9\.8R/);
  assert.ok(paid.length > free.length * 2, 'в платном — заметно больше информации');
  assert.doesNotMatch(free, /<b>За:<\/b>|<b>Уровни:<\/b>/);
  assert.match(free, /<a href="https:\/\/t\.me\/\+AbCdEf">в платном канале<\/a>/);
  assert.match(TG.setupPost(r), /Готовимся: (покупка|продажа)/);
  // разметка не ломается: теги парные
  for (const s of [paid, free, TG.setupPost(r)]) for (const tag of ['b', 'i', 'a']) assert.equal((s.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length, (s.match(new RegExp(`</${tag}>`, 'g')) ?? []).length, tag);
});

test('Посты: итоги сигнала, итоги недели (со всеми убыточными), обзор, киты и движения', () => {
  const en = { symbol: 'ETHUSDT', side: 'BUY', opened: Date.now() - 5 * 3600e3, entry: 3000, initialStop: 2900, stop: 3000, t1: 3150, t2: 3300, status: 'open' };
  const tp1 = TG.resultPost({ type: 'tp1', entry: en, r: 0.75 }, { stats });
  assert.match(tp1, /🎯 ETH: цель 1 достигнута \(\+0\.75R\)/);
  assert.match(tp1, /стоп переносим в безубыток/);
  assert.doesNotMatch(tp1, /📊/, 'статистика — когда сигнал закрыт');
  const stop = TG.resultPost({ type: 'stop', entry: { ...en, status: 'closed' }, r: -1 }, { stats });
  assert.match(stop, /🛑 ETH: стоп — итог −1\.00R/);
  assert.match(stop, /📊 Сигналы за 30 дней/);
  assert.equal(TG.resultPost({ type: 'unknown', entry: en, r: 0 }), null);
  const now = Date.now();
  const week = [
    { symbol: 'BTCUSDT', side: 'BUY', status: 'closed', result: 1.75, closed: now - 3e6 },
    { symbol: 'SOLUSDT', side: 'SELL', status: 'closed', result: -1, closed: now - 2e6 },
    { symbol: 'ETHUSDT', side: 'BUY', status: 'closed', result: 0, closed: now - 1e6 },
  ];
  const wp = TG.weeklyPost(week, { stats30: stats });
  assert.match(wp, /3 сигнала закрыто: в плюс 1, в минус 1, в ноль 1; итого <b>\+0\.8R<\/b>/);
  assert.match(wp, /🛑 SOL продажа: −1\.00R/, 'убыточные сигналы не прячем');
  assert.doesNotMatch(wp, /платном/);
  assert.match(TG.weeklyPost(week, { tier: 'free', paidLink: 'https://t.me/x' }), /в платном канале/);
  assert.match(TG.weeklyPost([]), /закрытых сигналов не было/);
  const r = signal();
  const d = TG.dailyPost({ results: [r, { ...r, symbol: 'NVDAUSDT', kind: 'stock' }], market: { fng: { value: 64, label: 'Жадность' }, global: { totalMcap: 3.1e12, mcapChange24h: 1.2, btcDom: 57.3 } }, stats, openSignals: [en] });
  assert.match(d, /📊 <b>Обзор рынка/);
  assert.match(d, /Страх и жадность: 64 \(Жадность\)/);
  assert.match(d, /<b>Акции<\/b>/);
  assert.match(d, /🟢 ETH от 3 000\.00|🟢 ETH от 3000/);
  assert.match(TG.whalePost({ symbol: 'BTCUSDT', side: 'buy', usd: 34.2e6, market: 'spot', type: 'single', price: 61000 }), /🐋 <b>Кит купил BTC на \$34\.20M<\/b> \(спот\)/);
  assert.match(TG.whalePost({ symbol: 'BTCUSDT', side: 'buy', usd: 41.3e6, market: 'futures', type: 'series', minutes: 10, count: 9 }), /скупает BTC: \$41\.30M за 10 мин<\/b> \(фьючерсы\)[\s\S]*9 крупных ордеров/);
  assert.match(TG.movePost({ symbol: 'SOLUSDT', change: -0.052, win: 15, from: 150, to: 142.2, enough: true, volX: 4.1 }, r), /⚡ <b>SOL −5\.2% за 15 мин<\/b>[\s\S]*объём ×4\.1/);
  assert.match(TG.reversalPost(en, r), /анализ развернулся против сигнала/);
});

test('Настройки Telegram: значения по умолчанию и проверка', () => {
  assert.deepEqual([cfg.telegram.freeEvery, cfg.telegram.freeEvents, cfg.telegram.charts], [3, ['signal', 'result', 'weekly'], true]);
  const c = structuredClone(cfg);
  Object.assign(c.telegram, { token: TOKEN, paid: 'paid_channel', free: '@free_ch', freeEvery: 2.5, paidLink: 'http://evil.example', paidEvents: ['signal', 'spam'] });
  const v = validateConfig(c);
  assert.equal(c.telegram.paid, '', 'имя канала без @ — отключён с предупреждением');
  assert.equal(c.telegram.free, '@free_ch');
  assert.equal(c.telegram.freeEvery, 3);
  assert.equal(c.telegram.paidLink, '');
  assert.deepEqual(c.telegram.paidEvents, ['signal']);
  for (const k of ['TG_PAID_CHANNEL=paid_channel', 'TG_FREE_EVERY=2.5', 'TG_PAID_LINK', 'spam']) assert.ok(v.warnings.some((w) => w.includes(k)), k);
  const same = structuredClone(cfg);
  Object.assign(same.telegram, { token: TOKEN, paid: '-1001234567890', free: '-1001234567890' });
  validateConfig(same);
  assert.equal(same.telegram.free, '');
  const badTok = structuredClone(cfg);
  Object.assign(badTok.telegram, { token: 'not-a-token', paid: '@pro_signals' });
  assert.ok(validateConfig(badTok).warnings.some((w) => /TELEGRAM_BOT_TOKEN не похож/.test(w)));
  assert.equal(badTok.telegram.token, '');
});
