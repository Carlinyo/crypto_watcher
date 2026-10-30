import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPatterns, _test } from '../lib/patterns.js';
import { rsi, macd, atr, pivots } from '../lib/indicators.js';
import { clusterZones, buildLevels } from '../lib/levels.js';
import { candlesFrom, path } from './helpers.js';

const run = (closes, opts = {}) => {
  const c = candlesFrom(closes, opts);
  const C = c.map((x) => x.close);
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), C, 14);
  return detectPatterns(c, { rsi: rsi(C), macdHist: macd(C).hist }, a[a.length - 1]);
};
const names = (r) => r.found.map((p) => p.name).join(' | ');

test('Двойное дно с пробоем шеи', () => {
  const closes = path([130], [100, 25], [110, 8], [100.2, 8], [111.5, 8]);
  const r = run(closes, { wick: 0.4 });
  assert.match(names(r), /двойное дно \(пробита шея/);
  const p = r.found.find((x) => x.name.startsWith('двойное дно'));
  assert.ok(p.score > 0 && p.target > 110, 'цель выше шеи');
});

test('Двойная вершина формируется', () => {
  const closes = path([80], [110, 25], [100, 8], [109.8, 8], [104, 4]);
  const r = run(closes, { wick: 0.4 });
  assert.match(names(r), /двойная вершина/);
});

test('Голова и плечи с пробоем линии шеи', () => {
  const closes = path([90], [110, 12], [104, 6], [118, 8], [104.5, 8], [110.3, 6], [100, 6]);
  const r = run(closes, { wick: 0.3 });
  assert.match(names(r), /голова и плечи/);
  assert.ok(r.found.find((x) => /голова и плечи/.test(x.name)).score < 0);
});

test('Снятие ликвидности снизу (ложный пробой минимума)', () => {
  const closes = path([135], [120, 15], [100, 15], [108, 10], [102, 10]);
  const c = candlesFrom(closes, { wick: 0.3 });
  // последняя свеча: прокол минимума 100 и закрытие выше
  const last = c[c.length - 1];
  last.low = 99.2; last.open = 101.5; last.close = 102.4; last.high = 102.6;
  const C = c.map((x) => x.close);
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), C, 14);
  const r = detectPatterns(c, { rsi: rsi(C), macdHist: macd(C).hist }, a[a.length - 1]);
  assert.match(names(r), /снятие ликвидности снизу/);
});

test('Бычье поглощение после снижения', () => {
  const closes = path([120], [100, 30]);
  const c = candlesFrom(closes, { wick: 0.2 });
  c.push({ ...c[c.length - 1], time: c[c.length - 1].time + 3600e3, open: 100, close: 98.5, high: 100.2, low: 98.3 });
  c.push({ ...c[c.length - 1], time: c[c.length - 1].time + 3600e3, open: 98.4, close: 101, high: 101.2, low: 98.2 });
  const found = _test.candlePatterns(c, 1.0);
  assert.ok(found.some((p) => p.name === 'бычье поглощение' && p.score > 0));
});

test('Восходящий треугольник: пробой вверх', () => {
  const closes = path([80], [95, 15], [110, 6], [100, 5], [110, 5], [103, 5], [110, 5], [106, 5], [110, 4], [114, 3]);
  const r = run(closes, { wick: 0.2 });
  assert.match(names(r), /треугольник: пробой вверх|пробой максимума/);
});

test('Склейка уровней в зоны и сила зоны', () => {
  const z = clusterZones([
    { price: 100, w: 1, label: 'A', kind: 'poc' }, { price: 100.2, w: 1, label: 'B', kind: 'prev' }, { price: 100.3, w: 0.5, label: 'C', kind: 'fib' },
    { price: 110, w: 1, label: 'D', kind: 'swing' },
  ], 1, 105);
  assert.equal(z.length, 2);
  assert.equal(z[0].side, 'support');
  assert.equal(z[1].side, 'resistance');
  assert.ok(z[0].strength > 2 && z[0].strength < 2.5, `сила с убыванием вклада: ${z[0].strength}`);
  assert.deepEqual(z[0].sources, ['A', 'B', 'C']);
});

test('buildLevels на длинной истории даёт поддержки ниже и сопротивления выше цены', () => {
  const closes = [];
  for (let i = 0; i < 600; i++) closes.push(100 + 10 * Math.sin(i / 25) + 3 * Math.sin(i / 7));
  const h1 = candlesFrom(closes, { wick: 0.5 });
  const price = closes[closes.length - 1];
  const lv = buildLevels({ price, atr1h: 1.2, atr4h: 3, h1, h4: candlesFrom(closes.filter((_, i) => i % 4 === 0), { step: 4 * 3600e3 }), d1: null, m15: null });
  assert.ok(lv.supports.every((z) => z.high < price));
  assert.ok(lv.resistances.every((z) => z.low > price));
  assert.ok(lv.supports.length > 0 && lv.resistances.length > 0);
});

test('Фигура, дошедшая до цели, ослабляется', () => {
  const closes = path([130], [100, 25], [110, 8], [100.2, 8], [125, 8]);
  const r = run(closes, { wick: 0.4 });
  const p = r.found.find((x) => x.name.startsWith('двойное дно'));
  if (p) assert.ok(p.score < 0.2 || !p.target, 'после достижения цели сигнал слабый');
});

test('pivots нужны для фигур', () => {
  const c = candlesFrom(path([100], [110, 10], [100, 10]));
  const p = pivots(c.map((x) => x.high), c.map((x) => x.low), 3, 3);
  assert.equal(p.highs.length, 1);
});

test('Бычий и медвежий флаги: пробой', () => {
  const bull = run(path([100], [100.5, 20], [112, 6], [110, 3], [111, 3], [109.5, 3], [110.5, 3], [113.5, 2]), { wick: 0.2 });
  assert.match(names(bull), /бычий флаг: пробой вверх/);
  const bear = run(path([120], [119.5, 20], [108, 6], [110, 3], [109, 3], [110.5, 3], [109.5, 3], [106.5, 2]), { wick: 0.2 });
  assert.match(names(bear), /медвежий флаг: пробой вниз/);
});
