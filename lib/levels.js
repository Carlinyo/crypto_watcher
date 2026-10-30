// 1. Исторические уровни и зоны.
// Собираем уровни из многих источников и склеиваем близкие в зоны. У каждой зоны есть «сила»
// (сколько независимых причин держит цену) и список источников, например:
//   «61 200 – 61 450, сила 3.4: POC 4h, мин. прошлой недели, Фибо 0.618, стена покупок $3.2M».
import { volumeProfile } from './volumeProfile.js';
import { pivots, vwapRange, clamp, sum } from './indicators.js';

const DAY = 86400e3;
const dayKey = (t) => Math.floor(t / DAY);
const weekKey = (t) => { const d = new Date(t); return dayKey(t) - ((d.getUTCDay() + 6) % 7); }; // понедельник UTC
const monthKey = (t) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const ddmm = (t) => new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });

function groupBy(candles, keyFn) {
  const groups = [];
  for (const c of candles) {
    const k = keyFn(c.time);
    const g = groups[groups.length - 1];
    if (g && g.key === k) g.items.push(c); else groups.push({ key: k, items: [c] });
  }
  return groups.map((g) => ({
    key: g.key,
    start: g.items[0].time,
    open: g.items[0].open,
    high: Math.max(...g.items.map((c) => c.high)),
    low: Math.min(...g.items.map((c) => c.low)),
    close: g.items[g.items.length - 1].close,
    items: g.items,
  }));
}

function profileLevels(out, candles, name, base, weight) {
  if (!candles || candles.length < 30) return null;
  const vp = volumeProfile(candles, { bins: 80, valueArea: 0.7, weight });
  if (!vp) return null;
  out.push({ price: vp.poc, w: base.poc, label: `POC ${name}`, kind: 'poc' });
  out.push({ price: vp.vah, w: base.va, label: `VAH ${name}`, kind: 'va' });
  out.push({ price: vp.val, w: base.va, label: `VAL ${name}`, kind: 'va' });
  for (const h of vp.hvn) out.push({ price: h.price, w: base.hvn * (0.5 + 0.5 * h.rel), label: `узел объёма ${name}`, kind: 'hvn' });
  return vp;
}

// Непротестированные POC прошлых дней — цена часто к ним возвращается
function nakedPocs(h1, weight, price) {
  const days = groupBy(h1, dayKey).slice(0, -1).slice(-20);
  const out = [];
  for (const d of days) {
    if (d.items.length < 12) continue;
    const vp = volumeProfile(d.items, { bins: 30, weight });
    if (!vp) continue;
    const poc = vp.poc;
    const afterIdx = h1.findIndex((c) => c.time >= d.start + DAY);
    if (afterIdx < 0) continue;
    let touched = false;
    for (let i = afterIdx; i < h1.length; i++) if (h1[i].low <= poc && h1[i].high >= poc) { touched = true; break; }
    if (!touched && Math.abs(poc / price - 1) < 0.2) out.push({ price: poc, date: d.start });
  }
  return out;
}

function roundLevels(price) {
  // психологические уровни: «круглые» (×5) сильнее, «полукруглые» слабее; берём только ближайшие
  const m = 10 ** Math.floor(Math.log10(price));
  const out = [];
  const seen = new Set();
  for (const [st, w, k] of [[m / 2, 0.6, 1], [m / 10, 0.3, 2]]) {
    const below = Math.floor(price / st) * st;
    for (let j = -(k - 1); j <= k; j++) {
      const x = +(below + j * st).toPrecision(10);
      if (x <= 0 || seen.has(x) || Math.abs(x / price - 1) > 0.08) continue;
      seen.add(x);
      out.push({ price: x, w, label: 'круглый уровень', kind: 'round' });
    }
  }
  return out;
}

function classicPivots(H, L, C) {
  const P = (H + L + C) / 3;
  return { P, R1: 2 * P - L, S1: 2 * P - H, R2: P + (H - L), S2: P - (H - L) };
}

// Фибоначчи последнего крупного движения на 4h
function fibonacci(h4, atr4h) {
  if (!h4 || h4.length < 40 || !atr4h) return null;
  const w = h4.slice(-120);
  let hiI = 0, loI = 0;
  w.forEach((c, i) => { if (c.high > w[hiI].high) hiI = i; if (c.low < w[loI].low) loI = i; });
  const hi = w[hiI].high, lo = w[loI].low;
  if (hi - lo < 4 * atr4h) return null;
  const up = hiI > loI; // последнее движение вверх (коррекция вниз от максимума)
  const r = (k) => (up ? hi - k * (hi - lo) : lo + k * (hi - lo));
  const e = (k) => (up ? lo + k * (hi - lo) : hi - k * (hi - lo));
  return {
    up, hi, lo, startTime: w[up ? loI : hiI].time,
    levels: [[0.382, 0.5], [0.5, 0.55], [0.618, 0.8], [0.786, 0.5]].map(([k, wt]) => ({ k, price: r(k), w: wt })),
    ext: [[1.272, 0.4], [1.618, 0.5]].map(([k, wt]) => ({ k, price: e(k), w: wt })),
  };
}

// Равные максимумы/минимумы — там лежат стопы (ликвидность), цену туда тянет
function liquidityPools(pivHigh, pivLow, tol) {
  const pools = [];
  const scan = (list, side) => {
    const used = new Set();
    for (let i = 0; i < list.length; i++) {
      if (used.has(i)) continue;
      const grp = [list[i]];
      for (let j = i + 1; j < list.length; j++) if (Math.abs(list[j].price - list[i].price) <= tol) { grp.push(list[j]); used.add(j); }
      if (grp.length >= 2) {
        const p = side === 'high' ? Math.max(...grp.map((g) => g.price)) : Math.min(...grp.map((g) => g.price));
        pools.push({ price: p, side, count: grp.length });
      }
    }
  };
  scan(pivHigh, 'high'); scan(pivLow, 'low');
  return pools;
}

/** Склейка уровней в зоны */
export function clusterZones(cands, atr, price) {
  const items = cands
    .filter((c) => Number.isFinite(c.price) && c.price > 0 && c.w > 0)
    .map((c) => ({ ...c, low: c.low ?? c.price, high: c.high ?? c.price }))
    .sort((a, b) => a.low - b.low);
  const gap = 0.3 * atr, maxWidth = 1.0 * atr;
  const zones = [];
  for (const it of items) {
    const z = zones[zones.length - 1];
    if (z && it.low - z.high <= gap && Math.max(z.high, it.high) - z.low <= maxWidth) {
      z.items.push(it); z.high = Math.max(z.high, it.high);
    } else zones.push({ low: it.low, high: it.high, items: [it] });
  }
  for (const z of zones) {
    const sorted = [...z.items].sort((a, b) => b.w - a.w);
    z.strength = sorted.reduce((s, it, k) => s + it.w * 0.85 ** k, 0);
    const W = sum(z.items.map((i) => i.w));
    z.price = sum(z.items.map((i) => i.price * i.w)) / W;
    const labels = [];
    for (const it of sorted) if (!labels.includes(it.label)) labels.push(it.label);
    z.sources = labels;
    z.kinds = [...new Set(z.items.map((i) => i.kind))];
    z.side = z.high < price ? 'support' : z.low > price ? 'resistance' : 'inside';
    z.dist = z.side === 'support' ? price - z.high : z.side === 'resistance' ? z.low - price : 0;
    z.distAtr = atr ? z.dist / atr : 0;
    z.distPct = z.dist / price;
    delete z.items;
  }
  return zones;
}

/**
 * Собрать все уровни.
 * @param {object} p
 * @param {number} p.price, p.atr1h, p.atr4h
 * @param {Array} p.m15, p.h1, p.h4, p.d1 — свечи (последняя может быть незакрытой)
 * @param {(c)=>number} p.weight — объём свечи в $ (спот + фьючерсы)
 * @param {Array} p.extra — дополнительные уровни (стены стакана, FVG, ордер-блоки)
 */
export function buildLevels({ price, atr1h, atr4h, m15, h1, h4, d1, weight, extra = [] }) {
  const c = [];
  const profiles = {};
  const wgt = weight ?? ((x) => x.quoteVolume || x.volume * x.close);

  profiles.short = profileLevels(c, m15?.slice(-400), '15m (4 дня)', { poc: 0.8, va: 0.5, hvn: 0.45 }, wgt);
  profiles.mid = profileLevels(c, h1?.slice(-500), '1h (3 недели)', { poc: 1.1, va: 0.7, hvn: 0.6 }, wgt);
  profiles.long = profileLevels(c, h4?.slice(-500), '4h (3 месяца)', { poc: 1.4, va: 0.9, hvn: 0.8 }, wgt);
  profiles.macro = profileLevels(c, d1?.slice(-365), '1d (год)', { poc: 1.6, va: 1.0, hvn: 0.9 }, wgt);

  const naked = h1?.length > 48 ? nakedPocs(h1, wgt, price) : [];
  for (const n of naked) c.push({ price: n.price, w: 0.8, label: `непротестированный POC ${ddmm(n.date)}`, kind: 'naked_poc' });

  const prev = {};
  if (d1?.length >= 3) {
    const pd = d1[d1.length - 2];
    prev.day = { high: pd.high, low: pd.low, close: pd.close };
    c.push({ price: pd.high, w: 0.8, label: 'макс. вчера', kind: 'prev' }, { price: pd.low, w: 0.8, label: 'мин. вчера', kind: 'prev' });
    const pv = classicPivots(pd.high, pd.low, pd.close);
    c.push({ price: pv.P, w: 0.5, label: 'пивот дня P', kind: 'pivot' },
      { price: pv.R1, w: 0.45, label: 'пивот дня R1', kind: 'pivot' }, { price: pv.S1, w: 0.45, label: 'пивот дня S1', kind: 'pivot' },
      { price: pv.R2, w: 0.35, label: 'пивот дня R2', kind: 'pivot' }, { price: pv.S2, w: 0.35, label: 'пивот дня S2', kind: 'pivot' });

    const weeks = groupBy(d1, weekKey);
    if (weeks.length >= 2) {
      const pw = weeks[weeks.length - 2];
      prev.week = { high: pw.high, low: pw.low, close: pw.close };
      c.push({ price: pw.high, w: 1.0, label: 'макс. прошлой недели', kind: 'prev' }, { price: pw.low, w: 1.0, label: 'мин. прошлой недели', kind: 'prev' });
      const wp = classicPivots(pw.high, pw.low, pw.close);
      c.push({ price: wp.P, w: 0.7, label: 'пивот недели P', kind: 'pivot' },
        { price: wp.R1, w: 0.6, label: 'пивот недели R1', kind: 'pivot' }, { price: wp.S1, w: 0.6, label: 'пивот недели S1', kind: 'pivot' },
        { price: wp.R2, w: 0.45, label: 'пивот недели R2', kind: 'pivot' }, { price: wp.S2, w: 0.45, label: 'пивот недели S2', kind: 'pivot' });
    }
    const months = groupBy(d1, monthKey);
    if (months.length >= 2) {
      const pm = months[months.length - 2];
      prev.month = { high: pm.high, low: pm.low };
      c.push({ price: pm.high, w: 1.2, label: 'макс. прошлого месяца', kind: 'prev' }, { price: pm.low, w: 1.2, label: 'мин. прошлого месяца', kind: 'prev' });
    }
    const yr = d1.slice(-365);
    const yHi = Math.max(...yr.map((x) => x.high)), yLo = Math.min(...yr.map((x) => x.low));
    prev.year = { high: yHi, low: yLo, days: yr.length };
    c.push({ price: yHi, w: 1.0, label: `макс. за ${yr.length} дн.`, kind: 'extreme' }, { price: yLo, w: 1.0, label: `мин. за ${yr.length} дн.`, kind: 'extreme' });
  }

  const fib = fibonacci(h4?.slice(0, -1), atr4h);
  if (fib) {
    for (const l of fib.levels) c.push({ price: l.price, w: l.w, label: `Фибо ${l.k}`, kind: 'fib' });
    for (const l of fib.ext) c.push({ price: l.price, w: l.w, label: `расширение Фибо ${l.k}`, kind: 'fib' });
  }

  // свинг-уровни и ликвидность
  const pv1 = h1?.length > 20 ? pivots(h1.slice(0, -1).map((x) => x.high), h1.slice(0, -1).map((x) => x.low), 3, 3) : { highs: [], lows: [] };
  const pv4 = h4?.length > 20 ? pivots(h4.slice(0, -1).map((x) => x.high), h4.slice(0, -1).map((x) => x.low), 3, 3) : { highs: [], lows: [] };
  const recent = (list, n, minI) => list.filter((p) => p.i >= minI).slice(-n);
  for (const p of recent(pv1.highs, 8, (h1?.length ?? 0) - 200)) c.push({ price: p.price, w: 0.45, label: 'свинг-максимум 1h', kind: 'swing' });
  for (const p of recent(pv1.lows, 8, (h1?.length ?? 0) - 200)) c.push({ price: p.price, w: 0.45, label: 'свинг-минимум 1h', kind: 'swing' });
  for (const p of recent(pv4.highs, 8, 0)) c.push({ price: p.price, w: 0.7, label: 'свинг-максимум 4h', kind: 'swing' });
  for (const p of recent(pv4.lows, 8, 0)) c.push({ price: p.price, w: 0.7, label: 'свинг-минимум 4h', kind: 'swing' });
  const pools = liquidityPools(
    [...recent(pv1.highs, 12, (h1?.length ?? 0) - 240), ...recent(pv4.highs, 10, 0)],
    [...recent(pv1.lows, 12, (h1?.length ?? 0) - 240), ...recent(pv4.lows, 10, 0)],
    0.15 * (atr1h || price * 0.003),
  );
  for (const p of pools) {
    c.push({ price: p.price, w: 0.8, label: p.side === 'high' ? 'равные максимумы (скопление стопов)' : 'равные минимумы (скопление стопов)', kind: 'liquidity', poolSide: p.side });
  }

  for (const r of roundLevels(price)) c.push(r);

  // VWAP: недельный, месячный и от начала последнего крупного движения
  const vw = {};
  if (h1?.length > 24) {
    const wk = weekKey(h1[h1.length - 1].time);
    const wStart = h1.findIndex((x) => weekKey(x.time) === wk);
    if (wStart >= 0 && h1.length - wStart >= 6) { vw.week = vwapRange(h1, wStart); if (vw.week) c.push({ price: vw.week.vwap, w: 0.55, label: 'VWAP недели', kind: 'vwap' }); }
    const mk = monthKey(h1[h1.length - 1].time);
    const mStart = h1.findIndex((x) => monthKey(x.time) === mk);
    if (mStart >= 0 && h1.length - mStart >= 24) { vw.month = vwapRange(h1, mStart); if (vw.month) c.push({ price: vw.month.vwap, w: 0.65, label: 'VWAP месяца', kind: 'vwap' }); }
    if (fib) {
      const aStart = h1.findIndex((x) => x.time >= fib.startTime);
      if (aStart >= 0 && h1.length - aStart >= 12) { vw.anchored = vwapRange(h1, aStart); if (vw.anchored) c.push({ price: vw.anchored.vwap, w: 0.6, label: `VWAP от ${fib.up ? 'минимума' : 'максимума'} движения`, kind: 'vwap' }); }
    }
  }

  for (const e of extra) c.push(e);

  const near = c.filter((x) => Number.isFinite(x.price) && Math.abs(x.price / price - 1) < 0.25);
  const zones = clusterZones(near, atr1h || price * 0.005, price);
  const supports = zones.filter((z) => z.side === 'support').sort((a, b) => a.dist - b.dist);
  const resistances = zones.filter((z) => z.side === 'resistance').sort((a, b) => a.dist - b.dist);
  const inside = zones.filter((z) => z.side === 'inside').sort((a, b) => b.strength - a.strength);

  return { zones, supports, resistances, inside, profiles, naked, prev, fib, vwap: vw, pools };
}

const zoneText = (z, fmt) => `${fmt(z.low)}${z.high - z.low > z.price * 1e-4 ? `–${fmt(z.high)}` : ''} (сила ${z.strength.toFixed(1)}: ${z.sources.slice(0, 4).join(', ')})`;

/** Оценка блока «уровни» */
export function scoreLevels(lv, price, atr, closes, fmt, cfg = {}) {
  const prox = cfg.proximityAtr ?? 0.6;
  const items = [];
  const notes = [];
  const sig = (minS) => (z) => z.strength >= minS;
  const real = (z) => z.kinds.some((k) => k !== 'round');
  // откуда пришла цена: последние 5 закрытий
  const n = closes.length;
  const fromAbove = n > 5 && closes[n - 1] < closes[n - 6];

  let proxScore = 0;
  const ins = (lv.inside ?? []).find((z) => sig(0.9)(z) && real(z));
  if (ins) {
    // цена внутри зоны: роль зоны — по стенам стакана в ней, иначе по положению цены в зоне
    const bidWall = ins.sources.some((x) => x.startsWith('стена покупок')), askWall = ins.sources.some((x) => x.startsWith('стена продаж'));
    const pos = ins.high > ins.low ? (price - ins.low) / (ins.high - ins.low) : 0.5;
    const asSupport = bidWall !== askWall ? bidWall : pos >= 0.5 || (pos > 0.3 && fromAbove);
    const k = Math.min(1, ins.strength / 3) * 0.6;
    const v = asSupport ? k : -k;
    proxScore += v;
    items.push({ text: `Цена внутри зоны ${zoneText(ins, fmt)} — ${asSupport ? 'держится на ней как на поддержке' : 'упирается в неё как в сопротивление'}`, s: v * 0.55 });
  }
  const sup = lv.supports.find((z) => sig(0.9)(z) && real(z));
  const res = lv.resistances.find((z) => sig(0.9)(z) && real(z));
  if (sup && sup.distAtr <= prox) {
    const k = Math.min(1, sup.strength / 3) * (1 - 0.5 * (sup.distAtr / prox)) * (ins ? 0.5 : 1);
    proxScore += k;
    items.push({ text: `Цена у поддержки ${zoneText(sup, fmt)}`, s: k * 0.55 });
  }
  if (res && res.distAtr <= prox) {
    const k = Math.min(1, res.strength / 3) * (1 - 0.5 * (res.distAtr / prox)) * (ins ? 0.5 : 1);
    proxScore -= k;
    items.push({ text: `Цена у сопротивления ${zoneText(res, fmt)}`, s: -k * 0.55 });
  }

  // дорого/дёшево относительно долгой истории
  let value = 0;
  const vp = lv.profiles.long ?? lv.profiles.mid;
  if (vp) {
    if (price < vp.val) { value = 0.6; items.push({ text: `Цена ниже зоны основного объёма (VAL ${fmt(vp.val)}) — дёшево относительно последних месяцев`, s: 0.15 }); }
    else if (price > vp.vah) { value = -0.6; items.push({ text: `Цена выше зоны основного объёма (VAH ${fmt(vp.vah)}) — дорого относительно последних месяцев`, s: -0.15 }); }
    else value = clamp(((vp.poc - price) / (vp.vah - vp.val || 1)) * 0.8);
    notes.push(`POC 4h ${fmt(vp.poc)}, зона основного объёма ${fmt(vp.val)} – ${fmt(vp.vah)}`);
  }

  // запас хода: далеко ли до следующего сильного сопротивления по сравнению с поддержкой
  let room = 0;
  const rS = lv.supports.find((z) => z.strength >= 1.5 && real(z)), rR = lv.resistances.find((z) => z.strength >= 1.5 && real(z));
  if (rS && rR) {
    const dS = Math.max(rS.dist, 0.2 * atr), dR = Math.max(rR.dist, 0.2 * atr);
    room = clamp(Math.log(dR / dS) / Math.log(4));
    if (Math.abs(room) > 0.4) {
      items.push({ text: room > 0 ? `Свободный ход вверх: до сильного сопротивления ${fmt(rR.low)} дальше, чем до поддержки` : `Мало места для роста: сильное сопротивление ${fmt(rR.low)} ближе поддержки`, s: room * 0.1 });
    }
  }

  const lvn = lv.profiles.mid?.lvn?.some((x) => Math.abs(x - price) < (lv.profiles.mid.step || 0)) ;
  if (lvn) notes.push('цена в «пустоте» профиля объёма — возможен быстрый проход');
  if (lv.naked.length) notes.push(`непротестированные POC: ${lv.naked.slice(-4).map((x) => fmt(x.price)).join(', ')}`);

  const score = clamp(0.55 * clamp(proxScore) + 0.25 * value + 0.2 * room);
  return { score, items, notes };
}
