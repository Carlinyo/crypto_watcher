import test from 'node:test';
import assert from 'node:assert/strict';
import cfg from '../config.js';
import { decide } from '../lib/analyzer.js';
import { rangeSetup } from '../lib/range.js';
import { executionCosts, lastClosedIndex, walkForward } from '../lib/backtest-metrics.js';
import { Decisions } from '../lib/decisions.js';
import { scanHealthy } from '../lib/server.js';

const H = 3600e3;
const now = 100 * H;
const shape = [95.5, 97, 99, 101, 103, 104.5, 104.5, 103, 101, 99, 97, 95.5];
const bars = shape.concat(shape, shape, shape).map((close, i) => ({
  close, low: close - 0.5, high: close + 0.5, time: (i + 52) * H, closeTime: (i + 53) * H - 1,
}));
const candle = (open, high, low, close) => ({
  open, high, low, close, time: now, closeTime: now + H / 4 - 1,
});
const geometry = (price, m15, regime = 'range') => rangeSetup({
  h1: bars, m15: [m15], atr: 2, price, regime: { key: regime }, now: now + H / 4, feePct: 0.2,
});

test('Боковик: входы от обеих границ после закрытой свечи, без входа из середины и на пробое', () => {
  const buy = geometry(96, candle(95.4, 96.3, 94.9, 96));
  const sell = geometry(104, candle(104.6, 105.1, 103.8, 104));
  assert.equal(buy.low, 95);
  assert.equal(sell.high, 105);
  assert.equal(buy.plan.dir, 'BUY');
  assert.equal(sell.plan.dir, 'SELL');
  assert.ok(buy.plan.stop < buy.low && sell.plan.stop > sell.high);
  assert.equal(buy.plan.t1, 100);
  assert.ok(buy.plan.t2 < buy.high && sell.plan.t2 > sell.low);
  assert.equal(geometry(100, candle(95.4, 100, 94.9, 100)).plan, null);
  assert.equal(geometry(96, candle(95.4, 96.3, 92, 96)).plan, null);
  assert.equal(geometry(96, candle(95.4, 96.3, 94.9, 96), 'trend_down'), null);
  const live = candle(95.4, 96.3, 94.9, 96);
  assert.equal(geometry(96, { ...live, closeTime: now + H }).plan, null);
});

test('Боковик: стратегия включается отдельно и соблюдает фильтр макрособытий', () => {
  const range = geometry(96, candle(95.4, 96.3, 94.9, 96));
  const inputs = { score: 0.01, agreement: 0.8, completeness: 1, htf: 0, isBtc: true, plan: range.plan, range };
  const enabled = { ...cfg, trade: { ...cfg.trade, range: true } };
  assert.equal(decide(inputs, cfg).action, 'NEUTRAL');
  assert.equal(decide(inputs, enabled).action, 'BUY');
  assert.equal(decide({ ...inputs, macro: { phase: 'before', minutesTo: 15, name: 'FOMC' } }, enabled).action, 'NEUTRAL');
  assert.equal(decide({ ...inputs, htf: -0.7 }, enabled).action, 'NEUTRAL');
});

test('Воронка группирует повторные проверки по эпизодам и учитывает исполнение', () => {
  const decisions = new Decisions();
  const signal = { sym: 'BTCUSDT', dir: 'BUY' };
  const id = decisions.stage(signal, 'candidate', now);
  assert.equal(decisions.stage(signal, 'candidate', now + 1000), id);
  decisions.stage({ ...signal, id }, 'qualified', now + 1000);
  decisions.stage({ ...signal, id }, 'entry', now + 3000);
  decisions.stage({ ...signal, id }, 'opened', now + 4000);
  decisions.stage({ sym: 'SOLUSDT', dir: 'SELL' }, 'candidate', now + 1000);
  assert.deepEqual(decisions.funnel(now + 5000), { candidate: 2, qualified: 1, entry: 1, opened: 1 });
});

test('Health: полностью неудачный цикл возвращает нездоровый статус', () => {
  const state = { startedAt: 1000, lastCycleAt: 1500, maxAgeMs: 1000, now: 1600 };
  assert.equal(scanHealthy({ ...state, lastScan: { analyzed: 0, closed: 0, errors: 10 } }), false);
  assert.equal(scanHealthy({ ...state, lastScan: { analyzed: 1, closed: 0, errors: 9 } }), true);
  assert.equal(scanHealthy({ ...state, lastScan: { analyzed: 0, closed: 3, errors: 0 } }), true);
  assert.equal(scanHealthy({ ...state, lastScan: { analyzed: 1, closed: 0, errors: 0 }, now: 2600 }), false);
});

test('Бэктест: учитываются комиссия, исполнение и знак фандинга с учётом частичного выхода', () => {
  const trade = { side: 'BUY', entry: 100, target1: 102, exit: 104, why: 'tp2',
    t0: 0, tp1: true, tp1At: 9 * H, t1: 17 * H };
  const options = { feePct: 0.2, spreadBps: 4, slippageBps: 3, fundingBps: 1, tp1Share: 0.5,
    funding: [{ time: 8 * H, price: 100, rate: 0.001 }, { time: 16 * H, price: 100, rate: 0.001 }] };
  const cost = executionCosts(trade, options);
  assert.ok(Math.abs(cost.fee - 0.203) < 1e-12);
  assert.equal(cost.spread, 0.02);
  assert.ok(Math.abs(cost.slippage - 0.03) < 1e-12);
  assert.ok(Math.abs(cost.funding - 0.15) < 1e-12);
  assert.equal(executionCosts({ ...trade, side: 'SELL' }, options).funding, -cost.funding);
  assert.equal(executionCosts(trade, { ...options, funding: null }).funding, 0.015);
});

test('Бэктест: финальное окно проверяет выбранный заранее порог', () => {
  const make = (start, n, r) => Array.from({ length: n }, (_, i) => ({ t0: start + i, t1: start + i + 0.5, r }));
  const runs = new Map([
    [0.3, [...make(1, 20, 1), ...make(41, 7, 1), ...make(61, 7, 1), ...make(81, 7, -1), { t0: 75, t1: 90, r: -100 }]],
    [0.5, [...make(1, 20, 0.1), ...make(81, 9, 100)]],
  ]);
  const stats = (trades) => ({
    n: trades.length, sumR: trades.reduce((s, t) => s + t.r, 0), maxDD: 0,
    pf: trades.every((t) => t.r > 0) ? Infinity : 0,
  });
  const result = walkForward(runs, { start: 0, end: 100, stats });
  assert.deepEqual(result.folds.map((f) => f.threshold), [0.3, 0.3]);
  assert.equal(result.holdout.threshold, 0.3);
  assert.equal(result.holdout.test.sumR, -7);
  assert.equal(result.recommended, null);
});

test('Бэктест: ретест при возврате назад получает только закрытые к тому моменту свечи', () => {
  const candles = [100, 200, 300, 400].map((closeTime) => ({ closeTime }));
  assert.equal(lastClosedIndex(candles, 400), 3);
  assert.equal(lastClosedIndex(candles, 250), 1);
  assert.equal(lastClosedIndex(candles, 99), -1);
  assert.equal(lastClosedIndex(candles, 300), 2);
});
