// 4. Паттерны: свечные модели, фигуры, Smart Money Concepts, дивергенции.
// Работает по закрытым свечам одного таймфрейма; итоговую оценку с учётом таймфрейма
// и расположения у уровней собирает analyzer.
import { pivots, mean, sma, linreg } from './indicators.js';

const body = (k) => Math.abs(k.close - k.open);
const range = (k) => Math.max(k.high - k.low, 1e-12);
const green = (k) => k.close > k.open;
const red = (k) => k.close < k.open;
const upWick = (k) => k.high - Math.max(k.open, k.close);
const dnWick = (k) => Math.min(k.open, k.close) - k.low;

// ── свечные модели (последняя закрытая свеча и 2 предыдущие) ───────────────
function candlePatterns(c, atr) {
  const out = [];
  const n = c.length;
  if (n < 8) return out;
  const x = c[n - 1], b = c[n - 2], a = c[n - 3];
  const priorDown = c[n - 2].close < c[n - 7].close - 0.5 * atr;
  const priorUp = c[n - 2].close > c[n - 7].close + 0.5 * atr;
  const big = (k) => body(k) >= 0.6 * atr;
  const add = (name, score, extra = {}) => out.push({ name, score, kind: 'candle', ...extra });

  if (green(x) && red(b) && x.close >= b.open && x.open <= b.close && body(x) > body(b) * 1.05 && body(x) >= 0.4 * atr) add('бычье поглощение', priorDown ? 0.6 : 0.3, { dir: 1 });
  if (red(x) && green(b) && x.open >= b.close && x.close <= b.open && body(x) > body(b) * 1.05 && body(x) >= 0.4 * atr) add('медвежье поглощение', priorUp ? -0.6 : -0.3, { dir: -1 });

  const small = body(x) / range(x) < 0.35 && range(x) >= 0.6 * atr;
  if (small && dnWick(x) >= 2 * body(x) && upWick(x) <= Math.max(body(x), range(x) * 0.12)) {
    if (priorDown) add('молот', 0.5, { dir: 1 }); else if (priorUp) add('повешенный', -0.25, { dir: -1 });
  }
  if (small && upWick(x) >= 2 * body(x) && dnWick(x) <= Math.max(body(x), range(x) * 0.12)) {
    if (priorUp) add('падающая звезда', -0.5, { dir: -1 }); else if (priorDown) add('перевёрнутый молот', 0.25, { dir: 1 });
  }
  if (body(x) <= range(x) * 0.1 && range(x) >= 0.5 * atr) {
    if (dnWick(x) > 2.5 * upWick(x) && priorDown) add('доджи-стрекоза', 0.3, { dir: 1 });
    else if (upWick(x) > 2.5 * dnWick(x) && priorUp) add('доджи-надгробие', -0.3, { dir: -1 });
    else add('доджи — нерешительность', 0, { info: true });
  }
  if (red(a) && big(a) && body(b) < body(a) * 0.4 && green(x) && x.close > (a.open + a.close) / 2) add('утренняя звезда', 0.7, { dir: 1 });
  if (green(a) && big(a) && body(b) < body(a) * 0.4 && red(x) && x.close < (a.open + a.close) / 2) add('вечерняя звезда', -0.7, { dir: -1 });

  const sg = (k) => green(k) && body(k) >= 0.5 * range(k) && k.high - k.close <= 0.3 * range(k);
  const sr = (k) => red(k) && body(k) >= 0.5 * range(k) && k.close - k.low <= 0.3 * range(k);
  if (sg(a) && sg(b) && sg(x) && b.close > a.close && x.close > b.close && body(a) + body(b) + body(x) >= 2 * atr) add('три белых солдата', 0.6, { dir: 1 });
  if (sr(a) && sr(b) && sr(x) && b.close < a.close && x.close < b.close && body(a) + body(b) + body(x) >= 2 * atr) add('три чёрные вороны', -0.6, { dir: -1 });

  if (red(b) && big(b) && green(x) && x.open <= b.close + 0.05 * atr && x.close > (b.open + b.close) / 2 && x.close < b.open) add('просвет в облаках', 0.45, { dir: 1 });
  if (green(b) && big(b) && red(x) && x.open >= b.close - 0.05 * atr && x.close < (b.open + b.close) / 2 && x.close > b.open) add('завеса из тёмных облаков', -0.45, { dir: -1 });

  const tol = 0.1 * atr;
  if (red(b) && green(x) && Math.abs(b.low - x.low) <= tol && priorDown) add('пинцет снизу', 0.35, { dir: 1 });
  if (green(b) && red(x) && Math.abs(b.high - x.high) <= tol && priorUp) add('пинцет сверху', -0.35, { dir: -1 });

  if (x.high <= b.high && x.low >= b.low) add('внутренний бар — сжатие перед движением', 0, { info: true });
  if (body(x) >= 0.85 * range(x) && body(x) >= 1.3 * atr) add(green(x) ? 'марубозу — сильный импульс вверх' : 'марубозу — сильный импульс вниз', green(x) ? 0.35 : -0.35, { dir: green(x) ? 1 : -1 });
  return out;
}

// ── дивергенции ─────────────────────────────────────────────────────────────
function divergences(pv, osc, n, oscName, tol, maxAge) {
  const out = [];
  const [l1, l2] = pv.lows.slice(-2);
  const [h1, h2] = pv.highs.slice(-2);
  const ok = (p) => p && osc[p.i] != null && Number.isFinite(osc[p.i]);
  if (ok(l1) && ok(l2) && n - 1 - l2.i <= maxAge && l2.i - l1.i >= 5) {
    if (l2.price < l1.price && osc[l2.i] > osc[l1.i] + tol) out.push({ name: `бычья дивергенция ${oscName}`, score: 0.6, kind: 'divergence', dir: 1 });
    else if (l2.price > l1.price && osc[l2.i] < osc[l1.i] - tol) out.push({ name: `скрытая бычья дивергенция ${oscName} (продолжение роста)`, score: 0.35, kind: 'divergence', dir: 1 });
  }
  if (ok(h1) && ok(h2) && n - 1 - h2.i <= maxAge && h2.i - h1.i >= 5) {
    if (h2.price > h1.price && osc[h2.i] < osc[h1.i] - tol) out.push({ name: `медвежья дивергенция ${oscName}`, score: -0.6, kind: 'divergence', dir: -1 });
    else if (h2.price < h1.price && osc[h2.i] > osc[h1.i] + tol) out.push({ name: `скрытая медвежья дивергенция ${oscName} (продолжение падения)`, score: -0.35, kind: 'divergence', dir: -1 });
  }
  return out;
}

// ── двойные/тройные вершины и основания ────────────────────────────────────
function tops(H, L, C, pv, atr, n, fmt) {
  const out = [];
  const close = C[n - 1];
  const lowsR = pv.lows.filter((p) => p.i >= n - 100);
  const highsR = pv.highs.filter((p) => p.i >= n - 100);
  const near = (a, b) => Math.abs(a.price - b.price) <= 0.6 * atr;

  const bottoms = lowsR.slice(-3);
  if (bottoms.length >= 2) {
    const [p1, p2] = bottoms.slice(-2);
    const triple = bottoms.length === 3 && near(bottoms[0], p1) && near(p1, p2) && p2.i - bottoms[0].i >= 12;
    if (p2.i - p1.i >= 6 && near(p1, p2) && n - 1 - p2.i <= 40) {
      const from = triple ? bottoms[0].i : p1.i;
      const neck = Math.max(...H.slice(from, p2.i + 1));
      const bottom = Math.min(p1.price, p2.price);
      const name = triple ? 'тройное дно' : 'двойное дно';
      const brokeRecently = C.slice(-8).some((x, k, arr) => k > 0 && x > neck && arr[k - 1] <= neck);
      if (close > neck && brokeRecently) out.push({ name: `${name} (пробита шея ${fmt(neck)})`, score: triple ? 0.9 : 0.85, kind: 'chart', dir: 1, target: neck + (neck - bottom) });
      else if (close > bottom && close <= neck) out.push({ name: `формируется ${name}, шея ${fmt(neck)}`, score: 0.3, kind: 'chart', dir: 1, target: neck });
    }
  }
  const peaks = highsR.slice(-3);
  if (peaks.length >= 2) {
    const [p1, p2] = peaks.slice(-2);
    const triple = peaks.length === 3 && near(peaks[0], p1) && near(p1, p2) && p2.i - peaks[0].i >= 12;
    if (p2.i - p1.i >= 6 && near(p1, p2) && n - 1 - p2.i <= 40) {
      const from = triple ? peaks[0].i : p1.i;
      const neck = Math.min(...L.slice(from, p2.i + 1));
      const top = Math.max(p1.price, p2.price);
      const name = triple ? 'тройная вершина' : 'двойная вершина';
      const brokeRecently = C.slice(-8).some((x, k, arr) => k > 0 && x < neck && arr[k - 1] >= neck);
      if (close < neck && brokeRecently) out.push({ name: `${name} (пробита шея ${fmt(neck)})`, score: triple ? -0.9 : -0.85, kind: 'chart', dir: -1, target: neck - (top - neck) });
      else if (close < top && close >= neck) out.push({ name: `формируется ${name}, шея ${fmt(neck)}`, score: -0.3, kind: 'chart', dir: -1, target: neck });
    }
  }
  return out;
}

// ── «голова и плечи» и перевёрнутая ─────────────────────────────────────────
function headShoulders(H, L, C, pv, atr, n, fmt) {
  const out = [];
  const crossed = (lineAt, below) => {
    for (let j = n - 10; j < n; j++) {
      if (j < 1) continue;
      const prev = C[j - 1] - lineAt(j - 1), cur = C[j] - lineAt(j);
      if (below ? prev >= 0 && cur < 0 : prev <= 0 && cur > 0) return true;
    }
    return false;
  };
  const hs = pv.highs.filter((p) => p.i >= n - 120).slice(-3);
  if (hs.length === 3) {
    const [s1, hd, s2] = hs;
    if (hd.price > s1.price && hd.price > s2.price && Math.abs(s1.price - s2.price) <= 1.0 * atr
      && hd.price - Math.max(s1.price, s2.price) >= 0.5 * atr && n - 1 - s2.i <= 40) {
      let t1 = s1.i, t2 = hd.i;
      for (let j = s1.i; j <= hd.i; j++) if (L[j] < L[t1]) t1 = j;
      for (let j = hd.i; j <= s2.i; j++) if (L[j] < L[t2]) t2 = j;
      const neckAt = (i) => L[t1] + ((L[t2] - L[t1]) * (i - t1)) / Math.max(1, t2 - t1);
      const height = hd.price - neckAt(hd.i);
      if (C[n - 1] < neckAt(n - 1) && crossed(neckAt, true)) out.push({ name: `голова и плечи — пробита линия шеи ${fmt(neckAt(n - 1))}`, score: -0.9, kind: 'chart', dir: -1, target: neckAt(n - 1) - height });
      else if (C[n - 1] < s2.price && C[n - 1] > neckAt(n - 1)) out.push({ name: `формируется «голова и плечи», шея ${fmt(neckAt(n - 1))}`, score: -0.35, kind: 'chart', dir: -1 });
    }
  }
  const ls = pv.lows.filter((p) => p.i >= n - 120).slice(-3);
  if (ls.length === 3) {
    const [s1, hd, s2] = ls;
    if (hd.price < s1.price && hd.price < s2.price && Math.abs(s1.price - s2.price) <= 1.0 * atr
      && Math.min(s1.price, s2.price) - hd.price >= 0.5 * atr && n - 1 - s2.i <= 40) {
      let t1 = s1.i, t2 = hd.i;
      for (let j = s1.i; j <= hd.i; j++) if (H[j] > H[t1]) t1 = j;
      for (let j = hd.i; j <= s2.i; j++) if (H[j] > H[t2]) t2 = j;
      const neckAt = (i) => H[t1] + ((H[t2] - H[t1]) * (i - t1)) / Math.max(1, t2 - t1);
      const height = neckAt(hd.i) - hd.price;
      if (C[n - 1] > neckAt(n - 1) && crossed(neckAt, false)) out.push({ name: `перевёрнутая «голова и плечи» — пробита линия шеи ${fmt(neckAt(n - 1))}`, score: 0.9, kind: 'chart', dir: 1, target: neckAt(n - 1) + height });
      else if (C[n - 1] > s2.price && C[n - 1] < neckAt(n - 1)) out.push({ name: `формируется перевёрнутая «голова и плечи», шея ${fmt(neckAt(n - 1))}`, score: 0.35, kind: 'chart', dir: 1 });
    }
  }
  return out;
}

// ── треугольники, клинья, каналы (по линиям через свинг-точки) ─────────────
function fitLine(pts) {
  const xs = pts.map((p) => p.i), ys = pts.map((p) => p.price);
  const xm = mean(xs), ym = mean(ys);
  let num = 0, den = 0, tot = 0;
  for (let k = 0; k < pts.length; k++) { num += (xs[k] - xm) * (ys[k] - ym); den += (xs[k] - xm) ** 2; tot += (ys[k] - ym) ** 2; }
  const slope = den ? num / den : 0, b = ym - slope * xm;
  let res = 0;
  for (let k = 0; k < pts.length; k++) res += (ys[k] - (b + slope * xs[k])) ** 2;
  return { slope, at: (i) => b + slope * i, r2: tot ? 1 - res / tot : 1 };
}

function figures(H, L, C, V, pv, atr, n, fmt) {
  const hs = pv.highs.filter((p) => p.i >= n - 90).slice(-4);
  const ls = pv.lows.filter((p) => p.i >= n - 90).slice(-4);
  if (hs.length < 2 || ls.length < 2 || hs.length + ls.length < 5) return [];
  const up = fitLine(hs), lo = fitLine(ls);
  if ((hs.length >= 3 && up.r2 < 0.6) || (ls.length >= 3 && lo.r2 < 0.6)) return [];
  const norm = (s) => (s * 20) / atr;
  const sH = norm(up.slope), sL = norm(lo.slope);
  const start = Math.min(hs[0].i, ls[0].i);
  const wStart = up.at(start) - lo.at(start), wNow = up.at(n - 1) - lo.at(n - 1);
  if (wStart <= 0 || wNow <= 0.3 * atr) return [];
  const converging = wNow < wStart * 0.75;
  const parallel = !converging && Math.abs(sH - sL) < 0.4;
  const flat = (s) => Math.abs(s) < 0.4;
  let type = null, bias = 0, channel = false;
  if (converging) {
    if (flat(sH) && sL >= 0.4) { type = 'восходящий треугольник'; bias = 0.4; }
    else if (sH <= -0.4 && flat(sL)) { type = 'нисходящий треугольник'; bias = -0.4; }
    else if (sH <= -0.4 && sL >= 0.4) { type = 'симметричный треугольник'; bias = 0; }
    else if (sH >= 0.4 && sL >= 0.4 && sL > sH) { type = 'восходящий клин'; bias = -0.4; }
    else if (sH <= -0.4 && sL <= -0.4 && sH < sL) { type = 'нисходящий клин'; bias = 0.4; }
  } else if (parallel) {
    channel = true;
    if (sH >= 0.4) { type = 'восходящий канал'; bias = 0.2; }
    else if (sH <= -0.4) { type = 'нисходящий канал'; bias = -0.2; }
    else { type = 'боковой канал'; bias = 0; }
  }
  if (!type) return [];
  const upper = up.at(n - 1), lower = lo.at(n - 1), close = C[n - 1];
  const vAvg = mean(V.slice(-21, -1)) || 1;
  const volConf = V[n - 1] > 1.3 * vAvg;
  const wasInside = C[n - 6] <= up.at(n - 6) + 0.1 * atr && C[n - 6] >= lo.at(n - 6) - 0.1 * atr;
  const lines = `${fmt(lower)} – ${fmt(upper)}`;
  if (close > upper + 0.1 * atr && wasInside) {
    const s = (bias >= 0 ? 0.75 : 0.6) + (volConf ? 0.1 : 0);
    return [{ name: `${type}: пробой вверх${volConf ? ' на объёме' : ''}`, score: Math.min(0.9, s), kind: 'chart', dir: 1, target: close + (channel ? wNow : wStart) }];
  }
  if (close < lower - 0.1 * atr && wasInside) {
    const s = (bias <= 0 ? 0.75 : 0.6) + (volConf ? 0.1 : 0);
    return [{ name: `${type}: пробой вниз${volConf ? ' на объёме' : ''}`, score: -Math.min(0.9, s), kind: 'chart', dir: -1, target: close - (channel ? wNow : wStart) }];
  }
  if (close > upper + 0.1 * atr || close < lower - 0.1 * atr) return [];
  const pos = (close - lower) / (upper - lower);
  if (channel) {
    if (pos < 0.2 && bias >= 0) return [{ name: `${type}: цена у нижней границы (${lines})`, score: 0.35, kind: 'chart', dir: 1, target: upper }];
    if (pos > 0.8 && bias <= 0) return [{ name: `${type}: цена у верхней границы (${lines})`, score: -0.35, kind: 'chart', dir: -1, target: lower }];
    return [{ name: `${type} (${lines})`, score: bias * 0.5, kind: 'chart', dir: Math.sign(bias) }];
  }
  return [{ name: `${type} (${lines})`, score: bias * 0.6, kind: 'chart', dir: Math.sign(bias) }];
}

// ── флаги ──────────────────────────────────────────────────────────────────
function flagsP(H, L, C, atr, n, fmt) {
  let best = null;
  for (let pe = n - 20; pe <= n - 4; pe++) {
    if (pe < 12) continue;
    for (const dir of [1, -1]) {
      for (let k = 3; k <= 10; k++) {
        const move = (C[pe] - C[pe - k]) * dir;
        if (move < 3 * atr) continue;
        const cons = { hi: Math.max(...H.slice(pe + 1, n - 1)), lo: Math.min(...L.slice(pe + 1, n - 1)) };
        if (!Number.isFinite(cons.hi)) continue;
        const poleTop = dir > 0 ? Math.max(...H.slice(pe - k, pe + 1)) : Math.min(...L.slice(pe - k, pe + 1));
        const height = Math.abs(poleTop - C[pe - k]);
        const retrace = dir > 0 ? poleTop - cons.lo : cons.hi - poleTop;
        const held = dir > 0 ? cons.hi <= poleTop + 0.3 * atr : cons.lo >= poleTop - 0.3 * atr;
        // консолидация не должна продолжать движение флагштока (наклон по регрессии, без свечей прорыва)
        const consC = C.slice(pe + 1, n - 2);
        const drift = consC.length >= 2 ? linreg(consC).slope * consC.length * dir : 0;
        if (held && retrace <= 0.5 * height && drift <= 0.4 * atr && (!best || move > best.move)) best = { dir, pe, k, move, height, cons, poleTop };
      }
    }
  }
  if (!best) return [];
  const close = C[n - 1];
  const nm = best.dir > 0 ? 'бычий флаг' : 'медвежий флаг';
  if (best.dir > 0 && close > best.cons.hi) return [{ name: `${nm}: пробой вверх`, score: 0.75, kind: 'chart', dir: 1, target: close + best.height }];
  if (best.dir < 0 && close < best.cons.lo) return [{ name: `${nm}: пробой вниз`, score: -0.75, kind: 'chart', dir: -1, target: close - best.height }];
  return [{ name: `формируется ${nm} (граница ${fmt(best.dir > 0 ? best.cons.hi : best.cons.lo)})`, score: best.dir * 0.3, kind: 'chart', dir: best.dir }];
}

// ── Smart Money: снятие ликвидности, BOS/CHoCH, FVG, ордер-блоки ───────────
function sweepsP(c, pv, atr, n) {
  const out = [];
  for (let j = n - 2; j <= n - 1; j++) {
    const bar = c[j];
    const lows = pv.lows.filter((p) => p.i < j - 2 && p.i >= n - 60).reverse();
    for (const p of lows) {
      let firstTake = true;
      for (let m = p.i + 1; m < j; m++) if (c[m].low < p.price) { firstTake = false; break; }
      if (!firstTake) continue;
      if (bar.low < p.price && bar.close > p.price) {
        const strongWick = dnWick(bar) >= 0.5 * range(bar);
        out.push({ name: 'снятие ликвидности снизу (ложный пробой минимума)', score: strongWick ? 0.75 : 0.6, kind: 'smc', dir: 1 });
      }
      break;
    }
    const highs = pv.highs.filter((p) => p.i < j - 2 && p.i >= n - 60).reverse();
    for (const p of highs) {
      let firstTake = true;
      for (let m = p.i + 1; m < j; m++) if (c[m].high > p.price) { firstTake = false; break; }
      if (!firstTake) continue;
      if (bar.high > p.price && bar.close < p.price) {
        const strongWick = upWick(bar) >= 0.5 * range(bar);
        out.push({ name: 'снятие ликвидности сверху (ложный пробой максимума)', score: strongWick ? -0.75 : -0.6, kind: 'smc', dir: -1 });
      }
      break;
    }
  }
  return out.slice(-1);
}

function structureP(C, pv, n) {
  const hs = pv.highs.slice(-2), ls = pv.lows.slice(-2);
  let trend = 0;
  if (hs.length === 2 && ls.length === 2) {
    if (hs[1].price > hs[0].price && ls[1].price > ls[0].price) trend = 1;
    else if (hs[1].price < hs[0].price && ls[1].price < ls[0].price) trend = -1;
  }
  const out = [];
  const lastH = pv.highs[pv.highs.length - 1], lastL = pv.lows[pv.lows.length - 1];
  const fresh = (lvl, upDir) => {
    for (let j = n - 3; j < n; j++) {
      if (j < 1) continue;
      if (upDir ? C[j] > lvl && C[j - 1] <= lvl : C[j] < lvl && C[j - 1] >= lvl) return true;
    }
    return false;
  };
  if (lastH && fresh(lastH.price, true)) {
    out.push(trend < 0
      ? { name: 'смена характера рынка (CHoCH) вверх — слом нисходящей структуры', score: 0.6, kind: 'smc', dir: 1 }
      : { name: 'слом структуры вверх (BOS) — продолжение роста', score: 0.35, kind: 'smc', dir: 1 });
  }
  if (lastL && fresh(lastL.price, false)) {
    out.push(trend > 0
      ? { name: 'смена характера рынка (CHoCH) вниз — слом восходящей структуры', score: -0.6, kind: 'smc', dir: -1 }
      : { name: 'слом структуры вниз (BOS) — продолжение падения', score: -0.35, kind: 'smc', dir: -1 });
  }
  return { trend, events: out, lastHigh: lastH?.price, lastLow: lastL?.price };
}

function fvgZones(c, atr, n) {
  const bull = [], bear = [];
  for (let i = Math.max(2, n - 100); i < n; i++) {
    const a = c[i - 2], x = c[i];
    if (x.low > a.high && x.low - a.high >= 0.15 * atr) {
      let top = x.low, filled = false;
      for (let m = i + 1; m < n; m++) {
        if (c[m].low <= a.high) { filled = true; break; }
        top = Math.min(top, c[m].low);
      }
      if (!filled && top > a.high) bull.push({ low: a.high, high: top, i });
    }
    if (x.high < a.low && a.low - x.high >= 0.15 * atr) {
      let bottom = x.high, filled = false;
      for (let m = i + 1; m < n; m++) {
        if (c[m].high >= a.low) { filled = true; break; }
        bottom = Math.max(bottom, c[m].high);
      }
      if (!filled && bottom < a.low) bear.push({ low: bottom, high: a.low, i });
    }
  }
  return { bull: bull.slice(-4), bear: bear.slice(-4) };
}

function orderBlocks(c, atr, n) {
  const bull = [], bear = [];
  for (let i = Math.max(1, n - 80); i < n - 3; i++) {
    const k = c[i];
    const ahead = c.slice(i + 1, i + 4);
    const maxC = Math.max(...ahead.map((x) => x.close)), minC = Math.min(...ahead.map((x) => x.close));
    if (red(k) && green(c[i + 1]) && maxC - k.close >= 2.5 * atr) {
      let valid = true;
      for (let m = i + 4; m < n; m++) if (c[m].close < k.low) { valid = false; break; }
      if (valid) bull.push({ low: k.low, high: Math.max(k.open, k.close), i });
    }
    if (green(k) && red(c[i + 1]) && k.close - minC >= 2.5 * atr) {
      let valid = true;
      for (let m = i + 4; m < n; m++) if (c[m].close > k.high) { valid = false; break; }
      if (valid) bear.push({ low: Math.min(k.open, k.close), high: k.high, i });
    }
  }
  return { bull: bull.slice(-2), bear: bear.slice(-2) };
}

// ── пробой диапазона ───────────────────────────────────────────────────────
function rangeBreak(H, L, C, V, n) {
  if (n < 25) return [];
  const prevHigh = Math.max(...H.slice(-21, -1)), prevLow = Math.min(...L.slice(-21, -1));
  const vAvg = mean(V.slice(-21, -1)) || 1;
  const boost = V[n - 1] / vAvg;
  const out = [];
  if (C[n - 1] > prevHigh && C[n - 2] <= prevHigh) out.push({ name: `пробой максимума 20 свечей${boost > 1.5 ? ` на объёме ×${boost.toFixed(1)}` : ''}`, score: boost > 1.5 ? 0.6 : 0.3, kind: 'breakout', dir: 1 });
  if (C[n - 1] < prevLow && C[n - 2] >= prevLow) out.push({ name: `пробой минимума 20 свечей${boost > 1.5 ? ` на объёме ×${boost.toFixed(1)}` : ''}`, score: boost > 1.5 ? -0.6 : -0.3, kind: 'breakout', dir: -1 });
  return out;
}

/**
 * Найти паттерны на одном таймфрейме.
 * @param {Array} c — закрытые свечи
 * @param {object} ind — { rsi, macdHist, obv, cvd } массивы той же длины
 * @param {number} atr — текущий ATR этого таймфрейма
 */
export function detectPatterns(c, ind, atr, { fmt = String, maxDivAge = 12 } = {}) {
  const n = c.length;
  if (n < 40 || !atr) return { found: [], zones: [], structure: { trend: 0, events: [] }, pivots: { highs: [], lows: [] } };
  const H = c.map((x) => x.high), L = c.map((x) => x.low), C = c.map((x) => x.close), V = c.map((x) => x.volume);
  const pv = pivots(H, L, 3, 3);
  const found = [];

  found.push(...candlePatterns(c, atr));
  if (ind.rsi) found.push(...divergences(pv, ind.rsi, n, 'RSI', 2, maxDivAge));
  if (ind.macdHist) {
    const scale = mean(ind.macdHist.filter((x) => x != null).slice(-100).map(Math.abs)) || 0;
    found.push(...divergences(pv, ind.macdHist, n, 'MACD', scale * 0.15, maxDivAge).map((d) => ({ ...d, score: d.score * 0.7 })));
  }
  if (ind.cvd) {
    const scale = Math.abs(ind.cvd[n - 1] - ind.cvd[Math.max(0, n - 50)]) || 1;
    found.push(...divergences(pv, ind.cvd, n, 'дельты объёма (CVD)', scale * 0.05, maxDivAge).map((d) => ({ ...d, score: d.score * 0.8 })));
  }
  found.push(...tops(H, L, C, pv, atr, n, fmt));
  found.push(...headShoulders(H, L, C, pv, atr, n, fmt));
  found.push(...figures(H, L, C, V, pv, atr, n, fmt));
  found.push(...flagsP(H, L, C, atr, n, fmt));
  found.push(...sweepsP(c, pv, atr, n));
  const st = structureP(C, pv, n);
  found.push(...st.events);
  found.push(...rangeBreak(H, L, C, V, n));

  // зоны неэффективности (FVG) и ордер-блоки — как уровни и как ретест-паттерны
  const zones = [];
  const fv = fvgZones(c, atr, n), ob = orderBlocks(c, atr, n);
  const price = C[n - 1], lastLow = L[n - 1], lastHigh = H[n - 1];
  for (const z of fv.bull) {
    zones.push({ ...z, kind: 'fvg', side: 'bull' });
    if (lastLow <= z.high && price >= z.low) found.push({ name: `ретест бычьего FVG ${fmt(z.low)}–${fmt(z.high)}`, score: 0.3, kind: 'smc', dir: 1 });
  }
  for (const z of fv.bear) {
    zones.push({ ...z, kind: 'fvg', side: 'bear' });
    if (lastHigh >= z.low && price <= z.high) found.push({ name: `ретест медвежьего FVG ${fmt(z.low)}–${fmt(z.high)}`, score: -0.3, kind: 'smc', dir: -1 });
  }
  for (const z of ob.bull) {
    zones.push({ ...z, kind: 'ob', side: 'bull' });
    if (lastLow <= z.high && price >= z.low) found.push({ name: `ретест бычьего ордер-блока ${fmt(z.low)}–${fmt(z.high)}`, score: 0.4, kind: 'smc', dir: 1 });
  }
  for (const z of ob.bear) {
    zones.push({ ...z, kind: 'ob', side: 'bear' });
    if (lastHigh >= z.low && price <= z.high) found.push({ name: `ретест медвежьего ордер-блока ${fmt(z.low)}–${fmt(z.high)}`, score: -0.4, kind: 'smc', dir: -1 });
  }

  // фигура уже отработала: цена дошла до цели — сигнал слабый
  for (const p of found) {
    if (p.target && p.dir && (p.dir > 0 ? price >= p.target : price <= p.target)) {
      p.score *= 0.15;
      p.name += ' — цель уже достигнута';
      delete p.target;
    }
  }
  // одна запись на название (на случай повторов)
  const seen = new Set();
  const uniq = found.filter((p) => !seen.has(p.name) && seen.add(p.name));
  return { found: uniq, zones, structure: st, pivots: pv };
}

export const _test = { candlePatterns, divergences, tops, headShoulders, figures, flagsP, sweepsP, structureP, fvgZones, orderBlocks, rangeBreak, sma };
