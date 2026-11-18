// ↔️ Торговля в боковике: покупка у нижней границы, продажа у верхней.
//
// В боковике общая оценка монеты обычно около нуля (тренда нет, доводы «за» и «против» уравновешены), поэтому
// трендовая часть программы там сделок не находит — хотя именно в боковике у границ хорошие точки входа.
// Здесь — отдельная стратегия:
//
// 1. Боковик — за последние 4 дня (часовые свечи, без последних 3 часов) цена ходила между границами:
//    ширина от 3 до 14 часовых ATR (и от 1.2% до 15% цены), каждая граница тронута минимум дважды, цена
//    пересекла диапазон туда-обратно минимум 3 раза, наклона почти нет; режим рынка — боковик или переходный.
// 2. Вход — когда цена у границы (подошла в крайнюю треть диапазона): покупка у нижней, продажа у верхней.
//    Как и на ретесте: цена коснулась границы → закрытая 15-минутная свеча развернулась от неё → вход.
// 3. Стоп — за границей (не ближе 0.35 ATR и 6% ширины) и за минимумом касания. Цель 1 — середина
//    боковика (там половина фиксируется, стоп — в безубыток), цель 2 — у противоположной границы.
// 4. Не входим: часовая свеча закрылась за границей (боковик сломан — это уже пробой), общая оценка
//    сильно против, старший тренд против, свежая плохая новость или близкое макро-событие.
import { fmt } from './format.js';

const pctl = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };

/**
 * Боковик по часовым свечам h1 (закрытые, по возрастанию времени).
 * @returns {{ ok: boolean, why: string, low?: number, high?: number, mid?: number, width?: number, touchesLow?: number,
 *   touchesHigh?: number, rotations?: number, hours?: number, broken?: 'up'|'down'|null }}
 */
export function findRange(h1, { atr, lookback = 96, skipLast = 3 } = {}) {
  const n = h1?.length ?? 0;
  if (n < lookback + skipLast || !(atr > 0)) return { ok: false, why: 'мало истории' };
  const hist = h1.slice(n - lookback - skipLast, n - skipLast);
  const recent = h1.slice(n - skipLast);
  // границы — по крайним ценам без одиночных проколов: 2-й минимум и 2-й максимум из 96 часов
  const low = pctl(hist.map((c) => c.low), 0.01), high = pctl(hist.map((c) => c.high), 0.99);
  const width = high - low, mid = (low + high) / 2;
  const base = { low, high, mid, width, hours: lookback };
  if (!(width > 0)) return { ok: false, why: 'нет диапазона', ...base };
  const wAtr = width / atr, wPct = width / mid;
  if (wAtr < 3 || wPct < 0.012) return { ok: false, why: `диапазон узкий (${wAtr.toFixed(1)} ATR) — после комиссии зарабатывать негде`, ...base };
  if (wAtr > 14 || wPct > 0.15) return { ok: false, why: `диапазон широкий (${wAtr.toFixed(1)} ATR) — это не боковик, а движение`, ...base };
  // закрытия за пределами границ (кроме проколов фитилём) — диапазона нет
  const out = hist.filter((c) => c.close < low - 0.25 * atr || c.close > high + 0.25 * atr).length;
  if (out > 2) return { ok: false, why: 'цена закрывалась за границами диапазона', ...base };
  // наклон: если цена за 4 дня сместилась больше чем на 40% ширины — это тренд, а не боковик
  const k = hist.length, xs = (k - 1) / 2;
  const ys = hist.reduce((s, c) => s + c.close, 0) / k;
  let num = 0, den = 0;
  hist.forEach((c, i) => { num += (i - xs) * (c.close - ys); den += (i - xs) ** 2; });
  const drift = Math.abs((num / den) * (k - 1));
  if (drift > 0.4 * width) return { ok: false, why: 'у диапазона заметный наклон — это тренд, а не боковик', ...base };
  // касания границ и «прогоны» от одной к другой: зона границы — крайние 20% ширины
  const band = 0.2 * width;
  let side = 0, touchesLow = 0, touchesHigh = 0, rotations = 0;
  for (const c of hist) {
    const s = c.low <= low + band ? -1 : c.high >= high - band ? 1 : 0;
    if (!s || s === side) continue;
    if (s < 0) touchesLow++; else touchesHigh++;
    if (side) rotations++;
    side = s;
  }
  Object.assign(base, { touchesLow, touchesHigh, rotations });
  if (touchesLow < 2 || touchesHigh < 2 || rotations < 3) {
    return { ok: false, why: `границы подтверждены слабо (касаний снизу ${touchesLow}, сверху ${touchesHigh}, проходов через диапазон ${rotations})`, ...base };
  }
  // за последние часы закрытие за границей — боковик сломан
  const brk = recent.find((c) => c.close < low - 0.25 * atr || c.close > high + 0.25 * atr);
  if (brk) return { ok: false, why: `боковик сломан: часовая свеча закрылась ${brk.close < low ? 'ниже' : 'выше'} границы (${fmt(brk.close)})`, broken: brk.close < low ? 'down' : 'up', ...base };
  return { ok: true, why: `боковик ${fmt(low)}–${fmt(high)} (${(wPct * 100).toFixed(1)}%) за ${lookback / 24} дня: касаний снизу ${touchesLow}, сверху ${touchesHigh}`, broken: null, ...base };
}

/**
 * Сделка от границы боковика: направление (если цена в крайней четверти диапазона), уровень входа и план.
 * @param {object} rg — findRange
 * @param {{ price: number, atr: number, stopMult?: number, risk?: object, regimeKey?: string }} o
 * @returns {null | { dir: 'BUY'|'SELL', pos: number, plan: object }}
 */
export function rangeTrade(rg, { price, atr, stopMult = 1, risk = {}, regimeKey = 'range' }) {
  if (!rg?.ok || !['range', 'transition'].includes(regimeKey)) return null;
  const pos = (price - rg.low) / rg.width;
  // у границы — крайняя треть диапазона (вход — после разворота свечи у самой границы)
  const dir = pos <= 0.35 ? 'BUY' : pos >= 0.65 ? 'SELL' : null;
  if (!dir) return null;
  return { dir, pos, plan: rangePlan(rg, dir, { price, atr, stopMult, risk }) };
}

/** План сделки от границы боковика в формате buildPlan (plan.js) */
export function rangePlan(rg, dir, { price, atr, stopMult = 1, risk = {} }) {
  const buy = dir === 'BUY', s = buy ? 1 : -1, feePct = (risk.feePct ?? 0.2) / 100;
  const edge = 0.12 * rg.width;
  // уровень входа — граница боковика: крайние 12% диапазона
  const level = buy ? { low: rg.low, high: rg.low + edge } : { low: rg.high - edge, high: rg.high };
  const zone = buy ? [level.low, level.high + 0.15 * atr] : [level.low - 0.15 * atr, level.high];
  const entry = (zone[0] + zone[1]) / 2;
  const gap = Math.max(0.35 * atr * stopMult, 0.06 * rg.width);
  const stop = buy ? rg.low - gap : rg.high + gap;
  const t1 = rg.mid, t2 = buy ? rg.high - edge : rg.low + edge;
  const fee = entry * feePct, feeNow = price * feePct;
  const rr = ((t1 - entry) * s - fee) / ((entry - stop) * s + fee);
  const rrNow = (price - stop) * s > 0 ? ((t1 - price) * s - feeNow) / ((price - stop) * s + feeNow) : 0;
  let size = null;
  if (risk.deposit > 0 && risk.riskPct > 0) {
    const riskUsd = (risk.deposit * risk.riskPct) / 100, qty = riskUsd / ((entry - stop) * s + fee);
    size = { riskUsd, qty, notional: qty * entry, leverage: (qty * entry) / risk.deposit };
  }
  const box = `${fmt(rg.low)}–${fmt(rg.high)}`;
  return {
    dir, zone, entry, entryNow: price, stop, t1, t2, t3: null, rr, rrNow, size,
    notes: [`боковик ${box}: ${buy ? 'покупка у нижней' : 'продажа у верхней'} границы, стоп — за границей`],
    anchor: { ...level, strength: 1.5, sources: ['граница боковика'] },
    level: { ...level, strength: 1.5, sources: ['граница боковика'], role: 'range', box: { low: rg.low, high: rg.high, hours: rg.hours, touchesLow: rg.touchesLow, touchesHigh: rg.touchesHigh } },
    entryType: 'range',
    t1Why: ['середина боковика'], t2Why: [`${buy ? 'верхняя' : 'нижняя'} граница боковика`], t3Why: null,
    invalidation: `закрытие часовой свечи ${buy ? 'ниже' : 'выше'} ${fmt(stop)} — боковик сломан`,
    stopPct: stop / entry - 1, t1Pct: t1 / entry - 1, t2Pct: t2 / entry - 1,
  };
}

/** Запреты для сделки в боковике (score — общая оценка, thr — порог сигнала) */
export function rangeVetoes({ dir, score, thr, htf, btcScore, isBtc, badNews, macro, stock = false }, cfg) {
  const s = dir === 'BUY' ? 1 : -1, v = [];
  if (score * s <= -0.5 * thr) v.push(`общая оценка против (${score >= 0 ? '+' : '−'}${Math.abs(score).toFixed(2)}) — от границы не вхожу`);
  if (htf * s <= -0.6) v.push(`старший тренд (4h, 1d, неделя) против — граница боковика может не удержаться`);
  if (!isBtc && btcScore != null && btcScore * s <= -0.45) v.push(stock ? 'рынок акций сильно против' : 'биткоин сильно против');
  if (badNews) v.push(`свежая негативная новость (${badNews.event.toLowerCase()})`);
  if (macro && cfg.macro?.filter !== false) v.push(`рядом ${macro.name} — возможен выход из боковика`);
  return v;
}

