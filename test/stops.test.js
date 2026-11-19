// 🛡 Надёжный стоп для сильного сигнала — на примере сделки SPCX с графика:
// вход ~144.5 на ретесте, стоп программы 143.3 (за уровнем), основание пробоя 142.0–142.6, минимум суток 141.38,
// цели 147.61 и 155.38. Прокол до ~143.0 выбил бы короткий стоп; стоп за основанием пробоя выдержал.
import test from 'node:test';
import assert from 'node:assert/strict';
import { widenStop, isStrongSignal } from '../lib/stops.js';
import { finalStop } from '../lib/entry.js';
import { Bybit } from '../lib/bybit.js';
import { Trader } from '../lib/trader.js';
import { MockBybit } from './bybit-mock.js';
import { selfTestLines } from '../lib/selftest.js';
import cfg from '../config.js';

const ATR = 0.9;
const plan = (o = {}) => ({ dir: 'BUY', entry: 144.5, entryNow: 144.5, stop: 143.3, t1: 147.61, t2: 155.38, zone: [143.6, 144.6], rr: 2.5, rrNow: 2.5, notes: [], size: { qty: 1 }, ...o });
const supports = [
  { low: 143.6, high: 144.1, strength: 2.1 }, // уровень входа (пробитое сопротивление) — за ним обычный стоп
  { low: 142.0, high: 142.6, strength: 1.6 }, // основание пробоя (синяя линия)
  { low: 138.5, high: 139.0, strength: 1.2 }, // далёкая поддержка — дальше 4 ATR
];
const h1 = [...Array(23)].map((_, i) => ({ low: 142.2 + (i % 5) * 0.3, high: 143.5 + (i % 5) * 0.3 })).concat([{ low: 141.38, high: 143.9 }]); // минимум суток 141.38 (зелёная)
const risk = { feePct: 0.11, deposit: 1000, riskPct: 2 };

test('Надёжный стоп: как на графике SPCX — за основанием пробоя; позиция меньше, риск в $ тот же', () => {
  const w = widenStop(plan(), { atr: ATR, supports, h1, minRR: 1.5, risk });
  assert.equal(w.moved, true);
  assert.equal(w.kind, 'support');
  assert.ok(Math.abs(w.plan.stop - (142.0 - 0.25 * ATR)) < 1e-9, `стоп ${w.plan.stop} — под основанием 142.0`);
  assert.equal(w.plan.stopTight, 143.3);
  assert.ok(w.plan.rr >= 1 && w.plan.rr < 1.3, `до цели 1 ${w.plan.rr}`);
  assert.ok(Math.abs(w.plan.size.riskUsd - 20) < 1e-9, 'риск $20 (2% от $1000) — как и был');
  assert.ok(w.plan.size.qty < 20 / (144.5 - 143.3), 'позиция меньше, чем с коротким стопом');
  assert.match(w.plan.notes.at(-1), /сильный сигнал — стоп вынесен за поддержкой 142\.00–142\.60 \(был 143\.30\); позиция меньше, риск в \$ тот же/);
  assert.match(w.plan.invalidation, /ниже 141\.78/);
  // зелёная линия (минимум суток 141.38) — дальше, но до цели 1 тогда прибыль меньше риска → не берём
  // а если цель 1 дальше — берём самый дальний надёжный вариант: за минимумом суток
  const far = widenStop(plan({ t1: 149 }), { atr: ATR, supports, h1, minRR: 1.5, risk });
  assert.equal(far.kind, 'swing');
  assert.ok(Math.abs(far.plan.stop - (141.38 - 0.2 * ATR)) < 1e-9);
  assert.match(far.why, /за минимумом суток 141\.38/);
});

test('Надёжный стоп: дальше 4 ATR и без опор — стоп остаётся; продажа — зеркально', () => {
  assert.equal(widenStop(plan(), { atr: 0.4, supports, h1, minRR: 1.5, risk }).moved, false, 'опоры дальше 4 ATR — не выносим');
  assert.equal(widenStop(plan(), { atr: ATR, supports: [], h1: null, minRR: 1.5, risk }).moved, false);
  assert.equal(widenStop(plan({ t2: 146 }), { atr: ATR, supports, h1, minRR: 1.5, risk }).moved, false, 'до цели 2 мало места — не выносим');
  const sell = { dir: 'SELL', entry: 100, entryNow: 100, stop: 101, t1: 97, t2: 92, notes: [], size: null };
  const w = widenStop(sell, { atr: 0.8, resistances: [{ low: 101.8, high: 102.3, strength: 1.4 }], h1: [{ high: 102.9, low: 99 }], minRR: 1.5, risk });
  assert.equal(w.moved, true);
  assert.ok(w.plan.stop > 102.3, `стоп над сопротивлением: ${w.plan.stop}`);
});

test('Когда выносить: сильный сигнал — да, обычный — нет; TRADE_WIDE_STOP=all/off; боковик — свой стоп', () => {
  assert.equal(isStrongSignal({ score: 0.6 }), true);
  assert.equal(isStrongSignal({ score: -0.58 }), true);
  assert.equal(isStrongSignal({ score: 0.4, confidence: 72 }), true);
  assert.equal(isStrongSignal({ score: 0.4, confidence: 50 }), false);
  const z = { dir: 'BUY', level: { role: 'breakout', low: 143.6, high: 144.1 } };
  const r = (score) => ({ score, confidence: 40, price: 144.5, stats: { atr: ATR }, regime: { stopMult: 1 }, levels: { supports } });
  const o = { h1, minRR: 1.5, risk };
  assert.equal(finalStop(z, r(0.62), plan(), o).moved, true);
  assert.equal(finalStop(z, r(0.4), plan(), o).moved, false, 'обычный сигнал — стоп за уровнем');
  assert.equal(finalStop(z, r(0.4), plan(), { ...o, wideStop: 'all' }).moved, true);
  assert.equal(finalStop(z, r(0.9), plan(), { ...o, wideStop: 'off' }).moved, false);
  assert.equal(finalStop({ ...z, level: { role: 'range' } }, r(0.9), plan(), o).moved, false, 'боковик — стоп за границей боковика');
  assert.equal(cfg.trade.wideStop, 'strong');
});

test('Bybit: сделка с надёжным стопом не отсекается проверкой прибыль/риск (считается по двум целям)', async () => {
  const ex = new MockBybit({ prices: { SOLUSDT: 144.5 } });
  const c = structuredClone(cfg);
  Object.assign(c.trade, { enabled: true, apiKey: ex.apiKey, apiSecret: ex.apiSecret, mode: 'demo' });
  const client = new Bybit({ apiKey: ex.apiKey, apiSecret: ex.apiSecret, mode: 'demo', fetchImpl: ex.fetch });
  const t = new Trader(c, { file: null, client, onEvent: () => {}, log: () => {} });
  await t.init();
  const w = widenStop(plan(), { atr: ATR, supports, h1, minRR: 1.5, risk });
  const sig = { symbol: 'SOLUSDT', action: 'BUY', price: 144.5, score: 0.62, confidence: 70, plan: { ...w.plan, zone: [144.5, 144.5] } };
  const res = await t.onSignal(sig, { zone: true });
  assert.equal(res.status, 'opened', res.reason);
  assert.ok(Math.abs(res.trade.stop - w.plan.stop) < 0.02, 'на бирже — надёжный стоп');
  // тот же стоп без пометки «надёжный» — прибыль/риск до цели 1 мал, сделки нет (как и раньше)
  const ex2 = new MockBybit({ prices: { SOLUSDT: 144.5 } });
  const c2 = structuredClone(c);
  Object.assign(c2.trade, { apiKey: ex2.apiKey, apiSecret: ex2.apiSecret });
  const t2 = new Trader(c2, { file: null, client: new Bybit({ apiKey: ex2.apiKey, apiSecret: ex2.apiSecret, mode: 'demo', fetchImpl: ex2.fetch }), onEvent: () => {}, log: () => {} });
  await t2.init();
  const { stopTight, ...noMark } = w.plan;
  assert.ok(stopTight);
  const r2 = await t2.onSignal({ ...sig, symbol: 'SOLUSDT', plan: { ...noMark, zone: [144.5, 144.5] } }, { zone: true });
  assert.equal(r2.code, 'low R:R', r2.reason);
});

test('Самопроверка показывает, что дал надёжный стоп на истории', () => {
  const st = (o) => ({ n: 40, wins: 20, winRate: 0.5, avgR: 0.2, sumR: 8, pf: 1.4, ...o });
  const res = { at: Date.now(), days: 60, symbols: ['A'], stats: st(), compare: { retest: st({ avgR: 0.24, winRate: 0.52 }), touch: st(), tightstop: st({ avgR: 0.11, winRate: 0.41 }) } };
  assert.ok(selfTestLines(res).includes('Надёжный стоп у сильных сигналов против стопа сразу у уровня: +0.24R против +0.11R на сделку, в плюс 52% против 41%.'));
});
