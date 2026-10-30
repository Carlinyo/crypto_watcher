// Имитация Bybit V5 для тестов и симулятора.
// Проверяет подпись запросов, исполняет рыночные ордера, лимитные «только закрытие», стоп/тейк на позиции,
// ведёт баланс (единый аккаунт), закрытый PnL (за вычетом комиссий). Цена задаётся через setPrice().
import crypto from 'node:crypto';

export const DEFAULT_INSTRUMENTS = [
  { symbol: 'BTCUSDT', tick: '0.10', step: '0.001', minQty: '0.001', maxMkt: '119', maxLev: '100' },
  { symbol: 'ETHUSDT', tick: '0.01', step: '0.01', minQty: '0.01', maxMkt: '1000', maxLev: '100' },
  { symbol: 'SOLUSDT', tick: '0.010', step: '0.1', minQty: '0.1', maxMkt: '50000', maxLev: '75' },
  { symbol: 'XRPUSDT', tick: '0.0001', step: '1', minQty: '1', maxMkt: '1000000', maxLev: '75' },
  { symbol: 'DOGEUSDT', tick: '0.00001', step: '1', minQty: '1', maxMkt: '5000000', maxLev: '75' },
  { symbol: 'ADAUSDT', tick: '0.0001', step: '1', minQty: '1', maxMkt: '1000000', maxLev: '75' },
  { symbol: '1000PEPEUSDT', tick: '0.0000001', step: '100', minQty: '100', maxMkt: '100000000', maxLev: '50' },
  { symbol: 'SHIB1000USDT', tick: '0.000001', step: '100', minQty: '100', maxMkt: '100000000', maxLev: '50' },
];

const ok = (result) => ({ retCode: 0, retMsg: 'OK', result, retExtInfo: {}, time: Date.now() });
const err = (code, msg) => ({ retCode: code, retMsg: msg, result: {}, retExtInfo: {}, time: Date.now() });
const S = (x) => String(+Number(x).toPrecision(12));

export class MockBybit {
  constructor({ apiKey = 'test-key', apiSecret = 'test-secret', equity = 10000, instruments = DEFAULT_INSTRUMENTS, prices = {}, permissions = null, ips = ['203.0.113.7'], readOnly = 0, hedge = false, takerFee = 0.00055, makerFee = 0.0002, spread = 0.0001 } = {}) {
    Object.assign(this, { apiKey, apiSecret, cash: equity, takerFee, makerFee, spread, hedge, ips, readOnly });
    this.permissions = permissions ?? { ContractTrade: ['Order', 'Position'], Spot: [], Wallet: ['AccountTransfer'], Options: [], Derivatives: [], Exchange: [] };
    this.inst = new Map(instruments.map((x) => [x.symbol, x]));
    this.prices = { ...prices };
    this.positions = new Map(); // `${symbol}:${idx}` → позиция
    this.orders = new Map();    // orderLinkId|orderId → ордер (все статусы)
    this.closed = [];
    this.lev = new Map();
    this.calls = [];
    this.failNext = null;       // { path, code, msg } — одна ошибка на следующий подходящий запрос
    this.httpStatus = null;     // например 403 — «страна заблокирована»
    this.seq = 1;
  }

  // ── fetch-совместимый вход ──
  fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const h = init.headers ?? {};
    const params = method === 'GET' ? Object.fromEntries(u.searchParams) : JSON.parse(init.body || '{}');
    this.calls.push({ method, path: u.pathname, params });
    const reply = (status, obj) => ({ status, ok: status < 400, text: async () => JSON.stringify(obj), headers: new Map() });
    if (this.httpStatus) return { status: this.httpStatus, ok: false, text: async () => '<html>403 ERROR. The request could not be satisfied.</html>', headers: new Map() };
    const pub = u.pathname.startsWith('/v5/market/');
    if (!pub) {
      if (h['X-BAPI-API-KEY'] !== this.apiKey) return reply(200, err(10003, 'API key is invalid.'));
      const payload = method === 'GET' ? u.search.replace(/^\?/, '') : init.body ?? '';
      const sign = crypto.createHmac('sha256', this.apiSecret).update(h['X-BAPI-TIMESTAMP'] + this.apiKey + h['X-BAPI-RECV-WINDOW'] + payload).digest('hex');
      if (sign !== h['X-BAPI-SIGN']) return reply(200, err(10004, 'error sign!'));
      const ts = +h['X-BAPI-TIMESTAMP'];
      if (!(ts >= Date.now() - +h['X-BAPI-RECV-WINDOW'] && ts < Date.now() + 1000)) return reply(200, err(10002, 'invalid request, please check your server timestamp or recv_window param'));
    }
    if (this.failNext && (!this.failNext.path || this.failNext.path === u.pathname)) {
      const f = this.failNext;
      this.failNext = null;
      return reply(200, err(f.code, f.msg ?? 'fail'));
    }
    try { return reply(200, this.route(method, u.pathname, params)); } catch (e) { return reply(200, err(e.code ?? 10001, e.message)); }
  };

  // ── состояние ──
  price(symbol) {
    const p = this.prices[symbol];
    if (!(p > 0)) throw Object.assign(new Error(`no price for ${symbol}`), { code: 10001 });
    return p;
  }
  bid(s) { return this.price(s) * (1 - this.spread); }
  ask(s) { return this.price(s) * (1 + this.spread); }
  posKey(symbol, idx) { return `${symbol}:${idx}`; }
  idxFor(side, positionIdx) { return this.hedge ? (positionIdx ?? (side === 'Buy' ? 1 : 2)) : 0; }
  upnl(p) { return (this.price(p.symbol) - p.avgPrice) * p.size * (p.side === 'Buy' ? 1 : -1); }
  equity() { let e = this.cash; for (const p of this.positions.values()) e += this.upnl(p); return e; }
  usedMargin() { let m = 0; for (const p of this.positions.values()) m += (p.size * p.avgPrice) / p.leverage; return m; }
  available() { return this.equity() - this.usedMargin(); }

  setPrice(symbol, price) {
    this.prices[symbol] = price;
    for (const p of [...this.positions.values()].filter((x) => x.symbol === symbol)) {
      const long = p.side === 'Buy';
      if (p.stopLoss > 0 && (long ? price <= p.stopLoss : price >= p.stopLoss)) { this.reduce(p, p.size, p.stopLoss, this.takerFee); continue; }
      if (p.takeProfit > 0 && (long ? price >= p.takeProfit : price <= p.takeProfit)) { this.reduce(p, p.size, p.takeProfit, this.takerFee); continue; }
      for (const o of [...this.orders.values()].filter((x) => x.orderStatus === 'New' && x.symbol === symbol && x.reduceOnly && x.positionIdx === p.positionIdx)) {
        if (!this.positions.has(this.posKey(symbol, p.positionIdx))) break;
        const hit = o.side === 'Sell' ? price >= o.price : price <= o.price;
        if (!hit) continue;
        const q = Math.min(o.qty, p.size);
        o.orderStatus = 'Filled'; o.cumExecQty = q; o.avgPrice = o.price;
        this.reduce(p, q, o.price, this.makerFee);
      }
    }
  }

  reduce(p, qty, px, feeRate) {
    const long = p.side === 'Buy';
    const fee = qty * px * feeRate;
    const openFee = p.openFee * (qty / p.size);
    const gross = (px - p.avgPrice) * qty * (long ? 1 : -1);
    this.cash += gross - fee;
    p.openFee -= openFee;
    this.closed.push({
      symbol: p.symbol, orderId: `m${this.seq++}`, side: long ? 'Sell' : 'Buy', qty: S(qty), orderPrice: S(px), orderType: 'Market', execType: 'Trade',
      closedSize: S(qty), cumEntryValue: S(qty * p.avgPrice), avgEntryPrice: S(p.avgPrice), cumExitValue: S(qty * px), avgExitPrice: S(px),
      closedPnl: S(gross - fee - openFee), fillCount: '1', leverage: String(p.leverage), openFee: S(openFee), closeFee: S(fee), createdTime: String(Date.now()), updatedTime: String(Date.now()),
    });
    p.size = +(p.size - qty).toPrecision(12);
    if (p.size <= 1e-12) {
      this.positions.delete(this.posKey(p.symbol, p.positionIdx));
      for (const o of this.orders.values()) if (o.symbol === p.symbol && o.reduceOnly && o.orderStatus === 'New' && o.positionIdx === p.positionIdx) o.orderStatus = 'Cancelled';
    }
  }

  // ── маршруты ──
  route(method, path, q) {
    const fail = (code, msg) => { throw Object.assign(new Error(msg), { code }); };
    switch (path) {
      case '/v5/market/time': { const t = Date.now(); return ok({ timeSecond: String(Math.floor(t / 1000)), timeNano: `${t}000000` }); }
      case '/v5/market/instruments-info':
        return ok({ category: 'linear', nextPageCursor: '', list: [...this.inst.values()].map((x) => ({
          symbol: x.symbol, contractType: 'LinearPerpetual', status: 'Trading', baseCoin: x.symbol.replace(/USDT$/, ''), quoteCoin: 'USDT', settleCoin: 'USDT',
          priceFilter: { minPrice: x.tick, maxPrice: '1999999', tickSize: x.tick }, leverageFilter: { minLeverage: '1', maxLeverage: x.maxLev, leverageStep: '0.01' },
          lotSizeFilter: { maxOrderQty: x.maxMkt, maxMktOrderQty: x.maxMkt, minOrderQty: x.minQty, qtyStep: x.step, minNotionalValue: '5' },
        })) });
      case '/v5/market/tickers': {
        const syms = q.symbol ? [q.symbol] : Object.keys(this.prices);
        return ok({ category: 'linear', list: syms.filter((s) => this.prices[s]).map((s) => ({ symbol: s, lastPrice: S(this.price(s)), markPrice: S(this.price(s)), indexPrice: S(this.price(s)), bid1Price: S(this.bid(s)), ask1Price: S(this.ask(s)) })) });
      }
      case '/v5/user/query-api':
        return ok({ id: '1', note: 'crypto-watcher', apiKey: this.apiKey, readOnly: this.readOnly, secret: '', permissions: this.permissions, ips: this.ips, type: 1, deadlineDay: this.ips.includes('*') || !this.ips.length ? 88 : -1, expiredAt: '', createdAt: '', unified: 0, uta: 1, userID: 1, inviterID: 0, vipLevel: 'No VIP', mktMakerLevel: '0', affiliateID: 0, rsaPublicKey: '', isMaster: true, parentUid: '0', kycLevel: 'LEVEL_DEFAULT', kycRegion: '' });
      case '/v5/account/wallet-balance': {
        const eq = this.equity(), av = this.available();
        return ok({ list: [{ accountType: 'UNIFIED', totalEquity: S(eq), totalWalletBalance: S(this.cash), totalMarginBalance: S(eq), totalAvailableBalance: S(av), totalPerpUPL: S(eq - this.cash), totalInitialMargin: S(this.usedMargin()), coin: [{ coin: 'USDT', equity: S(eq), walletBalance: S(this.cash), usdValue: S(eq), unrealisedPnl: S(eq - this.cash), locked: '0' }] }] });
      }
      case '/v5/position/list': {
        const view = (p, symbol, idx) => (p
          ? { positionIdx: p.positionIdx, symbol: p.symbol, side: p.side, size: S(p.size), avgPrice: S(p.avgPrice), positionValue: S(p.size * p.avgPrice), leverage: String(p.leverage), markPrice: S(this.price(p.symbol)), liqPrice: '', takeProfit: p.takeProfit ? S(p.takeProfit) : '', stopLoss: p.stopLoss ? S(p.stopLoss) : '', trailingStop: '0', unrealisedPnl: S(this.upnl(p)), curRealisedPnl: '0', cumRealisedPnl: '0', positionStatus: 'Normal', tpslMode: 'Full', createdTime: String(p.createdTime), updatedTime: String(Date.now()) }
          : { positionIdx: idx, symbol, side: '', size: '0', avgPrice: '0', positionValue: '0', leverage: String(this.lev.get(symbol) ?? 10), markPrice: S(this.prices[symbol] ?? 0), liqPrice: '', takeProfit: '', stopLoss: '', trailingStop: '0', unrealisedPnl: '0', curRealisedPnl: '0', cumRealisedPnl: '0', positionStatus: 'Normal', tpslMode: 'Full', createdTime: '0', updatedTime: '0' });
        if (q.symbol) {
          const idxs = this.hedge ? [1, 2] : [0];
          return ok({ category: 'linear', nextPageCursor: '', list: idxs.map((i) => view(this.positions.get(this.posKey(q.symbol, i)), q.symbol, i)) });
        }
        if (!q.settleCoin) fail(10001, 'symbol or settleCoin is required');
        return ok({ category: 'linear', nextPageCursor: '', list: [...this.positions.values()].map((p) => view(p)) });
      }
      case '/v5/position/set-leverage': {
        const x = this.inst.get(q.symbol);
        if (!x) fail(10001, 'symbol invalid');
        if (+q.buyLeverage !== +q.sellLeverage && !this.hedge) fail(10001, 'buy leverage must equal sell leverage');
        if (+q.buyLeverage > +x.maxLev) fail(10001, 'leverage invalid');
        if (this.lev.get(q.symbol) === +q.buyLeverage) fail(110043, 'leverage not modified');
        this.lev.set(q.symbol, +q.buyLeverage);
        return ok({});
      }
      case '/v5/order/create': return ok(this.create(q, fail));
      case '/v5/order/cancel': {
        const o = this.orders.get(q.orderLinkId ?? q.orderId);
        if (!o || o.orderStatus !== 'New') fail(110001, 'order not exists or too late to cancel');
        o.orderStatus = 'Cancelled';
        return ok({ orderId: o.orderId, orderLinkId: o.orderLinkId });
      }
      case '/v5/order/realtime': {
        if (q.orderLinkId) { const o = this.orders.get(q.orderLinkId); return ok({ category: 'linear', nextPageCursor: '', list: o ? [this.orderView(o)] : [] }); }
        return ok({ category: 'linear', nextPageCursor: '', list: [...this.orders.values()].filter((o) => o.symbol === q.symbol && o.orderStatus === 'New').map((o) => this.orderView(o)) });
      }
      case '/v5/position/trading-stop': {
        const p = this.positions.get(this.posKey(q.symbol, +q.positionIdx || 0));
        if (!p) fail(10001, 'can not set tp/sl/ts for zero position');
        const mark = this.price(q.symbol), long = p.side === 'Buy';
        if (q.stopLoss != null) {
          const sl = +q.stopLoss;
          if (sl > 0 && (long ? sl >= mark : sl <= mark)) fail(10001, `StopLoss:${q.stopLoss} set for ${p.side} position should ${long ? 'lower' : 'higher'} than base_price:${S(mark)}??LastPrice`);
          p.stopLoss = sl;
        }
        if (q.takeProfit != null) {
          const tp = +q.takeProfit;
          if (tp > 0 && (long ? tp <= mark : tp >= mark)) fail(10001, 'TakeProfit price invalid');
          p.takeProfit = tp;
        }
        return ok({});
      }
      case '/v5/position/closed-pnl':
        return ok({ category: 'linear', nextPageCursor: '', list: this.closed.filter((x) => (!q.symbol || x.symbol === q.symbol) && +x.createdTime >= +(q.startTime ?? 0)).reverse() });
      default: fail(10017, `route not found ${path}`);
    }
    return null;
  }

  orderView(o) {
    return { orderId: o.orderId, orderLinkId: o.orderLinkId, symbol: o.symbol, price: S(o.price ?? 0), qty: S(o.qty), side: o.side, orderStatus: o.orderStatus, avgPrice: o.avgPrice ? S(o.avgPrice) : '', cumExecQty: S(o.cumExecQty ?? 0), leavesQty: S(o.orderStatus === 'New' ? o.qty : 0), reduceOnly: !!o.reduceOnly, orderType: o.orderType, stopOrderType: '', triggerPrice: '', takeProfit: '', stopLoss: o.stopLoss ? S(o.stopLoss) : '', positionIdx: o.positionIdx, createdTime: String(o.createdTime), updatedTime: String(Date.now()) };
  }

  create(q, fail) {
    const x = this.inst.get(q.symbol);
    if (!x) fail(10001, 'symbol invalid');
    if (q.orderLinkId && this.orders.has(q.orderLinkId)) fail(110072, 'OrderLinkedID is duplicate');
    const qty = +q.qty, step = +x.step;
    if (!(qty > 0) || Math.abs(qty / step - Math.round(qty / step)) > 1e-6) fail(10001, `Qty invalid: ${q.qty}`);
    if (qty < +x.minQty) fail(110017, 'qty too small');
    if (q.price && Math.abs(+q.price / +x.tick - Math.round(+q.price / +x.tick)) > 1e-6) fail(10001, `price invalid: ${q.price}`);
    const idx = this.idxFor(q.side, q.positionIdx);
    if (this.hedge && q.positionIdx === 0) fail(10001, 'position idx not match position mode');
    if (!this.hedge && q.positionIdx && +q.positionIdx !== 0) fail(10001, 'position idx not match position mode');
    const key = this.posKey(q.symbol, idx);
    const o = { orderId: `o${this.seq++}`, orderLinkId: q.orderLinkId ?? '', symbol: q.symbol, side: q.side, qty, price: q.price ? +q.price : null, orderType: q.orderType, reduceOnly: !!q.reduceOnly, positionIdx: idx, orderStatus: 'New', createdTime: Date.now(), stopLoss: q.stopLoss ? +q.stopLoss : 0 };
    if (q.reduceOnly && (q.stopLoss || q.takeProfit)) fail(10001, 'TP/SL cannot be set with reduceOnly');
    if (q.orderType === 'Market') {
      const px = q.side === 'Buy' ? this.ask(q.symbol) : this.bid(q.symbol);
      if (q.reduceOnly) {
        const p = this.positions.get(key);
        if (!p) fail(110017, 'current position is zero, cannot fix reduce-only order qty');
        this.reduce(p, Math.min(qty, p.size), px, this.takerFee);
      } else {
        if (qty * px < 5) fail(110094, 'Order does not meet minimum order value 5USDT');
        if (+x.maxMkt && qty > +x.maxMkt) fail(10001, 'qty exceeds max market order qty');
        const lev = this.lev.get(q.symbol) ?? 10;
        if ((qty * px) / lev > this.available()) fail(110007, 'ab not enough for new order');
        const sl = q.stopLoss ? +q.stopLoss : 0;
        if (sl > 0 && (q.side === 'Buy' ? sl >= px : sl <= px)) fail(10001, 'StopLoss price invalid');
        const fee = qty * px * this.takerFee;
        this.cash -= fee;
        let p = this.positions.get(key);
        if (p && p.side !== q.side) fail(10001, 'mock: opposite position in one-way mode');
        if (!p) { p = { symbol: q.symbol, positionIdx: idx, side: q.side, size: 0, avgPrice: 0, stopLoss: 0, takeProfit: 0, leverage: lev, openFee: 0, createdTime: Date.now() }; this.positions.set(key, p); }
        p.avgPrice = (p.avgPrice * p.size + px * qty) / (p.size + qty);
        p.size = +(p.size + qty).toPrecision(12);
        p.openFee += fee;
        if (sl > 0) p.stopLoss = sl;
        if (q.takeProfit) p.takeProfit = +q.takeProfit;
      }
      Object.assign(o, { orderStatus: 'Filled', cumExecQty: qty, avgPrice: px });
    } else {
      if (!q.price) fail(10001, 'price required');
      if (!q.reduceOnly) fail(10001, 'mock: only reduce-only limit orders are supported');
    }
    this.orders.set(o.orderLinkId || o.orderId, o);
    return { orderId: o.orderId, orderLinkId: o.orderLinkId };
  }
}
