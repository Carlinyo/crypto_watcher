// v2.9 — защита капитала: суммарный риск, сделки в одну сторону, серия убытков, недельный лимит,
// просадка от максимума, пауза по монете после убытка, ранний безубыток, меньший риск в волатильном рынке.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bybit } from '../lib/bybit.js';
import { Trader } from '../lib/trader.js';
import { MockBybit } from './bybit-mock.js';
import { validateConfig } from '../lib/validate.js';
import { tradeEventMessage } from '../lib/report.js';
import cfg from '../config.js';

const PRICES = { BTCUSDT: 60000, ETHUSDT: 3000, SOLUSDT: 150, XRPUSDT: 0.5, DOGEUSDT: 0.1 };
const mk = (tradeOpts = {}) => {
  const ex = new MockBybit({ prices: { ...PRICES } });
  const c = structuredClone(cfg);
  Object.assign(c.trade, { enabled: true, apiKey: ex.apiKey, apiSecret: ex.apiSecret, mode: 'demo', maxPositions: 5 }, tradeOpts);
  const events = [];
  const client = new Bybit({ apiKey: ex.apiKey, apiSecret: ex.apiSecret, mode: 'demo', fetchImpl: ex.fetch });
  const t = new Trader(c, { file: null, client, onEvent: (e) => events.push(e), log: () => {} });
  return { ex, t, events };
};
const sig = (symbol, action, price, stop, t1, t2, extra = {}) => ({ symbol, action, price, score: action === 'BUY' ? 0.5 : -0.5, confidence: 70, plan: { dir: action, stop, t1, t2, zone: [price, price], rrNow: 2 }, ...extra });
const H = 3600e3;
const closed = (symbol, r, agoH = 1, riskUsd = 200) => ({ id: `x${Math.random()}`, symbol, side: 'Buy', status: 'closed', openedAt: Date.now() - (agoH + 2) * H, closedAt: Date.now() - agoH * H, pnl: r * riskUsd, r, riskUsd });
const btc = () => sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000);

test('Защита: суммарный риск открытых сделок ограничен — третья сделка меньше, четвёртой нет', async () => {
  const { t } = mk({ maxSameSide: 0, maxOpenRiskPct: 5, leverage: 10 });
  await t.init();
  const a = await t.onSignal(btc());
  const b = await t.onSignal(sig('ETHUSDT', 'BUY', 3000, 2950, 3080, 3150));
  assert.equal(a.status, 'opened', a.reason);
  assert.equal(b.status, 'opened', b.reason);
  const c = await t.onSignal(sig('SOLUSDT', 'BUY', 150, 147, 155, 158));
  assert.equal(c.status, 'opened', c.reason);
  const sum = a.trade.riskUsd + b.trade.riskUsd + c.trade.riskUsd;
  assert.ok(c.trade.riskUsd < a.trade.riskUsd * 0.75 && sum <= 500.5 && sum > 480, `третьей сделке достался остаток лимита $500: ${c.trade.riskUsd}, всего ${sum}`);
  assert.match(c.trade.warnings.join(' '), /суммарный риск открытых сделок ограничен 5% баланса/);
  const d = await t.onSignal(sig('XRPUSDT', 'BUY', 0.5, 0.49, 0.52, 0.53));
  assert.equal(d.code, 'open risk');
  // сделка со стопом в безубытке риска уже не несёт — место освобождается
  a.trade.beDone = true;
  assert.equal((await t.onSignal(sig('XRPUSDT', 'BUY', 0.5, 0.49, 0.52, 0.53))).status, 'opened');
  assert.ok(t.riskStatus().openRiskPct <= 5.01);
});

test('Защита: не больше двух сделок в одну сторону', async () => {
  const { t } = mk();
  await t.init();
  await t.onSignal(btc());
  await t.onSignal(sig('ETHUSDT', 'BUY', 3000, 2950, 3080, 3150));
  const c = await t.onSignal(sig('SOLUSDT', 'BUY', 150, 147, 155, 158));
  assert.equal(c.code, 'same side');
  assert.match(c.reason, /монеты ходят вместе/);
  assert.equal((await t.onSignal(sig('SOLUSDT', 'SELL', 150, 153, 145, 142))).status, 'opened', 'в обратную сторону можно');
});

test('Защита: серия убытков — после двух риск вдвое меньше, после трёх пауза на 12 часов', async () => {
  const { t, events } = mk();
  await t.init();
  t.state.trades.push(closed('SOLUSDT', -1, 30), closed('XRPUSDT', -1, 20));
  assert.equal(t.lossStreak().n, 2);
  const a = await t.onSignal(btc());
  assert.equal(a.status, 'opened');
  assert.ok(a.trade.riskUsd < 105 && a.trade.riskUsd > 80, `риск вдвое меньше: ${a.trade.riskUsd}`);
  assert.match(a.trade.warnings.join(' '), /риск уменьшен вдвое/);
  t.state.trades.push(closed('DOGEUSDT', -1, 2));
  const b = await t.onSignal(sig('ETHUSDT', 'SELL', 3000, 3060, 2900, 2800));
  assert.equal(b.code, 'loss streak');
  assert.match(b.reason, /3 убыточных сделок подряд — пауза ещё 10 ч/);
  assert.equal(events.filter((e) => e.type === 'risk' && e.key === 'streak').length, 1);
  await t.onSignal(sig('ETHUSDT', 'SELL', 3000, 3060, 2900, 2800));
  assert.equal(events.filter((e) => e.type === 'risk').length, 1, 'письмо о паузе — одно');
  // пауза прошла; прибыльная сделка обнуляет серию, сделка «в ноль» — нет
  t.state.trades.find((x) => x.symbol === 'DOGEUSDT').closedAt -= 12 * H;
  assert.notEqual((await t.onSignal(sig('ETHUSDT', 'SELL', 3000, 3060, 2900, 2800))).code, 'loss streak');
  t.state.trades.push(closed('XRPUSDT', -0.05, 0.5));
  assert.equal(t.lossStreak().n, 3);
  t.state.trades.push(closed('XRPUSDT', 1.5, 0.2));
  assert.equal(t.lossStreak().n, 0);
});

test('Защита: недельный лимит убытка и пауза по монете после убытка', async () => {
  const { t, events } = mk({ lossStreakPause: 0 });
  await t.init();
  t.state.trades.push(closed('BTCUSDT', -1, 3));
  const a = await t.onSignal(btc());
  assert.equal(a.code, 'cooldown');
  assert.match(a.reason, /не вхожу ещё 3 ч/);
  assert.equal((await t.onSignal(sig('ETHUSDT', 'BUY', 3000, 2950, 3080, 3150))).status, 'opened', 'другая монета — можно');
  t.state.trades.find((x) => x.symbol === 'BTCUSDT').closedAt -= 4 * H;
  assert.notEqual((await t.onSignal(btc())).code, 'cooldown');

  const w = mk({ lossStreakPause: 0, cooldownHours: 0 });
  await w.t.init();
  w.t.state.trades.push(closed('SOLUSDT', -2, 50, 250), closed('XRPUSDT', -2, 100, 250), closed('DOGEUSDT', 1, 60, 100), closed('ETHUSDT', -3, 200, 300));
  assert.equal(w.t.weekPnl(), -900, 'сделка 8 дней назад не в счёт');
  assert.notEqual((await w.t.onSignal(btc())).code, 'weekly loss limit');
  w.t.state.trades.push(closed('DOGEUSDT', -1, 5, 150));
  const r = await w.t.onSignal(sig('ETHUSDT', 'BUY', 3000, 2950, 3080, 3150));
  assert.equal(r.code, 'weekly loss limit');
  assert.ok(w.events.some((e) => e.type === 'risk' && e.key === 'weekly'));
  assert.equal(events.length >= 0, true);
});

test('Защита: просадка 15% от максимума баланса — полная остановка до снятия паузы', async () => {
  const { t, events } = mk();
  await t.init();
  assert.equal(t.checkPeak({ equity: 10000 }), false);
  assert.equal(t.checkPeak({ equity: 12000 }), false);
  assert.equal(t.state.peakEquity, 12000);
  assert.equal(t.checkPeak({ equity: 10500 }), false, '−12.5% — ещё работает');
  assert.equal(t.checkPeak({ equity: 10100 }), true, '−15.8% — стоп');
  const ev = events.find((e) => e.type === 'halt');
  assert.ok(ev && Math.abs(ev.ddPct - 15.83) < 0.01);
  const r = await t.onSignal(btc());
  assert.equal(r.code, 'paused');
  assert.match(r.reason, /просадка 15\.8% от максимума баланса/);
  assert.match(tradeEventMessage(ev).subject, /просадка достигла лимита — автоторговля остановлена/);
  // пауза снята — отсчёт от текущего баланса, повторной остановки нет
  t.halted = null;
  assert.equal(t.checkPeak({ equity: 10100 }), false);
  assert.equal((await t.onSignal(btc())).status, 'opened');
});

test('Защита: прибыль в один риск — стоп в безубыток до цели 1; откат закрывает сделку без убытка', async () => {
  const { ex, t, events } = mk();
  await t.init();
  const res = await t.onSignal(btc());
  const tr = res.trade;
  ex.setPrice('BTCUSDT', 60900); // +0.9R — рано
  await t.tick();
  assert.equal(tr.beDone, undefined);
  ex.setPrice('BTCUSDT', 61050); // +1.05R
  await t.tick();
  assert.equal(tr.beDone, true);
  assert.ok(tr.slNow > tr.entry && tr.slNow < tr.entry * 1.002, `стоп чуть выше входа: ${tr.slNow}`);
  assert.equal(t.liveRisk(tr), 0);
  assert.deepEqual(events.map((e) => e.type), ['be']);
  assert.match(tradeEventMessage(events[0]).subject, /BTC — стоп в безубытке/);
  ex.setPrice('BTCUSDT', 60000); // откат ниже входа
  await t.tick();
  assert.equal(tr.status, 'closed');
  assert.equal(tr.why, 'breakeven');
  assert.ok(tr.r > -0.1, `без убытка: ${tr.r}R`);
  assert.equal(t.lossStreak().n, 0, 'безубыток — не убыток');
  // TRADE_BE_AT_R=0 — как раньше: стоп остаётся на месте
  const o = mk({ beAtR: 0 });
  await o.t.init();
  const r2 = await o.t.onSignal(btc());
  o.ex.setPrice('BTCUSDT', 61200);
  await o.t.tick();
  assert.equal(r2.trade.slNow, 59000);
});

test('Защита: в волатильном рынке риск вдвое меньше; настройки проверяются', async () => {
  const { t } = mk();
  await t.init();
  const r = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000, { regime: { key: 'volatile' } }));
  assert.ok(r.trade.riskUsd < 105 && r.trade.riskUsd > 80, `${r.trade.riskUsd}`);
  assert.match(r.trade.warnings.join(' '), /высокая волатильность рынка/);
  assert.match(t.describe(), /все открытые сделки вместе рискуют не больше 4%/);
  const c = structuredClone(cfg);
  Object.assign(c.trade, { maxOpenRiskPct: 99, lossStreakPause: 2.5, beAtR: 0.1, volRiskMult: 3 });
  const { tradeErrors } = validateConfig(c);
  assert.deepEqual([c.trade.maxOpenRiskPct, c.trade.lossStreakPause, c.trade.beAtR, c.trade.volRiskMult], [4, 3, 1, 0.5]);
  assert.ok(tradeErrors.some((w) => /TRADE_MAX_OPEN_RISK_PCT=99/.test(w)), 'ошибка в настройке защиты — автоторговля не включится молча');
});
