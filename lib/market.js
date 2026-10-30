// Общий фон рынка: капитализация, доминация BTC и стейблкоинов (CoinGecko /global),
// индекс страха и жадности за 30 дней, состояние биткоина как лидера рынка.
import fs from 'node:fs';
import path from 'node:path';
import { getJSON } from './http.js';
import { TTLCache } from './cache.js';

const STABLES = ['usdt', 'usdc', 'dai', 'usde', 'fdusd', 'usds', 'pyusd', 'tusd', 'usd1'];

export class MarketContext {
  constructor(cfg, file) {
    this.cfg = cfg;
    this.file = file;
    this.cache = new TTLCache();
    this.hist = [];
    this.btc = null;
    try { this.hist = JSON.parse(fs.readFileSync(file, 'utf8')).hist ?? []; } catch { /* первый запуск */ }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ hist: this.hist }));
    } catch { /* не критично */ }
  }

  async global() {
    const u = this.cfg.universe;
    return this.cache.get('global', this.cfg.market.globalMinutes * 60e3, async () => {
      const headers = u.coingeckoKey ? { 'x-cg-demo-api-key': u.coingeckoKey } : {};
      const j = await getJSON(`${u.coingeckoUrl}/global`, { tries: 2, headers });
      const d = j.data;
      const pctMap = d.market_cap_percentage || {};
      const g = {
        totalMcap: d.total_market_cap?.usd ?? null,
        mcapChange24h: d.market_cap_change_percentage_24h_usd ?? null,
        btcDom: pctMap.btc ?? null,
        ethDom: pctMap.eth ?? null,
        stableDom: STABLES.reduce((s, k) => s + (pctMap[k] || 0), 0),
        t: Date.now(),
      };
      const lastT = this.hist[this.hist.length - 1]?.t ?? 0;
      if (Date.now() - lastT > 25 * 60e3) {
        this.hist.push({ t: g.t, btcDom: g.btcDom, stableDom: g.stableDom, totalMcap: g.totalMcap });
        this.hist = this.hist.filter((x) => x.t > Date.now() - 8 * 86400e3);
        this.save();
      }
      return g;
    });
  }

  async fng() {
    return this.cache.get('fng', 60 * 60e3, async () => {
      const j = await getJSON(this.cfg.market.fearGreedUrl, { tries: 2 });
      const rows = (j.data || []).map((x) => ({ value: +x.value, label: x.value_classification, t: +x.timestamp * 1000 }));
      if (!rows.length) throw new Error('пустой ответ индекса страха и жадности');
      const now = rows[0];
      const weekAgo = rows[7] ?? rows[rows.length - 1];
      return { value: now.value, label: now.label, change7d: now.value - weekAgo.value, history: rows.slice(0, 30) };
    });
  }

  async refresh() {
    await Promise.allSettled([this.global(), this.fng()]);
  }

  setBtc(r) {
    if (!r) return;
    this.btc = {
      score: r.score, trend: r.blocks?.trend?.score ?? 0, regime: r.regime?.key, price: r.price,
      change24h: r.stats?.change24h ?? null, action: r.action, t: Date.now(),
    };
  }

  // изменение доминации за ~24 часа по собственной истории
  domChange(key) {
    if (this.hist.length < 2) return null;
    const cur = this.hist[this.hist.length - 1];
    const target = cur.t - 24 * 3600e3;
    let best = null;
    for (const h of this.hist) if (h.t <= target + 3 * 3600e3 && (!best || Math.abs(h.t - target) < Math.abs(best.t - target))) best = h;
    if (!best || cur.t - best.t < 12 * 3600e3 || best[key] == null || cur[key] == null) return null;
    return cur[key] - best[key];
  }

  // капитализация стейблкоинов за ~7 дней: растёт — на рынок приходят «свежие» деньги
  stableChange(days = 7) {
    const pts = this.hist.filter((h) => h.stableDom != null && h.totalMcap != null).map((h) => ({ t: h.t, v: (h.stableDom / 100) * h.totalMcap }));
    if (pts.length < 2) return null;
    const cur = pts[pts.length - 1];
    const target = cur.t - days * 86400e3;
    const old = pts.find((p) => p.t >= target - 12 * 3600e3);
    if (!old || cur.t - old.t < (days - 1) * 86400e3) return null;
    return { abs: cur.v - old.v, rel: cur.v / old.v - 1, days: Math.round((cur.t - old.t) / 86400e3), now: cur.v };
  }

  snapshot() {
    const g = this.cache.peek('global');
    const f = this.cache.peek('fng');
    return {
      global: g ? { ...g, btcDomChange24h: this.domChange('btcDom'), stableDomChange24h: this.domChange('stableDom'), stable7d: this.stableChange(7) } : null,
      fng: f ?? null,
      btc: this.btc,
    };
  }
}
