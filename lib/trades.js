// Поток сделок в реальном времени (aggTrade, спот + фьючерсы):
// • склейка частей одного рыночного ордера (они приходят с одинаковым временем);
// • поминутная статистика: покупки/продажи, отдельно крупные игроки и мелкая розница;
// • 🐋 киты: одиночные крупные ордера и покупки частями (серии);
// • адаптивный порог уведомлений — только самые крупные покупки дня по каждой монете;
// • последняя цена и максимум/минимум между проверками (для стакана, сигналов, журнала).
import { clamp } from './indicators.js';

const MIN = 60e3, DAY = 86400e3;
const emptyBucket = () => ({ buy: 0, sell: 0, buyL: 0, sellL: 0, buyS: 0, sellS: 0, n: 0 });

export class TradeFlow {
  constructor(cfg, { onWhale } = {}) {
    this.cfg = cfg.whales;
    this.onWhale = onWhale;
    this.thresholds = new Map(); // "spot:BTCUSDT" → порог кита, $
    this.sym = new Map();        // спот-символ → состояние
    this.pending = new Map();    // незавершённые «склейки» ордеров
    this.futToSpot = new Map();  // 1000PEPEUSDT → { spot: 'PEPEUSDT', mult: 1000 }
    this.tracked = new Set();
    this.daily = { day: 0, count: 0 };
    this.timer = setInterval(() => this.housekeeping(), 250);
    this.timer.unref?.();
    this.lastPrune = Date.now();
  }

  setSymbols(symbols, futMap) {
    this.tracked = new Set(symbols);
    this.futToSpot = new Map();
    for (const s of symbols) {
      const f = futMap?.get(s);
      if (f) this.futToSpot.set(f.symbol, { spot: s, mult: f.mult });
    }
  }

  // порог кита для монеты: доля суточного объёма в пределах [minUsd, maxUsd]
  setThresholdsFromTickers(spotTickers = [], futTickers = []) {
    const c = this.cfg;
    const vol = new Map();
    for (const t of spotTickers) if (this.tracked.has(t.symbol)) vol.set(`spot:${t.symbol}`, +t.quoteVolume);
    for (const t of futTickers) {
      const m = this.futToSpot.get(t.symbol);
      if (m) vol.set(`futures:${m.spot}`, +t.quoteVolume);
    }
    for (const s of this.tracked) {
      for (const mk of ['spot', 'futures']) {
        const v = vol.get(`${mk}:${s}`);
        if (v > 0) this.thresholds.set(`${mk}:${s}`, clamp(v * c.volumeShare, c.minUsd, c.maxUsd));
        else if (mk === 'spot' && !this.thresholds.has(`spot:${s}`)) this.thresholds.set(`spot:${s}`, c.minUsd);
      }
    }
  }

  threshold(market, symbol) { return this.thresholds.get(`${market}:${symbol}`) ?? null; }

  state(symbol) {
    let st = this.sym.get(symbol);
    if (!st) {
      st = { last: null, ranges: new Map(), minutes: { spot: new Map(), futures: new Map() }, px: { spot: new Map(), futures: new Map() }, whales: [], lastAlert: null, startedAt: Date.now(), trades: 0 };
      this.sym.set(symbol, st);
    }
    return st;
  }

  // ── входящие сделки ──
  handleTrade(market, d) {
    let symbol = d.s, mult = 1;
    if (market === 'futures') {
      const m = this.futToSpot.get(d.s);
      if (!m) return;
      symbol = m.spot; mult = m.mult;
    } else if (!this.tracked.has(symbol)) return;
    const pRaw = +d.p, qRaw = +d.q;
    if (!(pRaw > 0) || !(qRaw > 0)) return;
    const price = pRaw / mult, usd = pRaw * qRaw;
    const st = this.state(symbol);
    st.trades++;
    if (market === 'spot' || !st.last || st.last.market === 'futures') st.last = { price, time: d.T, market };
    for (const r of st.ranges.values()) { if (price > r.hi) r.hi = price; if (price < r.lo) r.lo = price; }
    // поминутные цены (для поиска резких движений)
    const pm = Math.floor(d.T / MIN);
    const pmap = st.px[market];
    const pb = pmap.get(pm);
    if (!pb) pmap.set(pm, { o: price, h: price, l: price, c: price });
    else { if (price > pb.h) pb.h = price; if (price < pb.l) pb.l = price; pb.c = price; }

    // m=true — покупатель был мейкером, значит агрессор продавал
    const side = d.m ? 'sell' : 'buy';
    const key = `${market}:${symbol}:${side}`;
    let c = this.pending.get(key);
    if (c && d.T - c.T > this.cfg.clusterMs) { this.flush(key); c = null; }
    if (!c) {
      c = { market, symbol, side, T: d.T, seen: Date.now(), qty: 0, usd: 0, first: price, last: price, trades: 0 };
      this.pending.set(key, c);
    }
    c.qty += qRaw * mult; c.usd += usd; c.last = price; c.trades++; c.seen = Date.now();
  }

  housekeeping() {
    const now = Date.now();
    for (const [k, c] of this.pending) if (now - c.seen > this.cfg.clusterMs + 150) this.flush(k);
    if (now - this.lastPrune > MIN) {
      this.lastPrune = now;
      const minKey = Math.floor((now - DAY) / MIN);
      for (const st of this.sym.values()) {
        for (const map of [...Object.values(st.minutes), ...Object.values(st.px)]) for (const k of map.keys()) if (k < minKey) map.delete(k);
        while (st.whales.length && st.whales[0].t < now - DAY) st.whales.shift();
      }
    }
  }

  flush(key) {
    const c = this.pending.get(key);
    if (!c) return;
    this.pending.delete(key);
    const st = this.state(c.symbol);
    const known = this.threshold(c.market, c.symbol);
    const thr = known ?? this.cfg.maxUsd; // порог ещё неизвестен — для статистики берём верхнюю границу

    // поминутная статистика с разбивкой по размеру ордера
    const mk = Math.floor(c.T / MIN);
    const map = st.minutes[c.market];
    let b = map.get(mk);
    if (!b) { b = emptyBucket(); map.set(mk, b); }
    b[c.side] += c.usd; b.n++;
    if (c.usd >= thr * this.cfg.largeShare) b[c.side === 'buy' ? 'buyL' : 'sellL'] += c.usd;
    else if (c.usd < thr * this.cfg.smallShare) b[c.side === 'buy' ? 'buyS' : 'sellS'] += c.usd;

    if (!known || c.usd < thr * this.cfg.series.partX) return; // без порога китов на этом рынке не ищем
    const isWhale = c.usd >= thr;
    const rec = { t: c.T, side: c.side, usd: c.usd, market: c.market, whale: isWhale, price: c.usd / c.qty };
    st.whales.push(rec);
    const event = {
      market: c.market, symbol: c.symbol, side: c.side, usd: c.usd, qty: c.qty, price: c.usd / c.qty,
      from: c.first, to: c.last, trades: c.trades, time: c.T, threshold: thr, ref: rec,
    };
    if (isWhale) { this.emit({ ...event, type: 'single' }); return; }
    this.checkSeries(st, c, thr, event);
  }

  checkSeries(st, c, thr, event) {
    const s = this.cfg.series;
    const since = Date.now() - s.minutes * MIN;
    const recent = st.whales.filter((x) => x.t >= since && x.market === c.market);
    // серия — это набор позиции частями меньше порога; одиночные киты уже пришли отдельными письмами
    const parts = recent.filter((x) => x.side === c.side && !x.whale);
    const total = parts.reduce((a, x) => a + x.usd, 0);
    const opposite = recent.filter((x) => x.side !== c.side).reduce((a, x) => a + x.usd, 0);
    if (total < opposite * s.oneSided) return; // крупные ордера идут в обе стороны — это просто активный рынок
    st.seriesAt ??= {};
    const k = `${c.market}:${c.side}`;
    if (parts.length >= s.minCount && total >= thr * s.totalX && Date.now() - (st.seriesAt[k] || 0) > s.minutes * MIN) {
      // для монет, где крупные ордера идут постоянно (BTC, ETH), серия должна быть необычной для самой монеты:
      // поток крупных ордеров за 10 мин — в верхних topPct% всех 10-минутных отрезков за сутки
      const rank = this.flowRank(st, c.market, c.side, s.minutes);
      if (rank && rank.pct < 100 - s.topPct) return;
      st.seriesAt[k] = Date.now();
      this.emit({ ...event, type: 'series', usd: total, qty: null, count: parts.length, minutes: s.minutes, rank });
    }
  }

  /**
   * Насколько необычен текущий поток крупных ордеров (от largeShare порога) в одну сторону:
   * сумма за последние `minutes` мин против всех таких отрезков за последние сутки (не пересекающихся с текущим).
   * null — истории меньше 2 ч, сравнивать не с чем.
   */
  flowRank(st, market, side, minutes) {
    const nowMin = Math.floor(Date.now() / MIN);
    const first = Math.max(Math.ceil(st.startedAt / MIN), nowMin - 1440);
    if (nowMin - first < 120) return null;
    const key = side === 'buy' ? 'buyL' : 'sellL';
    const map = st.minutes[market];
    const v = [];
    for (let m = first; m <= nowMin; m++) v.push(map.get(m)?.[key] ?? 0);
    const cur = v.slice(-minutes).reduce((a, x) => a + x, 0);
    const sums = [];
    let s = 0;
    for (let i = 0; i < v.length - minutes; i++) {
      s += v[i];
      if (i >= minutes) s -= v[i - minutes];
      if (i >= minutes - 1) sums.push(s);
    }
    if (sums.length < 60) return null;
    const below = sums.filter((x) => x < cur).length;
    return { cur, pct: (100 * below) / sums.length, hours: Math.round(v.length / 60) };
  }

  emit(ev) {
    if (!this.onWhale) return;
    const decision = this.decideAlert(ev);
    try { this.onWhale(ev, decision); } catch (e) { console.error('🐋 ошибка обработки:', e.message); }
  }

  /** Решение, слать ли уведомление: только самые крупные покупки дня по монете */
  decideAlert(ev) {
    const c = this.cfg, now = Date.now();
    if (ev.side === 'sell' && !c.includeSells) return { alert: false, reason: 'продажи не уведомляются' };
    const st = this.state(ev.symbol);
    const base = ev.threshold;
    const coverH = (now - st.startedAt) / 3600e3;
    let need = base * c.alertX;
    let rule = `≥ ${c.alertX}× порога`;
    if (coverH < 6) { need *= 1.5; rule = `первые часы работы: ≥ ${(c.alertX * 1.5).toFixed(1)}× порога`; }
    else {
      const sizes = st.whales
        .filter((w) => w !== ev.ref && w.market === ev.market && w.side === ev.side && w.whale && w.t > now - DAY)
        .map((w) => w.usd).sort((a, b) => b - a);
      const nth = Math.max(1, Math.round((c.targetPerDay * Math.min(24, coverH)) / 24));
      if (sizes.length >= nth && sizes[nth - 1] > need) { need = sizes[nth - 1]; rule = `входит в ${nth} крупнейших за сутки`; }
    }
    if (ev.usd < need) return { alert: false, reason: `меньше порога уведомления (${rule})`, need };
    const last = st.lastAlert;
    if (last && now - last.at < c.cooldownMinutes * MIN && ev.usd < last.usd * c.bypassX) return { alert: false, reason: 'по монете недавно было уведомление', need };
    const day = Math.floor(now / DAY);
    if (this.daily.day !== day) this.daily = { day, count: 0 };
    if (this.daily.count >= c.maxPerDay) return { alert: false, reason: 'исчерпан дневной лимит уведомлений о китах', need };
    this.daily.count++;
    st.lastAlert = { at: now, usd: ev.usd };
    return { alert: true, need, rule };
  }

  /**
   * Резкое движение: изменение цены за 5 или 15 минут больше порога (в долях ATR часа, но не меньше minPct)
   * и объём в разы выше обычного.
   */
  detectMove(symbol, atrPct, mc) {
    const st = this.sym.get(symbol);
    if (!st?.last || !atrPct) return null;
    const now = Date.now();
    if (now - st.last.time > 60e3) return null;
    const nowMin = Math.floor(now / MIN);
    const px = st.px.spot.size ? st.px.spot : st.px.futures;
    const closeAt = (m) => { for (let k = m; k >= m - 3; k--) { const b = px.get(k); if (b) return b.c; } return null; };
    const covMin = Math.min(1440, (now - st.startedAt) / MIN);
    let dayVol = 0;
    for (const map of Object.values(st.minutes)) for (const b of map.values()) dayVol += b.buy + b.sell;
    const perMin = covMin > 0 ? dayVol / covMin : 0;
    let best = null;
    for (const [win, k] of [[5, mc.atrX5], [15, mc.atrX15]]) {
      const ref = closeAt(nowMin - win);
      if (!ref) continue;
      const change = st.last.price / ref - 1;
      const need = Math.max(mc.minPct / 100, atrPct * k);
      if (Math.abs(change) < need) continue;
      let vol = 0;
      for (const map of Object.values(st.minutes)) for (let m = nowMin - win + 1; m <= nowMin; m++) { const b = map.get(m); if (b) vol += b.buy + b.sell; }
      const volX = perMin > 0 ? vol / (perMin * win) : null;
      if (covMin >= 30 && volX != null && volX < mc.volX) continue;
      let hi = -Infinity, lo = Infinity;
      for (let m = nowMin - win; m <= nowMin; m++) { const b = px.get(m); if (b) { hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); } }
      const cand = { symbol, win, change, from: ref, to: st.last.price, volX, need, hi, lo, enough: covMin >= 30 };
      if (!best || Math.abs(change) / need > Math.abs(best.change) / best.need) best = cand;
    }
    return best;
  }

  // ── выдача статистики ──
  lastPrice(symbol) { return this.sym.get(symbol)?.last ?? null; }

  /** Максимум/минимум цены с прошлого вызова для данного потребителя */
  takeRange(symbol, consumer) {
    const st = this.sym.get(symbol);
    if (!st?.last) return null;
    let r = st.ranges.get(consumer);
    const p = st.last.price;
    if (!r) { r = { hi: p, lo: p }; st.ranges.set(consumer, r); return { hi: p, lo: p, last: p, fresh: true }; }
    const out = { hi: Math.max(r.hi, p), lo: Math.min(r.lo, p), last: p };
    r.hi = p; r.lo = p;
    return out;
  }

  summary(symbol, minutes = 60) {
    const st = this.sym.get(symbol);
    if (!st) return null;
    const now = Date.now();
    const since = Math.floor((now - minutes * MIN) / MIN);
    const agg = (map) => {
      const r = emptyBucket();
      for (const [m, b] of map) if (m >= since) for (const k in r) r[k] += b[k];
      return { ...r, delta: r.buy - r.sell, largeDelta: r.buyL - r.sellL, smallDelta: r.buyS - r.sellS, total: r.buy + r.sell };
    };
    const wh = st.whales.filter((w) => w.t >= now - minutes * MIN);
    const sumW = (side) => wh.filter((w) => w.side === side).reduce((a, w) => a + w.usd, 0);
    const buy = sumW('buy'), sell = sumW('sell');
    return {
      minutes,
      coverageMin: Math.min(minutes, (now - st.startedAt) / MIN),
      spot: agg(st.minutes.spot),
      futures: agg(st.minutes.futures),
      // киты (от порога) и крупные ордера (от series.partX порога): суммы и количество
      whales: {
        buy, sell, net: buy - sell,
        buyCount: wh.filter((w) => w.side === 'buy').length,
        sellCount: wh.filter((w) => w.side === 'sell').length,
        buyWhales: wh.filter((w) => w.side === 'buy' && w.whale).length,
        sellWhales: wh.filter((w) => w.side === 'sell' && w.whale).length,
        top: [...wh].sort((a, b) => b.usd - a.usd).slice(0, 5),
      },
    };
  }

  status() {
    return {
      symbols: this.sym.size,
      alertsToday: this.daily.count,
      thresholds: Object.fromEntries([...this.thresholds].map(([k, v]) => [k, Math.round(v)])),
    };
  }

  stop() { clearInterval(this.timer); }
}
