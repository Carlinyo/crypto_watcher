// Технические индикаторы. Все функции возвращают массив той же длины, что и вход
// (null там, где данных ещё недостаточно).

export const last = (arr) => arr[arr.length - 1];
export const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let count = 0, sum = 0, prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev === null) {
      sum += v;
      if (++count === period) { prev = sum / period; out[i] = prev; }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

const rsiOf = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    gain += Math.max(d, 0); loss += Math.max(-d, 0);
  }
  gain /= period; loss /= period;
  out[period] = rsiOf(gain, loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsiOf(gain, loss);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = f.map((v, i) => (v == null || s[i] == null ? null : v - s[i]));
  const sig = ema(line, signal);
  const hist = line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i]));
  return { line, signal: sig, hist };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = [], lower = [], pctB = [], width = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) { upper.push(null); lower.push(null); pctB.push(null); width.push(null); continue; }
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / period);
    const u = mid[i] + mult * sd, l = mid[i] - mult * sd;
    upper.push(u); lower.push(l);
    pctB.push(u === l ? 0.5 : (closes[i] - l) / (u - l));
    width.push(mid[i] ? (u - l) / mid[i] : 0);
  }
  return { mid, upper, lower, pctB, width };
}

export function trueRange(h, l, c) {
  return h.map((hi, i) => (i === 0 ? hi - l[i]
    : Math.max(hi - l[i], Math.abs(hi - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
}

export function atr(h, l, c, period = 14) {
  const tr = trueRange(h, l, c);
  const out = new Array(c.length).fill(null);
  if (c.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < c.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// ADX + направленные индикаторы (+DI / -DI) по Уайлдеру
export function adx(h, l, c, period = 14) {
  const n = c.length;
  const plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null), adxArr = new Array(n).fill(null);
  let trS = 0, pS = 0, mS = 0, adxPrev = null;
  const dxs = [];
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= period) {
      trS += tr; pS += pdm; mS += mdm;
      if (i < period) continue;
    } else {
      trS = trS - trS / period + tr;
      pS = pS - pS / period + pdm;
      mS = mS - mS / period + mdm;
    }
    const pdi = trS ? (100 * pS) / trS : 0, mdi = trS ? (100 * mS) / trS : 0;
    const dx = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
    plusDI[i] = pdi; minusDI[i] = mdi;
    dxs.push(dx);
    if (dxs.length === period) adxPrev = dxs.reduce((a, b) => a + b, 0) / period;
    else if (dxs.length > period) adxPrev = (adxPrev * (period - 1) + dx) / period;
    if (dxs.length >= period) adxArr[i] = adxPrev;
  }
  return { adx: adxArr, plusDI, minusDI };
}

export function obv(closes, volumes) {
  const out = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    out.push(out[i - 1] + (d > 0 ? volumes[i] : d < 0 ? -volumes[i] : 0));
  }
  return out;
}

// Наклон линейной регрессии последних n точек, в единицах значения за бар
export function slope(values, n) {
  const ys = values.slice(-n).filter((v) => v != null);
  const m = ys.length;
  if (m < 3) return 0;
  const xm = (m - 1) / 2, ym = ys.reduce((a, b) => a + b, 0) / m;
  let num = 0, den = 0;
  ys.forEach((y, x) => { num += (x - xm) * (y - ym); den += (x - xm) ** 2; });
  return num / den;
}

// Локальные экстремумы (свинг-хаи и свинг-лоу)
export function pivots(highs, lows, left = 3, right = 3) {
  const ph = [], pl = [];
  for (let i = left; i < highs.length - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (highs[j] >= highs[i]) isH = false;
      if (lows[j] <= lows[i]) isL = false;
    }
    if (isH) ph.push({ i, price: highs[i] });
    if (isL) pl.push({ i, price: lows[i] });
  }
  return { highs: ph, lows: pl };
}
