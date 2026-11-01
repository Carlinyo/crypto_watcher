// Bybit V5 REST — только то, что нужно для автоторговли USDT-фьючерсами.
// • подпись HMAC-SHA256: timestamp + ключ + recv_window + (строка запроса | тело JSON);
// • демо-счёт (api-demo.bybit.com), реальный (api.bybit.com) или тестовая сеть;
// • синхронизация времени с сервером Bybit (иначе ошибка 10002);
// • понятные русские ошибки: неверный ключ, подпись, IP, запрет страны, нехватка средств.
import crypto from 'node:crypto';
import { sleep } from './http.js';

export const BYBIT_URLS = {
  live: 'https://api.bybit.com',
  demo: 'https://api-demo.bybit.com',
  testnet: 'https://api-testnet.bybit.com',
};

const HINTS = {
  10001: 'неверные параметры запроса',
  10003: 'неверный API-ключ — проверьте, что ключ создан для этого режима (ключи демо-счёта создаются внутри демо-счёта Bybit)',
  10004: 'неверная подпись — проверьте BYBIT_API_SECRET',
  10005: 'у ключа нет нужных прав — нужны «Контракты: ордера и позиции»',
  10006: 'слишком много запросов к Bybit',
  10007: 'Bybit не принял авторизацию',
  10010: 'IP сервера не входит в список разрешённых для этого ключа',
  10018: 'слишком много запросов с этого IP',
  10024: 'операция запрещена правилами Bybit (комплаенс, страна)',
  10027: 'торговля для аккаунта запрещена',
  110004: 'недостаточно средств',
  110007: 'недостаточно доступного баланса',
  110012: 'недостаточно доступного баланса',
  110017: 'объём слишком мал',
  110044: 'недостаточно маржи',
  110045: 'недостаточно средств',
  110094: 'сумма сделки меньше минимальной',
};

export class BybitError extends Error {
  constructor(code, msg, path, http = null) {
    const hint = HINTS[code];
    super(`${hint ? `${hint} ` : ''}(${code}${msg ? `: ${msg}` : ''})`);
    this.code = code;
    this.rawMsg = msg;
    this.path = path;
    this.http = http;
  }
}

export class Bybit {
  constructor({ apiKey = '', apiSecret = '', mode = 'demo', baseUrl = '', recvWindow = 10000, timeoutMs = 10000, fetchImpl = null } = {}) {
    this.key = apiKey;
    this.secret = apiSecret;
    this.mode = BYBIT_URLS[mode] ? mode : 'demo';
    this.base = (baseUrl || BYBIT_URLS[this.mode]).replace(/\/+$/, '');
    this.recvWindow = recvWindow;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl ?? ((url, init) => fetch(url, init));
    this.offset = 0;
    this.synced = 0;
    this.stats = { requests: 0, errors: 0, lastError: null };
  }

  hasKeys() { return !!(this.key && this.secret); }

  sign(payload) { return crypto.createHmac('sha256', this.secret).update(payload).digest('hex'); }

  async syncTime() {
    const t0 = Date.now();
    const r = await this.call('GET', '/v5/market/time', {}, { auth: false, retry: false });
    const t1 = Date.now();
    const server = r.timeNano ? Number(r.timeNano) / 1e6 : Number(r.timeSecond) * 1000;
    if (server > 0) this.offset = Math.round(server - (t0 + t1) / 2);
    this.synced = Date.now();
    return this.offset;
  }

  /**
   * Запрос к Bybit. Возвращает result. Ошибки — BybitError с кодом Bybit (или HTTP / -2 для сети).
   * POST при сбое сети не повторяется: ордер мог уже дойти до биржи (проверяйте по orderLinkId).
   */
  async call(method, path, params = {}, { auth = true, retry = true } = {}) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    let url = this.base + path, body, payload = '';
    if (method === 'GET') {
      payload = new URLSearchParams(Object.entries(clean).map(([k, v]) => [k, String(v)])).toString();
      if (payload) url += `?${payload}`;
    } else {
      body = JSON.stringify(clean);
      payload = body;
    }
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      if (!this.hasKeys()) throw new BybitError(-1, 'не заданы BYBIT_API_KEY и BYBIT_API_SECRET', path);
      if (Date.now() - this.synced > 30 * 60e3) await this.syncTime().catch(() => {});
      const ts = String(Date.now() + this.offset);
      headers['X-BAPI-API-KEY'] = this.key;
      headers['X-BAPI-TIMESTAMP'] = ts;
      headers['X-BAPI-RECV-WINDOW'] = String(this.recvWindow);
      headers['X-BAPI-SIGN'] = this.sign(ts + this.key + this.recvWindow + payload);
    }
    this.stats.requests++;
    let res, text;
    try {
      res = await this.fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
      text = await res.text();
    } catch (e) {
      const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? `нет ответа ${this.timeoutMs / 1000} с` : e.message;
      if (retry && method === 'GET') { await sleep(1000); return this.call(method, path, params, { auth, retry: false }); }
      throw this.fail(new BybitError(-2, `нет связи с Bybit: ${why}`, path));
    }
    if (res.status === 403) {
      throw this.fail(new BybitError(403, 'Bybit отклонил запрос (HTTP 403): доступ из страны сервера запрещён или IP временно заблокирован за частые запросы', path, 403));
    }
    if (res.status === 429 || res.status >= 500) {
      if (retry && (method === 'GET' || res.status === 429)) { await sleep(2000); return this.call(method, path, params, { auth, retry: false }); }
      throw this.fail(new BybitError(res.status, `HTTP ${res.status}`, path, res.status));
    }
    let j;
    try { j = JSON.parse(text); } catch { throw this.fail(new BybitError(res.status, `непонятный ответ: ${String(text).slice(0, 120)}`, path, res.status)); }
    if (j.retCode !== 0) {
      if (j.retCode === 10002 && retry) { await this.syncTime().catch(() => {}); return this.call(method, path, params, { auth, retry: false }); }
      if ((j.retCode === 10006 || j.retCode === 10018) && retry) { await sleep(1500); return this.call(method, path, params, { auth, retry: false }); }
      throw this.fail(new BybitError(j.retCode, j.retMsg, path));
    }
    return j.result ?? {};
  }

  fail(err) {
    this.stats.errors++;
    this.stats.lastError = err.message;
    return err;
  }

  // ── рынок ──
  /** Контракты USDT; symbolType — только этот вид (stock — фьючерсы на акции, ETF…) */
  async instruments({ symbolType } = {}) {
    const out = [];
    let cursor;
    for (let i = 0; i < 10; i++) {
      const r = await this.call('GET', '/v5/market/instruments-info', { category: 'linear', limit: 1000, cursor, symbolType }, { auth: false });
      out.push(...(r.list ?? []));
      cursor = r.nextPageCursor;
      if (!cursor) break;
    }
    return out;
  }

  async ticker(symbol) {
    const r = await this.call('GET', '/v5/market/tickers', { category: 'linear', symbol }, { auth: false });
    return r.list?.[0] ?? null;
  }

  // ── аккаунт ──
  apiKeyInfo() { return this.call('GET', '/v5/user/query-api'); }

  async wallet() {
    const r = await this.call('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    return r.list?.[0] ?? null;
  }

  /** Позиции: по монете (вернёт и пустые) или все открытые в USDT */
  async positions({ symbol, settleCoin = 'USDT' } = {}) {
    const out = [];
    let cursor;
    for (let i = 0; i < 10; i++) {
      const r = await this.call('GET', '/v5/position/list', symbol ? { category: 'linear', symbol, limit: 200, cursor } : { category: 'linear', settleCoin, limit: 200, cursor });
      out.push(...(r.list ?? []));
      cursor = r.nextPageCursor;
      if (!cursor || symbol) break;
    }
    return out;
  }

  async setLeverage(symbol, leverage) {
    try {
      await this.call('POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage) });
      return true;
    } catch (e) {
      if (e.code === 110043) return true; // уже стоит такое плечо
      throw e;
    }
  }

  // ── ордера ──
  createOrder(p) { return this.call('POST', '/v5/order/create', { category: 'linear', ...p }); }

  cancelOrder(symbol, { orderId, orderLinkId }) { return this.call('POST', '/v5/order/cancel', { category: 'linear', symbol, orderId, orderLinkId }); }

  /** Ордер по своему id (возвращается и исполненный, и отменённый) */
  async order(symbol, orderLinkId) {
    const r = await this.call('GET', '/v5/order/realtime', { category: 'linear', symbol, orderLinkId });
    return r.list?.[0] ?? null;
  }

  async openOrdersAll(settleCoin = 'USDT') {
    const out = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const r = await this.call('GET', '/v5/order/realtime', { category: 'linear', settleCoin, limit: 50, cursor });
      out.push(...(r.list ?? []));
      cursor = r.nextPageCursor;
      if (!cursor) break;
    }
    return out;
  }

  async openOrders(symbol) {
    const r = await this.call('GET', '/v5/order/realtime', { category: 'linear', symbol, limit: 50 });
    return r.list ?? [];
  }

  /** Стоп (и/или тейк) на всю позицию */
  tradingStop(p) { return this.call('POST', '/v5/position/trading-stop', { category: 'linear', tpslMode: 'Full', ...p }); }

  async closedPnl(symbol, startTime) {
    const r = await this.call('GET', '/v5/position/closed-pnl', { category: 'linear', symbol, startTime, limit: 100 });
    return r.list ?? [];
  }

  status() { return { mode: this.mode, base: this.base, ...this.stats }; }
}
