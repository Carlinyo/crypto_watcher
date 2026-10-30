// Премия Coinbase: цена монеты на Coinbase (USD) против Binance (USDT, пересчитанной в доллары).
// Положительная премия — покупают американские и институциональные инвесторы, отрицательная — продают.
import { getJSON } from './http.js';
import { TTLCache } from './cache.js';

export class CoinbaseFeed {
  constructor(cfg) {
    this.cfg = cfg.coinbase;
    this.cache = new TTLCache();
    this.history = new Map(); // base → [{t, premium}]
  }

  async products() {
    return this.cache.get('products', 12 * 3600e3, async () => {
      const list = await getJSON(`${this.cfg.api}/products`, { tries: 2, timeout: 20000 });
      return new Set(list.filter((p) => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled).map((p) => p.id));
    }, { staleMs: 7 * 86400e3 });
  }

  async price(id) {
    return this.cache.get(`t:${id}`, this.cfg.refreshSeconds * 1000 - 5000, async () => {
      const t = await getJSON(`${this.cfg.api}/products/${id}/ticker`, { tries: 2, timeout: 10000 });
      const p = +t.price;
      if (!(p > 0)) throw new Error(`Coinbase ${id}: нет цены`);
      return p;
    }, { staleMs: 10 * 60e3 });
  }

  /** @returns {{premium:number, avg1h:number|null, n:number}|null} */
  async premium(base, binancePrice) {
    if (!this.cfg.enabled || !(binancePrice > 0)) return null;
    const prods = await this.products();
    const id = `${base}-USD`;
    if (!prods.has(id)) return null;
    const [cb, usdt] = await Promise.all([this.price(id), prods.has('USDT-USD') ? this.price('USDT-USD') : Promise.resolve(1)]);
    const premium = cb / (binancePrice * usdt) - 1;
    if (!Number.isFinite(premium) || Math.abs(premium) > 0.05) return null; // явный сбой данных
    const h = this.history.get(base) ?? [];
    h.push({ t: Date.now(), premium });
    while (h.length && h[0].t < Date.now() - 6 * 3600e3) h.shift();
    this.history.set(base, h);
    const hour = h.filter((x) => x.t >= Date.now() - 3600e3);
    const avg1h = hour.length >= 3 ? hour.reduce((s, x) => s + x.premium, 0) / hour.length : null;
    return { premium, avg1h, n: hour.length, coinbasePrice: cb };
  }
}
