// План сделки по зонам: где входить, где стоп (за зоной и за скоплением стопов), где цели
// (у ближайших сильных зон сопротивления/поддержки и по целям фигур), прибыль/риск с учётом
// комиссий и размер позиции при заданном депозите и риске.
import { fmt } from './format.js';

export function buildPlan({ dir, price, atr, levels, stopMult = 1, patternTargets = [], risk = {} }) {
  const buy = dir === 'BUY';
  const s = buy ? 1 : -1;
  const feePct = (risk.feePct ?? 0.2) / 100;
  const minStop = 0.8 * atr * stopMult, maxStop = 3.5 * atr * stopMult;
  const notes = [];

  // зона входа — ближайшая значимая поддержка (для покупки) или сопротивление (для продажи)
  const real = (z) => z.kinds.some((k) => k !== 'round'); // зона только из круглых чисел — слабая опора
  const list = [...(levels.inside ?? []), ...(buy ? levels.supports : levels.resistances)].filter(real);
  const anchor = list.find((z) => z.strength >= 1.5 && z.dist <= 2.5 * atr) ?? list.find((z) => z.strength >= 0.8 && z.dist <= 1.5 * atr) ?? null;
  let zone, stop;
  if (anchor) {
    zone = buy ? [anchor.low, Math.min(price, anchor.high + 0.15 * atr)] : [Math.max(price, anchor.low - 0.15 * atr), anchor.high];
    if (zone[1] < zone[0]) zone = [anchor.low, anchor.high];
    stop = buy ? anchor.low - 0.3 * atr * stopMult : anchor.high + 0.3 * atr * stopMult;
  } else {
    zone = buy ? [price - 0.5 * atr, price] : [price, price + 0.5 * atr];
    stop = buy ? price - 1.5 * atr * stopMult : price + 1.5 * atr * stopMult;
  }

  // стоп — за скоплением чужих стопов (равные минимумы/максимумы), чтобы не выбило «охотой за стопами»
  const pool = (levels.pools || [])
    .filter((p) => p.side === (buy ? 'low' : 'high') && (buy ? p.price < stop + 0.1 * atr && p.price > stop - 0.6 * atr : p.price > stop - 0.1 * atr && p.price < stop + 0.6 * atr))
    .sort((a, b) => (buy ? a.price - b.price : b.price - a.price))[0];
  if (pool) { stop = buy ? Math.min(stop, pool.price - 0.2 * atr) : Math.max(stop, pool.price + 0.2 * atr); notes.push('стоп вынесен за скопление стопов (равные экстремумы)'); }

  const entry = (zone[0] + zone[1]) / 2;
  if ((entry - stop) * s < minStop) stop = entry - s * minStop;
  if ((entry - stop) * s > maxStop) { stop = entry - s * maxStop; notes.push('стоп ограничен 3.5 ATR — зона широкая'); }

  // цели
  const opp = (buy ? levels.resistances : levels.supports).filter((z) => (buy ? z.low > entry + 0.8 * atr : z.high < entry - 0.8 * atr) && z.strength >= 1.0 && real(z));
  const edge = (z) => (buy ? z.low - 0.05 * atr : z.high + 0.05 * atr);
  const t1z = opp[0] ?? null;
  const t1 = t1z ? edge(t1z) : entry + s * 2 * atr;
  const t2z = opp.find((z) => (buy ? z.low > t1 + atr : z.high < t1 - atr)) ?? null;
  const t2 = t2z ? edge(t2z) : t1 + s * 1.5 * atr;
  const pt = patternTargets.filter((t) => (buy ? t > t2 : t < t2)).sort((a, b) => (buy ? a - b : b - a))[0];
  const t3z = opp.find((z) => (buy ? z.low > t2 + atr : z.high < t2 - atr)) ?? null;
  const t3 = pt ?? (t3z ? edge(t3z) : null);

  const fee = entry * feePct;
  const rr = ((t1 - entry) * s - fee) / ((entry - stop) * s + fee);
  const feeNow = price * feePct;
  const rrNow = (price - stop) * s > 0 ? ((t1 - price) * s - feeNow) / ((price - stop) * s + feeNow) : 0;

  let size = null;
  if (risk.deposit > 0 && risk.riskPct > 0) {
    const riskUsd = (risk.deposit * risk.riskPct) / 100;
    const perUnit = (entry - stop) * s + fee;
    const qty = riskUsd / perUnit;
    size = { riskUsd, qty, notional: qty * entry, leverage: (qty * entry) / risk.deposit };
  }

  return {
    dir, zone, entry, entryNow: price, stop, t1, t2, t3, rr, rrNow, size, notes,
    anchor: anchor ? { low: anchor.low, high: anchor.high, strength: anchor.strength, sources: anchor.sources } : null,
    t1Why: t1z?.sources ?? ['по ATR'], t2Why: t2z?.sources ?? ['по ATR'], t3Why: pt ? ['цель фигуры'] : t3z?.sources ?? null,
    invalidation: `закрытие часовой свечи ${buy ? 'ниже' : 'выше'} ${fmt(stop)}`,
    stopPct: (stop / entry - 1), t1Pct: (t1 / entry - 1), t2Pct: (t2 / entry - 1),
  };
}
