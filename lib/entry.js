// 🎯 Вход на ретесте: не «вдогонку» за пробоем и не на первом касании зоны, а когда цена вернулась
// к уровню и он удержался.
//
// 1. Уровень для входа (план сделки, plan.js) — поддержка, к которой цена подходит сверху, или недавно
//    пробитое сопротивление, ставшее поддержкой (для продажи — зеркально). Уровень, к которому цена
//    подходит с другой стороны (для покупки — снизу), — это сопротивление, а не место для покупки.
// 2. Касание: цена вошла в зону входа (уровень и 0.15 ATR перед ним).
// 3. Подтверждение — закрытая 15-минутная свеча после касания: для покупки растущая (или закрылась над
//    уровнем), закрытие в верхней половине свечи, не ниже середины уровня и не дальше 0.6 ATR над ним.
// 4. Стоп — за уровнем и за минимумом ретеста (для продажи — за максимумом) с запасом 0.2 ATR.
// Отмена: часовая свеча после касания закрылась за уровнем (для покупки — ниже) — уровень не удержался.
import { fmt, fmtDate } from './format.js';
import { zoneEntry } from './policy.js';

export const M15 = 900e3;
const H = 3600e3;
const isClosed = (c, ms, now) => (c.closeTime != null ? c.closeTime < now : c.time + ms <= now);
const hhmm = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
/** Уровень строкой: «148.50–149.80», а уровень из одной цены — «149.80» */
export const levelStr = (L) => `${fmt(L.low)}${L.high - L.low > Math.abs(L.low) * 1e-4 ? `–${fmt(L.high)}` : ''}`;

/**
 * Роль уровня z ({ low, high }) для сделки в сторону dir по закрытиям часовых свечей h1 (последние lookback):
 * - 'breakout' — уровень недавно пробит в сторону сделки (для покупки: закрытие ниже уровня, потом выше) —
 *   главный кандидат на ретест; brokeAt — время свечи пробоя, volRatio — её объём к среднему за 20 часов;
 * - 'level' — цена давно на нужной стороне (для покупки — выше) и подходит к уровню оттуда;
 * - 'against' — последнее закрытие вне уровня было с другой стороны: цена подходит к нему «не с той стороны»;
 * - null — все закрытия внутри уровня или цена ходила сквозь него туда-обратно (chop) — роль не ясна.
 * Без истории (h1 пуст) — 'level'.
 */
export function levelRole(z, dir, h1, { lookback = 72 } = {}) {
  const buy = dir === 'BUY', n = h1?.length ?? 0;
  if (!n) return { role: 'level' };
  let other = -1, front = -1, side = 0, flips = 0;
  for (let i = Math.max(0, n - lookback); i < n; i++) {
    const c = h1[i].close, s = c > z.high ? 1 : c < z.low ? -1 : 0;
    if (s && side && s !== side) flips++;
    if (s) side = s;
    if (buy ? c < z.low : c > z.high) other = i;
    if (buy ? c > z.high : c < z.low) front = i;
  }
  if (other < 0 && front < 0) return { role: null };
  if (other > front) return { role: 'against' };
  // цена ходила сквозь уровень туда-обратно два раза и больше — это не уровень, а середина боковика
  if (flips >= 4) return { role: null, chop: true };
  if (other < 0) return { role: 'level' };
  let k = other + 1;
  while (k < front && !(buy ? h1[k].close > z.high : h1[k].close < z.low)) k++;
  const prev = h1.slice(Math.max(0, k - 20), k).map((c) => c.volume).filter((v) => v > 0);
  const avg = prev.length ? prev.reduce((s, v) => s + v, 0) / prev.length : 0;
  return { role: 'breakout', brokeAt: h1[k].time, age: n - 1 - k, volRatio: avg > 0 && h1[k].volume > 0 ? h1[k].volume / avg : null };
}

/** Цена дошла до зоны входа: для покупки — до верха зоны (с запасом 0.05 ATR), для продажи — до низа */
export const touches = (z, ext) => (z.dir === 'BUY' ? ext <= z.high + 0.05 * (z.atr || 0) : ext >= z.low - 0.05 * (z.atr || 0));

/**
 * Закрытая свеча c подтверждает, что уровень удержался (z: dir, level { low, high }, atr):
 * для покупки — растущая или закрылась над уровнем, закрытие в верхней половине свечи и не ниже середины уровня,
 * не дальше maxAway ATR над уровнем (дальше — вход был бы уже вдогонку); для продажи — зеркально.
 */
export function isConfirmation(z, c, { maxAway = 0.6 } = {}) {
  const buy = z.dir === 'BUY', L = z.level ?? z, atr = z.atr || 0;
  const range = c.high - c.low, mid = (L.low + L.high) / 2;
  const turn = buy ? c.close > c.open || c.close > L.high : c.close < c.open || c.close < L.low;
  const half = !(range > 0) || (buy ? c.close - c.low >= 0.5 * range : c.high - c.close >= 0.5 * range);
  const side = buy ? c.close >= mid : c.close <= mid;
  const near = buy ? c.close <= L.high + maxAway * atr : c.close >= L.low - maxAway * atr;
  return turn && half && side && near;
}

/**
 * Подтверждение ретеста по 15-минутным свечам с момента касания (z.touchedAt).
 * Решает последняя закрытая свеча; ext — минимум (для продажи — максимум) цены с касания — для стопа.
 * @returns {{ ok: boolean, why: string, ext: number|null, candle?: object, away?: boolean, below?: boolean }}
 */
export function confirmRetest(z, m15, { now = Date.now(), maxAway = 0.6 } = {}) {
  const buy = z.dir === 'BUY', atr = z.atr || 0, L = z.level ?? { low: z.low, high: z.high };
  const from = Math.floor((z.touchedAt ?? now) / M15) * M15;
  const list = (m15 ?? []).filter((c) => c.time >= from && isClosed(c, M15, now));
  let ext = Number.isFinite(z.touchExt) ? z.touchExt : null;
  for (const c of list) { const x = buy ? c.low : c.high; ext = ext == null ? x : buy ? Math.min(ext, x) : Math.max(ext, x); }
  const last = list[list.length - 1];
  if (!last) return { ok: false, ext, why: 'цена у уровня — жду закрытия 15-минутной свечи' };
  if (buy ? last.close < L.low - 0.1 * atr : last.close > L.high + 0.1 * atr) {
    return { ok: false, ext, below: true, why: `15-минутная свеча закрылась ${buy ? 'ниже' : 'выше'} уровня (${fmt(last.close)}) — жду, удержится ли он` };
  }
  if (isConfirmation(z, last, { maxAway })) {
    return { ok: true, ext, candle: last, why: `${buy ? 'отскок' : 'отбой вниз'} от уровня ${levelStr(L)}: цена ${buy ? 'опускалась' : 'поднималась'} до ${fmt(ext ?? (buy ? last.low : last.high))}, 15-минутная свеча ${hhmm(last.time)} закрылась на ${fmt(last.close)}` };
  }
  const away = buy ? last.close > L.high + maxAway * atr : last.close < L.low - maxAway * atr;
  return { ok: false, ext, away, why: away
    ? `цена отошла от уровня ${levelStr(L)} без подтверждения (${fmt(last.close)}) — вход отсюда был бы вдогонку, жду нового ретеста`
    : `цена у уровня ${levelStr(L)}, но 15-минутная свеча ${hhmm(last.time)} без разворота (${fmt(last.close)}) — жду подтверждения` };
}

/** Часовая свеча после касания закрылась за уровнем — уровень не удержался: причина строкой или null */
export function retestFailed(z, h1, { now = Date.now() } = {}) {
  if (!z.touchedAt || !h1?.length) return null;
  const buy = z.dir === 'BUY', L = z.level ?? z, atr = z.atr || 0;
  const bad = h1.find((c) => c.time + H > z.touchedAt && isClosed(c, H, now) && (buy ? c.close < L.low - 0.1 * atr : c.close > L.high + 0.1 * atr));
  return bad ? `уровень ${levelStr(L)} не удержался: часовая свеча закрылась ${buy ? 'ниже' : 'выше'} (${fmt(bad.close)})` : null;
}

/**
 * План входа на ретесте из свежего плана plan и зоны z: зона — та, которую ждали; стоп — не ближе стопа зоны
 * и за экстремумом ретеста ext с запасом 0.2 ATR; прибыль/риск — от текущей цены price.
 * @param {object} plan
 * @param {object} z
 * @param {{ price: number, ext?: number|null, atr: number, stopMult?: number, risk?: { feePct?: number, deposit?: number, riskPct?: number } }} opts
 */
export function retestPlan(plan, z, { price, ext = null, atr, stopMult = 1, risk = {} }) {
  const buy = z.dir === 'BUY', s = buy ? 1 : -1, feePct = (risk.feePct ?? 0.2) / 100;
  let stop = Number.isFinite(z.stop) ? z.stop : plan.stop;
  const byExt = Number.isFinite(ext) && (buy ? ext - 0.2 * atr * stopMult < stop : ext + 0.2 * atr * stopMult > stop);
  if (byExt) stop = buy ? ext - 0.2 * atr * stopMult : ext + 0.2 * atr * stopMult;
  const zone = [z.low, z.high];
  const entry = (zone[0] + zone[1]) / 2, fee = entry * feePct, feeNow = price * feePct;
  const rr = ((plan.t1 - entry) * s - fee) / ((entry - stop) * s + fee);
  const rrNow = (price - stop) * s > 0 ? ((plan.t1 - price) * s - feeNow) / ((price - stop) * s + feeNow) : 0;
  let size = plan.size;
  if (size && risk.deposit > 0 && risk.riskPct > 0) {
    const riskUsd = (risk.deposit * risk.riskPct) / 100, qty = riskUsd / ((entry - stop) * s + fee);
    size = { riskUsd, qty, notional: qty * entry, leverage: (qty * entry) / risk.deposit };
  }
  return {
    ...plan, zone, entry, stop, rr, rrNow, size,
    notes: byExt ? [...plan.notes, `стоп — за ${buy ? 'минимумом' : 'максимумом'} ретеста ${fmt(ext)}`] : plan.notes,
    invalidation: `закрытие часовой свечи ${buy ? 'ниже' : 'выше'} ${fmt(stop)}`,
    stopPct: stop / entry - 1, t1Pct: plan.t1 / entry - 1, t2Pct: plan.t2 / entry - 1,
  };
}

/**
 * Шаг живой проверки зоны входа на ретесте (каждые 5 с): price — цена сейчас, lo/hi — минимум и максимум с прошлого шага.
 * Меняет состояние зоны z (touchedAt, touchExt, checked15) и говорит, что делать:
 *   'wait' — цена ещё не дошла до уровня; 'touch' — только что коснулась; 'hold' — у уровня, ждём закрытия 15-минутной свечи;
 *   'check' — 15-минутная свеча закрылась: пора проверить подтверждение (свежий анализ);
 *   'away' — ушла от уровня дальше ATR без подтверждения: ждём нового касания.
 */
export function retestStep(z, { now = Date.now(), price, lo = price, hi = price }) {
  const buy = z.dir === 'BUY', L = z.level, ext = buy ? lo : hi;
  if (!z.touchedAt) {
    if (!touches(z, ext)) return 'wait';
    Object.assign(z, { touchedAt: now, touchExt: ext, checked15: Math.floor(now / M15) });
    return 'touch';
  }
  z.touchExt = Number.isFinite(z.touchExt) ? (buy ? Math.min(z.touchExt, ext) : Math.max(z.touchExt, ext)) : ext;
  if (buy ? price > L.high + z.atr : price < L.low - z.atr) {
    Object.assign(z, { touchedAt: null, touchExt: null, checked15: null });
    return 'away';
  }
  // проверка — через 5 с после закрытия каждой 15-минутной свечи (биржа успевает её отдать)
  const bucket = Math.floor((now - 5e3) / M15);
  if (z.checked15 != null && bucket <= z.checked15) return 'hold';
  z.checked15 = bucket;
  return 'check';
}

/**
 * Решение по ретесту после закрытия 15-минутной свечи: свежий анализ r, свечи m15 и h1 (последняя может быть незакрытой).
 * @returns {{ kind: 'fail'|'wait'|'away'|'no'|'entry', why: string, plan?: object, retest?: object, conf?: object, code?: string, flip?: boolean }}
 *   fail — уровень не удержался (часовая свеча закрылась за ним); wait — подтверждения пока нет; away — цена ушла без подтверждения;
 *   no — подтверждение есть, но свежий анализ вход не пускает (code, flip — как у zoneEntry); entry — входить по плану plan.
 */
export function retestEntry(z, r, { m15, h1, now = Date.now(), minRR = 1.5, triggerRatio = 0.7, risk = {} }) {
  const fail = retestFailed(z, h1, { now });
  if (fail) return { kind: 'fail', why: fail };
  const conf = confirmRetest(z, m15, { now });
  if (!conf.ok) return { kind: conf.away ? 'away' : 'wait', why: conf.why, conf };
  const plan = retestPlan(r.plan, z, { price: r.price, ext: conf.ext, atr: r.stats?.atr ?? z.atr, stopMult: r.regime?.stopMult ?? 1, risk });
  if (z.dir === 'BUY' ? !(plan.t1 > z.high) : !(plan.t1 < z.low)) return { kind: 'no', why: 'первая цель слишком близко к уровню — места для сделки нет', code: 'rr', flip: false, conf };
  const res = zoneEntry(z, { ...r, plan }, { minRR, triggerRatio });
  if (!res.ok) return { kind: 'no', why: res.why, code: res.code, flip: !!res.flip, conf };
  return { kind: 'entry', why: conf.why, plan, conf, retest: { level: z.level, ext: conf.ext, candle: conf.candle, why: conf.why, touchedAt: z.touchedAt } };
}

/** Уровень для писем: «пробитое сопротивление 148.50–149.80 (пробой 05.11 14:00, на объёме ×1.8)», «поддержка 97.85–98.22» */
export function levelText(level, dir) {
  if (!level) return null;
  const buy = dir === 'BUY', at = Number.isFinite(level.low) ? ` ${levelStr(level)}` : '';
  if (level.role === 'breakout') {
    const vol = level.volRatio >= 1.5 ? `, на объёме ×${level.volRatio.toFixed(1)}` : level.volRatio != null && level.volRatio < 0.8 ? ', без объёма — осторожно' : '';
    return `${buy ? 'пробитое сопротивление' : 'пробитая поддержка'}${at} (пробой ${fmtDate(level.brokeAt)}${vol})`;
  }
  return `${buy ? 'поддержка' : 'сопротивление'}${at}`;
}
