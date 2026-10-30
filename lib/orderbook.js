// Стакан заявок (спот + фьючерсы Binance):
// • перекос покупок и продаж в пределах ±0.5%, ±1%, ±2% от цены;
// • «стены» — аномально крупные заявки; отслеживается, сколько они стоят;
// • судьба исчезнувших стен: «съедена» (цена прошла сквозь неё) или «снята при подходе цены»
//   (часто так выглядит спуфинг — фальшивая поддержка/сопротивление).
import { clamp, median } from './indicators.js';
import { fmtUsd, fmt } from './format.js';

const BPS = 0.0005; // ширина «корзины» цен — 0.05%
const LOG_STEP = Math.log(1 + BPS);
const bucketOf = (p) => Math.floor(Math.log(p) / LOG_STEP);
const bucketPrice = (b) => Math.exp((b + 0.5) * LOG_STEP);
const BANDS = { b05: 0.005, b1: 0.01, b2: 0.02 };
const MARKET_RU = { spot: 'спот', futures: 'фьючерсы' };

export class OrderBookTracker {
  constructor(cfg) {
    this.cfg = cfg.orderbook;
    this.walls = new Map();  // symbol → Map(key → стена)
    this.events = new Map(); // symbol → [{t, side, market, price, usd, fate}]
  }

  /**
   * @param {string} symbol спот-символ
   * @param {{spot?:{bids,asks}, futures?:{bids,asks,mult}}} books
   * @param {number} price текущая цена
   * @param {number} atr ATR 1h
   * @param {{hi:number,lo:number}|null} range мин/макс цены с прошлой проверки
   * @param {{spot?:number,futures?:number}} whaleThr пороги китов (масштаб «крупной» стены)
   */
  analyze(symbol, books, price, atr, range, whaleThr = {}) {
    const c = this.cfg;
    const now = Date.now();
    const depth = { bid: { b05: 0, b1: 0, b2: 0 }, ask: { b05: 0, b1: 0, b2: 0 } };
    const found = [];
    const coverage = {};

    for (const [market, book] of Object.entries(books)) {
      if (!book?.bids?.length || !book?.asks?.length) continue;
      const mult = book.mult ?? 1;
      // докуда реально видно стакан с каждой стороны — перекос считаем только в общей глубине
      const bidReach = Math.abs(book.bids[book.bids.length - 1][0] / mult / price - 1);
      const askReach = Math.abs(book.asks[book.asks.length - 1][0] / mult / price - 1);
      const reach = Math.min(bidReach, askReach, 0.03);
      coverage[market] = reach;
      const minWall = Math.max(c.wallMinUsd, (whaleThr[market] ?? c.wallMinUsd * 2) * c.wallWhaleShare);

      for (const side of ['bid', 'ask']) {
        const levels = side === 'bid' ? book.bids : book.asks;
        const buckets = new Map();
        for (const [pRaw, q] of levels) {
          const p = pRaw / mult, usd = pRaw * q;
          const dist = Math.abs(p / price - 1);
          if (dist > 0.03) continue;
          if (dist <= reach) for (const [k, w] of Object.entries(BANDS)) if (dist <= Math.min(w, reach)) depth[side][k] += usd;
          const b = bucketOf(p);
          buckets.set(b, (buckets.get(b) || 0) + usd);
        }
        const vals = [...buckets.values()];
        if (vals.length < 8) continue;
        const med = median(vals);
        for (const [b, usd] of buckets) {
          if (usd >= Math.max(c.wallMult * med, minWall)) {
            found.push({ key: `${market}:${side}:${b}`, market, side, price: bucketPrice(b), usd, ratio: usd / med, minWall });
          }
        }
      }
    }

    // ── живучесть стен ──
    let map = this.walls.get(symbol);
    if (!map) { map = new Map(); this.walls.set(symbol, map); }
    const seen = new Set();
    for (const w of found) {
      seen.add(w.key);
      const prev = map.get(w.key);
      if (prev) { prev.polls++; prev.lastSeen = now; prev.usd = w.usd; prev.maxUsd = Math.max(prev.maxUsd, w.usd); prev.ratio = w.ratio; }
      else map.set(w.key, { ...w, firstSeen: now, lastSeen: now, polls: 1, maxUsd: w.usd });
    }
    let ev = this.events.get(symbol) ?? [];
    for (const [k, w] of map) {
      if (seen.has(k)) continue;
      map.delete(k);
      if (w.polls < c.persistPolls) continue;
      // стена «переехала» вслед за ценой (похожая по размеру появилась рядом) — это не событие
      const moved = found.some((f) => f.market === w.market && f.side === w.side && Math.abs(f.price / w.price - 1) < 0.004 && f.usd > w.usd * 0.6 && f.usd < w.usd * 1.6);
      if (moved) continue;
      const touched = range
        ? (w.side === 'bid' ? range.lo <= w.price * (1 + BPS) : range.hi >= w.price * (1 - BPS))
        : Math.abs(price / w.price - 1) < BPS;
      const near = Math.abs(price / w.price - 1) < 0.004
        || (range && (w.side === 'bid' ? range.lo <= w.price * 1.004 : range.hi >= w.price * 0.996));
      const fate = touched ? 'eaten' : near ? 'pulled' : null;
      if (fate) ev.push({ t: now, side: w.side, market: w.market, price: w.price, usd: w.maxUsd, fate, polls: w.polls });
    }
    ev = ev.filter((e) => now - e.t < 2 * 3600e3).slice(-40);
    this.events.set(symbol, ev);

    const walls = [...map.values()]
      .filter((w) => w.polls >= 2)
      .map((w) => ({ ...w, distPct: w.price / price - 1, distAtr: atr ? Math.abs(w.price - price) / atr : null, ageMin: (now - w.firstSeen) / 60e3 }))
      .sort((a, b) => b.usd - a.usd);

    // ── оценка ──
    const imb = (k) => { const b = depth.bid[k], a = depth.ask[k]; return b + a > 0 ? (b - a) / (b + a) : 0; };
    const imbalance = { b05: imb('b05'), b1: imb('b1'), b2: imb('b2') };
    const items = [], notes = [];
    if (depth.bid.b1 + depth.ask.b1 > 0) {
      notes.push(`стакан ±1%: покупки ${fmtUsd(depth.bid.b1)} / продажи ${fmtUsd(depth.ask.b1)} (перекос ${imbalance.b1 >= 0 ? '+' : ''}${(imbalance.b1 * 100).toFixed(0)}%)`);
    }
    const imbScore = clamp(0.6 * imbalance.b1 + 0.2 * imbalance.b05 + 0.2 * imbalance.b2) * 1.4;
    if (Math.abs(imbalance.b1) >= 0.2) {
      items.push({ text: `В стакане ±1% ${imbalance.b1 > 0 ? 'заметно больше заявок на покупку' : 'заметно больше заявок на продажу'} (${(imbalance.b1 * 100).toFixed(0)}%)`, s: clamp(imbScore) * 0.45 });
    }

    let wallScore = 0;
    const strength = (w) => Math.min(1, 0.35 + 0.3 * Math.log2(w.usd / w.minWall + 1)) * Math.min(1, 0.5 + w.polls / 10);
    const bidW = walls.filter((w) => w.side === 'bid' && w.price < price && w.distAtr != null && w.distAtr <= 2).sort((a, b) => b.price - a.price)[0];
    const askW = walls.filter((w) => w.side === 'ask' && w.price > price && w.distAtr != null && w.distAtr <= 2).sort((a, b) => a.price - b.price)[0];
    if (bidW) {
      const v = strength(bidW) * (1 - bidW.distAtr / 2.5) * 0.35;
      wallScore += v;
      items.push({ text: `Стена покупок ${fmtUsd(bidW.usd)} на ${fmt(bidW.price)} (${MARKET_RU[bidW.market]}, держится ${bidW.ageMin < 1 ? 'меньше минуты' : `${Math.round(bidW.ageMin)} мин`})`, s: v });
    }
    if (askW) {
      const v = strength(askW) * (1 - askW.distAtr / 2.5) * 0.35;
      wallScore -= v;
      items.push({ text: `Стена продаж ${fmtUsd(askW.usd)} на ${fmt(askW.price)} (${MARKET_RU[askW.market]}, держится ${askW.ageMin < 1 ? 'меньше минуты' : `${Math.round(askW.ageMin)} мин`})`, s: -v });
    }

    // события за час: склеиваем однотипные («продавили 3 стены покупок на $1.2M»)
    let evScore = 0;
    const groups = new Map();
    for (const e of ev.filter((x) => now - x.t < 3600e3)) {
      const g = groups.get(`${e.side}:${e.fate}`) ?? { side: e.side, fate: e.fate, n: 0, usd: 0, prices: [] };
      g.n++; g.usd += e.usd; g.prices.push(e.price);
      groups.set(`${e.side}:${e.fate}`, g);
    }
    for (const g of groups.values()) {
      const k = (g.fate === 'eaten' ? 0.2 : 0.12) * Math.min(2, 1 + 0.25 * (g.n - 1));
      const s = (g.side === 'bid' ? -1 : 1) * k;
      evScore += s;
      const what = g.side === 'bid' ? 'покупок' : 'продаж';
      const cnt = g.n > 1 ? `${g.n} стен ${what} на ${fmtUsd(g.usd)}` : `стену ${what} ${fmtUsd(g.usd)} на ${fmt(g.prices[0])}`;
      items.push({
        text: g.fate === 'eaten'
          ? `За час ${g.side === 'bid' ? 'продавили' : 'выкупили'} ${cnt}`
          : `За час сняли при подходе цены ${cnt} — возможен спуфинг (фальшивые заявки)`,
        s,
      });
    }
    evScore = clamp(evScore, -0.4, 0.4);

    const score = clamp(0.5 * clamp(imbScore) + wallScore + evScore);
    const hasData = depth.bid.b1 + depth.ask.b1 > 0;

    // стены как уровни для зон
    const levelCands = walls.filter((w) => w.polls >= c.persistPolls && Math.abs(w.distPct) < 0.03).map((w) => ({
      price: w.price,
      w: Math.min(1.5, 0.6 + 0.3 * Math.log2(w.usd / w.minWall + 1)),
      label: `стена ${w.side === 'bid' ? 'покупок' : 'продаж'} ${fmtUsd(w.usd)} (${MARKET_RU[w.market]})`,
      kind: 'wall',
    }));

    return { hasData, score, imbalance, depth, coverage, walls: walls.slice(0, 10), events: ev, items, notes, levelCands };
  }
}
