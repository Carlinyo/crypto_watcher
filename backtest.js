#!/usr/bin/env node
// Бэктест: прогоняет анализ по истории и симулирует сделки по сигналам — с теми же правилами,
// что и журнал (стоп, цель 1 → половина и стоп в безубыток, цель 2, истечение, вход по зоне).
//
//   node backtest.js                          — монеты из сохранённого топа (или BTC, ETH, SOL), 90 дней
//   node backtest.js BTCUSDT SOLUSDT --days 180
//   node backtest.js --grid                   — перебрать пороги и подсказать лучший
//   флаги: --days N  --step K (анализ раз в K часов)  --fast (без 15m)  --threshold X
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
const { MacroCalendar } = await import('./lib/calendar.js');
const calendar = new MacroCalendar(path.join(dir, cfg.macro.file));

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const bool = (n) => { const i = args.indexOf(`--${n}`); if (i < 0) return false; args.splice(i, 1); return true; };
const days = Number(flag('days', 90));
const step = Math.max(1, Number(flag('step', 1)));
const baseThr = Number(flag('threshold', cfg.signal.threshold));
const grid = bool('grid');
const fast = bool('fast');
cfg.signal.threshold = baseThr;

let symbols = args.map((s) => s.toUpperCase());
if (!symbols.length) {
  try { symbols = JSON.parse(fs.readFileSync(path.join(dir, cfg.universe.cacheFile), 'utf8')).coins.map((c) => c.symbol); } catch { symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']; }
}
if (symbols.length > 1 && !symbols.includes('BTCUSDT')) symbols.unshift('BTCUSDT'); // контекст биткоина для альтов
const binance = new Binance(cfg);
const DAY = 86400e3, H = 3600e3;

async function history(symbol, interval, nDays) {
  const file = path.join(dir, 'data', 'history', `${symbol}-${interval}-${nDays}.json`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < 6 * H) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* нет кэша */ }
  const rows = await binance.klinesHistory(symbol, interval, Date.now() - nDays * DAY);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
}

// последняя закрытая к моменту t свеча (указатель двигается только вперёд)
function cursor(arr) {
  let k = -1;
  return (t) => { while (k + 1 < arr.length && arr[k + 1].closeTime <= t) k++; return k; };
}

function analyzeAt(sym, data, i, price, btcAt) {
  const t = data.h1[i].closeTime;
  const i4 = data.c4(t), iD = data.cD(t), i15 = data.c15 ? data.c15(t) : -1;
  const bundle = {
    symbol: sym, price, closedOnly: true, now: t,
    candles: {
      h1: data.h1.slice(Math.max(0, i - 499), i + 1),
      h4: i4 >= 0 ? data.h4.slice(Math.max(0, i4 - 499), i4 + 1) : null,
      d1: iD >= 0 ? data.d1.slice(Math.max(0, iD - 499), iD + 1) : null,
      m15: data.m15 && i15 >= 0 ? data.m15.slice(Math.max(0, i15 - 399), i15 + 1) : null,
    },
    btc: btcAt ? btcAt(t) : null,
    macro: { risk: calendar.risk(t), next: calendar.next(t) },
  };
  return analyze(bundle, cfg);
}

const compact = (r) => ({ score: r.score, agreement: r.agreement, completeness: r.completeness, regime: r.regime, plan: r.plan, core: r.core, trend: r.blocks.trend.score });

// ── симуляция сделок по сохранённым оценкам ───────────────────────────────
function simulate(sym, data, recs, thr, zoneCache) {
  const c = { ...cfg, signal: { ...cfg.signal, threshold: thr } };
  const feePct = (cfg.risk.feePct ?? 0.2) / 100;
  const expire = cfg.journal.expireHours;
  const trades = [];
  let open = null, zone = null, lastSig = -1e9;

  const close = (j, price, why) => {
    const s = open.side === 'BUY' ? 1 : -1;
    const risk = Math.abs(open.entry - open.initStop) || 1e-12;
    const rOf = (p) => ((p - open.entry) * s) / risk;
    let r = open.tp1 ? 0.5 * rOf(open.t1) + 0.5 * rOf(price) : rOf(price);
    r -= (open.entry * feePct) / risk;
    trades.push({ ...open, exitIdx: j, exit: price, why, r });
    open = null;
  };
  const openTrade = (j, side, entry, plan, via, rec) => {
    open = { sym, side, entryIdx: j, entry, stop: plan.stop, initStop: plan.stop, t1: plan.t1, t2: plan.t2, tp1: false, via, regime: rec.regime.key, score: rec.score };
    // если вход заметно хуже расчётного — стоп/цели остаются по плану (как в реальной жизни)
    if ((side === 'BUY' && entry <= plan.stop) || (side === 'SELL' && entry >= plan.stop)) open = null;
  };

  for (let j = data.start; j < data.h1.length; j++) {
    const bar = data.h1[j];
    if (open && j >= open.entryIdx) {
      const buy = open.side === 'BUY';
      const fav = buy ? bar.high : bar.low, adv = buy ? bar.low : bar.high;
      if (buy ? adv <= open.stop : adv >= open.stop) close(j, open.stop, open.trailed ? 'trail' : open.tp1 ? 'breakeven' : 'stop');
      else {
        if (!open.tp1 && (buy ? fav >= open.t1 : fav <= open.t1)) { open.tp1 = true; open.stop = open.entry; }
        if (open && open.tp1 && (buy ? fav >= open.t2 : fav <= open.t2)) close(j, open.t2, 'tp2');
        else if (open && open.tp1 && !open.trailed && (buy ? fav >= (open.t1 + open.t2) / 2 : fav <= (open.t1 + open.t2) / 2)) { open.trailed = true; open.stop = open.t1; }
        if (open && j - open.entryIdx >= expire) close(j, bar.close, 'expired');
      }
    }
    // вход по зоне: цена дошла до зоны «готовиться»
    if (!open && zone && j > zone.armed && j <= zone.until) {
      const hit = zone.dir === 'BUY' ? bar.low <= zone.high : bar.high >= zone.low;
      if (hit) {
        const px = zone.dir === 'BUY' ? Math.min(bar.open, zone.high) : Math.max(bar.open, zone.low);
        const key = `${j}:${px}`;
        let rz = zoneCache.get(key);
        if (!rz) { rz = compact(analyzeAt(sym, data, j - 1, px, data.btcAt)); zoneCache.set(key, rz); }
        const d = decide({ ...rz.core, score: rz.score, agreement: rz.agreement, completeness: rz.completeness, regime: rz.regime, plan: rz.plan }, c);
        const dirOk = zone.dir === 'BUY' ? rz.score > 0 : rz.score < 0;
        if (dirOk && Math.abs(rz.score) >= d.threshold * cfg.signal.zoneTriggerRatio && rz.plan.rrNow >= cfg.signal.minRiskReward && !d.warnings.length) {
          openTrade(j, zone.dir, px, rz.plan, 'зона', rz);
          lastSig = j;
          // после входа внутри свечи проверяем только стоп (консервативно)
          if (open && (zone.dir === 'BUY' ? bar.low <= open.stop : bar.high >= open.stop)) close(j, open.stop, 'stop');
        }
        zone = null;
      }
    }
    const rec = recs.get(j);
    if (!rec) continue;
    const d = decide({ ...rec.core, score: rec.score, agreement: rec.agreement, completeness: rec.completeness, regime: rec.regime, plan: rec.plan }, c);
    if (d.action === 'BUY' || d.action === 'SELL') {
      if (open && open.side === d.action) continue;
      if (open) close(j, bar.close, 'reversed');
      if (j - lastSig >= 2 && j + 1 < data.h1.length) { openTrade(j + 1, d.action, data.h1[j + 1].open, rec.plan, 'сигнал', rec); lastSig = j; zone = null; }
    } else if (d.action.startsWith('WATCH') && d.zoneOk && !open) {
      zone = { dir: rec.plan.dir, low: rec.plan.zone[0], high: rec.plan.zone[1], armed: j, until: j + cfg.signal.zoneValidHours };
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
  for (const t of [...trades].sort((a, b) => a.exitIdx - b.exitIdx)) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return {
    n, wins, losses, winRate: wins + losses ? wins / (wins + losses) : null, tp1: n ? trades.filter((t) => t.tp1).length / n : null,
    avgR: n ? sumR / n : null, sumR, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : null, maxDD: dd,
  };
}

const pad = (s, n) => String(s).padStart(n);
const pf = (x) => (x == null ? '—' : x === Infinity ? '∞' : x.toFixed(2));
const row = (name, s) => `${name.padEnd(12)}${pad(s.n, 7)}${pad(s.winRate == null ? '—' : `${(s.winRate * 100).toFixed(0)}%`, 8)}${pad(s.tp1 == null ? '—' : `${(s.tp1 * 100).toFixed(0)}%`, 8)}${pad(s.avgR == null ? '—' : s.avgR.toFixed(2), 8)}${pad(s.sumR.toFixed(1), 9)}${pad(pf(s.pf), 7)}${pad(s.maxDD.toFixed(1), 10)}`;
const HEAD = `${'монета'.padEnd(12)}${pad('сделок', 7)}${pad('успех', 8)}${pad('цель1', 8)}${pad('ср. R', 8)}${pad('сумма R', 9)}${pad('PF', 7)}${pad('просадка', 10)}`;
const WHY_RU = { stop: 'стоп', breakeven: 'цель 1 → безубыток', trail: 'цель 1 → подтянутый стоп', tp2: 'цель 2', expired: 'истекло время', reversed: 'обратный сигнал' };
const REG_RU = { trend_up: 'восх. тренд', trend_down: 'нисх. тренд', range: 'боковик', squeeze: 'сжатие', volatile: 'волатильно', transition: 'переходный' };

// ── прогон ────────────────────────────────────────────────────────────────
console.log(`Бэктест: ${symbols.join(', ')} | ${days} дн. | анализ каждые ${step} ч | порог ${baseThr}${fast ? ' | без 15m' : ''}`);
console.log('Загрузка истории (кэшируется в data/history)…');
const all = new Map();
const btcScores = new Map();
let btcData = null;
const t0 = Date.now();

for (const sym of symbols) {
  let data;
  try {
    const [h1, h4, d1, m15] = await Promise.all([
      history(sym, '1h', days + 25), history(sym, '4h', days + 90), history(sym, '1d', days + 400),
      fast ? Promise.resolve(null) : history(sym, '15m', days + 5),
    ]);
    data = { h1, h4, d1, m15, c4: cursor(h4), cD: cursor(d1), c15: m15 ? cursor(m15) : null };
  } catch (e) { console.error(`${sym}: не удалось загрузить историю — ${e.message}`); continue; }
  if (data.h1.length < 600) { console.error(`${sym}: мало истории (${data.h1.length} ч) — пропускаю`); continue; }
  const startT = Date.now() - days * DAY;
  data.start = Math.max(500, data.h1.findIndex((c) => c.time >= startT));
  if (sym !== 'BTCUSDT' && btcData) {
    const btcH1 = btcData.h1;
    const cb = cursor(btcH1);
    data.btcAt = (t) => {
      const k = cb(t);
      if (k < 60) return null;
      const s = btcScores.get(btcH1[k].closeTime);
      return { h1: btcH1.slice(Math.max(0, k - 499), k + 1), trend: s?.trend ?? 0, score: s?.score ?? 0 };
    };
  }
  const recs = new Map();
  const total = Math.ceil((data.h1.length - data.start) / step);
  let done = 0, lastLog = Date.now();
  for (let i = data.start; i < data.h1.length - 1; i += step) {
    const r = analyzeAt(sym, data, i, data.h1[i].close, data.btcAt);
    recs.set(i, compact(r));
    if (sym === 'BTCUSDT') btcScores.set(data.h1[i].closeTime, { score: r.score, trend: r.blocks.trend.score });
    if (++done && Date.now() - lastLog > 5000) { lastLog = Date.now(); process.stdout.write(`  ${sym}: ${Math.round((done / total) * 100)}%\r`); }
  }
  if (sym === 'BTCUSDT') btcData = data;
  all.set(sym, { data, recs, zoneCache: new Map() });
  console.log(`  ${sym}: проанализировано ${done} точек`);
}

const thresholds = grid ? [0.25, 0.28, 0.3, 0.33, 0.36, 0.4, 0.45, 0.5] : [baseThr];
const summary = [];
for (const thr of thresholds) {
  const per = [];
  for (const [sym, x] of all) per.push([sym, simulate(sym, x.data, x.recs, thr, x.zoneCache)]);
  const allTrades = per.flatMap(([, t]) => t);
  summary.push({ thr, stats: stats(allTrades), per, trades: allTrades });
}

const main = summary.find((s) => s.thr === baseThr) ?? summary[0];
console.log(`\nРезультаты при пороге ${main.thr} (комиссия ${cfg.risk.feePct}% учтена):\n${HEAD}`);
for (const [sym, t] of main.per) console.log(row(sym.replace(/USDT$/, ''), stats(t)));
console.log(row('ИТОГО', main.stats));
const byWhy = {};
for (const t of main.trades) byWhy[t.why] = (byWhy[t.why] ?? 0) + 1;
console.log(`\nЧем закончились сделки: ${Object.entries(byWhy).map(([k, v]) => `${WHY_RU[k] ?? k} ${v}`).join(', ') || '—'}`);
const byRegime = {};
for (const t of main.trades) (byRegime[t.regime] ??= []).push(t);
console.log('По режимам рынка:');
for (const [k, t] of Object.entries(byRegime)) console.log(`  ${row(REG_RU[k] ?? k, stats(t))}`);
const byVia = {};
for (const t of main.trades) (byVia[t.via] ??= []).push(t);
console.log('По способу входа:');
for (const [k, t] of Object.entries(byVia)) console.log(`  ${row(k, stats(t))}`);

if (grid) {
  console.log(`\nПеребор порога:\n${'порог'.padEnd(12)}${HEAD.slice(12)}`);
  for (const s of summary) console.log(row(String(s.thr), s.stats));
  const ok = summary.filter((s) => s.stats.n >= 10 && s.stats.pf != null && s.stats.pf >= 1.2);
  const best = [...(ok.length ? ok : summary)].sort((a, b) => b.stats.sumR - a.stats.sumR)[0];
  console.log(`\nЛучший итог за весь период: порог ${best.thr} (сумма ${best.stats.sumR.toFixed(1)}R, PF ${pf(best.stats.pf)}, сделок ${best.stats.n}).`);

  // проверка на новых данных: подбираем порог по первой половине периода, проверяем на второй
  const split = (s) => {
    const first = [], second = [];
    for (const t of s.trades) {
      const d = all.get(t.sym).data;
      const mid = d.start + Math.floor((d.h1.length - d.start) / 2);
      (t.entryIdx < mid ? first : second).push(t);
    }
    return { first: stats(first), second: stats(second) };
  };
  const halves = summary.map((s) => ({ thr: s.thr, ...split(s) }));
  const okIn = halves.filter((h) => h.first.n >= 5);
  const pick = [...(okIn.length ? okIn : halves)].sort((a, b) => b.first.sumR - a.first.sumR)[0];
  console.log(`\nПроверка на новых данных (подбор на первой половине периода, проверка на второй):`);
  console.log(`${'порог'.padEnd(12)}${'1-я половина'.padStart(22)}${'2-я половина'.padStart(24)}`);
  for (const h of halves) console.log(`${String(h.thr).padEnd(12)}${`${h.first.n} сд. ${h.first.sumR.toFixed(1)}R PF ${pf(h.first.pf)}`.padStart(22)}${`${h.second.n} сд. ${h.second.sumR.toFixed(1)}R PF ${pf(h.second.pf)}`.padStart(24)}`);
  // честная проверка: прибыль на второй половине должна быть не случайной (PF ≥ 1.1 и хотя бы 5 сделок)
  const pf2 = pick.second.pf ?? 0, pf1 = pick.first.pf ?? 0;
  const holds = pick.second.n >= 5 && pick.second.sumR > 0 && pf2 >= 1.1;
  const weaker = holds && pf1 !== Infinity && pf2 < 1 + (pf1 - 1) * 0.5;
  console.log(`\nПорог ${pick.thr}, выбранный по первой половине, на второй: ${pick.second.n} сделок, ${pick.second.sumR.toFixed(1)}R, PF ${pf(pick.second.pf)} — ${!holds ? 'на новых данных не подтвердился ✗ (возможно, подгонка под историю)' : weaker ? 'держится, но заметно слабее, чем на истории (часть результата — подгонка)' : 'результат держится ✓'}.`);
  // самый устойчивый порог: лучший худший PF из двух половин (по 10+ сделок в каждой)
  const minPf = (h) => Math.min(h.first.pf ?? 0, h.second.pf ?? 0);
  const both = halves.filter((h) => h.first.n >= 10 && h.second.n >= 10).sort((a, b) => minPf(b) - minPf(a));
  const stable = both[0];
  if (stable) console.log(`Устойчивее всего (работает в обеих половинах, по 10+ сделок): порог ${stable.thr} — PF ${pf(stable.first.pf)} и ${pf(stable.second.pf)}.`);
  const def = cfg.signal.threshold;
  if (stable && minPf(stable) >= 1.15) console.log(`Рекомендация: THRESHOLD=${stable.thr} в .env${stable.thr === def ? ' (это и есть значение по умолчанию)' : ''}.`);
  else console.log(`Рекомендация: ни один порог не даёт устойчивого преимущества на этих данных — оставьте ${def} и проверьте на более длинном периоде (--days 365).`);
}

const out = path.join(dir, 'data', `backtest-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ days, step, thresholds: summary.map((s) => ({ thr: s.thr, ...s.stats })), trades: main.trades.map((t) => ({ ...t, entryTime: all.get(t.sym).data.h1[t.entryIdx]?.time, exitTime: all.get(t.sym).data.h1[t.exitIdx]?.time })) }, null, 1));
console.log(`\nСделки сохранены в ${path.relative(dir, out)} · время ${Math.round((Date.now() - t0) / 1000)} с`);
if (main.trades.length) {
  console.log('\nПоследние сделки:');
  const tOf = (t) => all.get(t.sym).data.h1[t.entryIdx]?.time ?? 0;
  for (const t of [...main.trades].sort((a, b) => tOf(a) - tOf(b)).slice(-8)) {
    const d = all.get(t.sym).data.h1;
    console.log(`  ${new Date(d[t.entryIdx].time).toISOString().slice(0, 13)} ${t.sym.replace(/USDT$/, '').padEnd(6)} ${t.side === 'BUY' ? 'покупка' : 'продажа'} ${fmt(t.entry)} → ${fmt(t.exit)} (${WHY_RU[t.why] ?? t.why}, ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R, ${t.via})`);
  }
}
