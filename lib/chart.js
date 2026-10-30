// Графики без внешних библиотек:
//   • chartPng — PNG для писем (Gmail не показывает SVG): свой растеризатор + кодировщик PNG на zlib;
//   • chartSvg — SVG для веб-панели.
// На графике: свечи 1h за 4 дня, объём, EMA20/EMA50, зоны поддержки (зелёные) и сопротивления (красные),
// зона входа (синяя), стоп, цели, текущая цена.
import zlib from 'node:zlib';
import { ema } from './indicators.js';
import { fmt } from './format.js';

// ── PNG ────────────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 5×7 точечный шрифт: цифры, латиница, знаки
const GLYPHS = {
  0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110', 2: '01110100010000100010001000100011111',
  3: '11110000010000101110000010000111110', 4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
  6: '00110010001000011110100011000101110', 7: '11111000010001000100010000100001000', 8: '01110100011000101110100011000101110',
  9: '01110100011000101111000010001001100', '.': '00000000000000000000000000110001100', ',': '00000000000000000000011000010001000',
  '-': '00000000000000011111000000000000000', '+': '00000001000010011111001000010000000', '%': '11000110010001000100010001001100011',
  '$': '00100011111010001110001011111000100', ':': '00000011000110000000011000110000000', '/': '00001000100001000100010000100010000',
  ' ': '00000000000000000000000000000000000', '(': '00010001000100001000010000010000010', ')': '01000001000001000010000100010001000',
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111', M: '10001110111010110101100011000110001',
  N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110', P: '11110100011000111110100001000010000',
  R: '11110100011000111110101001001010001', S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110', V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010',
  X: '10001100010101000100010101000110001', Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
};

class Canvas {
  constructor(w, h, bg = [255, 255, 255]) {
    this.w = w; this.h = h;
    this.px = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) { this.px[i * 3] = bg[0]; this.px[i * 3 + 1] = bg[1]; this.px[i * 3 + 2] = bg[2]; }
  }
  set(x, y, c, a = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    if (a >= 1) { this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2]; return; }
    for (let k = 0; k < 3; k++) this.px[i + k] = Math.round(c[k] * a + this.px[i + k] * (1 - a));
  }
  rect(x, y, w, h, c, a = 1) {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w)), y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.set(xx, yy, c, a);
  }
  hline(x0, x1, y, c, { dash = 0, a = 1, width = 1 } = {}) {
    for (let x = Math.round(x0); x <= Math.round(x1); x++) {
      if (dash && Math.floor((x - x0) / dash) % 2) continue;
      for (let k = 0; k < width; k++) this.set(x, Math.round(y) + k, c, a);
    }
  }
  vline(x, y0, y1, c, a = 1) { for (let y = Math.round(Math.min(y0, y1)); y <= Math.round(Math.max(y0, y1)); y++) this.set(x, y, c, a); }
  line(x0, y0, x1, y1, c, a = 1) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c, a);
  }
  text(x, y, str, c, s = 1) {
    let cx = Math.round(x);
    for (const ch of String(str).toUpperCase()) {
      const g = GLYPHS[ch] ?? GLYPHS[' '];
      for (let r = 0; r < 7; r++) for (let col = 0; col < 5; col++) if (g[r * 5 + col] === '1') this.rect(cx + col * s, y + r * s, s, s, c);
      cx += 6 * s;
    }
    return cx;
  }
  textWidth(str, s = 1) { return String(str).length * 6 * s; }
  png() {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      this.px.copy(raw, y * (this.w * 3 + 1) + 1, y * this.w * 3, (y + 1) * this.w * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  }
}

const COL = {
  grid: [234, 238, 242], text: [87, 96, 106], up: [26, 127, 55], down: [207, 34, 46], vol: [175, 184, 193],
  sup: [26, 127, 55], res: [207, 34, 46], entry: [9, 105, 218], stop: [207, 34, 46], target: [26, 127, 55],
  price: [31, 35, 40], ema20: [191, 135, 0], ema50: [130, 80, 223],
};

// общая разметка графика для PNG и SVG
function layout(r, candles, { w = 760, h = 380, bars = 96 } = {}) {
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const n = Math.min(bars, candles.length);
  const off = candles.length - n;
  const cs = candles.slice(off);
  const p = r.plan, buy = p.dir === 'BUY';
  const showPlan = r.action !== 'NEUTRAL';
  let lo = Math.min(...cs.map((c) => c.low)), hi = Math.max(...cs.map((c) => c.high));
  const extra = showPlan ? [p.stop, p.t1, p.zone[0], p.zone[1], r.price] : [r.price];
  for (const v of extra) if (Number.isFinite(v) && Math.abs(v / r.price - 1) < 0.25) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (showPlan && Number.isFinite(p.t2) && Math.abs(p.t2 / r.price - 1) < 0.12) { lo = Math.min(lo, p.t2); hi = Math.max(hi, p.t2); }
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad; hi += pad;
  const M = { l: 8, r: 96, t: 28, b: 8 };
  const volH = 46;
  const plotH = h - M.t - M.b - volH - 6;
  const plotW = w - M.l - M.r;
  const step = plotW / n;
  const X = (i) => M.l + step * (i + 0.5);
  const Y = (v) => M.t + ((hi - v) / (hi - lo)) * plotH;
  const vMax = Math.max(...cs.map((c) => c.volume)) || 1;
  const VY = M.t + plotH + 6 + volH;
  const zones = [
    ...r.levels.supports.slice(0, 3).map((z) => ({ ...z, kind: 'sup' })),
    ...r.levels.resistances.slice(0, 3).map((z) => ({ ...z, kind: 'res' })),
    ...(r.levels.inside ?? []).slice(0, 1).map((z) => ({ ...z, kind: 'ins' })),
  ].filter((z) => z.high >= lo && z.low <= hi);
  const lines = [];
  if (showPlan) {
    lines.push({ v: p.stop, c: 'stop', tag: 'SL', ru: 'стоп', dash: 6 });
    lines.push({ v: p.t1, c: 'target', tag: 'TP1', ru: 'цель 1', dash: 6 });
    if (p.t2 <= hi && p.t2 >= lo) lines.push({ v: p.t2, c: 'target', tag: 'TP2', ru: 'цель 2', dash: 3 });
  }
  lines.push({ v: r.price, c: 'price', tag: '', ru: '', dash: 2 });
  return { w, h, M, n, cs, off, e20, e50, lo, hi, X, Y, step, plotW, plotH, volH, VY, vMax, zones, lines, showPlan, buy, p };
}

// подписи справа не должны налезать друг на друга
function placeLabels(lines, Y, minGap = 13) {
  const items = lines.filter((l) => Number.isFinite(l.v)).map((l) => ({ ...l, y: Y(l.v) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < items.length; i++) if (items[i].y - items[i - 1].y < minGap) items[i].y = items[i - 1].y + minGap;
  return items;
}

export function chartPng(r, candles, opts = {}) {
  if (!candles || candles.length < 20) return null;
  const L = layout(r, candles, opts);
  const cv = new Canvas(L.w, L.h);
  const { M, X, Y } = L;
  // сетка и шкала
  for (let k = 0; k <= 4; k++) {
    const v = L.lo + ((L.hi - L.lo) * k) / 4;
    cv.hline(M.l, M.l + L.plotW, Y(v), COL.grid);
  }
  // зоны
  for (const z of L.zones) {
    const c = z.kind === 'sup' ? COL.sup : z.kind === 'res' ? COL.res : COL.text;
    const y0 = Y(Math.min(L.hi, z.high)), y1 = Y(Math.max(L.lo, z.low));
    cv.rect(M.l, y0, L.plotW, Math.max(2, y1 - y0), c, 0.1 + Math.min(0.12, z.strength * 0.025));
  }
  if (L.showPlan) {
    const y0 = Y(L.p.zone[1]), y1 = Y(L.p.zone[0]);
    cv.rect(M.l + L.plotW * 0.55, y0, L.plotW * 0.45, Math.max(3, y1 - y0), COL.entry, 0.22);
  }
  // объём и свечи
  L.cs.forEach((c, i) => {
    const x = X(i), up = c.close >= c.open;
    const col = up ? COL.up : COL.down;
    const vh = (c.volume / L.vMax) * L.volH;
    cv.rect(x - Math.max(1, L.step * 0.32), L.VY - vh, Math.max(2, L.step * 0.64), vh, COL.vol, 0.8);
    cv.vline(x, Y(c.high), Y(c.low), col);
    const bt = Y(Math.max(c.open, c.close)), bb = Y(Math.min(c.open, c.close));
    cv.rect(x - Math.max(1, L.step * 0.32), bt, Math.max(2, L.step * 0.64), Math.max(1, bb - bt), col);
  });
  // EMA
  for (const [arr, col] of [[L.e20, COL.ema20], [L.e50, COL.ema50]]) {
    let prev = null;
    L.cs.forEach((_, i) => {
      const v = arr[L.off + i];
      if (v == null) { prev = null; return; }
      const pt = [X(i), Y(v)];
      if (prev) cv.line(prev[0], prev[1], pt[0], pt[1], col, 0.9);
      prev = pt;
    });
  }
  // линии плана и подписи
  for (const l of L.lines) cv.hline(M.l, M.l + L.plotW, Y(l.v), COL[l.c], { dash: l.dash, width: l.c === 'price' ? 1 : 2 });
  for (const l of placeLabels(L.lines, Y)) {
    const x = M.l + L.plotW + 4;
    cv.rect(x - 2, l.y - 6, L.w - x, 13, COL[l.c], 0.12);
    const num = fmt(l.v).replace(/ /g, '');
    cv.text(x, l.y - 3, l.tag ? `${l.tag} ${num}` : num, COL[l.c], 1);
  }
  // заголовок
  const coin = r.symbol.replace(/USDT$/, '');
  let tx = cv.text(M.l, 8, `${coin}/USDT 1H`, COL.price, 2);
  tx = cv.text(tx + 10, 12, `EMA20`, COL.ema20, 1);
  tx = cv.text(tx + 8, 12, `EMA50`, COL.ema50, 1);
  if (L.showPlan) cv.text(tx + 8, 12, L.buy ? 'BUY ZONE' : 'SELL ZONE', COL.entry, 1);
  return cv.png();
}

export function chartSvg(r, candles, opts = {}) {
  if (!candles || candles.length < 20) return '';
  const L = layout(r, candles, { w: 900, h: 420, bars: 120, ...opts });
  const { M, X, Y } = L;
  const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.w} ${L.h}" style="width:100%;max-width:${L.w}px;background:#fff;border:1px solid #d0d7de" font-family="-apple-system,Segoe UI,Roboto,Arial,sans-serif" font-size="11">`);
  for (let k = 0; k <= 4; k++) {
    const v = L.lo + ((L.hi - L.lo) * k) / 4;
    o.push(`<line x1="${M.l}" x2="${M.l + L.plotW}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${rgb(COL.grid)}"/>`);
  }
  for (const z of L.zones) {
    const c = z.kind === 'sup' ? COL.sup : z.kind === 'res' ? COL.res : COL.text;
    const y0 = Y(Math.min(L.hi, z.high)), y1 = Y(Math.max(L.lo, z.low));
    o.push(`<rect x="${M.l}" y="${y0.toFixed(1)}" width="${L.plotW}" height="${Math.max(2, y1 - y0).toFixed(1)}" fill="${rgb(c, 0.1 + Math.min(0.12, z.strength * 0.025))}"><title>${z.sources.slice(0, 4).join(', ')} (сила ${z.strength.toFixed(1)})</title></rect>`);
  }
  if (L.showPlan) {
    const y0 = Y(L.p.zone[1]), y1 = Y(L.p.zone[0]);
    o.push(`<rect x="${(M.l + L.plotW * 0.55).toFixed(1)}" y="${y0.toFixed(1)}" width="${(L.plotW * 0.45).toFixed(1)}" height="${Math.max(3, y1 - y0).toFixed(1)}" fill="${rgb(COL.entry, 0.22)}"><title>зона входа</title></rect>`);
  }
  L.cs.forEach((c, i) => {
    const x = X(i), up = c.close >= c.open, col = rgb(up ? COL.up : COL.down);
    const bw = Math.max(2, L.step * 0.64);
    const vh = (c.volume / L.vMax) * L.volH;
    o.push(`<rect x="${(x - bw / 2).toFixed(1)}" y="${(L.VY - vh).toFixed(1)}" width="${bw.toFixed(1)}" height="${vh.toFixed(1)}" fill="${rgb(COL.vol, 0.8)}"/>`);
    o.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${Y(c.high).toFixed(1)}" y2="${Y(c.low).toFixed(1)}" stroke="${col}"/>`);
    const bt = Y(Math.max(c.open, c.close)), bb = Y(Math.min(c.open, c.close));
    o.push(`<rect x="${(x - bw / 2).toFixed(1)}" y="${bt.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bb - bt).toFixed(1)}" fill="${col}"/>`);
  });
  for (const [arr, col] of [[L.e20, COL.ema20], [L.e50, COL.ema50]]) {
    const pts = L.cs.map((_, i) => (arr[L.off + i] == null ? null : `${X(i).toFixed(1)},${Y(arr[L.off + i]).toFixed(1)}`)).filter(Boolean);
    if (pts.length > 1) o.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${rgb(col)}" stroke-width="1.2"/>`);
  }
  for (const l of L.lines) o.push(`<line x1="${M.l}" x2="${M.l + L.plotW}" y1="${Y(l.v).toFixed(1)}" y2="${Y(l.v).toFixed(1)}" stroke="${rgb(COL[l.c])}" stroke-width="${l.c === 'price' ? 1 : 1.6}" stroke-dasharray="${l.dash}"/>`);
  for (const l of placeLabels(L.lines, Y, 14)) {
    o.push(`<text x="${M.l + L.plotW + 5}" y="${(l.y + 4).toFixed(1)}" fill="${rgb(COL[l.c])}">${l.ru ? `${l.ru} ` : ''}${fmt(l.v)}</text>`);
  }
  o.push(`<text x="${M.l}" y="18" font-size="14" font-weight="600" fill="${rgb(COL.price)}">${r.symbol.replace(/USDT$/, '')}/USDT · 1h · ${L.n} свечей</text>`);
  o.push(`<text x="${M.l + 230}" y="18" fill="${rgb(COL.ema20)}">EMA20</text><text x="${M.l + 280}" y="18" fill="${rgb(COL.ema50)}">EMA50</text>`);
  o.push(`<text x="${M.l + 330}" y="18" fill="${rgb(COL.sup)}">▮ поддержки</text><text x="${M.l + 410}" y="18" fill="${rgb(COL.res)}">▮ сопротивления</text>`);
  if (L.showPlan) o.push(`<text x="${M.l + 515}" y="18" fill="${rgb(COL.entry)}">▮ зона входа</text>`);
  o.push('</svg>');
  return o.join('');
}
