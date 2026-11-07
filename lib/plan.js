// План сделки по зонам: где входить, где стоп (за зоной и за скоплением стопов), где цели
// (у ближайших сильных зон сопротивления/поддержки и по целям фигур), прибыль/риск с учётом
// комиссий и размер позиции при заданном депозите и риске.
//
// mode 'retest' (по умолчанию) — зона входа только у уровня, от которого можно войти на ретесте
// (см. entry.js): свежий пробитый уровень или поддержка, к которой цена подходит сверху (для продажи —
// зеркально). Нет такого уровня рядом — точки входа нет (entryType 'none'): вдогонку программа не входит.
// mode 'legacy' — как в версии 2.7: ближайшая зона, а без неё — зона у текущей цены.
import { fmt } from './format.js';
import { levelRole } from './entry.js';

export function buildPlan({ dir, price, atr, levels, stopMult = 1, patternTargets = [], risk = {}, h1 = null, mode = 'retest' }) {
  const buy = dir === 'BUY';
  const s = buy ? 1 : -1;
  const feePct = (risk.feePct ?? 0.2) / 100;
  const minStop = 0.8 * atr * stopMult, maxStop = 3.5 * atr * stopMult;
  const notes = [];
  const retest = mode !== 'legacy';

  // зона входа — ближайшая значимая поддержка (для покупки) или сопротивление (для продажи)
  const real = (z) => z.kinds.some((k) => k !== 'round'); // зона только из круглых чисел — слабая опора
  const list = [...(levels.inside ?? []), ...(buy ? levels.supports : levels.resistances)].filter(real);
  let anchor = null, role = null;
  if (retest) {
    // свежий пробитый уровень (к нему цена вернётся на ретест), иначе поддержка, к которой цена подходит сверху;
    // уровень, к которому цена подходит с другой стороны (для покупки — снизу), — сопротивление, не место для входа
    const cands = list.map((z) => ({ z, r: levelRole(z, dir, h1) })).filter((x) => x.r.role === 'level' || x.r.role === 'breakout');
    const near = (x, k) => x.z.dist <= k * atr;
    const pick = cands.find((x) => x.r.role === 'breakout' && x.z.strength >= 0.8 && near(x, 3))
      ?? cands.find((x) => x.z.strength >= 1.5 && near(x, 2.5))
      ?? cands.find((x) => x.z.strength >= 0.8 && near(x, 1.5))
      ?? cands.find((x) => x.z.strength >= 1.5 && near(x, 4))
      // после сильного рывка главный пробитый уровень может быть дальше — ждём ретест и его
      ?? cands.find((x) => x.r.role === 'breakout' && x.z.strength >= 2 && near(x, 7));
    if (pick) { anchor = pick.z; role = pick.r; }
  } else {
    anchor = list.find((z) => z.strength >= 1.5 && z.dist <= 2.5 * atr) ?? list.find((z) => z.strength >= 0.8 && z.dist <= 1.5 * atr) ?? null;
  }
  let zone, stop;
  if (anchor) {
    zone = retest ? (buy ? [anchor.low, anchor.high + 0.15 * atr] : [anchor.low - 0.15 * atr, anchor.high])
      : buy ? [anchor.low, Math.min(price, anchor.high + 0.15 * atr)] : [Math.max(price, anchor.low - 0.15 * atr), anchor.high];
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
  // вход на ретесте пробитого уровня, а сопротивлений выше нет (цена у максимумов): цель — максимум после пробоя,
  // если он дальше обычной цели в 2 ATR (для продажи — минимум после пробоя)
  if (retest && role?.role === 'breakout' && !opp.length && h1?.length) {
    const recent = h1.filter((c) => c.time >= role.brokeAt);
    const ext = recent.length ? (buy ? Math.max(...recent.map((c) => c.high)) : Math.min(...recent.map((c) => c.low))) : NaN;
    if (Number.isFinite(ext) && (buy ? ext > entry + 2 * atr : ext < entry - 2 * atr)) opp.push({ low: ext, high: ext, strength: 1, sources: [buy ? 'максимум после пробоя' : 'минимум после пробоя'], kinds: ['swing'] });
  }
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

  if (retest && !anchor) notes.push('рядом нет уровня для входа на ретесте — вдогонку не вхожу');
  return {
    dir, zone, entry, entryNow: price, stop, t1, t2, t3, rr, rrNow, size, notes,
    anchor: anchor ? { low: anchor.low, high: anchor.high, strength: anchor.strength, sources: anchor.sources } : null,
    // уровень для входа на ретесте и тип входа: retest — ретест пробитого уровня, bounce — отскок от уровня,
    // none — уровня рядом нет (вход не ищем), legacy — как в 2.7
    level: retest && anchor ? { low: anchor.low, high: anchor.high, strength: anchor.strength, sources: anchor.sources, role: role.role, brokeAt: role.brokeAt ?? null, volRatio: role.volRatio ?? null } : null,
    entryType: !retest ? 'legacy' : !anchor ? 'none' : role.role === 'breakout' ? 'retest' : 'bounce',
    t1Why: t1z?.sources ?? ['по ATR'], t2Why: t2z?.sources ?? ['по ATR'], t3Why: pt ? ['цель фигуры'] : t3z?.sources ?? null,
    invalidation: `закрытие часовой свечи ${buy ? 'ниже' : 'выше'} ${fmt(stop)}`,
    stopPct: (stop / entry - 1), t1Pct: (t1 / entry - 1), t2Pct: (t2 / entry - 1),
  };
}
