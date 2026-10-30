// Помощники для тестов: свечи из ряда цен закрытия
export function candlesFrom(closes, { wick = 0.3, start = Date.UTC(2026, 0, 1), step = 3600e3, volume = 100 } = {}) {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return {
      time: start + i * step, closeTime: start + (i + 1) * step - 1,
      open: o, close: c, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick,
      volume, quoteVolume: volume * c, takerBuy: volume / 2, takerBuyQuote: (volume * c) / 2, trades: 10,
    };
  });
}

// прямая линия от a до b за n шагов (без первой точки)
export function leg(a, b, n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

export function path(...pts) {
  // path([100], [110, 5], [100, 5]) — от 100 до 110 за 5 баров, потом до 100 за 5
  let cur = pts[0][0];
  const out = [cur];
  for (const [to, n] of pts.slice(1)) { out.push(...leg(cur, to, n)); cur = to; }
  return out;
}

export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
