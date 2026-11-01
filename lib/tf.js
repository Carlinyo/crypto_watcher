// Расчёт всех индикаторов для одного таймфрейма (по закрытым свечам)
import {
  ema, rsi, macd, bollinger, atr, adx, obv, mfi, cmf, cci, stochRsi, supertrend, squeeze, ichimoku,
  lastValid, sign,
} from './indicators.js';

export function emaStack(price, e20, e50, e200) {
  if (e20 == null || e50 == null) return 0;
  if (e200 == null) return (sign(price - e20) + sign(e20 - e50)) / 2;
  return (sign(price - e20) + sign(e20 - e50) + sign(e50 - e200)) / 3;
}

export function trendWord(s) {
  if (s >= 0.6) return 'вверх';
  if (s >= 0.2) return 'скорее вверх';
  if (s <= -0.6) return 'вниз';
  if (s <= -0.2) return 'скорее вниз';
  return 'боковик';
}

/** Недельные свечи из дневных: неделя — с понедельника (UTC); последняя — текущая, ещё не закрытая */
export function toWeekly(d1) {
  const out = [];
  for (const c of d1 ?? []) {
    const day = Math.floor(c.time / 86400e3) * 86400e3;
    const wk = day - ((new Date(day).getUTCDay() + 6) % 7) * 86400e3;
    const w = out[out.length - 1];
    if (w && w.time === wk) {
      if (c.high > w.high) w.high = c.high;
      if (c.low < w.low) w.low = c.low;
      w.close = c.close; w.closeTime = c.closeTime;
      w.volume += c.volume; w.quoteVolume += c.quoteVolume ?? 0; w.takerBuy += c.takerBuy ?? 0; w.takerBuyQuote += c.takerBuyQuote ?? 0; w.trades += c.trades ?? 0;
    } else {
      out.push({ time: wk, open: c.open, high: c.high, low: c.low, close: c.close, closeTime: c.closeTime, volume: c.volume, quoteVolume: c.quoteVolume ?? 0, takerBuy: c.takerBuy ?? 0, takerBuyQuote: c.takerBuyQuote ?? 0, trades: c.trades ?? 0 });
    }
  }
  return out;
}

/** @param {Array} candles закрытые свечи */
export function computeTF(candles, name) {
  if (!candles || candles.length < 30) return null;
  const H = candles.map((c) => c.high), L = candles.map((c) => c.low), C = candles.map((c) => c.close), V = candles.map((c) => c.volume);
  const atrS = atr(H, L, C, 14);
  const ema20 = ema(C, 20), ema50 = ema(C, 50), ema200 = ema(C, 200);
  const close = C[C.length - 1];
  const hasTaker = candles.some((c) => c.takerBuy > 0);
  let cvd = null;
  if (hasTaker) {
    cvd = [];
    let acc = 0;
    for (const c of candles) { acc += 2 * c.takerBuy - c.volume; cvd.push(acc); }
  }
  const t = {
    name, candles, H, L, C, V, close,
    atr: atrS, atrV: lastValid(atrS),
    ema20, ema50, ema200,
    rsi: rsi(C, 14),
    macd: macd(C),
    bb: bollinger(C, 20, 2),
    adx: adx(H, L, C, 14),
    st: supertrend(H, L, C, 10, 3),
    sq: squeeze(H, L, C),
    srsi: stochRsi(C),
    mfi: mfi(H, L, C, V, 14),
    cmf: cmf(H, L, C, V, 20),
    obv: obv(C, V),
    cci: cci(H, L, C, 20),
    ich: C.length >= 80 ? ichimoku(H, L, C) : null,
    cvd,
  };
  t.stack = emaStack(close, lastValid(ema20), lastValid(ema50), lastValid(ema200));
  return t;
}
