// Автоторговля на Bybit (USDT-фьючерсы) по сигналам ПОКУПКА / ПРОДАЖА.
//
// Безопасность прежде всего:
// • по умолчанию — демо-счёт; реальные деньги только при TRADE_MODE=live;
// • ключ с правом вывода средств не принимается;
// • стоп ставится на бирже вместе с ордером; цели — лимитные ордера «только закрытие» (50% / 50%);
// • риск на сделку — % баланса с учётом комиссий; позиция ограничена плечом и долей баланса;
// • не больше N позиций, дневной лимит убытка, позиции, открытые не программой, не трогаются;
// • если цена на Bybit ушла от расчётной или прибыль/риск стал плохим — сделка не открывается.
// Сопровождение: после цели 1 стоп — в безубыток, на полпути к цели 2 — на цель 1; через 72 ч — закрытие.
import fs from 'node:fs';
import path from 'node:path';
import { Bybit } from './bybit.js';
import { writeJsonAtomic, readJson } from './storage.js';
import { coinOf, fmt, fmtMoney as fmtUsd, trades as nTrades } from './format.js';

export const MODE_RU = { demo: 'демо-счёт', live: 'реальный счёт', testnet: 'тестовая сеть' };

// ── округление под правила биржи ──
const decimals = (step) => {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};
export const floorStep = (x, step) => Number((Math.floor(x / Number(step) + 1e-9) * Number(step)).toFixed(decimals(step)));
export const roundTick = (x, tick, mode = 'nearest') => {
  const n = x / Number(tick);
  const k = mode === 'down' ? Math.floor(n + 1e-9) : mode === 'up' ? Math.ceil(n - 1e-9) : Math.round(n);
  return Number((k * Number(tick)).toFixed(decimals(tick)));
};
export const fmtStep = (x, step) => Number(x).toFixed(decimals(step));
const newId = () => `cw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const localDay = () => new Date().toLocaleDateString('sv-SE');

/**
 * Размер позиции от риска: убыток при стопе (с комиссиями входа и выхода) = riskPct% баланса.
 * Ограничения: доля покупательной способности (баланс × плечо / число позиций), свободная маржа, TRADE_MAX_USD.
 */
export function sizePosition({ equity, available, riskPct, leverage, maxPositions, maxNotionalUsd = 0, feePct, price, stop, info, mult = 1 }) {
  const stopDist = Math.abs(price - stop);
  if (!(stopDist > 0) || !(price > 0)) return { ok: false, why: 'стоп совпадает с ценой' };
  const perCoinLoss = stopDist + price * (feePct / 100) * 2;
  let coins = (equity * riskPct) / 100 / perCoinLoss;
  const caps = [
    [(equity * leverage) / Math.max(1, maxPositions), `плечо ×${leverage} на ${maxPositions} позиции`],
    [Math.max(0, available) * leverage * 0.95, 'свободная маржа на счёте'],
    [maxNotionalUsd > 0 ? maxNotionalUsd : Infinity, 'лимит TRADE_MAX_USD'],
  ];
  let limitedBy = null;
  for (const [cap, why] of caps) if (coins * price > cap) { coins = cap / price; limitedBy = why; }
  let contracts = floorStep(coins / mult, info.qtyStep);
  if (info.maxMktQty > 0 && contracts > info.maxMktQty) { contracts = floorStep(info.maxMktQty, info.qtyStep); limitedBy = 'максимум рыночного ордера на Bybit'; }
  if (!(contracts >= info.minQty) || contracts <= 0) return { ok: false, why: `позиция получается меньше минимальной на Bybit (${info.minQty} контр.) — мало средств или слишком далёкий стоп` };
  const notional = contracts * mult * price;
  if (notional < info.minNotional) return { ok: false, why: `сумма сделки ${fmtUsd(notional)} меньше минимальной на Bybit (${fmtUsd(info.minNotional)})` };
  const riskUsd = contracts * mult * perCoinLoss;
  return { ok: true, contracts, coins: contracts * mult, notional, riskUsd, riskPct: (riskUsd / equity) * 100, margin: notional / leverage, limitedBy };
}

export class Trader {
  constructor(cfg, { file, client = null, onEvent = null, log = console.log } = {}) {
    this.all = cfg;
    this.cfg = cfg.trade;
    this.file = file;
    this.client = client ?? new Bybit({ apiKey: this.cfg.apiKey, apiSecret: this.cfg.apiSecret, mode: this.cfg.mode, baseUrl: this.cfg.baseUrl });
    this.mode = this.client.mode;
    this.onEvent = onEvent;
    this.log = log;
    this.instruments = new Map();
    this.instrumentsAt = 0;
    this.levSet = new Set();
    this.ready = false;
    this.problem = null;
    this.warnings = [];
    this.keyInfo = null;
    this.balance = null;
    this.balanceAt = 0;
    this.lastInit = 0;
    this.lastError = null;
    this.failStreak = 0;
    this.queue = Promise.resolve();
    this.state = { trades: [], day: null, dayStartEquity: null, pnlToday: 0, paused: null };
    if (file) { const saved = readJson(file, null); if (saved && Array.isArray(saved.trades)) this.state = { ...this.state, ...saved }; }
  }

  get enabled() { return !!this.cfg.enabled; }
  hasKeys() { return this.client.hasKeys(); }

  // ── ручная пауза: node index.js --pause-trading / --resume-trading (файл data/TRADING_PAUSED) ──
  static pauseFile(file) { return path.join(path.dirname(file), 'TRADING_PAUSED'); }
  static pause(file, reason = 'команда --pause-trading') { writeJsonAtomic(Trader.pauseFile(file), { at: Date.now(), reason }); }
  static resume(file) { for (const f of [Trader.pauseFile(file), `${Trader.pauseFile(file)}.bak`]) { try { fs.unlinkSync(f); } catch { /* нет паузы */ } } }
  userPause() {
    if (!this.file) return null;
    const f = Trader.pauseFile(this.file);
    return fs.existsSync(f) ? readJson(f, { at: null, reason: 'пауза' }, { log: () => {} }) : null;
  }
  openTrades() { return this.state.trades.filter((t) => t.status === 'open'); }

  save() {
    if (!this.file) return;
    try {
      const trades = this.state.trades.filter((t, i, a) => t.status === 'open' || i >= a.length - 500);
      writeJsonAtomic(this.file, { ...this.state, trades }, { pretty: true });
    } catch (e) { this.log(`Bybit: не удалось сохранить сделки — ${e.message}`); }
  }

  // все операции с биржей — строго по очереди (два сигнала одновременно не превысят лимит позиций)
  lock(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  emit(type, trade = null, extra = {}) {
    try { this.onEvent?.({ type, trade, mode: this.mode, ...extra }); } catch (e) { this.log(`Bybit: ошибка уведомления — ${e.message}`); }
  }

  // ── запуск: ключ, права, справочник контрактов, баланс ──
  async init() {
    this.lastInit = Date.now();
    this.warnings = [];
    if (!this.hasKeys()) { this.ready = false; this.problem = 'не заданы BYBIT_API_KEY и BYBIT_API_SECRET'; return this.describe(); }
    try {
      await this.client.syncTime().catch(() => {});
      const k = await this.client.apiKeyInfo();
      const perms = k.permissions ?? {};
      this.keyInfo = { readOnly: +k.readOnly === 1, ips: k.ips ?? [], deadlineDay: k.deadlineDay ?? null, expiredAt: k.expiredAt ?? null, uta: k.uta, perms };
      if ((perms.Wallet ?? []).includes('Withdraw')) throw new Error('у ключа есть право вывода средств — с таким ключом программа не торгует. Создайте ключ без вывода (только «Контракты: ордера и позиции»)');
      if (this.keyInfo.readOnly) throw new Error('ключ только для чтения — при создании ключа выберите «Чтение и запись»');
      const ct = perms.ContractTrade ?? [];
      if (!ct.includes('Order') || !ct.includes('Position')) this.warnings.push('у ключа может не быть прав «Контракты: ордера и позиции» — без них сделки не откроются');
      const extra = (perms.Wallet ?? []).filter((x) => x !== 'Withdraw');
      if (extra.length) this.warnings.push(`у ключа есть права на переводы между счетами (${extra.join(', ')}) — программе они не нужны, безопаснее их выключить`);
      const needless = ['Spot', 'Options', 'Exchange', 'Earn', 'BlockTrade', 'FiatP2P', 'FiatBitPay', 'FiatConvertBroker', 'FiatGlobalPay', 'BitCard', 'ByXPost'].filter((g) => (perms[g] ?? []).length);
      if (needless.length) this.warnings.push(`у ключа есть лишние права (${needless.join(', ')}) — для автоторговли нужны только «Контракты: ордера и позиции»; лишние лучше выключить`);
      const ips = this.keyInfo.ips.filter((x) => x && x !== '*');
      if (!ips.length) {
        // украденным ключом без привязки к IP может торговать кто угодно — на реальном счёте не работаем
        if (this.mode === 'live' && !this.cfg.allowAnyIp) throw new Error('для реального счёта ключ должен быть привязан к IP сервера: без привязки украденным ключом сможет торговать кто угодно. Укажите IP сервера в настройках ключа на Bybit (если понимаете риск — TRADE_ALLOW_ANY_IP=1)');
        this.warnings.push(`ключ не привязан к IP сервера${this.keyInfo.deadlineDay > 0 ? ` — Bybit отключит его через ${this.keyInfo.deadlineDay} дн.` : ''}; для постоянной работы привяжите IP`);
      }
      await this.loadInstruments();
      await this.refreshBalance(true);
      await this.findOrphans().catch(() => {});
      this.ready = true;
      this.problem = null;
      this.failStreak = 0;
    } catch (e) {
      this.ready = false;
      this.problem = e.message;
    }
    return this.describe();
  }

  /** Ордера программы на бирже, о которых нет записи (файл сделок потерян или открыт другой копией) */
  async findOrphans() {
    const known = new Set(this.openTrades().map((t) => t.id));
    const orders = await this.client.openOrdersAll();
    const orphans = orders.filter((o) => /^cw[a-z0-9]+-/.test(o.orderLinkId ?? '') && !known.has(o.orderLinkId.split('-')[0]));
    this.orphans = orphans.map((o) => ({ symbol: o.symbol, side: o.side, qty: o.qty, price: o.price, orderLinkId: o.orderLinkId }));
    if (orphans.length) {
      const list = [...new Set(orphans.map((o) => o.symbol))].join(', ');
      this.warnings.push(`на Bybit есть ордера программы без записи о сделке (${list}) — проверьте эти позиции вручную`);
      this.emit('orphans', null, { orders: this.orphans });
    }
    return this.orphans;
  }

  async loadInstruments() {
    const list = await this.client.instruments();
    // фьючерсы на акции: в общем списке их может не быть — запрашиваем отдельно
    const have = new Set(list.map((x) => x.symbol));
    try { for (const x of await this.client.instruments({ symbolType: 'stock' })) if (!have.has(x.symbol)) list.push({ ...x, symbolType: x.symbolType || 'stock' }); } catch { /* нет — значит, только крипта */ }
    const map = new Map();
    for (const x of list) {
      if (x.quoteCoin !== 'USDT' || x.settleCoin !== 'USDT' || x.status !== 'Trading') continue;
      if (x.contractType && x.contractType !== 'LinearPerpetual') continue;
      map.set(x.symbol, {
        tick: x.priceFilter?.tickSize ?? '0.0001',
        qtyStep: x.lotSizeFilter?.qtyStep ?? '1',
        minQty: +x.lotSizeFilter?.minOrderQty || 0,
        maxMktQty: +x.lotSizeFilter?.maxMktOrderQty || 0,
        minNotional: +x.lotSizeFilter?.minNotionalValue || 5,
        maxLev: +x.leverageFilter?.maxLeverage || 1,
        symbolType: String(x.symbolType ?? '').toLowerCase(), // '' — крипта; stock, etf, commodity, forex — традиционные активы
      });
    }
    if (!map.size) throw new Error('Bybit не вернул список фьючерсов');
    this.instruments = map;
    this.typed = [...map.values()].some((i) => i.symbolType); // Bybit сообщает вид контракта (акция, ETF…)
    this.instrumentsAt = Date.now();
  }

  async refreshBalance(force = false) {
    if (!force && this.balance && Date.now() - this.balanceAt < 60e3) return this.balance;
    const w = await this.client.wallet();
    if (!w) throw new Error('Bybit не вернул баланс единого торгового аккаунта (UTA)');
    const usdt = (w.coin ?? []).find((c) => c.coin === 'USDT');
    const equity = +w.totalEquity || +usdt?.equity || 0;
    const available = w.totalAvailableBalance !== '' && w.totalAvailableBalance != null ? +w.totalAvailableBalance : equity;
    this.balance = { equity, available, at: Date.now() };
    this.balanceAt = Date.now();
    if (this.state.dayStartEquity == null && equity > 0) { this.state.dayStartEquity = equity; this.save(); }
    return this.balance;
  }

  /**
   * Контракт Bybit для монеты Binance: PEPEUSDT → 1000PEPEUSDT (×1000), SHIBUSDT → SHIB1000USDT (×1000).
   * Акция (kind: 'stock') — только фьючерс на акцию с тем же тикером; монета — только криптовалютный контракт
   * (тикеры акций и монет могут совпадать).
   */
  resolve(symbol, { kind = 'crypto' } = {}) {
    const coin = coinOf(symbol);
    const tradfi = (info) => ['stock', 'etf', 'commodity', 'forex', 'index'].includes(info.symbolType);
    const variants = kind === 'stock' ? [[`${coin}USDT`, 1]]
      : [[`${coin}USDT`, 1], [`1000${coin}USDT`, 1000], [`${coin}1000USDT`, 1000], [`10000${coin}USDT`, 1e4], [`${coin}10000USDT`, 1e4], [`1000000${coin}USDT`, 1e6]];
    for (const [s, mult] of variants) {
      const info = this.instruments.get(s);
      if (!info) continue;
      if (kind === 'stock' ? this.typed && info.symbolType !== 'stock' && info.symbolType !== 'etf' : tradfi(info)) continue;
      return { symbol: s, mult, info };
    }
    return null;
  }

  async ensureLeverage(symbol, lev) {
    const key = `${symbol}:${lev}`;
    if (this.levSet.has(key)) return;
    await this.client.setLeverage(symbol, lev);
    this.levSet.add(key);
  }

  // ── новая сделка по сигналу ──
  /** @returns {Promise<null|{status:'opened'|'skipped'|'error', reason?, trade?, sms}>} */
  async onSignal(r, { zone = false } = {}) {
    if (!this.enabled) return null;
    const side = r.action === 'BUY' ? 'Buy' : r.action === 'SELL' ? 'Sell' : null;
    if (!side) return null;
    return this.lock(() => this.open(r, side, { zone })).catch((e) => this.error(e.message));
  }

  skip(reason, code) { return { status: 'skipped', reason, code, sms: `BYBIT: no trade, ${code}`, mode: this.mode }; }

  error(reason) { return { status: 'error', reason, code: 'error', sms: 'BYBIT: error', mode: this.mode }; }

  async open(r, side, { zone }) {
    if (!this.ready) { await this.init(); if (!this.ready) return this.error(`автоторговля не запущена: ${this.problem}`); }
    if (Date.now() - this.instrumentsAt > 24 * 3600e3) await this.loadInstruments().catch(() => {});
    const c = this.cfg, buy = side === 'Buy';
    const today = localDay();
    const openedToday = this.state.trades.filter((t) => new Date(t.openedAt).toLocaleDateString('sv-SE') === today).length;
    if (c.maxPerDay > 0 && openedToday >= c.maxPerDay) return this.skip(`сегодня уже открыто ${nTrades(openedToday)} — это дневной максимум (TRADE_MAX_PER_DAY=${c.maxPerDay})`, 'daily trade limit');
    const up = this.userPause();
    if (up) return this.skip(`автоторговля приостановлена${up.at ? ` с ${new Date(up.at).toLocaleString('ru-RU')}` : ''} (${up.reason}); снять паузу: --resume-trading`, 'paused');
    if (!buy && !c.shorts) return this.skip('шорты выключены (TRADE_SHORTS=0)', 'shorts off');
    if (c.symbols.length && !c.symbols.includes(r.symbol)) return this.skip('монеты нет в списке TRADE_SYMBOLS', 'not in list');
    if (r.confidence < c.minConfidence) return this.skip(`уверенность ${r.confidence}% ниже TRADE_MIN_CONFIDENCE (${c.minConfidence}%)`, 'low confidence');
    this.rollDay();
    if (this.state.paused) return this.skip(`торговля на сегодня остановлена: убыток за день ${fmtUsd(this.state.pnlToday)} (лимит ${c.dailyLossPct}% баланса)`, 'daily loss limit');
    const m = this.resolve(r.symbol, { kind: r.kind });
    if (!m) return this.skip(r.kind === 'stock' ? 'фьючерса на эту акцию нет на Bybit (или он недоступен на этом счёте)' : 'этой монеты нет среди USDT-фьючерсов Bybit', 'no contract');
    const p = r.plan;
    if (!p || !(p.stop > 0) || !(p.t1 > 0)) return this.skip('в сигнале нет стопа или цели', 'no plan');
    const stop = p.stop, t1 = p.t1, t2 = p.t2 > 0 ? p.t2 : p.t1;

    // своя сделка по этой монете: в ту же сторону — пропуск, в обратную — закрыть и развернуться
    const mine = this.openTrades().find((t) => t.symbol === r.symbol);
    if (mine && mine.side === side) return this.skip('по этой монете уже открыта сделка в ту же сторону', 'already open');
    let reversed = null;
    if (mine) { await this.closeTrade(mine, 'reversed'); reversed = mine; }

    const list = await this.client.positions({ symbol: m.symbol });
    const hedge = list.some((x) => +x.positionIdx > 0);
    if (list.some((x) => +x.size > 0)) return this.skip('на Bybit уже есть позиция по этой монете, открытая не программой, — её не трогаю', 'manual position');
    const nOpen = this.openTrades().length;
    if (nOpen >= c.maxPositions) return this.skip(`уже открыто ${nTrades(nOpen)} — это максимум (TRADE_MAX_POSITIONS=${c.maxPositions})`, 'max positions');

    // цена на Bybit: не ушла ли от расчётной, не за стопом/целью ли, хорош ли ещё прибыль/риск
    const tk = await this.client.ticker(m.symbol);
    const last = +tk?.lastPrice / m.mult;
    const fill = (buy ? +tk?.ask1Price : +tk?.bid1Price) / m.mult || last;
    if (!(fill > 0)) return this.error('Bybit не вернул цену');
    const dev = Math.abs(fill / r.price - 1) * 100;
    if (dev > 5) return this.skip(`цена на Bybit ${fmt(fill)} сильно отличается от Binance ${fmt(r.price)} — возможно, это другой контракт`, 'price mismatch');
    if (dev > c.maxSlippagePct) return this.skip(`цена на Bybit ${fmt(fill)} ушла от расчётной ${fmt(r.price)} на ${dev.toFixed(2)}% (допустимо ${c.maxSlippagePct}%)`, 'price moved');
    if (buy ? !(stop < fill && fill < t1) : !(stop > fill && fill > t1)) return this.skip('цена на Bybit уже за стопом или первой целью', 'beyond levels');
    const fee = c.feePct / 100;
    const rr = (Math.abs(t1 - fill) - fill * fee * 2) / (Math.abs(fill - stop) + fill * fee * 2);
    if (rr < c.minRR) return this.skip(`прибыль/риск от цены Bybit ${rr.toFixed(2)} — меньше ${c.minRR}`, 'low R:R');
    // защита от явно ошибочных планов: слишком близкий стоп съедят комиссии и шум, слишком далёкий — подозрителен
    const stopPct = Math.abs(fill - stop) / fill;
    if (stopPct < 0.0015) return this.skip(`стоп слишком близко к цене (${(stopPct * 100).toFixed(2)}%) — комиссии и случайные колебания съедят сделку`, 'stop too close');
    if (stopPct > 0.2) return this.skip(`стоп слишком далеко от цены (${(stopPct * 100).toFixed(1)}%) — похоже на ошибку в данных`, 'stop too far');
    const lev = Math.max(1, Math.min(c.leverage, m.info.maxLev || c.leverage));
    if (stopPct >= 0.8 / lev) return this.skip(`при плече ×${lev} ликвидация может наступить раньше стопа (${(stopPct * 100).toFixed(1)}%)`, 'liquidation risk');

    const bal = await this.refreshBalance(true);
    if (!(bal.equity > 0)) return this.error('на счёте Bybit нет средств');
    if (this.checkDrawdown(bal)) return this.skip(`торговля на сегодня остановлена: баланс снизился на ${fmtUsd(this.state.dayStartEquity - bal.equity)} за день (лимит ${c.dailyLossPct}%)`, 'daily loss limit');
    const sz = sizePosition({ equity: bal.equity, available: bal.available, riskPct: c.riskPct, leverage: lev, maxPositions: c.maxPositions, maxNotionalUsd: c.maxNotionalUsd, feePct: c.feePct, price: fill, stop, info: m.info, mult: m.mult });
    if (!sz.ok) return this.skip(sz.why, 'too small');

    const warnings = [];
    await this.ensureLeverage(m.symbol, lev).catch((e) => warnings.push(`плечо не изменено: ${e.message}`));
    const id = newId();
    const positionIdx = hedge ? (buy ? 1 : 2) : 0;
    const sl = roundTick(stop * m.mult, m.info.tick, buy ? 'down' : 'up');
    try {
      await this.client.createOrder({ symbol: m.symbol, side, orderType: 'Market', qty: fmtStep(sz.contracts, m.info.qtyStep), positionIdx, stopLoss: fmtStep(sl, m.info.tick), slTriggerBy: c.slTriggerBy, tpslMode: 'Full', orderLinkId: `${id}-e` });
    } catch (e) {
      // фьючерсы на акции требуют один раз принять соглашение — в приложении Bybit, а не через API
      const agree = r.kind === 'stock' && /agree|sign|tradfi|permission/i.test(e.message) ? ' — похоже, на Bybit не принято соглашение о торговле акциями: откройте любой фьючерс на акцию в приложении или на сайте Bybit и примите условия' : '';
      if (e.code !== -2) return this.error(`Bybit не принял ордер: ${e.message}${agree}`);
      const o = await this.client.order(m.symbol, `${id}-e`).catch(() => null); // сеть: ордер мог дойти
      if (!o) return this.error(`нет связи с Bybit при отправке ордера: ${e.message}`);
    }
    const pos = await this.waitPosition(m.symbol, positionIdx, side);
    if (!pos) return this.error('ордер отправлен, но позиция не появилась — проверьте Bybit вручную');

    const qty = +pos.size, entry = +pos.avgPrice / m.mult || fill;
    const t = {
      id, mode: this.mode, symbol: r.symbol, bySymbol: m.symbol, mult: m.mult, side, positionIdx, qty, entry, stop, t1, t2, slNow: stop,
      leverage: lev, notional: qty * m.mult * entry, riskUsd: qty * m.mult * (Math.abs(entry - stop) + entry * fee * 2),
      openedAt: Date.now(), status: 'open', tp1Done: false, trailed: false, score: +r.score.toFixed(3), confidence: r.confidence, zone,
      limitedBy: sz.limitedBy, warnings,
    };
    t.riskPct = (t.riskUsd / bal.equity) * 100;
    this.state.trades.push(t);
    this.save();

    // стоп должен быть на бирже всегда; если не встал с ордером — ставим отдельно, не вышло — закрываем
    if (!(+pos.stopLoss > 0)) {
      try { await this.setStop(t, stop); } catch (e) {
        await this.closeTrade(t, 'no-stop').catch(() => {});
        return this.error(`не удалось поставить стоп (${e.message}) — позиция сразу закрыта`);
      }
    }
    // цели: половина на цели 1, остаток на цели 2 (если позиция слишком мала для деления — всё на цели 1)
    const step = m.info.qtyStep;
    const q1 = floorStep(qty * c.tp1Share, step), q2 = floorStep(qty - q1, step);
    t.single = !(q1 >= m.info.minQty && q2 >= m.info.minQty && t2 !== t1);
    t.tp1Qty = t.single ? qty : q1;
    t.tp2Qty = t.single ? 0 : q2;
    t.tpIds = t.single ? { t1: `${id}-t1` } : { t1: `${id}-t1`, t2: `${id}-t2` };
    try {
      await this.placeTp(t, 't1', t.tp1Qty, t1);
      if (!t.single) await this.placeTp(t, 't2', t.tp2Qty, t2);
    } catch (e) {
      // запасной вариант: тейк на всю позицию по цели 1
      try {
        await this.client.tradingStop({ symbol: t.bySymbol, positionIdx, takeProfit: fmtStep(roundTick(t1 * m.mult, m.info.tick), m.info.tick) });
        t.single = true; t.tp1Qty = qty; t.tp2Qty = 0; t.tpOnPosition = true;
        warnings.push(`лимитные цели не выставлены (${e.message}) — вместо них тейк на всю позицию по цели 1`);
      } catch (e2) { warnings.push(`цели не выставлены (${e2.message}) — стоп на бирже стоит, закрою по сроку или вручную`); }
    }
    this.save();
    const sms = `BYBIT ${buy ? 'LONG' : 'SHORT'} ${Math.round(t.notional)}$ risk ${t.riskUsd.toFixed(0)}$${this.mode === 'demo' ? ' demo' : ''}`;
    return { status: 'opened', trade: t, reversed, sms, mode: this.mode };
  }

  async waitPosition(symbol, positionIdx, side, tries = 15) {
    for (let i = 0; i < tries; i++) {
      const list = await this.client.positions({ symbol }).catch(() => []);
      const p = list.find((x) => +x.positionIdx === positionIdx && +x.size > 0 && (!x.side || x.side === side));
      if (p) return p;
      await new Promise((res) => setTimeout(res, 400));
    }
    return null;
  }

  async placeTp(t, tag, qty, price, linkId = `${t.id}-${tag}`) {
    const info = this.instruments.get(t.bySymbol);
    await this.client.createOrder({
      symbol: t.bySymbol, side: t.side === 'Buy' ? 'Sell' : 'Buy', orderType: 'Limit', qty: fmtStep(qty, info.qtyStep),
      price: fmtStep(roundTick(price * t.mult, info.tick), info.tick), reduceOnly: true, timeInForce: 'GTC', positionIdx: t.positionIdx, orderLinkId: linkId,
    });
  }

  /** Цели на месте? Если ордер цели отменили вручную или он не встал — выставить снова на остаток (не чаще раза в 5 мин) */
  async checkTps(t, size, info) {
    if (t.tpOnPosition || Date.now() - (t.tpCheckedAt || 0) < 5 * 60e3) return;
    t.tpCheckedAt = Date.now();
    t.tpIds ??= t.single ? { t1: `${t.id}-t1` } : { t1: `${t.id}-t1`, t2: `${t.id}-t2` };
    const plan = [];
    if (!t.tp1Done) plan.push(['t1', t.single ? size : Math.min(t.tp1Qty, size), t.t1]);
    if (!t.single) plan.push(['t2', t.tp1Done ? size : Math.min(t.tp2Qty, size), t.t2]);
    for (const [tag, qtyRaw, price] of plan) {
      const o = await this.client.order(t.bySymbol, t.tpIds[tag]).catch(() => undefined);
      if (o === undefined) continue; // не удалось проверить — в следующий раз
      if (o && ['New', 'PartiallyFilled', 'Untriggered', 'Filled'].includes(o.orderStatus)) continue;
      const qty = floorStep(qtyRaw, info.qtyStep);
      if (!(qty >= info.minQty)) continue;
      const linkId = `${t.id}-${tag}r${(t.tpRe = (t.tpRe ?? 0) + 1)}`;
      await this.placeTp(t, tag, qty, price, linkId);
      t.tpIds[tag] = linkId;
      this.emit('tp-restored', t, { tag, price });
    }
  }

  async setStop(t, price) {
    const info = this.instruments.get(t.bySymbol);
    const sl = roundTick(price * t.mult, info.tick, t.side === 'Buy' ? 'down' : 'up');
    await this.client.tradingStop({ symbol: t.bySymbol, positionIdx: t.positionIdx, stopLoss: fmtStep(sl, info.tick), slTriggerBy: this.cfg.slTriggerBy });
    t.slNow = price;
  }

  /** Перенос стопа; если цена уже за новым стопом (биржа его не примет) — закрываем по рынку */
  async moveStop(t, price, mark) {
    try { await this.setStop(t, price); return true; } catch (e) {
      if (t.side === 'Buy' ? mark <= price : mark >= price) { await this.closeTrade(t, t.tp1Done ? 'breakeven' : 'stop'); return false; }
      throw e;
    }
  }

  async cancelTps(t) {
    const ids = Object.values(t.tpIds ?? (t.single ? { t1: `${t.id}-t1` } : { t1: `${t.id}-t1`, t2: `${t.id}-t2` }));
    for (const orderLinkId of ids) {
      await this.client.cancelOrder(t.bySymbol, { orderLinkId }).catch(() => { /* уже исполнен или отменён */ });
    }
  }

  /** Закрыть сделку по рынку (разворот, срок, «закрыть всё») */
  async closeTrade(t, why) {
    if (t.status !== 'open') return;
    t.closeWhy = why;
    await this.cancelTps(t);
    const pos = (await this.client.positions({ symbol: t.bySymbol })).find((x) => +x.positionIdx === t.positionIdx && +x.size > 0);
    if (pos) {
      await this.client.createOrder({ symbol: t.bySymbol, side: t.side === 'Buy' ? 'Sell' : 'Buy', orderType: 'Market', qty: pos.size, reduceOnly: true, positionIdx: t.positionIdx, orderLinkId: `${t.id}-x${Date.now().toString(36).slice(-4)}` });
      for (let i = 0; i < 15; i++) {
        const still = (await this.client.positions({ symbol: t.bySymbol }).catch(() => [])).find((x) => +x.positionIdx === t.positionIdx && +x.size > 0);
        if (!still) break;
        await new Promise((res) => setTimeout(res, 400));
      }
    }
    await this.finish(t);
  }

  /** Позиция закрылась (стоп, цель, вручную): итог по данным Bybit, письмо, дневной лимит */
  async finish(t) {
    if (t.status !== 'open') return;
    await this.cancelTps(t);
    let recs = [];
    for (let i = 0; i < 3; i++) {
      recs = (await this.client.closedPnl(t.bySymbol, t.openedAt - 60e3).catch(() => [])).filter((x) => +x.createdTime >= t.openedAt - 5e3);
      const closed = recs.reduce((s, x) => s + +x.closedSize, 0);
      if (closed >= t.qty * 0.99) break;
      await new Promise((res) => setTimeout(res, 1500));
    }
    const qty = recs.reduce((s, x) => s + +x.closedSize, 0);
    t.status = 'closed';
    t.closedAt = Date.now();
    t.pnl = recs.length ? recs.reduce((s, x) => s + +x.closedPnl, 0) : null;
    t.exit = qty > 0 ? recs.reduce((s, x) => s + +x.avgExitPrice * +x.closedSize, 0) / qty / t.mult : null;
    t.r = t.pnl != null && t.riskUsd > 0 ? t.pnl / t.riskUsd : null;
    const lastRec = [...recs].sort((a, b) => +b.createdTime - +a.createdTime)[0];
    t.why = t.closeWhy ?? this.inferWhy(t, lastRec ? +lastRec.avgExitPrice / t.mult : null);
    if (t.pnl != null) { this.rollDay(); this.state.pnlToday += t.pnl; }
    this.save();
    await this.refreshBalance(true).catch(() => {}); // в письме — баланс уже после сделки
    this.emit('closed', t);
    this.checkDailyLoss();
  }

  inferWhy(t, lastExit) {
    if (lastExit == null) return 'closed';
    const cands = [
      [t.single ? t.t1 : t.t2, t.single ? 'tp1' : 'tp2'],
      [t.slNow, t.trailed ? 'trail' : t.tp1Done ? 'breakeven' : 'stop'],
    ];
    const [lvl, why] = cands.sort((a, b) => Math.abs(lastExit / a[0] - 1) - Math.abs(lastExit / b[0] - 1))[0];
    return Math.abs(lastExit / lvl - 1) < 0.006 ? why : 'manual';
  }

  rollDay() {
    const day = localDay();
    if (this.state.day === day) return;
    const wasPaused = this.state.paused;
    Object.assign(this.state, { day, pnlToday: 0, dayStartEquity: this.balance?.equity ?? null, paused: null });
    this.save();
    if (wasPaused) this.emit('resumed');
  }

  /** Баланс (вместе с незакрытыми сделками) упал за день на лимит — пауза до завтра */
  checkDrawdown(bal = this.balance) {
    const lim = this.cfg.dailyLossPct, base = this.state.dayStartEquity;
    if (this.state.paused) return true;
    if (!(lim > 0) || !(base > 0) || !(bal?.equity > 0)) return false;
    if (bal.equity > base * (1 - lim / 100)) return false;
    this.state.paused = { at: Date.now(), pnl: bal.equity - base, byEquity: true };
    this.save();
    this.emit('paused', null, { pnl: bal.equity - base, limitPct: lim });
    return true;
  }

  checkDailyLoss() {
    const lim = this.cfg.dailyLossPct, base = this.state.dayStartEquity;
    if (!(lim > 0) || !(base > 0) || this.state.paused) return;
    if (this.state.pnlToday <= (-base * lim) / 100) {
      this.state.paused = { at: Date.now(), pnl: this.state.pnlToday };
      this.save();
      this.emit('paused', null, { pnl: this.state.pnlToday, limitPct: lim });
    }
  }

  // ── сопровождение открытых сделок (каждые ~10 с) ──
  async tick() {
    if (!this.hasKeys() || this.ticking) return;
    this.ticking = true;
    try {
      if (!this.ready) {
        if (Date.now() - this.lastInit > 10 * 60e3) await this.init();
        if (!this.ready) return;
      }
      this.rollDay();
      if (!this.openTrades().length) {
        if (Date.now() - this.balanceAt > 5 * 60e3) await this.refreshBalance(true).catch(() => {});
        return;
      }
      await this.lock(async () => {
        if (Date.now() - this.balanceAt > 60e3) { await this.refreshBalance(true).catch(() => {}); this.checkDrawdown(); }
        const all = await this.client.positions({ settleCoin: 'USDT' });
        for (const t of this.openTrades()) {
          try { await this.manage(t, all); } catch (e) { this.lastError = `${coinOf(t.symbol)}: ${e.message}`; this.log(`Bybit ${coinOf(t.symbol)}: ${e.message}`); }
        }
        this.save();
      });
      if (this.failStreak >= 30) this.emit('online');
      this.failStreak = 0;
    } catch (e) {
      this.failStreak++;
      this.lastError = e.message;
      if (this.failStreak === 30) this.emit('offline', null, { error: e.message }); // ~5 минут без связи
    } finally {
      this.ticking = false;
    }
  }

  async manage(t, all) {
    let pos = all.find((x) => x.symbol === t.bySymbol && +x.positionIdx === t.positionIdx && +x.size > 0);
    if (!pos) {
      // перепроверим запросом по монете — и только потом считаем сделку закрытой
      pos = (await this.client.positions({ symbol: t.bySymbol })).find((x) => +x.positionIdx === t.positionIdx && +x.size > 0);
      if (!pos) return this.finish(t);
    }
    // позицию закрыли и открыли в обратную сторону вручную — наша сделка закончена, чужую не трогаем
    if (pos.side && pos.side !== t.side) { t.closeWhy = 'manual'; return this.finish(t); }
    const info = this.instruments.get(t.bySymbol);
    const buy = t.side === 'Buy';
    const size = +pos.size, mark = +pos.markPrice / t.mult;
    Object.assign(t, { sizeNow: size, mark, upnl: +pos.unrealisedPnl || 0 });
    if (!(+pos.stopLoss > 0)) { await this.setStop(t, t.slNow); this.emit('sl-restored', t); }
    // цель 1 исполнилась → стоп в безубыток (с учётом комиссий)
    if (!t.single && !t.tp1Done && size <= t.qty - t.tp1Qty + Number(info?.qtyStep ?? 0) / 2) {
      t.tp1Done = true;
      t.tp1At = Date.now();
      const fee = this.cfg.feePct / 100;
      const be = t.entry * (buy ? 1 + 2 * fee : 1 - 2 * fee);
      if (await this.moveStop(t, be, mark)) this.emit('tp1', t);
      if (t.status !== 'open') return;
    }
    // на полпути к цели 2 → стоп на цель 1
    if (t.tp1Done && !t.trailed) {
      const mid = t.t1 + (t.t2 - t.t1) / 2;
      if (buy ? mark >= mid : mark <= mid) {
        if (await this.moveStop(t, t.t1, mark)) { t.trailed = true; t.trailedAt = Date.now(); this.emit('trail', t); }
        if (t.status !== 'open') return;
      }
    }
    if (Date.now() - t.openedAt > this.all.journal.expireHours * 3600e3) { await this.closeTrade(t, 'expired'); return; }
    if (info) await this.checkTps(t, size, info).catch((e) => this.log(`Bybit ${coinOf(t.symbol)}: цели не проверены — ${e.message}`));
  }

  /** Закрыть все сделки программы (команда --close-all) */
  async closeAll() {
    const out = [];
    await this.lock(async () => {
      for (const t of this.openTrades()) {
        try { await this.closeTrade(t, 'manual-all'); out.push(t); } catch (e) { out.push({ ...t, error: e.message }); }
      }
    });
    return out;
  }

  // ── сводки ──
  stats(days = 30) {
    const since = Date.now() - days * 86400e3;
    const closed = this.state.trades.filter((t) => t.status === 'closed' && t.closedAt >= since && t.pnl != null);
    const wins = closed.filter((t) => t.pnl > 0).length;
    return {
      n: closed.length, wins, winRate: closed.length ? wins / closed.length : null,
      pnl: closed.reduce((s, t) => s + t.pnl, 0),
      sumR: closed.reduce((s, t) => s + (t.r ?? 0), 0),
    };
  }

  describe() {
    const c = this.cfg;
    if (!c.enabled && !this.openTrades().length) return null;
    const head = `Bybit, ${MODE_RU[this.mode]}${this.mode === 'live' ? ' (НАСТОЯЩИЕ ДЕНЬГИ)' : ''}`;
    if (!this.ready) return `⚠️ Автоторговля (${head}) не запущена: ${this.problem}`;
    const bal = this.balance ? `, баланс ${fmtUsd(this.balance.equity)}` : '';
    const set = `риск ${c.riskPct}% на сделку, плечо до ×${c.leverage}, до ${c.maxPositions} позиций, дневной лимит убытка ${c.dailyLossPct}%`;
    return `🤖 Автоторговля${c.enabled ? '' : ' выключена (TRADE=0), сопровождаю открытые сделки'}: ${head}${bal}; ${set}${this.warnings.length ? `\n⚠️ ${this.warnings.join('\n⚠️ ')}` : ''}`;
  }

  status() {
    const closed = this.state.trades.filter((t) => t.status === 'closed');
    return {
      enabled: this.enabled, hasKeys: this.hasKeys(), mode: this.mode, modeRu: MODE_RU[this.mode], ready: this.ready, problem: this.problem, warnings: this.warnings, userPause: this.userPause(),
      balance: this.balance, pnlToday: this.state.pnlToday, paused: this.state.paused, lastError: this.lastError,
      settings: { riskPct: this.cfg.riskPct, leverage: this.cfg.leverage, maxPositions: this.cfg.maxPositions, dailyLossPct: this.cfg.dailyLossPct },
      open: this.openTrades(), closed: closed.slice(-20).reverse(), stats: this.stats(30), api: this.client.status(),
    };
  }
}
