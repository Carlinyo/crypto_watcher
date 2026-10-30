import test from 'node:test';
import assert from 'node:assert/strict';
import { priceInZone, signalEmail, resultProblem, TRADE_EVENT_CATEGORY, DEFAULT_EMAIL_EVENTS } from '../lib/policy.js';
import { whaleMessage, tradeEventMessage } from '../lib/report.js';
import cfg from '../config.js';

test('Письма по умолчанию: цена в зоне, сделки, киты, сбои', () => {
  assert.deepEqual(cfg.notify.events, DEFAULT_EMAIL_EVENTS);
  assert.equal(cfg.trade.entry, 'zone');
});

test('Цена в зоне входа: покупка — у зоны или ниже (но не провал), продажа — зеркально', () => {
  const buy = { dir: 'BUY', low: 100, high: 102, atr: 2 };
  assert.equal(priceInZone(buy, 101), true);
  assert.equal(priceInZone(buy, 102.05), true);   // чуть выше верха — в пределах 0.05 ATR
  assert.equal(priceInZone(buy, 103), false);     // ещё не дошла
  assert.equal(priceInZone(buy, 99.5), true);     // чуть ниже зоны — цена даже лучше
  assert.equal(priceInZone(buy, 98), false);      // провалилась сквозь зону
  const sell = { dir: 'SELL', low: 200, high: 204, atr: 4 };
  assert.equal(priceInZone(sell, 202), true);
  assert.equal(priceInZone(sell, 198), false);
  assert.equal(priceInZone(sell, 205), true);
});

test('Письмо о сигнале: только в зоне или если сделка открыта', () => {
  const ev = DEFAULT_EMAIL_EVENTS;
  assert.equal(signalEmail(ev, { inZone: true, opened: false }), true);
  assert.equal(signalEmail(ev, { inZone: false, opened: false }), false);
  assert.equal(signalEmail(ev, { inZone: false, opened: true }), true);
  assert.equal(signalEmail(['signals'], { inZone: false, opened: false }), true);
  assert.equal(signalEmail(['whales'], { inZone: true, opened: true }), false);
  assert.equal(TRADE_EVENT_CATEGORY.closed, 'trade');
  assert.equal(TRADE_EVENT_CATEGORY.tp1, 'trade-steps');
  assert.equal(TRADE_EVENT_CATEGORY.paused, 'critical');
});

test('Письмо о ките показывает вашу сделку и предупреждает, если кит против неё', () => {
  const ev = { type: 'single', market: 'spot', symbol: 'SOLUSDT', side: 'buy', usd: 3e6, qty: 20000, price: 150, from: 150, to: 150.2, trades: 3, time: Date.now(), threshold: 1e6 };
  const short = { side: 'Sell', entry: 152, slNow: 155, upnl: -40 };
  const m = whaleMessage(ev, { alert: true, rule: 'тест' }, { trade: short });
  assert.match(m.text, /Ваша сделка на Bybit: ШОРТ по 152/);
  assert.match(m.text, /против вашей позиции/);
  const long = { side: 'Buy', entry: 148, slNow: 145, upnl: 25 };
  assert.match(whaleMessage(ev, { alert: true }, { trade: long }).text, /в сторону вашей позиции/);
});

test('Письмо о закрытии сделки рассказывает весь ход сделки', () => {
  const t0 = Date.now() - 3 * 3600e3;
  const trade = { symbol: 'AVAXUSDT', bySymbol: 'AVAXUSDT', mult: 1, side: 'Buy', qty: 294, entry: 21.25, stop: 20.59, slNow: 22.97, t1: 22.97, t2: 23.85, openedAt: t0, tp1At: t0 + 3600e3, trailedAt: t0 + 7200e3, closedAt: t0 + 10000e3, why: 'tp2', exit: 23.41, pnl: 570.59, r: 2.85, riskUsd: 200 };
  const m = tradeEventMessage({ type: 'closed', trade, mode: 'demo' }, { pnlToday: 570.59 });
  assert.match(m.subject, /AVAX ЛОНГ закрыт — \+\$570\.59 \(\+2\.85R\)/);
  assert.match(m.text, /Ход сделки: открыта .* → .*цель 1: половина закрыта по 22\.9700.* → .*стоп подтянут к цели 1 → .*закрыта — цель 2/);
});

test('Результат анализа с ошибкой не превращается в письмо и сделку', () => {
  const ok = { score: 0.5, price: 100, action: 'BUY', plan: { dir: 'BUY', stop: 95, t1: 110, zone: [98, 100] } };
  assert.equal(resultProblem(ok), null);
  assert.match(resultProblem({ ...ok, score: NaN }), /не число/);
  assert.match(resultProblem({ ...ok, plan: { ...ok.plan, stop: undefined } }), /не числа/);
  assert.match(resultProblem({ ...ok, plan: { ...ok.plan, stop: 99 } }), /неправильно/);       // стоп внутри зоны
  assert.match(resultProblem({ ...ok, plan: { ...ok.plan, t1: 99.5 } }), /неправильно/);      // цель ниже зоны
  const sell = { score: -0.5, price: 100, action: 'SELL', plan: { dir: 'SELL', stop: 105, t1: 90, zone: [100, 102] } };
  assert.equal(resultProblem(sell), null);
  assert.equal(resultProblem({ score: 0, price: 100, action: 'NEUTRAL', plan: null }), null);
});
