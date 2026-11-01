// 🧲 Карта ликвидаций (оценка): где сработают принудительные закрытия позиций с плечом.
//
// Когда растёт открытый интерес, открываются новые позиции. По свече этого часа видно, по какой цене
// и кто был агрессором (покупки — больше новых лонгов, продажи — шортов). Новые позиции раскладываются
// по типичным плечам (10×, 25×, 50×, 100×): у лонга ликвидация ниже цены входа, у шорта — выше.
// Когда открытый интерес падает, позиции закрываются (пропорционально); уровни, через которые цена уже
// прошла, считаются сработавшими. Остаются «скопления ликвидаций» — цена часто тянется к крупным из них.
// Это оценка, как у карт ликвидаций Coinglass: настоящих позиций трейдеров биржа не показывает.

/** @type {Array<[number, number]>} плечо и доля новых позиций с ним */
export const LEVERAGE_TIERS = [[10, 0.3], [25, 0.3], [50, 0.25], [100, 0.15]];
const H = 3600e3;
const clampN = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * @param {{ oi: Array<{timestamp, sumOpenInterest, sumOpenInterestValue}>, candles: Array, price: number, atr?: number,
 *   tiers?: Array<[number, number]>, mmr?: number, period?: number, binPct?: number }} p
 *   oi — история открытого интереса (по часам), candles — часовые свечи той же монеты, price — цена сейчас;
 *   tiers — плечи и их доли, mmr — поддерживающая маржа, period — шаг истории, binPct — ширина «корзины»
 * @returns {null | { above: Array<{price, usd}>, below: Array<{price, usd}>, nearAbove: number, nearBelow: number, oiUsd: number, bias: number }}
 */
export function liquidationMap({ oi, candles, price, atr = null, tiers = LEVERAGE_TIERS, mmr = 0.005, period = H, binPct = 0.003 }) {
  if (!Array.isArray(oi) || oi.length < 24 || !candles?.length || !(price > 0)) return null;
  const bar = new Map(candles.map((c) => [Math.floor(c.time / period) * period, c]));
  const pts = oi.map((x) => ({ t: +x.timestamp, qty: +x.sumOpenInterest, usd: +x.sumOpenInterestValue }))
    .filter((x) => x.t > 0 && x.qty > 0 && x.usd > 0).sort((a, b) => a.t - b.t);
  if (pts.length < 24) return null;
  let active = []; // { side, liq, usd }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const c = bar.get(Math.floor(a.t / period) * period); // свеча интервала между двумя замерами
    if (!c) continue;
    // цена прошла через уровни — эти позиции ликвидированы
    active = active.filter((x) => (x.side === 'long' ? c.low > x.liq : c.high < x.liq));
    const dUsd = (b.qty - a.qty) * (b.usd / b.qty);
    if (dUsd > 0) {
      const p = (c.high + c.low + c.close) / 3;
      const taker = c.volume > 0 && c.takerBuy >= 0 ? c.takerBuy / c.volume : 0.5;
      const longShare = clampN(taker, 0.25, 0.75);
      for (const [lev, w] of tiers) {
        active.push({ side: 'long', liq: p * (1 - 1 / lev + mmr), usd: dUsd * longShare * w });
        active.push({ side: 'short', liq: p * (1 + 1 / lev - mmr), usd: dUsd * (1 - longShare) * w });
      }
    } else if (dUsd < 0) {
      // позиции закрываются — уменьшаем все пропорционально
      const total = active.reduce((s, x) => s + x.usd, 0);
      const k = total > 0 ? Math.max(0, 1 + dUsd / total) : 0;
      for (const x of active) x.usd *= k;
    }
  }
  // уровни, которые цена прошла после последнего замера
  const lastT = pts[pts.length - 1].t;
  for (const c of candles) if (c.time >= lastT) active = active.filter((x) => (x.side === 'long' ? c.low > x.liq : c.high < x.liq));

  // скопления: склеиваем в «корзины» по 0.3% цены
  const bins = new Map();
  for (const x of active) {
    if (x.usd <= 0 || (x.side === 'long' ? x.liq >= price : x.liq <= price)) continue;
    const k = `${x.side}:${Math.round(Math.log(x.liq / price) / Math.log(1 + binPct))}`;
    const b = bins.get(k) ?? { side: x.side, w: 0, usd: 0 };
    b.usd += x.usd; b.w += x.usd * x.liq;
    bins.set(k, b);
  }
  const list = [...bins.values()].map((b) => ({ side: b.side, price: b.w / b.usd, usd: b.usd }));
  const near = (side) => {
    const lim = Math.max(atr ? 3 * atr : 0, price * 0.03);
    return list.filter((x) => x.side === side && Math.abs(x.price - price) <= lim).reduce((s, x) => s + x.usd, 0);
  };
  const top = (side) => list.filter((x) => x.side === side && Math.abs(x.price / price - 1) <= 0.15).sort((a, b) => b.usd - a.usd).slice(0, 3).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  const nearAbove = near('short'), nearBelow = near('long');
  const oiUsd = pts[pts.length - 1].usd;
  // перевес: где скопилось больше ликвидаций рядом с ценой, туда её чаще и «тянет»
  const bias = nearAbove + nearBelow > oiUsd * 0.01 ? (nearAbove - nearBelow) / (nearAbove + nearBelow) : 0;
  return { above: top('short'), below: top('long'), nearAbove, nearBelow, oiUsd, bias };
}
