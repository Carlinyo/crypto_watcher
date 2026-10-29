// 4. Паттерны: свечные модели, дивергенции, двойное дно/вершина, структура рынка, пробои
import { pivots, clamp, sma } from './indicators.js';

function candlePatterns(c) {
  const out = [];
  const n = c.length;
  if (n < 3) return out;
  const [a, b, x] = [c[n - 3], c[n - 2], c[n - 1]]; // x — последняя закрытая свеча
  const body = (k) => Math.abs(k.close - k.open);
  const range = (k) => k.high - k.low || 1e-12;
  const green = (k) => k.close > k.open;
  const upperWick = (k) => k.high - Math.max(k.open, k.close);
  const lowerWick = (k) => Math.min(k.open, k.close) - k.low;

  if (green(x) && !green(b) && x.close >= b.open && x.open <= b.close && body(x) > body(b))
    out.push({ name: 'бычье поглощение', score: 0.6 });
  if (!green(x) && green(b) && x.open >= b.close && x.close <= b.open && body(x) > body(b))
    out.push({ name: 'медвежье поглощение', score: -0.6 });

  if (lowerWick(x) >= 2 * body(x) && upperWick(x) <= body(x) * 0.6 && body(x) / range(x) < 0.4)
    out.push({ name: 'молот (длинная нижняя тень)', score: 0.45 });
  if (upperWick(x) >= 2 * body(x) && lowerWick(x) <= body(x) * 0.6 && body(x) / range(x) < 0.4)
    out.push({ name: 'падающая звезда (длинная верхняя тень)', score: -0.45 });

  const mid = (k) => (k.open + k.close) / 2;
  if (!green(a) && body(b) < body(a) * 0.4 && green(x) && x.close > mid(a))
    out.push({ name: 'утренняя звезда', score: 0.7 });
  if (green(a) && body(b) < body(a) * 0.4 && !green(x) && x.close < mid(a))
    out.push({ name: 'вечерняя звезда', score: -0.7 });

  return out;
}

export function detectPatterns(candles, rsiArr, atrV) {
  const H = candles.map((c) => c.high), L = candles.map((c) => c.low);
  const C = candles.map((c) => c.close), V = candles.map((c) => c.volume);
  const n = candles.length;
  const price = C[n - 1];
  const found = candlePatterns(candles);
  const pv = pivots(H, L, 3, 3);
  const [h1, h2] = pv.highs.slice(-2);
  const [l1, l2] = pv.lows.slice(-2);

  // Дивергенции RSI
  if (l1 && l2 && rsiArr[l1.i] != null && rsiArr[l2.i] != null && n - 1 - l2.i <= 15
      && l2.price < l1.price && rsiArr[l2.i] > rsiArr[l1.i] + 2)
    found.push({ name: 'бычья дивергенция RSI', score: 0.7 });
  if (h1 && h2 && rsiArr[h1.i] != null && rsiArr[h2.i] != null && n - 1 - h2.i <= 15
      && h2.price > h1.price && rsiArr[h2.i] < rsiArr[h1.i] - 2)
    found.push({ name: 'медвежья дивергенция RSI', score: -0.7 });

  // Двойное дно / двойная вершина
  if (l1 && l2 && l2.i - l1.i >= 8 && Math.abs(l1.price - l2.price) <= 0.6 * atrV) {
    const neck = Math.max(...H.slice(l1.i, l2.i + 1));
    if (price > neck) found.push({ name: `двойное дно (пробита шея ${neck.toPrecision(6)})`, score: 0.9 });
    else if (price > l2.price) found.push({ name: 'формируется двойное дно', score: 0.35 });
  }
  if (h1 && h2 && h2.i - h1.i >= 8 && Math.abs(h1.price - h2.price) <= 0.6 * atrV) {
    const neck = Math.min(...L.slice(h1.i, h2.i + 1));
    if (price < neck) found.push({ name: `двойная вершина (пробита шея ${neck.toPrecision(6)})`, score: -0.9 });
    else if (price < h2.price) found.push({ name: 'формируется двойная вершина', score: -0.35 });
  }

  // Структура рынка
  if (h1 && h2 && l1 && l2) {
    if (h2.price > h1.price && l2.price > l1.price) found.push({ name: 'структура HH/HL (восходящая)', score: 0.4 });
    if (h2.price < h1.price && l2.price < l1.price) found.push({ name: 'структура LH/LL (нисходящая)', score: -0.4 });
  }

  // Пробой 20-барного диапазона на объёме
  const prevHigh = Math.max(...H.slice(-21, -1)), prevLow = Math.min(...L.slice(-21, -1));
  const volAvg = sma(V, 20)[n - 2] || 0;
  const volBoost = volAvg ? V[n - 1] / volAvg : 1;
  if (price > prevHigh) found.push({ name: `пробой максимума 20 баров${volBoost > 1.5 ? ' на объёме' : ''}`, score: volBoost > 1.5 ? 0.7 : 0.35 });
  if (price < prevLow) found.push({ name: `пробой минимума 20 баров${volBoost > 1.5 ? ' на объёме' : ''}`, score: volBoost > 1.5 ? -0.7 : -0.35 });

  const score = clamp(found.reduce((s, p) => s + p.score, 0));
  return { score, found, pivots: pv };
}
