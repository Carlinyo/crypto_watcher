import test from 'node:test';
import assert from 'node:assert/strict';
import { rsi, sma, ema, atr, supertrend, pivots, percentileRank, correlation, linreg, vwapRange, stochRsi } from '../lib/indicators.js';
import { volumeProfile } from '../lib/volumeProfile.js';
import { candlesFrom, path } from './helpers.js';

test('RSI по Уайлдеру совпадает с ручным расчётом', () => {
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
  const r = rsi(c, 14);
  assert.equal(r[13], null);
  assert.ok(Math.abs(r[14] - 70.46) < 0.01, `RSI[14]=${r[14]}`);
  assert.ok(Math.abs(r[15] - 66.25) < 0.01, `RSI[15]=${r[15]}`);
});

test('SMA и EMA', () => {
  const x = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(sma(x, 3).slice(2), [2, 3, 4, 5]);
  const e = ema(x, 3);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3); // 4*0.5 + 2*0.5
});

test('Supertrend: на росте направление вверх, на падении вниз', () => {
  const up = candlesFrom(path([100], [150, 60]));
  const st = supertrend(up.map((c) => c.high), up.map((c) => c.low), up.map((c) => c.close));
  assert.equal(st.dir[st.dir.length - 1], 1);
  const dn = candlesFrom(path([150], [100, 60]));
  const sd = supertrend(dn.map((c) => c.high), dn.map((c) => c.low), dn.map((c) => c.close));
  assert.equal(sd.dir[sd.dir.length - 1], -1);
});

test('Свинг-точки: плато даёт одну точку', () => {
  const h = [1, 2, 3, 5, 5, 3, 2, 1, 0], l = h.map((x) => x - 1);
  const p = pivots(h, l, 2, 2);
  assert.equal(p.highs.length, 1);
  assert.equal(p.highs[0].i, 3);
});

test('ATR положительный и разумный', () => {
  const c = candlesFrom(path([100], [110, 30], [100, 30]), { wick: 0.5 });
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14);
  const v = a[a.length - 1];
  assert.ok(v > 0.5 && v < 2.5, `ATR=${v}`);
});

test('Перцентиль, корреляция, регрессия, VWAP, StochRSI', () => {
  assert.equal(percentileRank([1, 2, 3, 4], 4), 0.875);
  const a = Array.from({ length: 50 }, (_, i) => Math.sin(i));
  assert.ok(Math.abs(correlation(a, a).corr - 1) < 1e-9);
  const lr = linreg([1, 3, 5, 7]);
  assert.equal(lr.slope, 2);
  assert.equal(lr.r2, 1);
  const c = candlesFrom([10, 10, 10, 10]);
  assert.ok(Math.abs(vwapRange(c).vwap - 10) < 0.2);
  const k = stochRsi(path([100], [130, 40], [110, 20])).k;
  assert.ok(k[k.length - 1] < 20, 'после падения StochRSI внизу');
});

test('Профиль объёма: POC там, где больше всего торговали', () => {
  const closes = [...path([100], [120, 20]), ...Array(40).fill(110), ...path([110], [100, 10])];
  const c = candlesFrom(closes, { wick: 0.2 });
  const vp = volumeProfile(c, { bins: 40 });
  assert.ok(Math.abs(vp.poc - 110) < 1, `POC=${vp.poc}`);
  assert.ok(vp.val < 110 && vp.vah > 110);
});
