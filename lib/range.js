const HOUR = 3600e3;
const average = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const quantile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.round((xs.length - 1) * p)];

function touches(bars, test) {
  let count = 0, last = -Infinity;
  for (const bar of bars) {
    if (bar.time - last >= 3 * HOUR && test(bar)) { count++; last = bar.time; }
  }
  return count;
}

/** Границы по 48 закрытым часам до свечи подтверждения. */
export function rangeSetup({ h1, m15, atr, price, regime, now, feePct }) {
  if (regime.key !== 'range' || !(atr > 0)) return null;
  const candle = m15?.at(-1) ?? h1.at(-1);
  const past = h1.filter((b) => b.closeTime < candle.time).slice(-48);
  if (past.length < 48) return null;
  const low = quantile(past.map((b) => b.low), 0.12);
  const high = quantile(past.map((b) => b.high), 0.88);
  const width = high - low;
  if (!(low > 0 && width >= 3 * atr)) return null;
  const drift = average(past.slice(-12).map((b) => b.close)) - average(past.slice(0, 12).map((b) => b.close));
  if (Math.abs(drift) > width * 0.3) return null;
  const edge = Math.min(0.35 * atr, width * 0.12);
  const lowerTests = touches(past, (b) => b.low <= low + edge && b.close >= low);
  const upperTests = touches(past, (b) => b.high >= high - edge && b.close <= high);
  if (lowerTests < 2 || upperTests < 2) return null;
  const mid = (low + high) / 2;
  const range = { low, high, mid, lowerTests, upperTests, plan: null };
  const inside = (p) => p >= low && p <= high;
  const prior = past.slice(-3);
  if (!inside(price) || !inside(candle.close) || prior.some((b) => b.close < low - edge || b.close > high + edge)) return range;
  const maxAge = m15?.length ? HOUR / 2 : HOUR * 2;
  if (!(candle.closeTime <= now && now - candle.closeTime <= maxAge)) return range;
  const buy = candle.low <= low + edge && candle.low >= low - atr * 0.6 &&
    candle.close >= low + edge && candle.close > candle.open && price <= low + width * 0.24;
  const sell = candle.high >= high - edge && candle.high <= high + atr * 0.6 &&
    candle.close <= high - edge && candle.close < candle.open && price >= high - width * 0.24;
  if (!buy && !sell) return range;
  const side = buy ? 1 : -1;
  const stop = buy ? Math.min(low, candle.low, price - atr * 0.4) - atr * 0.25
    : Math.max(high, candle.high, price + atr * 0.4) + atr * 0.25;
  const t2 = buy ? high - edge : low + edge;
  const fee = price * feePct / 100;
  const rr = ((mid - price) * side - fee) / ((price - stop) * side + fee);
  range.plan = {
    dir: buy ? 'BUY' : 'SELL', entryType: 'range', entry: price, entryNow: price,
    zone: buy ? [low, low + width * 0.24] : [high - width * 0.24, high],
    stop, t1: mid, t2, t3: null, rr, rrNow: rr, size: null,
    notes: ['Отбой от границы боковика подтверждён закрытой свечой'],
  };
  return range;
}
