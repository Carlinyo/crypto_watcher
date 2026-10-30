// Ликвидации на фьючерсах Binance (поток !forceOrder@arr).
// S = SELL — принудительно закрыт лонг (ликвидация покупателей), S = BUY — закрыт шорт.
// Поток отдаёт крупнейшую ликвидацию по каждой монете за секунду, поэтому суммы — нижняя оценка.

const MIN = 60e3, DAY = 86400e3;

export class Liquidations {
  constructor() {
    this.futToSpot = new Map();
    this.sym = new Map();     // спот-символ → Map(минута → {long, short, n, max})
    this.market = new Map();  // весь рынок: минута → {long, short, n}
    this.big = [];            // крупнейшие события за сутки
    this.startedAt = Date.now();
    this.lastPrune = Date.now();
  }

  setSymbols(symbols, futMap) {
    this.futToSpot = new Map();
    for (const s of symbols) {
      const f = futMap?.get(s);
      if (f) this.futToSpot.set(f.symbol, { spot: s, mult: f.mult });
    }
  }

  handle(d) {
    const o = d?.o;
    if (!o) return;
    const price = +o.ap || +o.p, qty = +o.z || +o.q;
    const usd = price * qty;
    if (!(usd > 0)) return;
    const side = o.S === 'SELL' ? 'long' : 'short';
    const t = o.T || d.E || Date.now();
    const mk = Math.floor(t / MIN);
    const add = (map) => {
      let b = map.get(mk);
      if (!b) { b = { long: 0, short: 0, n: 0, max: 0 }; map.set(mk, b); }
      b[side] += usd; b.n++; if (usd > b.max) b.max = usd;
    };
    add(this.market);
    const m = this.futToSpot.get(o.s);
    if (m) {
      let map = this.sym.get(m.spot);
      if (!map) { map = new Map(); this.sym.set(m.spot, map); }
      add(map);
      if (usd >= 100e3) {
        this.big.push({ t, symbol: m.spot, side, usd, price: price / m.mult });
        if (this.big.length > 500) this.big.shift();
      }
    }
    if (Date.now() - this.lastPrune > MIN) this.prune();
  }

  prune() {
    this.lastPrune = Date.now();
    const old = Math.floor((Date.now() - DAY) / MIN);
    for (const map of [this.market, ...this.sym.values()]) for (const k of map.keys()) if (k < old) map.delete(k);
    while (this.big.length && this.big[0].t < Date.now() - DAY) this.big.shift();
  }

  static agg(map, minutes) {
    const since = Math.floor((Date.now() - minutes * MIN) / MIN);
    const r = { long: 0, short: 0, n: 0, max: 0 };
    if (!map) return r;
    for (const [k, b] of map) if (k >= since) { r.long += b.long; r.short += b.short; r.n += b.n; if (b.max > r.max) r.max = b.max; }
    return r;
  }

  summary(symbol, minutes = 60) {
    const map = this.sym.get(symbol);
    const cov = Math.min(24 * 60, (Date.now() - this.startedAt) / MIN);
    const cur = Liquidations.agg(map, minutes);
    const day = Liquidations.agg(map, 24 * 60);
    const baselinePerMin = cov > 0 ? (day.long + day.short) / cov : 0;
    const total = cur.long + cur.short;
    return {
      ...cur,
      total,
      minutes,
      coverageMin: cov,
      day,
      intensity: baselinePerMin > 0 ? total / (baselinePerMin * Math.min(minutes, cov)) : null,
    };
  }

  marketSummary(minutes = 60) {
    return { ...Liquidations.agg(this.market, minutes), coverageMin: Math.min(24 * 60, (Date.now() - this.startedAt) / MIN) };
  }

  biggest(symbol, n = 3) {
    return this.big.filter((b) => !symbol || b.symbol === symbol).sort((a, b) => b.usd - a.usd).slice(0, n);
  }
}
