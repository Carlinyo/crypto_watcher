// 🎲 Опционы Deribit (BTC и ETH) — как рынок оценивает будущее движение:
// • риск-реверсал 25Δ (разница подразумеваемой волатильности коллов и путов на ~30 дней): коллы дороже —
//   рынок закладывается на рост, путы дороже — платят за защиту от падения;
// • соотношение путов и коллов по открытому интересу;
// • «максимальная боль» — цена, при которой на экспирации обесценится больше всего опционов: перед крупной
//   экспирацией цену нередко тянет к ней;
// • подразумеваемая волатильность (IV) против фактической: IV заметно выше — рынок ждёт сильного движения.
// Данные — публичный API Deribit, без ключа.
import { getJSON } from './http.js';

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const DAY = 86400e3, YEAR = 365 * DAY;

/** BTC-27DEC26-90000-C → { cur: 'BTC', expiry (08:00 UTC), strike, type } */
export function parseOption(name) {
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/.exec(String(name));
  if (!m || MONTHS[m[3]] == null) return null;
  return { cur: m[1], expiry: Date.UTC(2000 + +m[4], MONTHS[m[3]], +m[2], 8), strike: +m[5].replace('d', '.'), type: m[6] };
}

// нормальное распределение (приближение Абрамовица — Стиган, точность ~1e-7)
function erf(x) {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
const N = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

/** Дельта опциона по Блэку (форвард F, страйк K, волатильность iv в долях, срок T в годах) */
export function bsDelta(type, F, K, iv, T) {
  const s = iv * Math.sqrt(T);
  if (!(s > 0) || !(F > 0) || !(K > 0)) return null;
  const d1 = (Math.log(F / K) + 0.5 * s * s) / s;
  return type === 'C' ? N(d1) : N(d1) - 1;
}

/** Цена «максимальной боли»: при ней покупатели опционов этой экспирации получат меньше всего */
export function maxPain(list) {
  const strikes = [...new Set(list.map((o) => o.strike))].sort((a, b) => a - b);
  let best = null, bestPain = Infinity;
  for (const S of strikes) {
    let pain = 0;
    for (const o of list) pain += o.oi * (o.type === 'C' ? Math.max(0, S - o.strike) : Math.max(0, o.strike - S));
    if (pain < bestPain) { bestPain = pain; best = S; }
  }
  return best;
}

// волатильность при заданной дельте — линейная интерполяция между соседними страйками
function ivAtDelta(points, target) {
  const p = points.filter((x) => x.delta != null).sort((a, b) => a.delta - b.delta);
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    if (a.delta <= target && target <= b.delta) return b.delta === a.delta ? a.iv : a.iv + ((b.iv - a.iv) * (target - a.delta)) / (b.delta - a.delta);
  }
  return null;
}

/**
 * Разбор книги опционов Deribit (ответ public/get_book_summary_by_currency, kind=option).
 * @returns {null | { spot, oiUsd, pcr, atmIv, rr25, tenorDays, expiries: Array, nextBig: object|null }}
 */
export function analyzeOptions(rows, { now = Date.now() } = {}) {
  const opts = [];
  for (const r of rows ?? []) {
    const o = parseOption(r.instrument_name);
    if (!o || o.expiry <= now) continue;
    opts.push({ ...o, oi: +r.open_interest || 0, iv: (+r.mark_iv || 0) / 100, F: +r.underlying_price || 0 });
  }
  if (opts.length < 20) return null;
  const groups = new Map();
  for (const o of opts) { const g = groups.get(o.expiry) ?? []; g.push(o); groups.set(o.expiry, g); }
  const expiries = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([ts, list]) => {
    const F = list.find((o) => o.F > 0)?.F ?? null;
    const calls = list.filter((o) => o.type === 'C').reduce((s, o) => s + o.oi, 0), puts = list.filter((o) => o.type === 'P').reduce((s, o) => s + o.oi, 0);
    return { ts, F, oi: calls + puts, oiUsd: (calls + puts) * (F ?? 0), pcr: calls > 0 ? puts / calls : null, maxPain: calls + puts > 0 ? maxPain(list) : null, list };
  });
  const spot = expiries[0].F;
  const oiUsd = expiries.reduce((s, e) => s + e.oiUsd, 0);
  const callsAll = opts.filter((o) => o.type === 'C').reduce((s, o) => s + o.oi, 0), putsAll = opts.filter((o) => o.type === 'P').reduce((s, o) => s + o.oi, 0);

  // ~30 дней: ближайшая к месяцу экспирация (от 2 недель до 2 месяцев)
  const tenor = expiries.filter((e) => e.ts - now >= 14 * DAY && e.ts - now <= 60 * DAY && e.F > 0)
    .sort((a, b) => Math.abs(a.ts - now - 30 * DAY) - Math.abs(b.ts - now - 30 * DAY))[0] ?? null;
  let atmIv = null, rr25 = null;
  if (tenor) {
    const T = (tenor.ts - now) / YEAR;
    const pts = tenor.list.filter((o) => o.iv > 0).map((o) => ({ ...o, delta: bsDelta(o.type, tenor.F, o.strike, o.iv, T) }));
    const c25 = ivAtDelta(pts.filter((o) => o.type === 'C'), 0.25), p25 = ivAtDelta(pts.filter((o) => o.type === 'P'), -0.25);
    if (c25 != null && p25 != null) rr25 = (c25 - p25) * 100;
    const atm = pts.filter((o) => o.iv > 0).sort((a, b) => Math.abs(a.strike - tenor.F) - Math.abs(b.strike - tenor.F)).slice(0, 2);
    if (atm.length) atmIv = atm.reduce((s, o) => s + o.iv, 0) / atm.length;
  }
  // крупная экспирация в ближайшие 7 дней — не меньше 10% всего открытого интереса
  const nextBig = expiries.find((e) => e.ts - now <= 7 * DAY && e.oiUsd >= oiUsd * 0.1) ?? null;
  const strip = ({ list, ...e }) => e;
  return {
    spot, oiUsd, pcr: callsAll > 0 ? putsAll / callsAll : null, atmIv, rr25, tenorDays: tenor ? Math.round((tenor.ts - now) / DAY) : null,
    expiries: expiries.slice(0, 4).map(strip), nextBig: nextBig ? strip(nextBig) : null,
  };
}

export class OptionsFeed {
  constructor(cfg) {
    this.cfg = cfg.options;
    this.cache = new Map();
    this.health = { ok: null, lastError: null };
  }

  /** Разбор опционов по монете (BTC, ETH); остальные монеты — null. Кэш — refreshMinutes. */
  async get(coin) {
    if (!this.cfg?.enabled || !this.cfg.currencies.includes(coin)) return null;
    const c = this.cache.get(coin);
    if (c && Date.now() - c.at < this.cfg.refreshMinutes * 60e3) return c.value;
    try {
      const j = await getJSON(`${this.cfg.api}/public/get_book_summary_by_currency?currency=${coin}&kind=option`, { tries: 2, timeout: 20000 });
      if (!Array.isArray(j?.result)) throw new Error(`Deribit: неожиданный ответ${j?.error?.message ? ` — ${String(j.error.message).slice(0, 80)}` : ''}`);
      const value = analyzeOptions(j.result);
      this.cache.set(coin, { at: Date.now(), okAt: Date.now(), value });
      this.health = { ok: true, lastError: null };
      return value;
    } catch (e) {
      this.health = { ok: false, lastError: e.message };
      // при сбое — последние данные, но не старше 2 часов; повтор через половину интервала
      const value = c && Date.now() - c.okAt < 2 * 3600e3 ? c.value : null;
      this.cache.set(coin, { at: Date.now() - this.cfg.refreshMinutes * 30e3, okAt: c?.okAt ?? 0, value });
      return value;
    }
  }
}
