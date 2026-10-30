// Клиент публичного API Binance (спот + USDⓈ-M фьючерсы).
// • учитывает «вес» запросов (X-MBX-USED-WEIGHT-1M) и паузы при 429/418;
// • свечи догружаются инкрементально — после первой загрузки запрашиваются только новые бары;
// • знает соответствие спот ↔ фьючерс (PEPEUSDT ↔ 1000PEPEUSDT с множителем цены 1000).
import { request, sleep } from './http.js';
import { TTLCache } from './cache.js';

export const INTERVAL_MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '2h': 7200e3,
  '4h': 14400e3, '6h': 21600e3, '8h': 28800e3, '12h': 43200e3, '1d': 86400e3, '3d': 259200e3, '1w': 604800e3,
};
export const intervalMs = (i) => INTERVAL_MS[i] ?? 3600e3;

export const parseKline = (k) => ({
  time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  closeTime: k[6], quoteVolume: +k[7], trades: +k[8], takerBuy: +k[9], takerBuyQuote: +k[10],
});

const FUT_PERIODS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];
export const futuresPeriod = (i) => (FUT_PERIODS.includes(i) ? i : '1h');

const tickFromFilters = (filters = []) => {
  const pf = filters.find((f) => f.filterType === 'PRICE_FILTER');
  const t = pf ? +pf.tickSize : NaN;
  return t > 0 ? t : null;
};

export class Binance {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = { spot: cfg.api.spot, futures: cfg.api.futures };
    // запасной адрес для рыночных данных спота, если основной недоступен
    this.spotBases = [...new Set([cfg.api.spot, 'https://data-api.binance.vision'])];
    this.spotBaseIdx = 0;
    this.restricted = null; // текст ошибки, если Binance недоступен из страны сервера (HTTP 451/403)
    this.cache = new TTLCache();
    this.pauseUntil = { spot: 0, futures: 0 };
    this.weight = { spot: 0, futures: 0 };
    this.limit = { spot: 6000, futures: 2400 };
    this.stats = { requests: 0, errors: 0, lastError: null, bannedUntil: 0 };
    this.futMap = new Map(); // BTCUSDT → { symbol: 'BTCUSDT', mult: 1, tick }
    this.spotInfo = new Map(); // BTCUSDT → { tick, status }
  }

  async call(market, path, params = {}, { tries = 3, timeout = 15000 } = {}) {
    const wait = this.pauseUntil[market] - Date.now();
    if (wait > 0) await sleep(wait);
    if (this.weight[market] > this.limit[market] * 0.85) await sleep(4000); // мягкое притормаживание у лимита
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]),
    ).toString();
    const base = market === 'spot' ? this.spotBases[this.spotBaseIdx] : this.base.futures;
    try {
      const { data, headers } = await request(`${base}${path}${qs ? `?${qs}` : ''}`, { tries, timeout });
      const w = Number(headers.get('x-mbx-used-weight-1m'));
      if (Number.isFinite(w)) this.weight[market] = w;
      this.stats.requests++;
      return data;
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = `${new Date().toISOString()} ${e.message}`;
      if (e.status === 451 || (e.status === 403 && /restricted|eligib/i.test(e.message))) {
        this.restricted = e.message;
      }
      // сеть недоступна или доступ закрыт — переключаем спот на запасной адрес и пробуем ещё раз
      if (market === 'spot' && (!e.status || e.status === 451 || e.status === 403) && this.spotBases.length > 1 && !this._switching) {
        this.spotBaseIdx = (this.spotBaseIdx + 1) % this.spotBases.length;
        console.error(`Binance: ${e.message} — пробую ${this.spotBases[this.spotBaseIdx]}`);
        this._switching = true;
        try { return await this.call(market, path, params, { tries: 1, timeout }); } finally { this._switching = false; }
      }
      if (e.status === 429 || e.status === 418) {
        const sec = e.retryAfter ?? (e.status === 418 ? 300 : 60);
        this.pauseUntil[market] = Date.now() + sec * 1000;
        if (e.status === 418) this.stats.bannedUntil = this.pauseUntil[market];
        console.error(`Binance ${market}: лимит запросов (HTTP ${e.status}), пауза ${sec} с`);
      }
      throw e;
    }
  }

  // ── справочная информация ──────────────────────────────────────────────

  /** Насколько часы сервера расходятся с Binance, мс (плюс — часы сервера отстают) */
  async serverTimeSkew() {
    const t0 = Date.now();
    const j = await this.call('spot', '/api/v3/time', {}, { tries: 2, timeout: 8000 });
    const t1 = Date.now();
    if (!(j?.serverTime > 0)) return null;
    return j.serverTime - (t0 + t1) / 2;
  }

  async loadFuturesInfo() {
    return this.cache.get('fut:exchangeInfo', 6 * 3600e3, async () => {
      const info = await this.call('futures', '/fapi/v1/exchangeInfo', {}, { timeout: 30000 });
      const map = new Map();
      for (const s of info.symbols || []) {
        if (s.contractType !== 'PERPETUAL' || s.status !== 'TRADING' || s.quoteAsset !== 'USDT') continue;
        // 1000PEPE → PEPE ×1000, 1000000MOG → MOG ×1e6, 1MBABYDOGE → BABYDOGE ×1e6
        let base = s.baseAsset, mult = 1;
        const m = base.match(/^(1000000|10000|1000|1M)(.+)$/);
        if (m) { base = m[2]; mult = m[1] === '1M' ? 1e6 : Number(m[1]); }
        const spot = `${base}USDT`;
        const prev = map.get(spot);
        if (!prev || mult < prev.mult) map.set(spot, { symbol: s.symbol, mult, tick: tickFromFilters(s.filters) });
      }
      this.futMap = map;
      return map;
    }, { staleMs: 7 * 86400e3 });
  }

  async loadSpotInfo(symbols) {
    const key = `spot:exchangeInfo:${[...symbols].sort().join(',')}`;
    return this.cache.get(key, 6 * 3600e3, async () => {
      const info = await this.call('spot', '/api/v3/exchangeInfo', { symbols: JSON.stringify(symbols) }, { timeout: 30000 });
      for (const s of info.symbols || []) this.spotInfo.set(s.symbol, { tick: tickFromFilters(s.filters), status: s.status });
      return this.spotInfo;
    }, { staleMs: 7 * 86400e3 });
  }

  futuresOf(spotSymbol) { return this.futMap.get(spotSymbol) ?? null; }
  tickOf(spotSymbol) { return this.spotInfo.get(spotSymbol)?.tick ?? null; }

  async ticker24h(market) {
    return this.cache.get(`t24:${market}`, 30 * 60e3, () => (market === 'spot'
      ? this.call('spot', '/api/v3/ticker/24hr', { type: 'MINI' }, { timeout: 30000 })
      : this.call('futures', '/fapi/v1/ticker/24hr', {}, { timeout: 30000 })));
  }

  // ── свечи ──────────────────────────────────────────────────────────────

  /** Свечи с инкрементальной догрузкой. market: 'spot' | 'futures' (символ — фьючерсный). */
  async klines(symbol, interval, limit, { market = 'spot', ttlMs = 55e3 } = {}) {
    const key = `k:${market}:${symbol}:${interval}:${limit}`;
    const ms = intervalMs(interval);
    return this.cache.get(key, ttlMs, async (prev) => {
      let need = limit;
      if (prev?.length >= Math.min(limit, 50)) {
        need = Math.min(limit, Math.ceil((Date.now() - prev[prev.length - 1].time) / ms) + 2);
      }
      const path = market === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
      const rows = await this.call(market, path, { symbol, interval, limit: Math.min(market === 'spot' ? 1000 : 1500, need) });
      const fresh = rows.map(parseKline);
      if (!prev || need >= limit || !fresh.length) return fresh.slice(-limit);
      const first = fresh[0].time;
      return prev.filter((c) => c.time < first).concat(fresh).slice(-limit);
    });
  }

  /** История для бэктеста: постранично от startTime до endTime. */
  async klinesHistory(symbol, interval, startTime, endTime = Date.now(), market = 'spot') {
    const ms = intervalMs(interval);
    const path = market === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
    const out = [];
    let from = startTime;
    while (from < endTime) {
      const rows = await this.call(market, path, { symbol, interval, startTime: from, endTime, limit: 1000 }, { tries: 4, timeout: 30000 });
      if (!rows.length) break;
      for (const r of rows) out.push(parseKline(r));
      const lastT = rows[rows.length - 1][0];
      if (rows.length < 1000) break;
      from = lastT + ms;
      await sleep(120);
    }
    const seen = new Set();
    return out.filter((c) => !seen.has(c.time) && seen.add(c.time));
  }

  // ── стакан ─────────────────────────────────────────────────────────────

  async depth(symbol, { market = 'spot', limit = 1000, ttlMs = 50e3 } = {}) {
    return this.cache.get(`d:${market}:${symbol}:${limit}`, ttlMs, async () => {
      const path = market === 'spot' ? '/api/v3/depth' : '/fapi/v1/depth';
      const d = await this.call(market, path, { symbol, limit });
      return {
        time: Date.now(),
        bids: (d.bids || []).map(([p, q]) => [+p, +q]),
        asks: (d.asks || []).map(([p, q]) => [+p, +q]),
      };
    }, { staleMs: 5 * 60e3 });
  }

  // ── деривативы (символ — фьючерсный) ───────────────────────────────────

  premiumIndex(fsym, ttlMs = 55e3) {
    return this.cache.get(`pi:${fsym}`, ttlMs, () => this.call('futures', '/fapi/v1/premiumIndex', { symbol: fsym }));
  }

  fundingRates(fsym, limit = 100, ttlMs = 30 * 60e3) {
    return this.cache.get(`fr:${fsym}`, ttlMs, () => this.call('futures', '/fapi/v1/fundingRate', { symbol: fsym, limit }));
  }

  openInterestHist(fsym, period = '1h', limit = 500, ttlMs = 5 * 60e3) {
    return this.cache.get(`oi:${fsym}:${period}:${limit}`, ttlMs,
      () => this.call('futures', '/futures/data/openInterestHist', { symbol: fsym, period, limit }, { tries: 2 }));
  }

  ratio(kind, fsym, period = '1h', limit = 48, ttlMs = 5 * 60e3) {
    const path = {
      topPosition: '/futures/data/topLongShortPositionRatio',
      topAccount: '/futures/data/topLongShortAccountRatio',
      globalAccount: '/futures/data/globalLongShortAccountRatio',
      taker: '/futures/data/takerlongshortRatio',
    }[kind];
    return this.cache.get(`r:${kind}:${fsym}:${period}:${limit}`, ttlMs,
      () => this.call('futures', path, { symbol: fsym, period, limit }, { tries: 2 }));
  }

  basis(fsym, period = '1h', limit = 48, ttlMs = 5 * 60e3) {
    return this.cache.get(`b:${fsym}:${period}`, ttlMs,
      () => this.call('futures', '/futures/data/basis', { pair: fsym, contractType: 'PERPETUAL', period, limit }, { tries: 2 }));
  }

  status() {
    return {
      weight: { ...this.weight },
      requests: this.stats.requests,
      errors: this.stats.errors,
      lastError: this.stats.lastError,
      paused: Object.fromEntries(Object.entries(this.pauseUntil).map(([k, v]) => [k, Math.max(0, Math.round((v - Date.now()) / 1000))])),
    };
  }
}
