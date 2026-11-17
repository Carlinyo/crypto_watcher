#!/usr/bin/env node
// Бэктест: прогоняет анализ по истории и симулирует сделки по сигналам — с теми же правилами,
// что и журнал (стоп, цель 1 → половина и стоп в безубыток, цель 2, истечение, вход по зоне).
//
//   node backtest.js                          — монеты из сохранённого топа (или BTC, ETH, SOL), 90 дней
//   node backtest.js BTCUSDT SOLUSDT --days 180
//   node backtest.js --grid                   — перебрать пороги и подсказать лучший
//   флаги: --days N  --step K (анализ раз в K часов)  --fast (без 15m)  --threshold X
//          --entry retest|touch|signal (как TRADE_ENTRY: на ретесте уровня, при касании зоны — как в 2.7, сразу по сигналу)
//   node backtest.js --compare                — три способа входа рядом на одних и тех же данных
//   флаги: --json файл (итог в файл — для самопроверки программы)  --quiet (без хода загрузки, низкий приоритет)
//   node backtest.js --stocks                 — акции из списка программы (фьючерсы на акции Binance)
//   node backtest.js NVDAUSDT AAPLUSDT        — свои акции: фьючерс на акцию распознаётся сам
//
// Важно: в истории нет стакана, деривативов, потока сделок и новостей — эти блоки в бэктесте
// не участвуют, оценка строится по уровням, тренду, индикаторам и паттернам.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(dir, '.env');
if (fs.existsSync(envFile) && process.loadEnvFile) process.loadEnvFile(envFile);

const { default: cfg } = await import('./config.js');
const { Binance } = await import('./lib/binance.js');
const { analyze, decide } = await import('./lib/analyzer.js');
const { fmt } = await import('./lib/format.js');
const { priceInZone, zoneEntry } = await import('./lib/policy.js');
const { touches, isConfirmation, retestPlan } = await import('./lib/entry.js');
const { STOCK_CANDIDATES, tradedOnly } = await import('./lib/stocks.js');
const { simulateAccount, accountText } = await import('./lib/portfolio.js');
const { executionCosts, lastClosedIndex, tradesIn, walkForward } = await import('./lib/backtest-metrics.js');
const os = await import('node:os');
const { MacroCalendar } = await import('./lib/calendar.js');
const calendar = new MacroCalendar(path.join(dir, cfg.macro.file));

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const bool = (n) => { const i = args.indexOf(`--${n}`); if (i < 0) return false; args.splice(i, 1); return true; };
const days = Number(flag('days', 90));
const step = Math.max(1, Number(flag('step', 1)));
const baseThr = Number(flag('threshold', cfg.signal.threshold));
const grid = bool('grid');
const ENTRY_MODES = { retest: 'на ретесте уровня', touch: 'при касании зоны (как в 2.7)', signal: 'сразу по сигналу' };
const entryMode = ((v) => (v === 'zone' ? 'retest' : ENTRY_MODES[v] ? v : 'retest'))(String(flag('entry', cfg.trade.entry)).toLowerCase());
const compare = bool('compare');
const fast = bool('fast');
const jsonOut = flag('json', null);
const quiet = bool('quiet');
const useRange = bool('range');
const noRange = bool('no-range');
if (useRange || noRange) cfg.trade.range = useRange && !noRange;
const costs = {
  feePct: cfg.risk.feePct, spreadBps: Number(flag('spread-bps', 2)), slippageBps: Number(flag('slippage-bps', 2)),
  fundingBps: Number(flag('funding-bps', 1)), tp1Share: cfg.trade.tp1Share,
};
if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(step) || step <= 0 ||
  !(baseThr > 0 && baseThr <= 1) ||
  ![costs.feePct, costs.spreadBps, costs.slippageBps, costs.fundingBps].every((n) => Number.isFinite(n) && n >= 0)) {
  throw new Error('Укажите положительный период и шаг, неотрицательные комиссии и издержки');
}
// самопроверка идёт рядом с работающей программой — не отнимаем у неё процессор, а если на сервере кончится память,
// система должна остановить бэктест, а не программу (Linux: чем больше oom_score_adj, тем раньше процесс под снос)
if (quiet) {
  try { os.setPriority(os.constants.priority.PRIORITY_LOW); } catch { /* не разрешено — работаем как есть */ }
  try { fs.writeFileSync('/proc/self/oom_score_adj', '1000'); } catch { /* не Linux или запрещено */ }
}
const say = (...a) => { if (!quiet) console.log(...a); };
// анализ — с планом для входа на ретесте и планом как в 2.7 (b.legacyPlan), способ входа выбирает симуляция
const acfg = { ...cfg, trade: { ...cfg.trade, entry: 'retest' } };
const stocksMode = bool('stocks');
cfg.signal.threshold = baseThr;
const binance = new Binance(cfg);
const DAY = 86400e3, H = 3600e3;
const periodEnd = Date.now();
const periodStart = periodEnd - days * DAY;
const holdoutStart = periodStart + Math.floor(days * DAY * 0.8);
await binance.loadFuturesInfo().catch(() => null); // какие символы — фьючерсы на акции

let symbols = args.map((s) => s.toUpperCase());
if (!symbols.length && stocksMode) {
  try { symbols = JSON.parse(fs.readFileSync(path.join(dir, cfg.stocks.cacheFile), 'utf8')).stocks.map((c) => c.symbol); } catch { symbols = STOCK_CANDIDATES.slice(0, cfg.stocks.size).map((c) => `${c.ticker.replace(/[^A-Z0-9]/g, '')}USDT`).filter((s) => binance.stockOf(s)); }
}
if (!symbols.length) {
  try { symbols = JSON.parse(fs.readFileSync(path.join(dir, cfg.universe.cacheFile), 'utf8')).coins.map((c) => c.symbol); } catch { symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']; }
}
// акция — фьючерс на акцию Binance (TRADIFI_PERPETUAL), у которого нет обычного криптоконтракта
const isStockSym = (s) => !!binance.stockOf(s) && !binance.futuresOf(s);
if (symbols.filter((s) => !isStockSym(s)).length > 1 && !symbols.includes('BTCUSDT')) symbols.unshift('BTCUSDT'); // контекст биткоина для альтов

// кэш истории живёт 6 часов — файлы старше суток не нужны (иначе папка растёт с каждой сменой списка монет)
try {
  const hd = path.join(dir, 'data', 'history');
  for (const f of fs.readdirSync(hd)) {
    const full = path.join(hd, f);
    if (/\.(json|tmp)$/.test(f) && Date.now() - fs.statSync(full).mtimeMs > 86400e3) fs.unlinkSync(full);
  }
} catch { /* папки ещё нет */ }

async function history(symbol, interval, nDays, market = 'spot') {
  const file = path.join(dir, 'data', 'history', `${market === 'spot' ? '' : 'f-'}${symbol}-${interval}-${nDays}.json`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < 6 * H) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* нет кэша */ }
  const rows = await binance.klinesHistory(symbol, interval, periodEnd - nDays * DAY, periodEnd, market);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows));
    fs.renameSync(tmp, file); // целиком или никак: рядом может идти второй бэктест (самопроверка и запуск вручную)
  } catch { /* кэш не записался (нет места на диске?) — работаем без него */ }
  return rows;
}

function analyzeAt(sym, data, i, price, btcAt) {
  const t = data.h1[i].closeTime;
  // Запросы ретеста возвращаются назад по времени после расчёта основной серии.
  const i4 = lastClosedIndex(data.h4, t), iD = lastClosedIndex(data.d1, t), i15 = data.m15 ? lastClosedIndex(data.m15, t) : -1;
  const bundle = {
    symbol: sym, kind: data.kind, price, closedOnly: true, now: t,
    candles: {
      h1: data.h1.slice(Math.max(0, i - 499), i + 1),
      h4: i4 >= 0 ? data.h4.slice(Math.max(0, i4 - 499), i4 + 1) : null,
      d1: iD >= 0 ? data.d1.slice(Math.max(0, iD - 499), iD + 1) : null,
      m15: data.m15 && i15 >= 0 ? data.m15.slice(Math.max(0, i15 - 399), i15 + 1) : null,
    },
    btc: btcAt ? btcAt(t) : null,
    macro: { risk: calendar.risk(t), next: calendar.next(t) },
    legacyPlan: true,
  };
  return analyze(bundle, acfg);
}

const compact = (r) => ({ score: r.score, agreement: r.agreement, completeness: r.completeness, regime: r.regime, plan: r.plan, planLegacy: r.planLegacy, core: r.core, trend: r.blocks.trend.score, atr: r.stats.atr });

// ── симуляция сделок по сохранённым оценкам ───────────────────────────────
// Способы входа (--entry, как TRADE_ENTRY; --compare — все три на одних данных):
//   retest (по умолчанию) — сильный сигнал или «готовиться» ставит ожидание у уровня (ретест пробитого уровня
//     или отскок от поддержки). Цена коснулась уровня → после каждой закрытой 15-минутной свечи — проверка
//     подтверждения (свеча от уровня в сторону сделки) → свежий анализ → вход по закрытию этой свечи.
//     Стоп — за уровнем и за экстремумом ретеста; часовая свеча, закрывшаяся за уровнем, снимает ожидание;
//   touch — как в 2.7: сильный сигнал, если цена уже в зоне входа, — вход сразу; иначе — как только цена войдёт в зону;
//   signal — сильный сигнал — вход сразу, где бы ни была цена.
// Вход по свежему анализу — если оценка в ту же сторону не слабее 70% порога, прибыль/риск от MIN_RR и нет запретов.
function simulate(sym, data, recs, thr, zoneCache, mode = entryMode) {
  const c = { ...cfg, signal: { ...cfg.signal, threshold: thr }, trade: { ...cfg.trade, entry: mode } };
  const legacy = mode !== 'retest';
  const planOf = (x) => (legacy ? x.planLegacy ?? x.plan : x.plan);
  const expire = cfg.journal.expireHours;
  const rule = { minRR: cfg.signal.minRiskReward, triggerRatio: cfg.signal.zoneTriggerRatio };
  const trades = [];
  let open = null, zone = null, lastSig = -1e9;
  const dec = (x) => decide({ ...x.core, score: x.score, agreement: x.agreement, completeness: x.completeness, regime: x.regime, plan: planOf(x) }, c);
  // свежий анализ в момент входа: по данным на закрытие прошлого часа, с ценой px (кэш общий для всех способов)
  const freshAt = (j, px) => {
    const key = `${j}:${px}`;
    let rz = zoneCache.get(key);
    if (!rz) { rz = compact(analyzeAt(sym, data, j - 1, px, data.btcAt)); zoneCache.set(key, rz); }
    return rz;
  };
  // 15-минутные свечи внутри часа (без 15m — сам час)
  let p15 = 0;
  const subOf = (bar) => {
    const m = data.m15;
    if (!m) return [bar];
    while (p15 < m.length && m[p15].time < bar.time) p15++;
    const out = [];
    for (let q = p15; q < m.length && m[q].time < bar.time + H; q++) out.push(m[q]);
    return out.length ? out : [bar];
  };

  const close = (j, price, why, exitAt = data.h1[j].closeTime) => {
    const s = open.side === 'BUY' ? 1 : -1;
    const risk = Math.abs(open.entry - open.initStop) || 1e-12;
    const rOf = (p) => ((p - open.entry) * s) / risk;
    const grossR = open.tp1 ? costs.tp1Share * rOf(open.t1) + (1 - costs.tp1Share) * rOf(price) : rOf(price);
    const t0 = open.entryAt, t1 = Math.max(t0, exitAt);
    const fees = executionCosts({ ...open, target1: open.t1, exit: price, t0, t1, why }, data.costs);
    const r = grossR - Object.values(fees).reduce((sum, value) => sum + value, 0) / risk;
    trades.push({ ...open, exitIdx: j, exitAt: t1, exit: price, why, grossR, fees, r });
    open = null;
  };
  const openTrade = (j, side, entry, plan, via, rec, entryAt = data.h1[j].time) => {
    open = { sym, side, entryIdx: j, entryAt, entry, stop: plan.stop, initStop: plan.stop, t1: plan.t1, t2: plan.t2, tp1: false, via, rangeEntry: plan.entryType === 'range', regime: rec.regime.key, score: rec.score };
    // если вход заметно хуже расчётного — стоп/цели остаются по плану (как в реальной жизни)
    if ((side === 'BUY' && entry <= plan.stop) || (side === 'SELL' && entry >= plan.stop)) open = null;
    if (open?.rangeEntry) {
      const sign = side === 'BUY' ? 1 : -1;
      const fee = entry * costs.feePct / 100;
      const rr = ((plan.t1 - entry) * sign - fee) / ((entry - plan.stop) * sign + fee);
      if (entry < plan.zone[0] || entry > plan.zone[1] || rr < rule.minRR) open = null;
    }
  };
  const arm = (j, rec) => {
    const p = planOf(rec);
    // идёт ретест (цена у уровня) — уровень и касание не меняются при пересчёте, как у работающей программы
    if (zone && zone.level && zone.touched != null && zone.dir === p.dir) return;
    const level = legacy ? null : p.level;
    // план обновился, а уровень тот же — касание и экстремум ретеста сохраняются
    const keep = zone && zone.dir === p.dir && zone.touched != null && level && zone.level && level.low <= zone.level.high && level.high >= zone.level.low;
    zone = { dir: p.dir, low: p.zone[0], high: p.zone[1], stop: p.stop, atr: rec.atr, level, armed: j, until: j + cfg.signal.zoneValidHours, touched: keep ? zone.touched : null, ext: keep ? zone.ext : null };
  };

  for (let j = data.start; j < data.h1.length; j++) {
    const bar = data.h1[j];
    if (open && j >= open.entryIdx) {
      const buy = open.side === 'BUY';
      const fav = buy ? bar.high : bar.low, adv = buy ? bar.low : bar.high;
      if (buy ? adv <= open.stop : adv >= open.stop) close(j, buy ? Math.min(open.stop, bar.open) : Math.max(open.stop, bar.open), open.trailed ? 'trail' : open.tp1 ? 'breakeven' : open.be ? 'be' : 'stop');
      else {
        // прибыль в один риск (TRADE_BE_AT_R) — стоп в безубыток ещё до цели 1, как у работающей программы
        const beR = cfg.trade.beAtR * Math.abs(open.entry - open.initStop);
        if (!open.tp1 && !open.be && beR > 0 && (buy ? fav >= open.entry + beR : fav <= open.entry - beR)) { open.be = true; open.stop = open.entry; open.safeIdx ??= j; }
        if (!open.tp1 && (buy ? fav >= open.t1 : fav <= open.t1)) { open.tp1 = true; open.tp1At = bar.closeTime; open.stop = open.entry; open.safeIdx ??= j; }
        if (open && open.tp1 && (buy ? fav >= open.t2 : fav <= open.t2)) close(j, open.t2, 'tp2');
        else if (open && open.tp1 && !open.trailed && (buy ? fav >= (open.t1 + open.t2) / 2 : fav <= (open.t1 + open.t2) / 2)) { open.trailed = true; open.stop = open.t1; }
        if (open && j - open.entryIdx >= expire) close(j, bar.close, 'expired');
      }
    }
    if (!open && zone && j > zone.armed && j <= zone.until) {
      if (zone.level) {
        // 🎯 ретест: касание уровня → закрытая 15-минутная свеча подтверждает отскок → вход по её закрытию
        const buy = zone.dir === 'BUY', L = zone.level, atr = zone.atr;
        const subs = subOf(bar);
        for (let q = 0; q < subs.length && zone; q++) {
          const k = subs[q], ext = buy ? k.low : k.high;
          if (zone.touched == null) {
            if (!touches(zone, ext)) continue;
            zone.touched = k.time; zone.ext = ext;
          } else zone.ext = buy ? Math.min(zone.ext, ext) : Math.max(zone.ext, ext);
          if (buy ? k.low < zone.stop : k.high > zone.stop) { zone = null; break; } // прошла за стоп — уровень пробит
          if (!isConfirmation(zone, k)) {
            if (buy ? k.close > L.high + atr : k.close < L.low - atr) { zone.touched = null; zone.ext = null; } // ушла без подтверждения
            continue;
          }
          const px = k.close, rz = freshAt(j, px), d = dec(rz);
          if (cfg.trade.range && rz.core.range) { zone = null; break; }
          const plan = retestPlan(planOf(rz), zone, { price: px, ext: zone.ext, atr: rz.atr, stopMult: rz.regime.stopMult ?? 1, risk: cfg.risk });
          const res = zoneEntry(zone, { score: rz.score, threshold: d.threshold, vetoes: d.vetoes, plan }, rule);
          if (res.ok) {
            openTrade(j, zone.dir, px, plan, L.role === 'breakout' ? 'ретест' : 'отскок', rz, k.closeTime);
            lastSig = j;
            zone = null;
            // остаток часа после входа — только стоп (консервативно)
            if (open) for (const k2 of subs.slice(q + 1)) if (buy ? k2.low <= open.stop : k2.high >= open.stop) { close(j, open.stop, 'stop'); break; }
            break;
          }
          if (res.flip) { zone = null; break; }
        }
        // часовая свеча закрылась за уровнем — уровень не удержался
        if (zone && zone.touched != null && (buy ? bar.close < L.low - 0.1 * atr : bar.close > L.high + 0.1 * atr)) zone = null;
      } else {
        // как в 2.7: цена дошла до зоны входа — свежий анализ и вход сразу
        const hit = zone.dir === 'BUY' ? bar.low <= zone.high : bar.high >= zone.low;
        if (hit) {
          const px = zone.dir === 'BUY' ? Math.min(bar.open, zone.high) : Math.max(bar.open, zone.low);
          const rz = freshAt(j, px);
          if (cfg.trade.range && rz.core.range) { zone = null; continue; }
          const d = dec(rz);
          const res = zoneEntry(zone, { score: rz.score, threshold: d.threshold, vetoes: d.vetoes, plan: planOf(rz) }, rule);
          if (res.ok) {
            openTrade(j, zone.dir, px, res.plan, 'зона', rz);
            lastSig = j;
            zone = null;
            // после входа внутри свечи проверяем только стоп (консервативно)
            if (open && (open.side === 'BUY' ? bar.low <= open.stop : bar.high >= open.stop)) close(j, open.stop, 'stop');
          } else if (res.flip) zone = null; // иначе зона остаётся — проверим снова на следующей свече
        }
        // цена ушла за стоп — зона больше не актуальна
        if (zone && (zone.dir === 'BUY' ? bar.low < zone.stop : bar.high > zone.stop)) zone = null;
      }
    }
    if (zone && j > zone.until) zone = null;
    const rec = recs.get(j);
    if (!rec) continue;
    const d = dec(rec), p = d.rangeEntry ? rec.core.range.plan : planOf(rec);
    if (cfg.trade.range && rec.core.range) zone = null;
    if (d.action === 'BUY' || d.action === 'SELL') {
      if (open && open.side === d.action) continue;
      // подтверждённый сигнал против открытой сделки — выход, не дожидаясь стопа (TRADE_EXIT_ON_REVERSAL)
      if (open && !cfg.trade.exitOnReversal) continue;
      if (open) close(j, bar.close, 'reversed');
      const inZone = priceInZone({ dir: p.dir, low: p.zone[0], high: p.zone[1], atr: rec.atr }, bar.close);
      if (d.rangeEntry || mode === 'signal' || (mode === 'touch' && inZone)) {
        if (d.rangeEntry && ((!cfg.trade.shorts && d.action === 'SELL') || d.confidence < cfg.trade.minConfidence)) continue;
        if (j - lastSig >= 2 && j + 1 < data.h1.length) { openTrade(j + 1, d.action, data.h1[j + 1].open, p, d.rangeEntry ? 'боковик' : 'сигнал', rec); lastSig = j; zone = null; }
      } else {
        arm(j, rec);
        // цена уже у уровня — касание засчитано, подтверждение — по следующим 15-минутным свечам
        if (zone.level && inZone && zone.touched == null) { zone.touched = bar.time; zone.ext = p.dir === 'BUY' ? bar.low : bar.high; }
      }
    } else if (d.action.startsWith('WATCH') && !open) {
      if (d.zoneOk) arm(j, rec);
      else if (!(zone && zone.level && zone.touched != null && zone.dir === p.dir)) zone = null;
    } else if (d.action === 'NEUTRAL' && zone && Math.abs(rec.score) < d.threshold * 0.3) zone = null;
  }
  if (open) close(data.h1.length - 1, data.h1[data.h1.length - 1].close, 'открыта на конец');
  return trades;
}

function stats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.r > 0.05).length, losses = trades.filter((t) => t.r < -0.05).length;
  const sumR = trades.reduce((s, t) => s + t.r, 0);
  const gp = trades.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0), gl = -trades.filter((t) => t.r < 0).reduce((s, t) => s + t.r, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...trades].sort((a, b) => (a.t1 ?? a.exitIdx) - (b.t1 ?? b.exitIdx))) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return {
    n, wins, losses, winRate: wins + losses ? wins / (wins + losses) : null, tp1: n ? trades.filter((t) => t.tp1).length / n : null,
    avgR: n ? sumR / n : null, sumR, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : null, maxDD: dd,
  };
}

const pad = (s, n) => String(s).padStart(n);
const pf = (x) => (x == null ? '—' : x === Infinity ? '∞' : x.toFixed(2));
const perDay = (n) => (n / reportDays < 0.1 ? (n / reportDays).toFixed(2) : (n / reportDays).toFixed(1));
const row = (name, s) => `${name.padEnd(12)}${pad(s.n, 7)}${pad(perDay(s.n), 8)}${pad(s.winRate == null ? '—' : `${(s.winRate * 100).toFixed(0)}%`, 8)}${pad(s.tp1 == null ? '—' : `${(s.tp1 * 100).toFixed(0)}%`, 8)}${pad(s.avgR == null ? '—' : s.avgR.toFixed(2), 8)}${pad(s.sumR.toFixed(1), 9)}${pad(pf(s.pf), 7)}${pad(s.maxDD.toFixed(1), 10)}`;
const HEAD = `${'монета'.padEnd(12)}${pad('сделок', 7)}${pad('в день', 8)}${pad('успех', 8)}${pad('цель1', 8)}${pad('ср. R', 8)}${pad('сумма R', 9)}${pad('PF', 7)}${pad('просадка', 10)}`;
const WHY_RU = { stop: 'стоп', breakeven: 'цель 1 → безубыток', be: 'безубыток до цели 1', trail: 'цель 1 → подтянутый стоп', tp2: 'цель 2', expired: 'истекло время', reversed: 'обратный сигнал' };
const REG_RU = { trend_up: 'восх. тренд', trend_down: 'нисх. тренд', range: 'боковик', squeeze: 'сжатие', volatile: 'волатильно', transition: 'переходный' };

// ── прогон ────────────────────────────────────────────────────────────────
// Каждая монета считается целиком (анализ → сделки при всех порогах и способах входа) и сразу освобождает память:
// так бэктест укладывается в память контейнера рядом с работающей программой.
say(`Бэктест: ${symbols.join(', ')} | ${days} дн. | анализ каждые ${step} ч | порог ${baseThr} | вход ${compare ? 'всеми тремя способами' : ENTRY_MODES[entryMode]}${fast ? ' | без 15m (подтверждение ретеста — по часовым свечам)' : ''}`);
say('Загрузка истории (кэшируется в data/history)…');
const thresholds = grid ? [...new Set([0.25, 0.28, 0.3, 0.33, 0.36, 0.4, 0.45, 0.5, baseThr])].sort((a, b) => a - b) : [baseThr];
const reportEnd = grid ? holdoutStart : periodEnd;
const reportDays = (reportEnd - periodStart) / DAY;
const CMP = [['retest', 'ретест'], ['touch', 'касание 2.7'], ['signal', 'по сигналу']];
const runs = new Map(thresholds.map((thr) => [thr, []]));   // порог → сделки (способ входа — entryMode)
const cmpRuns = new Map(CMP.map(([m]) => [m, []]));         // способ входа → сделки при основном пороге
const perSym = [];                                            // [монета, сделки] при основном пороге
const mainThr = thresholds.includes(baseThr) ? baseThr : thresholds[0];
const btcScores = new Map();
let btcData = null;
const t0 = Date.now();
const done = [];
const fundingSources = {};

for (const sym of symbols) {
  let data;
  const stock = isStockSym(sym);
  try {
    // акция: свечи фьючерса на акцию, часы без торгов выбрасываются; истории нужно больше (торгов — несколько часов в день)
    const mk = stock ? 'futures' : 'spot', keep = stock ? tradedOnly : (x) => x;
    const [h1, h4, d1, m15] = (await Promise.all([
      history(sym, '1h', days + (stock ? 120 : 25), mk), history(sym, '4h', days + 90, mk), history(sym, '1d', days + 400, mk),
      fast ? Promise.resolve(null) : history(sym, '15m', days + 5, mk),
    ])).map((x) => (x ? keep(x.filter((bar) => bar.closeTime <= periodEnd)) : x));
    data = { h1, h4, d1, m15, kind: stock ? 'stock' : 'crypto' };
  } catch (e) { console.error(`${sym}: не удалось загрузить историю — ${e.message}`); continue; }
  const warm = stock ? 250 : 500;
  if (data.h1.length < warm + 100) { console.error(`${sym}: мало истории (${data.h1.length} ч с торгами) — пропускаю`); continue; }
  const first = data.h1.findIndex((c) => c.time >= periodStart);
  if (first < 0) { console.error(`${sym}: нет свечей в выбранном периоде`); continue; }
  data.start = Math.max(warm, first);
  const futures = stock ? { symbol: sym, mult: 1 } : binance.futuresOf(sym);
  const funding = futures ? await binance.fundingHistory(futures.symbol, periodStart, periodEnd).catch((e) => {
    console.error(`${sym}: нет истории фандинга, использую оценку — ${e.message}`);
    return null;
  }) : null;
  const payments = funding?.map((x) => ({
    time: +x.fundingTime, rate: +x.fundingRate, price: +x.markPrice / (futures.mult ?? 1),
  })).filter((x) => Number.isFinite(x.time) && Number.isFinite(x.rate)).sort((a, b) => a.time - b.time);
  data.costs = { ...costs, funding: payments?.length ? payments : null };
  fundingSources[sym] = data.costs.funding ? 'binance' : 'estimate';
  if (!stock && sym !== 'BTCUSDT' && btcData) {
    const btcH1 = btcData.h1;
    data.btcAt = (t) => {
      const k = lastClosedIndex(btcH1, t);
      if (k < 60) return null;
      const s = btcScores.get(btcH1[k].closeTime);
      return { h1: btcH1.slice(Math.max(0, k - 499), k + 1), trend: s?.trend ?? 0, score: s?.score ?? 0 };
    };
  }
  const recs = new Map();
  const total = Math.ceil((data.h1.length - data.start) / step);
  let n = 0, lastLog = Date.now();
  for (let i = data.start; i < data.h1.length - 1; i += step) {
    const r = analyzeAt(sym, data, i, data.h1[i].close, data.btcAt);
    recs.set(i, compact(r));
    if (sym === 'BTCUSDT') btcScores.set(data.h1[i].closeTime, { score: r.score, trend: r.blocks.trend.score });
    if (++n && !quiet && Date.now() - lastLog > 5000) { lastLog = Date.now(); process.stdout.write(`  ${sym}: ${Math.round((n / total) * 100)}%\r`); }
  }
  // сделки с временем входа и выхода, расстоянием до стопа и моментом, когда стоп перенесён в безубыток
  const stamp = (tr) => tr.map((t) => ({
    ...t, kind: data.kind, t0: t.entryAt, t1: t.exitAt,
    safeAt: t.safeIdx != null ? data.h1[t.safeIdx].closeTime ?? data.h1[t.safeIdx].time + H : null,
    stopPct: Math.abs(t.entry - t.initStop) / t.entry,
  }));
  const zoneCache = new Map();
  for (const thr of thresholds) {
    const tr = stamp(simulate(sym, data, recs, thr, zoneCache));
    runs.get(thr).push(...tr);
    if (thr === mainThr) {
      const visible = tradesIn(tr, periodStart, reportEnd);
      perSym.push([sym, visible]); cmpRuns.get(entryMode).push(...visible);
    }
  }
  if (compare) for (const [m] of CMP) if (m !== entryMode) {
    cmpRuns.get(m).push(...tradesIn(stamp(simulate(sym, data, recs, mainThr, zoneCache, m)), periodStart, reportEnd));
  }
  if (sym === 'BTCUSDT') btcData = { h1: data.h1 }; // альтам нужен только часовой график биткоина
  done.push(sym);
  say(`  ${sym}: проанализировано ${n} точек`);
}

const summary = thresholds.map((thr) => {
  const trades = tradesIn(runs.get(thr), periodStart, reportEnd);
  return { thr, stats: stats(trades), trades };
});
const main = summary.find((s) => s.thr === mainThr);
say(`\nРезультаты при пороге ${main.thr}${grid ? ' на первых 80% периода' : ''}\n${HEAD}`);
say(`Издержки: комиссия ${costs.feePct}% за оборот вход–выход, спред ${costs.spreadBps} б.п., проскальзывание ${costs.slippageBps} б.п. за рыночную сторону.`);
say(`Фандинг: история Binance для ${Object.values(fundingSources).filter((x) => x === 'binance').length} из ${done.length} инструментов, для остальных оценка ${costs.fundingBps} б.п. за 8 ч.`);
for (const [sym, t] of perSym) say(row(sym.replace(/USDT$/, ''), stats(t)));
say(row('ИТОГО', main.stats));
say(`В среднем ${perDay(main.stats.n)} сделки в день по всем монетам (${(main.stats.n / reportDays / Math.max(1, perSym.length)).toFixed(2)} на монету).`);
const group = (key) => { const g = {}; for (const t of main.trades) (g[t[key]] ??= []).push(t); return g; };
const byWhy = {};
for (const t of main.trades) byWhy[t.why] = (byWhy[t.why] ?? 0) + 1;
say(`\nЧем закончились сделки: ${Object.entries(byWhy).map(([k, v]) => `${WHY_RU[k] ?? k} ${v}`).join(', ') || '—'}`);
const byRegime = group('regime');
say('По режимам рынка:');
for (const [k, t] of Object.entries(byRegime)) say(`  ${row(REG_RU[k] ?? k, stats(t))}`);
const byVia = group('via');
say('По способу входа:');
for (const [k, t] of Object.entries(byVia)) say(`  ${row(k, stats(t))}`);

// счёт целиком: те же сделки, но с риском в % баланса и правилами защиты капитала — как у автоторговли
const startEq = cfg.risk.deposit > 0 ? cfg.risk.deposit : 10000;
const account = { protect: simulateAccount(main.trades, cfg.trade, { start: startEq }), plain: simulateAccount(main.trades, cfg.trade, { start: startEq, protect: false }) };
say(`\nСчёт целиком (риск ${cfg.trade.riskPct}% на сделку, плечо до ×${cfg.trade.leverage}, до ${cfg.trade.maxPositions} позиций):`);
say(`  с правилами защиты:  ${accountText(account.protect)}`);
say(`  без правил защиты:   ${accountText(account.plain)}`);

// сравнение способов входа на одних и тех же оценках: ретест (2.8), касание зоны (2.7), сразу по сигналу
let cmp = null;
if (compare) {
  say(`\nСравнение способов входа (порог ${main.thr}):\n${'способ'.padEnd(12)}${HEAD.slice(12)}`);
  cmp = CMP.map(([m, name]) => ({ m, name, st: stats(cmpRuns.get(m)) }));
  for (const x of cmp) say(row(x.name, x.st));
  const [rt, tc] = cmp;
  if (rt.st.n >= 10 && tc.st.n >= 10) {
    const better = rt.st.avgR > tc.st.avgR && (rt.st.pf ?? 0) >= (tc.st.pf ?? 0);
    say(`\n${better ? 'Вход на ретесте лучше прежнего' : 'Вход на ретесте на этих данных не лучше прежнего'}: в среднем ${rt.st.avgR.toFixed(2)}R против ${tc.st.avgR.toFixed(2)}R на сделку, PF ${pf(rt.st.pf)} против ${pf(tc.st.pf)}, сделок ${rt.st.n} против ${tc.st.n}.`);
  } else say('\nСделок мало для вывода — увеличьте период (--days 180) или добавьте монеты.');
}

const midpoint = (periodStart + reportEnd) / 2;
const halfStats = (tr) => ({ first: stats(tradesIn(tr, periodStart, midpoint)), second: stats(tradesIn(tr, midpoint, reportEnd)) });
const validation = grid ? walkForward(runs, { start: periodStart, end: periodEnd, stats }) : null;
if (grid) {
  say(`\nПеребор порога на первых 80% периода:\n${'порог'.padEnd(12)}${HEAD.slice(12)}`);
  for (const s of summary) say(row(String(s.thr), s.stats));
  const date = (at) => new Date(at).toISOString().slice(0, 10);
  const printTest = (label, x) => {
    const result = x.test ? `порог ${x.threshold}, ${x.test.n} сделок, ${x.test.sumR.toFixed(1)}R, PF ${pf(x.test.pf)}` : 'мало данных для выбора порога';
    say(`${label} ${date(x.from)} — ${date(x.to)} · ${result}`);
  };
  validation.folds.forEach((x, i) => printTest(`Окно ${i + 1}`, x));
  printTest('Финальная проверка', validation.holdout);
  if (validation.recommended != null) say(`Порог ${validation.recommended} прошёл все три окна. Кандидат для демо: THRESHOLD=${validation.recommended}.`);
  else say('Порог, прошедший все три окна, не подтверждён.');
}

const slim = (t) => { const { safeIdx, ...x } = t; return { ...x, entryTime: t.t0, exitTime: t.t1 }; };
const metadata = { days, reportDays, step, range: cfg.trade.range, costs, fundingSources, validation };
const json = (value) => JSON.stringify(value, (_, x) => x === Infinity ? 999 : x, 1);
fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
if (!jsonOut) {
  const out = path.join(dir, 'data', `backtest-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(out, json({ ...metadata, thresholds: summary.map((s) => ({ thr: s.thr, ...s.stats })), account, trades: main.trades.map(slim) }));
  say(`\nСделки сохранены в ${path.relative(dir, out)} · время ${Math.round((Date.now() - t0) / 1000)} с`);
}
if (main.trades.length) {
  say('\nПоследние сделки:');
  for (const t of [...main.trades].sort((a, b) => a.t0 - b.t0).slice(-8)) {
    say(`  ${new Date(t.t0).toISOString().slice(0, 13)} ${t.sym.replace(/USDT$/, '').padEnd(6)} ${t.side === 'BUY' ? 'покупка' : 'продажа'} ${fmt(t.entry)} → ${fmt(t.exit)} (${WHY_RU[t.why] ?? t.why}, ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R, ${t.via})`);
  }
}

// итог одним файлом — для самопроверки программы (lib/selftest.js) и панели
if (jsonOut) {
  const J = (st) => ({ ...st, pf: st.pf === Infinity ? 999 : st.pf });
  const mapStats = (g) => Object.fromEntries(Object.entries(g).map(([k, t]) => [k, J(stats(t))]));
  const result = {
    ...metadata, at: Date.now(), fast, symbols: done, stocks: done.filter(isStockSym).length, threshold: main.thr, entry: entryMode, feePct: cfg.risk.feePct,
    stats: J(main.stats), perDay: main.stats.n / reportDays, halves: (({ first, second }) => ({ first: J(first), second: J(second) }))(halfStats(main.trades)),
    byVia: mapStats(byVia), byRegime: mapStats(byRegime), bySymbol: Object.fromEntries(perSym.map(([sym, t]) => [sym, J(stats(t))])),
    compare: cmp ? Object.fromEntries(cmp.map((x) => [x.m, J(x.st)])) : null,
    account, risk: { riskPct: cfg.trade.riskPct, leverage: cfg.trade.leverage, maxPositions: cfg.trade.maxPositions },
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  const file = path.isAbsolute(jsonOut) ? jsonOut : path.join(dir, jsonOut);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json(result));
  fs.renameSync(tmp, file);
  say(`Итог записан в ${path.relative(dir, file)}`);
}
