// 🐋 Отслеживание китов: крупные рыночные покупки (и, по желанию, продажи) на Binance в реальном времени.
//
// Источник — поток сделок aggTrade (спот и фьючерсы) через WebSocket.
// Один рыночный ордер кита обычно «съедает» несколько ценовых уровней и приходит пачкой сделок
// с одинаковым временем — такие сделки склеиваются в одну.
// Порог «китовой» сделки свой для каждой монеты: доля суточного объёма, но не меньше minUsd.
// Кроме одиночных крупных ордеров ловится «серия»: кит покупает частями за несколько минут.
import { getJSON } from './http.js';
import { clamp } from './indicators.js';

export const fmtUsd = (x) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : `$${Math.round(x / 1e3)}K`);
const DAY = 24 * 3600e3;

export class WhaleWatcher {
  constructor(cfg, onWhale) {
    this.cfg = cfg.whales;
    this.api = cfg.api;
    this.onWhale = onWhale;
    this.thresholds = new Map(); // "spot:BTCUSDT" → порог в $
    this.pending = new Map();    // склеиваемые сделки одного ордера
    this.history = new Map();    // BTCUSDT → [{ t, side, usd, market, whale }]
    this.seriesAt = new Map();   // когда последний раз сообщали о серии
    this.sockets = new Map();    // market → { ws, lastMsg }
    this.symbols = [];
    this.stopped = false;
    this.watchdog = null;
  }

  // ── пороги по суточному объёму каждой монеты ──
  async computeThresholds(symbols) {
    const c = this.cfg;
    const set = new Set(symbols);
    const load = async (market) => {
      const url = market === 'spot' ? `${this.api.spot}/api/v3/ticker/24hr?type=MINI` : `${this.api.futures}/fapi/v1/ticker/24hr`;
      const rows = await getJSON(url, { tries: 2, timeout: 30000 });
      for (const t of rows) {
        if (!set.has(t.symbol) || !(+t.quoteVolume > 0)) continue;
        this.thresholds.set(`${market}:${t.symbol}`, clamp(+t.quoteVolume * c.volumeShare, c.minUsd, c.maxUsd));
      }
    };
    await Promise.allSettled(c.markets.map(load));
    // если объём получить не удалось — минимальный порог для спота
    for (const s of symbols) if (!this.thresholds.has(`spot:${s}`) && c.markets.includes('spot')) this.thresholds.set(`spot:${s}`, c.minUsd);
  }

  threshold(market, symbol) { return this.thresholds.get(`${market}:${symbol}`); }

  async setSymbols(symbols) {
    if (!this.cfg.enabled) return;
    if (typeof WebSocket === 'undefined') {
      console.error('🐋 Для отслеживания китов нужен Node.js 22 или новее — функция отключена');
      this.cfg.enabled = false;
      return;
    }
    const same = symbols.length === this.symbols.length && symbols.every((s) => this.symbols.includes(s));
    await this.computeThresholds(symbols); // пороги обновляем при каждом пересмотре списка
    if (same && this.sockets.size) return;
    this.symbols = [...symbols];
    for (const m of this.cfg.markets) this.connect(m);
    if (!this.watchdog) this.watchdog = setInterval(() => this.checkAlive(), 30e3).unref?.() ?? null;
  }

  // ── WebSocket ──
  connect(market, attempt = 0) {
    this.sockets.get(market)?.ws.close();
    const syms = this.symbols.filter((s) => this.threshold(market, s) != null);
    if (!syms.length || this.stopped) return;
    const base = market === 'spot' ? this.cfg.spotWs : this.cfg.futuresWs;
    const url = `${base}/stream?streams=${syms.map((s) => `${s.toLowerCase()}@aggTrade`).join('/')}`;
    const ws = new WebSocket(url);
    const entry = { ws, lastMsg: Date.now(), openedAt: Date.now() };
    this.sockets.set(market, entry);

    ws.onopen = () => { attempt = 0; console.log(`🐋 Слежу за китами: ${market === 'spot' ? 'спот' : 'фьючерсы'}, ${syms.length} монет`); };
    ws.onmessage = (ev) => {
      entry.lastMsg = Date.now();
      try {
        const msg = JSON.parse(ev.data);
        if (msg.data?.e === 'aggTrade') this.handleTrade(market, msg.data);
      } catch { /* битое сообщение — пропускаем */ }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.stopped || this.sockets.get(market) !== entry) return; // закрыт намеренно
      const delay = Math.min(60e3, 2000 * 2 ** attempt);
      console.error(`🐋 Поток ${market} оборвался, переподключение через ${Math.round(delay / 1000)} с`);
      setTimeout(() => { if (this.sockets.get(market) === entry) this.connect(market, attempt + 1); }, delay);
    };
  }

  // переподключаемся, если поток «завис» или живёт почти сутки (Binance рвёт соединения через 24 ч)
  checkAlive() {
    for (const [market, e] of this.sockets) {
      if (Date.now() - e.lastMsg > 120e3 || Date.now() - e.openedAt > 23 * 3600e3) this.connect(market);
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    for (const { ws } of this.sockets.values()) ws.close();
  }

  // ── обработка сделок ──
  handleTrade(market, d) {
    // m = true — покупатель был мейкером, т.е. агрессор продавал; m = false — агрессивная покупка
    const side = d.m ? 'sell' : 'buy';
    const price = +d.p, qty = +d.q, usd = price * qty;
    const key = `${market}:${d.s}:${side}`;
    let c = this.pending.get(key);
    if (c && d.T - c.T > this.cfg.clusterMs) { this.flush(key); c = null; }
    if (!c) {
      c = { market, symbol: d.s, side, T: d.T, qty: 0, usd: 0, first: price, last: price, trades: 0, timer: null };
      this.pending.set(key, c);
    }
    c.qty += qty; c.usd += usd; c.last = price; c.trades++;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => this.flush(key), this.cfg.clusterMs + 250);
  }

  flush(key) {
    const c = this.pending.get(key);
    if (!c) return;
    this.pending.delete(key);
    clearTimeout(c.timer);
    const thr = this.threshold(c.market, c.symbol);
    if (!thr || c.usd < thr * this.cfg.series.partX) return; // мелочь не храним

    const isWhale = c.usd >= thr;
    const h = this.history.get(c.symbol) ?? [];
    h.push({ t: c.T, side: c.side, usd: c.usd, market: c.market, whale: isWhale });
    while (h.length && h[0].t < Date.now() - DAY) h.shift();
    this.history.set(c.symbol, h);

    const event = {
      market: c.market, symbol: c.symbol, side: c.side, usd: c.usd, qty: c.qty,
      price: c.usd / c.qty, from: c.first, to: c.last, trades: c.trades, time: c.T, threshold: thr,
    };
    if (isWhale) { this.emit({ ...event, type: 'single' }); return; }
    this.checkSeries(c, thr, event);
  }

  // серия: кит набирает позицию частями (несколько сделок ≥ partX порога за N минут, в сумме ≥ totalX порогов)
  checkSeries(c, thr, event) {
    const s = this.cfg.series;
    const since = Date.now() - s.minutes * 60e3;
    const parts = (this.history.get(c.symbol) ?? []).filter((x) => x.t >= since && x.side === c.side && x.market === c.market);
    const total = parts.reduce((a, x) => a + x.usd, 0);
    const k = `${c.market}:${c.symbol}:${c.side}`;
    if (parts.length >= s.minCount && total >= thr * s.totalX && Date.now() - (this.seriesAt.get(k) || 0) > s.minutes * 60e3) {
      this.seriesAt.set(k, Date.now());
      this.emit({ ...event, type: 'series', usd: total, qty: null, count: parts.length, minutes: s.minutes });
    }
  }

  emit(ev) {
    if (ev.side === 'sell' && !this.cfg.includeSells) return;
    try { this.onWhale(ev); } catch (e) { console.error('🐋 Ошибка обработки:', e.message); }
  }

  // сводка китовых денег по монете за N часов — для уведомлений и для анализа
  summary(symbol, hours = 1) {
    const since = Date.now() - hours * 3600e3;
    const rows = (this.history.get(symbol) ?? []).filter((x) => x.t >= since);
    const sum = (side) => rows.filter((x) => x.side === side).reduce((a, x) => a + x.usd, 0);
    const cnt = (side) => rows.filter((x) => x.side === side && x.whale).length;
    const buy = sum('buy'), sell = sum('sell');
    return { hours, buy, sell, net: buy - sell, buyCount: cnt('buy'), sellCount: cnt('sell'), active: this.cfg.enabled && this.sockets.size > 0 };
  }
}
