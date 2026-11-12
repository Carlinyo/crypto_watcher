// 🧪 Самопроверка на истории.
//
// Раз в неделю программа сама прогоняет бэктест на свежей истории биржи — отдельным процессом с низким
// приоритетом, чтобы не мешать слежению за рынком, — и показывает в панели, как её нынешние правила сработали бы
// за последние недели: сколько сделок, сколько в плюс, что стало бы со счётом. Если на истории стратегия
// в минусе, приходит письмо, а риск сделок уменьшается вдвое (SELF_TEST_GUARD) до следующей проверки.
//
// В истории нет стакана, деривативов, потока сделок и новостей — это проверка главного: уровней, тренда,
// входа на ретесте и сопровождения сделки. Гарантией будущей прибыли она не является.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { accountText } from './portfolio.js';
import { plural } from './format.js';

const DAY = 86400e3, H = 3600e3;
// потолок памяти бэктеста: ему хватает ~200 МБ, а при нехватке должен упасть он, а не программа
const MAX_HEAP_MB = 320;
const sgn = (x, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
const pfTxt = (x) => (x == null ? '—' : x >= 999 ? '∞' : x.toFixed(2));

/**
 * Вывод по итогу бэктеста: good — в плюсе, weak — около нуля, bad — в минусе, few — мало сделок для вывода.
 * mult — множитель риска сделок (bad → 0.5).
 */
export function verdict(res, { minTrades = 30 } = {}) {
  const s = res?.stats;
  if (!s || !(s.n > 0)) return { level: 'few', mult: 1, text: 'за период не было ни одной сделки — вывода нет' };
  if (s.n < minTrades) return { level: 'few', mult: 1, text: `сделок мало (${s.n}) — для вывода нужно хотя бы ${minTrades}` };
  const pf = s.pf ?? 0, second = res.halves?.second;
  if (pf < 0.9 || s.avgR < -0.05) return { level: 'bad', mult: 0.5, text: `на истории стратегия в минусе (в среднем ${sgn(s.avgR)}R на сделку, PF ${pfTxt(s.pf)})` };
  if (pf >= 1.15 && s.avgR > 0.05) {
    const shaky = second && second.n >= 10 && (second.pf ?? 0) < 1;
    return { level: 'good', mult: 1, text: `на истории стратегия в плюсе (в среднем ${sgn(s.avgR)}R на сделку, PF ${pfTxt(s.pf)})${shaky ? ', но во второй половине периода — в минусе: результат неустойчив' : ''}` };
  }
  return { level: 'weak', mult: 1, text: `на истории стратегия около нуля (в среднем ${sgn(s.avgR)}R на сделку, PF ${pfTxt(s.pf)})` };
}

/** Итог самопроверки строками — для панели, письма и терминала; guard — уменьшается ли риск при выводе «в минусе» */
export function selfTestLines(res, { guard = true } = {}) {
  if (!res?.stats) return [];
  const s = res.stats, v = verdict(res), L = [];
  const stocks = res.stocks ?? 0, coins = (res.symbols?.length ?? 0) - stocks;
  const what = [coins > 0 || !stocks ? plural(coins, ['монете', 'монетам', 'монетам']) : null, stocks > 0 ? plural(stocks, ['акции', 'акциям', 'акциям']) : null].filter(Boolean).join(' и ');
  L.push(`За ${plural(res.days, ['день', 'дня', 'дней'])} по ${what}: ${plural(s.n, ['сделка', 'сделки', 'сделок'])}${s.n ? ` (${(res.perDay ?? s.n / res.days).toFixed(1)} в день), в плюс ${s.winRate != null ? Math.round(s.winRate * 100) : '—'}%, в среднем ${sgn(s.avgR ?? 0)}R на сделку, PF ${pfTxt(s.pf)}` : ''}.`);
  const a = res.account?.protect;
  if (a && a.total > 0) L.push(`Счёт с риском ${res.risk?.riskPct ?? '—'}% на сделку и правилами защиты: ${accountText(a)}.`);
  const p = res.account?.plain;
  if (a && p && p.total > 0 && Math.abs(p.maxDdPct - a.maxDdPct) >= 0.5) L.push(`Без правил защиты: ${sgn(p.returnPct, 1)}%, просадка до ${p.maxDdPct.toFixed(1)}%.`);
  const c = res.compare;
  if (c?.retest && c?.touch && c.retest.n >= 10 && c.touch.n >= 10) L.push(`Вход на ретесте против входа при касании зоны (как в 2.7): ${sgn(c.retest.avgR)}R против ${sgn(c.touch.avgR)}R на сделку, PF ${pfTxt(c.retest.pf)} против ${pfTxt(c.touch.pf)}.`);
  L.push(`Вывод: ${v.text}.${v.level === 'bad' && guard ? ' Пока так, риск новых сделок уменьшен вдвое.' : ''}`);
  return L;
}

/** Через сколько повторять после неудачи: 6 ч, потом 12, 24, 48… — но не реже обычного расписания */
export const retryWaitMs = (fails = 0, everyDays = 7) => Math.min(6 * H * 2 ** Math.max(0, fails - 1), everyDays * DAY);

/**
 * Пора ли запускать: включено, программа работает дольше 10 минут, прошлый итог старше недели,
 * после последней попытки прошло достаточно (6 ч; после нескольких неудач подряд — дольше).
 */
export function selfTestDue({ enabled, everyDays = 7 }, { now = Date.now(), last = null, lastTry = 0, fails = 0, upMs = 0, running = false } = {}) {
  if (!enabled || running || upMs < 10 * 60e3) return false;
  if (now - lastTry < retryWaitMs(fails, everyDays)) return false;
  return !last?.at || now - last.at >= everyDays * DAY;
}

/** Ключи запуска node для бэктеста: те же, что у программы, без потолка памяти, отладчика, слежения за файлами и режима тестов */
export function childExecArgv(argv = process.execArgv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^--(max-old-space-size|inspect|watch|test)/.test(a)) { if (a === '--watch-path') i++; continue; }
    out.push(a);
  }
  return out;
}

export class SelfTest {
  /** guard — функция: уменьшается ли сейчас риск сделок при выводе «в минусе» (по умолчанию — настройка SELF_TEST_GUARD) */
  constructor(cfg, { dir, log = console.log, guard = null } = {}) {
    this.cfg = cfg.selftest;
    this.guardOn = guard ?? (() => this.cfg.guard);
    this.dir = dir;
    this.file = path.join(dir, this.cfg.file);
    this.tryFile = this.file.replace(/(\.json)?$/, '-try.json');
    this.log = log;
    this.running = false;
    this.child = null;
    this.lastError = null;
    this.startedAt = Date.now();
    this.result = this.load();
    this.mtime = this.mtimeOf();
    // попытки переживают перезапуск: если проверка каждый раз обрывается, паузы между попытками растут
    const t = this.loadTry();
    this.lastTry = t.at;
    this.fails = t.fails;
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return j && j.stats && Number.isFinite(j.at) ? j : null;
    } catch { return null; }
  }

  mtimeOf() { try { return fs.statSync(this.file).mtimeMs; } catch { return 0; } }

  loadTry() {
    try {
      const j = JSON.parse(fs.readFileSync(this.tryFile, 'utf8'));
      return { at: Number.isFinite(j.at) ? Math.min(j.at, Date.now()) : 0, fails: Number.isInteger(j.fails) && j.fails > 0 ? Math.min(j.fails, 20) : 0 };
    } catch { return { at: 0, fails: 0 }; }
  }

  saveTry() {
    try {
      fs.mkdirSync(path.dirname(this.tryFile), { recursive: true });
      fs.writeFileSync(this.tryFile, JSON.stringify({ at: this.lastTry, fails: this.fails }));
    } catch { /* не удалось записать — попытки считаем только в памяти */ }
  }

  /**
   * Итог обновился на диске (проверку запускали командой --selftest рядом с работающей программой) — берём его.
   * Возвращает true, если появился новый итог.
   */
  reload() {
    if (this.running) return false;
    const m = this.mtimeOf();
    if (m === this.mtime) return false;
    this.mtime = m;
    const res = this.load();
    if (!res || res.at === this.result?.at) return false;
    this.result = res;
    const t = this.loadTry();
    this.lastTry = Math.max(this.lastTry, t.at);
    this.fails = t.fails;
    this.lastError = null;
    return true;
  }

  /** Итог годится для выводов, пока он не старше двух периодов проверки */
  fresh(now = Date.now()) { return !!this.result && now - this.result.at < 2 * this.cfg.everyDays * DAY; }
  verdict(now = Date.now()) { return this.fresh(now) ? verdict(this.result) : null; }
  due(now = Date.now()) { return selfTestDue(this.cfg, { now, last: this.result, lastTry: this.lastTry, fails: this.fails, upMs: now - this.startedAt, running: this.running }); }
  /** Через сколько часов следующая попытка после неудачи */
  retryHours() { return Math.round(retryWaitMs(this.fails, this.cfg.everyDays) / H); }

  /**
   * Программа останавливается — бэктест не должен остаться работать без неё.
   * forgive: остановка плановая (перезапуск, обновление) — попытка не считается неудачной, проверка начнётся снова после запуска.
   */
  stop({ forgive = true } = {}) {
    if (!this.child) return;
    if (forgive) { this.fails = Math.max(0, this.fails - 1); this.lastTry = 0; this.saveTry(); }
    try { this.child.kill('SIGKILL'); } catch { /* уже завершился */ }
  }

  /** Итог строками; про уменьшение риска — только если оно действительно действует */
  lines() { return this.result ? selfTestLines(this.result, { guard: this.fresh() && !!this.guardOn() }) : []; }

  /** Для панели */
  status() {
    return {
      enabled: this.cfg.enabled, running: this.running, at: this.result?.at ?? null, days: this.cfg.days, everyDays: this.cfg.everyDays,
      lines: this.lines(), level: this.result ? verdict(this.result).level : null, stale: !!this.result && !this.fresh(),
      curve: this.result?.account?.protect?.curve ?? null, error: this.lastError, retryHours: this.lastError ? this.retryHours() : null,
    };
  }

  /**
   * Бэктест отдельным процессом (с теми же ключами запуска node, что у программы): --quiet — низкий приоритет,
   * память ограничена, чтобы при нехватке упал бэктест, а не программа. Возвращает итог или null.
   * symbols — что проверять (пусто — сохранённый список монет программы).
   */
  run({ timeoutMs = 45 * 60e3, quiet = true, symbols = [] } = {}) {
    if (this.running) return Promise.resolve(null);
    this.running = true;
    this.lastTry = Date.now();
    this.lastError = null;
    // попытка считается неудачной, пока не доказано обратное: если программа упадёт во время проверки, счёт сохранится
    this.fails += 1;
    this.saveTry();
    const names = symbols.filter((s) => /^[A-Z0-9]{2,20}$/.test(s));
    // ключи запуска node передаём бэктесту, кроме тех, что ему не годятся: свой потолок памяти, отладчик, слежение за файлами
    const args = [...childExecArgv(), `--max-old-space-size=${MAX_HEAP_MB}`, path.join(this.dir, 'backtest.js'), ...names,
      '--json', this.cfg.file, '--days', String(this.cfg.days), '--step', String(this.cfg.step), '--compare', ...(quiet ? ['--quiet'] : [])];
    return new Promise((resolve) => {
      let err = '', done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.running = false;
        this.child = null;
        if (res) { this.fails = 0; this.saveTry(); }
        this.mtime = this.mtimeOf();
        resolve(res);
      };
      let child, timer = null;
      try { child = spawn(process.execPath, args, { cwd: this.dir, stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'pipe'] }); } catch (e) { this.lastError = e.message; finish(null); return; }
      this.child = child;
      timer = setTimeout(() => { this.lastError = 'проверка шла слишком долго и остановлена'; child.kill('SIGKILL'); }, timeoutMs);
      child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      child.on('error', (e) => { this.lastError = e.message; finish(null); });
      child.on('exit', (code, signal) => {
        if (code !== 0) {
          const last = err.trim().split('\n').filter((l) => l.trim()).pop();
          this.lastError ??= /heap out of memory|Allocation failed/i.test(err) || code === 134 ? 'бэктесту не хватило памяти'
            : `бэктест завершился с ошибкой${last ? `: ${last.trim().slice(0, 200)}` : signal ? ` (остановлен системой: ${signal})` : ` (код ${code})`}`;
          finish(null);
          return;
        }
        const res = this.load();
        if (!res || res.at < this.lastTry - 60e3) { this.lastError = 'бэктест не записал итог'; finish(null); return; }
        this.result = res;
        finish(res);
      });
    });
  }
}
