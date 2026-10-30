// Технические индикаторы. Функции-ряды возвращают массив той же длины, что и вход
// (null там, где данных ещё недостаточно). Формулы — как в TradingView, где это важно.

export const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : undefined);
export const lastValid = (arr, back = 0) => {
  let skip = back;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null && Number.isFinite(arr[i])) { if (skip-- === 0) return arr[i]; }
  }
  return null;
};
export const clamp = (x, lo = -1, hi = 1) => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : 0);
export const squash = (x, k = 1) => (Number.isFinite(x) ? Math.tanh(x / k) : 0);
export const sum = (a) => a.reduce((s, x) => s + x, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : 0);
export const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

export function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
}

export const highest = (arr, from, to) => { let m = -Infinity; for (let i = Math.max(0, from); i <= to; i++) if (arr[i] > m) m = arr[i]; return m; };
export const lowest = (arr, from, to) => { let m = Infinity; for (let i = Math.max(0, from); i <= to; i++) if (arr[i] < m) m = arr[i]; return m; };

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let s = 0, n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { s = 0; n = 0; continue; }
    s += v; n++;
    if (n > period) s -= values[i - period];
    if (n >= period) out[i] = s / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let count = 0, s = 0, prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev === null) {
      s += v;
      if (++count === period) { prev = s / period; out[i] = prev; }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Скользящее Уайлдера (RMA), старт — SMA
export function rma(values, period) {
  const out = new Array(values.length).fill(null);
  let count = 0, s = 0, prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (prev === null) {
      s += v;
      if (++count === period) { prev = s / period; out[i] = prev; }
    } else {
      prev = (prev * (period - 1) + v) / period;
      out[i] = prev;
    }
  }
  return out;
}

const rsiOf = (g, l) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));

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

export function stochRsi(closes, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3) {
  const r = rsi(closes, rsiPeriod);
  const raw = r.map((v, i) => {
    if (v == null || i < rsiPeriod + stochPeriod - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) { if (r[j] > hi) hi = r[j]; if (r[j] < lo) lo = r[j]; }
    return hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100;
  });
  const k = sma(raw, kPeriod);
  const d = sma(k, dPeriod);
  return { k, d };
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

export function atr(h, l, c, period = 14) { return rma(trueRange(h, l, c), period); }

// Каналы Кельтнера: EMA ± mult·ATR
export function keltner(h, l, c, period = 20, mult = 1.5, atrPeriod = period) {
  const mid = ema(c, period);
  const a = atr(h, l, c, atrPeriod);
  return {
    mid,
    upper: mid.map((m, i) => (m == null || a[i] == null ? null : m + mult * a[i])),
    lower: mid.map((m, i) => (m == null || a[i] == null ? null : m - mult * a[i])),
  };
}

// Линейная регрессия: наклон, сдвиг, R², значение в последней точке
export function linreg(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0, end: ys[0] ?? 0 };
  const xm = (n - 1) / 2, ym = mean(ys);
  let num = 0, den = 0, tot = 0;
  for (let x = 0; x < n; x++) { num += (x - xm) * (ys[x] - ym); den += (x - xm) ** 2; tot += (ys[x] - ym) ** 2; }
  const slope = den ? num / den : 0;
  const intercept = ym - slope * xm;
  let res = 0;
  for (let x = 0; x < n; x++) res += (ys[x] - (intercept + slope * x)) ** 2;
  return { slope, intercept, r2: tot ? 1 - res / tot : 1, end: intercept + slope * (n - 1) };
}

// Наклон регрессии последних n точек (единиц значения за бар)
export function slope(values, n) {
  const ys = values.slice(-n).filter((v) => v != null && Number.isFinite(v));
  return ys.length < 3 ? 0 : linreg(ys).slope;
}

// TTM Squeeze: полосы Боллинджера внутри каналов Кельтнера → «сжатие пружины»; momentum — направление выхода
export function squeeze(h, l, c, period = 20, bbMult = 2, kcMult = 1.5) {
  const bb = bollinger(c, period, bbMult);
  const mid = sma(c, period);
  const a = atr(h, l, c, period);
  const n = c.length;
  const on = new Array(n).fill(null), momentum = new Array(n).fill(null);
  const delta = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    if (bb.upper[i] == null || a[i] == null) continue;
    const kcU = mid[i] + kcMult * a[i], kcL = mid[i] - kcMult * a[i];
    on[i] = bb.upper[i] < kcU && bb.lower[i] > kcL;
    const dc = (highest(h, i - period + 1, i) + lowest(l, i - period + 1, i)) / 2;
    delta[i] = c[i] - (dc + mid[i]) / 2;
  }
  for (let i = 2 * period - 2; i < n; i++) {
    const w = delta.slice(i - period + 1, i + 1);
    if (w.some((x) => x == null)) continue;
    momentum[i] = linreg(w).end;
  }
  return { on, momentum };
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
    if (dxs.length === period) adxPrev = mean(dxs);
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

// Money Flow Index — «RSI с объёмом»
export function mfi(h, l, c, v, period = 14) {
  const n = c.length;
  const out = new Array(n).fill(null);
  const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
  for (let i = period; i < n; i++) {
    let pos = 0, neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const mf = tp[j] * v[j];
      if (tp[j] > tp[j - 1]) pos += mf; else if (tp[j] < tp[j - 1]) neg += mf;
    }
    out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

// Chaikin Money Flow — приток/отток денег
export function cmf(h, l, c, v, period = 20) {
  const n = c.length;
  const out = new Array(n).fill(null);
  const mfv = c.map((x, i) => (h[i] === l[i] ? 0 : (((x - l[i]) - (h[i] - x)) / (h[i] - l[i])) * v[i]));
  for (let i = period - 1; i < n; i++) {
    let a = 0, b = 0;
    for (let j = i - period + 1; j <= i; j++) { a += mfv[j]; b += v[j]; }
    out[i] = b ? a / b : 0;
  }
  return out;
}

export function cci(h, l, c, period = 20) {
  const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
  const m = sma(tp, period);
  return tp.map((x, i) => {
    if (m[i] == null) return null;
    let md = 0;
    for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
    md /= period;
    return md === 0 ? 0 : (x - m[i]) / (0.015 * md);
  });
}

// VWAP по отрезку свечей [from, to] со стандартным отклонением (для полос)
export function vwapRange(candles, from = 0, to = candles.length - 1) {
  let pv = 0, vv = 0;
  for (let i = Math.max(0, from); i <= to; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume; vv += c.volume;
  }
  if (!vv) return null;
  const vwap = pv / vv;
  let s = 0;
  for (let i = Math.max(0, from); i <= to; i++) {
    const c = candles[i];
    s += c.volume * ((c.high + c.low + c.close) / 3 - vwap) ** 2;
  }
  return { vwap, sd: Math.sqrt(s / vv) };
}

// Ишимоку (смещение как в TradingView: displacement−1)
export function ichimoku(h, l, c, tenkanP = 9, kijunP = 26, spanBP = 52, displacement = 26) {
  const n = c.length;
  const mid = (p, i) => (i < p - 1 ? null : (highest(h, i - p + 1, i) + lowest(l, i - p + 1, i)) / 2);
  const tenkan = c.map((_, i) => mid(tenkanP, i));
  const kijun = c.map((_, i) => mid(kijunP, i));
  const spanA = tenkan.map((t, i) => (t == null || kijun[i] == null ? null : (t + kijun[i]) / 2));
  const spanB = c.map((_, i) => mid(spanBP, i));
  const off = displacement - 1;
  const at = (i) => (i - off >= 0 ? { a: spanA[i - off], b: spanB[i - off] } : { a: null, b: null });
  const cur = at(n - 1);
  return {
    tenkan, kijun, spanA, spanB,
    cloudTop: cur.a == null || cur.b == null ? null : Math.max(cur.a, cur.b),
    cloudBottom: cur.a == null || cur.b == null ? null : Math.min(cur.a, cur.b),
    futureBullish: spanA[n - 1] != null && spanB[n - 1] != null ? spanA[n - 1] > spanB[n - 1] : null,
    chikouAbove: n > off ? c[n - 1] > c[n - 1 - off] : null,
  };
}

// Supertrend (ATR по Уайлдеру, как в TradingView)
export function supertrend(h, l, c, period = 10, mult = 3) {
  const n = c.length;
  const a = atr(h, l, c, period);
  const line = new Array(n).fill(null), dir = new Array(n).fill(null);
  let fu = null, fl = null, d = 1;
  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    const hl2 = (h[i] + l[i]) / 2;
    const bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
    if (fu === null) { fu = bu; fl = bl; d = 1; }
    else {
      fu = bu < fu || c[i - 1] > fu ? bu : fu;
      fl = bl > fl || c[i - 1] < fl ? bl : fl;
      if (d === -1 && c[i] > fu) d = 1;
      else if (d === 1 && c[i] < fl) d = -1;
    }
    dir[i] = d;
    line[i] = d === 1 ? fl : fu;
  }
  return { line, dir };
}

// Перцентиль значения внутри массива (0..1)
export function percentileRank(arr, value) {
  const xs = arr.filter((x) => x != null && Number.isFinite(x));
  if (!xs.length || value == null) return null;
  let below = 0, equal = 0;
  for (const x of xs) { if (x < value) below++; else if (x === value) equal++; }
  return (below + equal / 2) / xs.length;
}

export function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i - 1] > 0 && closes[i] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0);
  return out;
}

// Корреляция Пирсона и бета (a относительно b)
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return { corr: null, beta: null };
  const x = a.slice(-n), y = b.slice(-n);
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return { corr: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null, beta: syy ? sxy / syy : null };
}

// Локальные экстремумы (свинг-хаи и свинг-лоу). Равные соседи не считаются экстремумом слева.
export function pivots(highs, lows, left = 3, right = 3) {
  const ph = [], pl = [];
  for (let i = left; i < highs.length - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (j < i ? highs[j] >= highs[i] : highs[j] > highs[i]) isH = false;
      if (j < i ? lows[j] <= lows[i] : lows[j] < lows[i]) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) ph.push({ i, price: highs[i] });
    if (isL) pl.push({ i, price: lows[i] });
  }
  return { highs: ph, lows: pl };
}
