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
