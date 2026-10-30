#!/usr/bin/env node
// Crypto Watcher — круглосуточный анализ топ-монет и уведомления о хорошей цене для покупки/продажи.
//
//   node index.js                     — работать постоянно (монеты из .env, по умолчанию топ-15)
//   node index.js SOLUSDT ETHUSDT     — следить за выбранными парами
//   node index.js BTCUSDT --once      — один подробный отчёт и выход
//   node index.js --test-notify       — проверить почту и SMS
//   node index.js --digest-now        — сразу после первого цикла прислать ежедневный обзор
//   node index.js --stats             — статистика сигналов из журнала
//   node index.js --trade-check       — проверить ключ Bybit, баланс и контракты
//   node index.js --trade-status      — открытые сделки программы на Bybit и итоги
//   node index.js --close-all         — закрыть все сделки программы на Bybit
//   флаги: --top N --threshold X --poll S --verbose --no-news --no-whales --no-server
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(dir, '.env');
if (fs.existsSync(envFile) && process.loadEnvFile) process.loadEnvFile(envFile);

const { default: cfg } = await import('./config.js');
const { Binance } = await import('./lib/binance.js');
const { BinanceStream } = await import('./lib/streams.js');
const { TradeFlow } = await import('./lib/trades.js');
const { Liquidations } = await import('./lib/liquidations.js');
const { OrderBookTracker } = await import('./lib/orderbook.js');
const { CoinbaseFeed } = await import('./lib/coinbase.js');
const { MarketContext } = await import('./lib/market.js');
const { NewsService } = await import('./lib/news.js');
const { Journal } = await import('./lib/journal.js');
const { Notifier } = await import('./lib/notifier.js');
const { analyze } = await import('./lib/analyzer.js');
const { selectUniverse } = await import('./lib/universe.js');
const { startServer } = await import('./lib/server.js');
const { MacroCalendar } = await import('./lib/calendar.js');
const { Trader, MODE_RU } = await import('./lib/trader.js');
const { chartPng, chartSvg } = await import('./lib/chart.js');
const { atr, lastValid } = await import('./lib/indicators.js');
const { sleep } = await import('./lib/http.js');
const { coinOf, fmt, fmtUsd, fmtMoney, trades: nTrades } = await import('./lib/format.js');
const R = await import('./lib/report.js');

// ── аргументы ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const bool = (n) => { const i = args.indexOf(`--${n}`); if (i < 0) return false; args.splice(i, 1); return true; };
const once = bool('once'), verbose = bool('verbose'), testNotify = bool('test-notify'), digestNow = bool('digest-now'), showStats = bool('stats');
const tradeCheck = bool('trade-check'), tradeStatus = bool('trade-status'), closeAll = bool('close-all');
if (bool('no-news')) cfg.news.enabled = false;
if (bool('no-whales')) cfg.whales.enabled = false;
if (bool('no-server') || once) cfg.server.port = 0;
cfg.signal.threshold = Number(flag('threshold') ?? cfg.signal.threshold);
cfg.pollSeconds = Number(flag('poll') ?? cfg.pollSeconds);
cfg.universe.size = Number(flag('top') ?? cfg.universe.size);
const manual = args.length ? args.map((s) => s.toUpperCase())
  : cfg.symbols[0]?.toLowerCase() === 'auto' ? null : cfg.symbols.map((s) => s.toUpperCase());

// ── компоненты ─────────────────────────────────────────────────────────────
const file = (f) => path.resolve(dir, f);
const binance = new Binance(cfg);
const notifier = new Notifier(cfg);
const news = new NewsService(cfg);
const market = new MarketContext(cfg, file(cfg.files.market));
const coinbase = new CoinbaseFeed(cfg);
const book = new OrderBookTracker(cfg);
const journal = new Journal(file(cfg.files.journal), cfg);
const liq = new Liquidations();
const calendar = new MacroCalendar(file(cfg.macro.file));
const macroNow = () => ({ risk: calendar.risk(), next: calendar.next() });
const flow = new TradeFlow(cfg, { onWhale: (ev, d) => { onWhale(ev, d).catch((e) => console.error('🐋', e.message)); } });
const streamsOn = cfg.whales.enabled && !once && BinanceStream.supported();
const spotStream = new BinanceStream({ name: 'спот', base: cfg.streams.spotWs, fallback: cfg.streams.spotFallback, onMessage: (d) => { if (d.e === 'aggTrade') flow.handleTrade('spot', d); } });
const trader = new Trader(cfg, { file: file(cfg.files.trades), onEvent: (ev) => onTradeEvent(ev) });
const futStream = new BinanceStream({
  name: 'фьючерсы', base: cfg.streams.futuresWs,
  onMessage: (d) => { if (d.e === 'aggTrade') flow.handleTrade('futures', d); else if (d.e === 'forceOrder') liq.handle(d); },
});

if (showStats) {
  const s = journal.stats(30);
  console.log(JSON.stringify(s, null, 2));
  for (const e of journal.recent(20)) console.log(`${new Date(e.opened).toISOString().slice(0, 16)} ${e.symbol} ${e.side} ${fmt(e.entry)} → ${e.status}${e.why ? ` (${e.why})` : ''} ${e.result != null ? `${e.result}R` : ''}`);
  process.exit(0);
}

// ── команды автоторговли ───────────────────────────────────────────────────
if (tradeCheck || tradeStatus || closeAll) {
  console.log(`Bybit: ${MODE_RU[trader.mode]} — ${trader.client.base}`);
  if (!trader.hasKeys()) { console.log('❌ Не заданы BYBIT_API_KEY и BYBIT_API_SECRET в .env'); process.exit(1); }
  await trader.init();
  if (!trader.ready) { console.log(`❌ ${trader.problem}`); process.exit(1); }
  const k = trader.keyInfo;
  if (tradeCheck) {
    console.log(`✅ Ключ работает: ${k.readOnly ? 'только чтение' : 'чтение и запись'}, контракты: ${(k.perms.ContractTrade ?? []).join(', ') || '—'}, вывод средств: ${(k.perms.Wallet ?? []).includes('Withdraw') ? 'ЕСТЬ' : 'нет'}`);
    console.log(`   IP: ${k.ips.filter((x) => x !== '*').join(', ') || 'не привязан'}`);
    for (const w of trader.warnings) console.log(`⚠️ ${w}`);
    console.log(`Баланс: ${fmtMoney(trader.balance.equity)}, свободно ${fmtMoney(trader.balance.available)}`);
    let syms = manual;
    if (!syms) { try { syms = JSON.parse(fs.readFileSync(file(cfg.universe.cacheFile), 'utf8')).coins.map((c) => c.symbol); } catch { syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'PEPEUSDT']; } }
    console.log('Контракты Bybit для монет:');
    for (const s of syms) { const m = trader.resolve(s); console.log(`  ${s.padEnd(11)} → ${m ? `${m.symbol}${m.mult > 1 ? ` (1 контракт = ${m.mult} монет)` : ''}, плечо до ×${m.info.maxLev}` : 'нет на Bybit — по этой монете сделок не будет'}`); }
    console.log(cfg.trade.enabled
      ? `🤖 Автоторговля включена: риск ${cfg.trade.riskPct}% на сделку, плечо до ×${cfg.trade.leverage}, до ${cfg.trade.maxPositions} позиций`
      : 'Автоторговля пока выключена — чтобы включить, поставьте TRADE=1 в .env и перезапустите программу');
  }
  if (tradeStatus) {
    const st = trader.status();
    console.log(`Баланс ${fmtMoney(st.balance.equity)}, итог за сегодня ${fmtMoney(st.pnlToday, { sign: true })}${st.paused ? ' — ⛔ дневной лимит убытка' : ''}`);
    if (!st.open.length) console.log('Открытых сделок программы нет');
    for (const t of st.open) console.log(`  ${t.side === 'Buy' ? 'ЛОНГ' : 'ШОРТ'} ${coinOf(t.symbol)} с ${new Date(t.openedAt).toLocaleString('ru-RU')} по ${fmt(t.entry)}, стоп ${fmt(t.slNow)}, цели ${fmt(t.t1)}${t.single ? '' : `/${fmt(t.t2)}`}${t.tp1Done ? ' (цель 1 взята)' : ''}`);
    if (st.stats.n) console.log(`За 30 дней: ${nTrades(st.stats.n)}, прибыльных ${(st.stats.winRate * 100).toFixed(0)}%, итог ${fmtMoney(st.stats.pnl, { sign: true })}`);
  }
  if (closeAll) {
    if (!trader.openTrades().length) console.log('Открытых сделок программы нет');
    else for (const t of await trader.closeAll()) console.log(`  ${coinOf(t.symbol)}: ${t.error ? `ошибка — ${t.error}` : `закрыта, ${t.pnl != null ? fmtMoney(t.pnl, { sign: true }) : 'итог уточняется'}`}`);
  }
  process.exit(0);
}

// ── состояние (переживает перезапуск) ──────────────────────────────────────
const stateFile = file(cfg.files.state);
let state = { signals: {}, pending: {}, zones: {}, newsAlerted: {}, macroAlerted: {}, digestDay: null, newsDay: { day: 0, count: 0 } };
try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* первый запуск */ }
// совместимость с версией 1.x: там состояние хранилось как { BTCUSDT: {action, at} }
for (const [k, v] of Object.entries(state)) if (/USDT$/.test(k) && v?.action) { state.signals[k] = v; delete state[k]; }
let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); }
    catch (e) { console.error('Не удалось сохранить состояние:', e.message); }
  }, 500);
}

const results = new Map();
const candleCache = new Map(); // последние часовые свечи монеты — для графиков
const alertLog = [];
const whaleLog = [];
const errors = new Map();
let coins = manual ? manual.map((symbol) => ({ symbol })) : [];
let universeAt = 0;
let lastCycleAt = 0, cycles = 0;
const startedAt = Date.now();

function logAlert(subject) { alertLog.unshift({ t: Date.now(), subject }); alertLog.length = Math.min(alertLog.length, 100); }

// ── список монет ───────────────────────────────────────────────────────────
async function refreshUniverse(force = false) {
  const due = force || !coins.length || Date.now() - universeAt > cfg.universe.refreshHours * 3600e3;
  if (!due && universeAt) return;
  let source = 'ваш список';
  const before = new Set(coins.map((c) => c.symbol));
  const first = universeAt === 0;
  if (!manual) {
    const res = await selectUniverse(cfg, file(cfg.universe.cacheFile), () => binance.ticker24h('spot'));
    coins = res.coins;
    source = res.source;
  }
  universeAt = Date.now();
  const symbols = coins.map((c) => c.symbol);
  await Promise.allSettled([binance.loadFuturesInfo(), binance.loadSpotInfo(symbols)]);
  await syncStreams();
  const added = symbols.filter((s) => !before.has(s)), removed = [...before].filter((s) => !symbols.includes(s));
  console.log(`\nМонеты (${source}):\n${R.coinsTable(coins)}\n`);
  if (once) return;
  if (first) {
    const m = R.startMessage({ coins, source, cfg, channels: notifier.channels(), trading: trader.describe() });
    logAlert(m.subject);
    await notifier.broadcast(m);
  } else if (added.length || removed.length) {
    const m = R.startMessage({ coins, source, cfg, channels: notifier.channels(), changed: { added, removed } });
    logAlert(m.subject);
    notifier.enqueue({ ...m, tag: '🔄' });
  }
}

// потоки, пороги китов и справочник фьючерсов: при сбое при старте — догоняем в следующих циклах
async function syncStreams() {
  await Promise.allSettled([binance.loadFuturesInfo()]);
  if (!streamsOn) return;
  const symbols = coins.map((c) => c.symbol);
  flow.setSymbols(symbols, binance.futMap);
  liq.setSymbols(symbols, binance.futMap);
  const [st, ft] = await Promise.allSettled([binance.ticker24h('spot'), binance.ticker24h('futures')]);
  flow.setThresholdsFromTickers(st.value ?? [], ft.value ?? []);
  if (cfg.whales.markets.includes('spot')) spotStream.setStreams(symbols.map((s) => `${s.toLowerCase()}@aggTrade`));
  const fsyms = symbols.map((s) => binance.futuresOf(s)?.symbol).filter(Boolean);
  futStream.setStreams([...(cfg.whales.markets.includes('futures') ? fsyms.map((s) => `${s.toLowerCase()}@aggTrade`) : []), '!forceOrder@arr']);
}

// ── сбор данных по монете ──────────────────────────────────────────────────
const val = (r) => (r.status === 'fulfilled' ? r.value : null);

async function gatherDeriv(fsym) {
  const p = cfg.derivatives.period, R5 = cfg.refresh.derivativesMinutes * 60e3;
  const res = await Promise.allSettled([
    binance.premiumIndex(fsym),
    binance.fundingRates(fsym, 100, cfg.refresh.fundingMinutes * 60e3),
    binance.openInterestHist(fsym, p, 500, R5),
    binance.ratio('topPosition', fsym, p, 48, R5),
    binance.ratio('globalAccount', fsym, p, 48, R5),
    binance.ratio('taker', fsym, p, 48, R5),
  ]);
  const [premium, funding, oi, topPos, globalAcc, taker] = res.map(val);
  if (!premium && !oi) throw res[0].reason ?? new Error('нет данных по фьючерсам');
  return { premium, funding, oi, topPos, globalAcc, taker };
}

async function btcContext(symbol) {
  if (/^BTC/.test(symbol)) return null;
  const r = results.get('BTCUSDT') ?? results.get('BTCUSDT@ctx');
  const h1 = binance.cache.peek(`k:spot:BTCUSDT:1h:${cfg.candles.h1}`) ?? await binance.klines('BTCUSDT', '1h', cfg.candles.h1).catch(() => null);
  return h1 ? { h1, trend: r?.blocks?.trend?.score ?? market.btc?.trend ?? 0, score: r?.score ?? market.btc?.score ?? 0 } : null;
}

async function gather(c, { light = false } = {}) {
  const sym = c.symbol;
  const f = cfg.derivatives.enabled ? binance.futuresOf(sym) : null;
  const [m15, h1, h4, d1] = await Promise.all([
    binance.klines(sym, '15m', cfg.candles.m15),
    binance.klines(sym, '1h', cfg.candles.h1),
    binance.klines(sym, '4h', cfg.candles.h4, { ttlMs: cfg.refresh.h4Minutes * 60e3 }),
    binance.klines(sym, '1d', cfg.candles.d1, { ttlMs: cfg.refresh.d1Minutes * 60e3 }),
  ]);
  const live = flow.lastPrice(sym);
  const price = live && Date.now() - live.time < 90e3 ? live.price : m15[m15.length - 1].close;
  candleCache.set(sym, h1);
  const lastBar = h1[h1.length - 1];
  if (!lastBar || Date.now() - lastBar.time > 2 * 3600e3) throw new Error(`данные Binance устарели (последняя свеча ${lastBar ? new Date(lastBar.time).toISOString().slice(0, 16) : '—'})`);
  if (light) return { symbol: sym, name: c.name, price, candles: { m15, h1, h4, d1 }, market: market.snapshot(), macro: macroNow() };

  const H = h1.map((x) => x.high), L = h1.map((x) => x.low), C = h1.map((x) => x.close);
  const atr1 = lastValid(atr(H.slice(0, -1), L.slice(0, -1), C.slice(0, -1), 14));
  const ob = cfg.orderbook.enabled;
  const res = await Promise.allSettled([
    f ? binance.klines(f.symbol, '1h', 200, { market: 'futures' }) : null,
    ob ? binance.depth(sym, { market: 'spot', limit: cfg.orderbook.depthLimit }) : null,
    ob && f ? binance.depth(f.symbol, { market: 'futures', limit: cfg.orderbook.depthLimit }) : null,
    f ? gatherDeriv(f.symbol) : null,
    coinbase.premium(coinOf(sym), price),
    news.analyze(sym, c.name),
    btcContext(sym),
  ]);
  const [futH1, sBook, fBook, deriv, cb, newsRes, btc] = res.map(val);
  if (verbose) for (const r of res) if (r.status === 'rejected') console.error(`${sym}: ${r.reason?.message}`);

  let bookRes = null;
  if (sBook || fBook) {
    bookRes = book.analyze(sym, { spot: sBook, futures: fBook ? { ...fBook, mult: f.mult } : null }, price, atr1,
      flow.takeRange(sym, 'book'), { spot: flow.threshold('spot', sym), futures: flow.threshold('futures', sym) });
  }
  let liqSum = null;
  if (streamsOn && f) { const h = liq.summary(sym, 60); liqSum = { h1: h, h24: liq.summary(sym, 1440), coverageMin: h.coverageMin }; }
  const flowSum = streamsOn ? { h1: flow.summary(sym, 60), h4: flow.summary(sym, 240) } : null;
  return {
    symbol: sym, name: c.name, price, candles: { m15, h1, h4, d1 }, fut: futH1 ? { h1: futH1 } : null,
    deriv, liq: liqSum, flow: flowSum, book: bookRes, coinbase: cb, news: newsRes, market: market.snapshot(), btc, macro: macroNow(),
  };
}

// график для письма: PNG-вложение с Content-ID
function chartFor(r) {
  const c = r && candleCache.get(r.symbol);
  if (!c) return { chartCid: null, attachments: [] };
  try {
    const png = chartPng(r, c);
    if (!png) return { chartCid: null, attachments: [] };
    const cid = `chart-${r.symbol}-${Date.now().toString(36)}@crypto-watcher`;
    return { chartCid: cid, attachments: [{ filename: `${coinOf(r.symbol)}-1h.png`, content: png, cid }] };
  } catch (e) { console.error('График:', e.message); return { chartCid: null, attachments: [] }; }
}

// ── сигналы ────────────────────────────────────────────────────────────────
function notifyJournal(ev) {
  const m = R.journalMessage(ev, journal.stats(30));
  logAlert(m.subject);
  notifier.enqueue({ ...m, tag: m.subject.split(' ')[0] });
}

// анализ развернулся против открытого сигнала — предупредить один раз
function checkReversal(r) {
  const en = journal.openFor(r.symbol);
  if (!en || en.reversalWarned) return;
  const against = en.side === 'BUY' ? r.score <= -r.threshold * 0.7 : r.score >= r.threshold * 0.7;
  if (!against || r.action === (en.side === 'BUY' ? 'SELL' : 'BUY')) return; // сильный обратный сигнал закроет сделку сам
  en.reversalWarned = Date.now();
  journal.save();
  const ch = chartFor(r);
  const m = R.reversalMessage(en, r, { chartCid: ch.chartCid });
  logAlert(m.subject);
  notifier.enqueue({ ...m, tag: '⚠️', attachments: ch.attachments });
}

async function handleResult(r, { zone = false } = {}) {
  results.set(r.symbol, r);
  if (once) return;
  checkReversal(r);
  const sym = r.symbol, now = Date.now();
  const st = state.signals[sym];
  const strong = r.action === 'BUY' || r.action === 'SELL';

  // подтверждение: сигнал должен продержаться confirmPolls проверок подряд
  if (strong && !zone) {
    const p = state.pending[sym];
    const recent = p && now - p.at < cfg.pollSeconds * 3000; // подтверждение должно быть свежим (не из прошлого запуска)
    const count = p?.action === r.action && recent ? p.count + 1 : 1;
    state.pending[sym] = { action: r.action, count, at: now };
    if (count < cfg.signal.confirmPolls) { saveState(); return; }
  } else if (!strong) delete state.pending[sym];

  if (r.action === 'NEUTRAL') {
    if (st && st.action !== 'NEUTRAL') { state.signals[sym] = { action: 'NEUTRAL', at: now }; saveState(); }
    if (state.zones[sym] && Math.abs(r.score) < r.threshold * 0.3) { delete state.zones[sym]; saveState(); }
    return;
  }

  if (strong) {
    const fresh = st && now - st.at < cfg.signal.cooldownMinutes * 60e3;
    if (st?.action === r.action && fresh) return;
    r.exposure = journal.entries.filter((x) => x.status === 'open' && x.symbol !== sym && x.side === r.action).map((x) => ({ symbol: x.symbol, opened: x.opened }));
    const { events } = journal.open(r);
    for (const ev of events) notifyJournal(ev);
    // «готовиться» по этой монете, ещё ждущее в очереди писем, устарело — сигнал важнее
    notifier.drop(`watch:${sym}`);
    state.signals[sym] = { action: r.action, at: now, price: r.price };
    delete state.zones[sym];
    delete state.pending[sym];
    saveState();
    // автоторговля: сначала сделка на Bybit, потом письмо и SMS — уже с её результатом
    r.exec = trader.enabled ? await trader.onSignal(r, { zone }) : null;
    if (r.exec) console.log(`🤖 Bybit: ${r.exec.status === 'opened' ? `открыт ${r.exec.trade.side === 'Buy' ? 'лонг' : 'шорт'} ${coinOf(sym)} на ${fmtMoney(r.exec.trade.notional)}` : `без сделки — ${r.exec.reason}`}`);
    const subject = R.signalSubject(r, { zone });
    logAlert(subject);
    const ch = chartFor(r);
    await notifier.urgent({ subject, text: R.signalText(r, { zone }), html: R.signalHtml(r, { zone, chartCid: ch.chartCid }), smsText: R.smsText(r, { zone }), attachments: ch.attachments });
    return;
  }

  // «готовиться»: запоминаем зону — как только цена в неё войдёт, анализ запустится сразу.
  // Если даже от зоны прибыль/риск плохой — точки входа нет, письмо не нужно (видно в панели).
  if (!r.zoneOk) { delete state.zones[sym]; saveState(); return; }
  const prevZone = state.zones[sym];
  state.zones[sym] = { dir: r.plan.dir, low: r.plan.zone[0], high: r.plan.zone[1], atr: r.stats.atr, at: now, until: now + cfg.signal.zoneValidHours * 3600e3, lastTrigger: prevZone?.lastTrigger ?? 0 };
  const base = r.action.replace('WATCH_', '');
  if (st && (st.action === r.action || st.action === base) && now - st.at < cfg.signal.watchCooldownMinutes * 60e3) { saveState(); return; }
  const subject = R.signalSubject(r);
  logAlert(subject);
  const ch = chartFor(r);
  notifier.enqueue({ subject, text: R.signalText(r), html: R.signalHtml(r, { chartCid: ch.chartCid }), tag: '🟡', attachments: ch.attachments, key: `watch:${sym}` });
  state.signals[sym] = { action: r.action, at: now, price: r.price };
  saveState();
}

function newsAlerts(r) {
  if (once || !cfg.news.alerts || !r.news?.alerts?.length) return;
  const day = Math.floor(Date.now() / 86400e3);
  if (state.newsDay?.day !== day) state.newsDay = { day, count: 0 };
  for (const a of r.news.alerts) {
    if (state.newsAlerted[a.id] || state.newsDay.count >= cfg.news.alertsPerDay) continue;
    state.newsAlerted[a.id] = Date.now();
    state.newsDay.count++;
    const m = R.newsMessage(r.symbol, a, r);
    logAlert(m.subject);
    notifier.enqueue({ ...m, tag: '📰' });
  }
  for (const [id, t] of Object.entries(state.newsAlerted)) if (Date.now() - t > 4 * 86400e3) delete state.newsAlerted[id];
  saveState();
}

// ── макрособытия: письмо за несколько часов ───────────────────────────────
function macroAlerts() {
  if (once || !cfg.macro.alerts) return;
  const now = Date.now();
  state.macroAlerted ??= {};
  for (const ev of calendar.upcoming(now, cfg.macro.alertHours)) {
    if (state.macroAlerted[ev.id]) continue;
    state.macroAlerted[ev.id] = now;
    const btc = results.get('BTCUSDT') ?? results.get('BTCUSDT@ctx');
    const m = R.macroMessage(ev, { btc: btc ? { price: btc.price, score: btc.score, change24h: btc.stats?.change24h } : null, open: journal.entries.filter((x) => x.status === 'open'), filter: cfg.macro.filter !== false });
    logAlert(m.subject);
    notifier.enqueue({ ...m, tag: '📅' });
  }
  for (const [id, t] of Object.entries(state.macroAlerted)) if (now - t > 30 * 86400e3) delete state.macroAlerted[id];
  saveState();
}

// ── автоторговля: письма о сопровождении сделок ─────────────────────────────
function onTradeEvent(ev) {
  const m = R.tradeEventMessage(ev, { pnlToday: trader.state.pnlToday, stats: trader.stats(30), balance: trader.balance });
  console.log(m.subject);
  logAlert(m.subject);
  notifier.enqueue({ ...m, tag: '🤖' });
}

// ── киты ───────────────────────────────────────────────────────────────────
async function onWhale(ev, decision) {
  const line = `🐋 ${new Date(ev.time).toLocaleTimeString('ru-RU')} ${ev.side === 'buy' ? 'покупка' : 'продажа'} ${coinOf(ev.symbol)} ${ev.market}${ev.type === 'series' ? ` серия ×${ev.count}` : ''} ${fmtUsd(ev.usd)}`;
  const { ref, ...rest } = ev;
  whaleLog.unshift({ ...rest, alerted: decision.alert });
  whaleLog.length = Math.min(whaleLog.length, 300);
  if (!decision.alert) { if (verbose) console.log(`${line} — без письма: ${decision.reason}`); return; }
  console.log(line);
  const ch = chartFor(results.get(ev.symbol));
  const m = R.whaleMessage(ev, decision, { summary: flow.summary(ev.symbol, 60), result: results.get(ev.symbol), chartCid: ch.chartCid });
  logAlert(m.subject);
  notifier.enqueue({ subject: m.subject, text: m.text, html: m.html, tag: '🐋', attachments: ch.attachments });
  if (cfg.whales.sms) notifier.sms(m.sms);
}

// ── живые проверки: зоны входа и журнал (каждые 5 с) ───────────────────────
const triggering = new Set();
async function zoneTrigger(sym, z) {
  const c = coins.find((x) => x.symbol === sym);
  if (!c) return;
  const r = analyze(await gather(c), cfg);
  results.set(sym, r);
  const dirOk = z.dir === 'BUY' ? r.score > 0 : r.score < 0;
  const why = !dirOk ? 'оценка сменила знак' : Math.abs(r.score) < r.threshold * cfg.signal.zoneTriggerRatio ? `оценка ${r.score.toFixed(2)} слабее ${(r.threshold * cfg.signal.zoneTriggerRatio).toFixed(2)}`
    : r.plan.rrNow < cfg.signal.minRiskReward ? `прибыль/риск ${r.plan.rrNow.toFixed(2)}` : r.warnings[0] ?? null;
  console.log(`🎯 ${coinOf(sym)}: цена ${fmt(r.price)} в зоне ${fmt(z.low)}–${fmt(z.high)} — ${why ? `сигнал не подтверждён (${why})` : 'сигнал подтверждён'}`);
  if (!why) {
    r.action = z.dir;
    await handleResult(r, { zone: true });
  } else if (!dirOk && Math.abs(r.score) >= r.threshold * 0.6) {
    delete state.zones[sym]; // картина развернулась — зона больше не актуальна
    saveState();
  }
}

function liveTick() {
  const now = Date.now();
  for (const [sym, z] of Object.entries(state.zones)) {
    if (now > z.until) { delete state.zones[sym]; saveState(); continue; }
    const lp = flow.lastPrice(sym);
    if (!lp || now - lp.time > 60e3 || triggering.has(sym) || now - (z.lastTrigger || 0) < 10 * 60e3) continue;
    const inZone = z.dir === 'BUY'
      ? lp.price <= z.high + 0.05 * z.atr && lp.price >= z.low - 0.4 * z.atr
      : lp.price >= z.low - 0.05 * z.atr && lp.price <= z.high + 0.4 * z.atr;
    if (!inZone) continue;
    z.lastTrigger = now;
    triggering.add(sym);
    zoneTrigger(sym, z).catch((e) => console.error(`🎯 ${sym}: ${e.message}`)).finally(() => triggering.delete(sym));
  }
  const evs = journal.update((s) => flow.takeRange(s, 'journal'));
  for (const ev of evs) notifyJournal(ev);
  if (cfg.move.alerts) for (const c of coins) checkMove(c);
}

// ⚡ резкое движение: сразу пересчитать анализ и прислать письмо
const moving = new Set();
function checkMove(c) {
  const sym = c.symbol, r0 = results.get(sym);
  if (moving.has(sym) || !r0) return;
  const mv = flow.detectMove(sym, r0.stats.atrPct, cfg.move);
  if (!mv) return;
  state.moveAlerted ??= {};
  const prev = state.moveAlerted[sym];
  const now = Date.now();
  const dir = Math.sign(mv.change);
  if (prev && now - prev.at < cfg.move.cooldownMinutes * 60e3 && (prev.dir === dir || now - prev.at < 10 * 60e3)) return;
  const day = Math.floor(now / 86400e3);
  if (state.moveDay?.day !== day) state.moveDay = { day, count: 0 };
  if (state.moveDay.count >= cfg.move.maxPerDay) return;
  state.moveAlerted[sym] = { at: now, dir };
  state.moveDay.count++;
  saveState();
  moving.add(sym);
  console.log(`⚡ ${coinOf(sym)} ${(mv.change * 100).toFixed(2)}% за ${mv.win} мин — пересчитываю анализ`);
  (async () => {
    let r = null;
    try { r = analyze(await gather(c), cfg); await handleResult(r); } catch (e) { console.error(`⚡ ${sym}: ${e.message}`); }
    const ch = chartFor(r);
    const m = R.moveMessage(mv, r, { liq: streamsOn ? liq.summary(sym, 15) : null, flow: streamsOn ? flow.summary(sym, 15) : null, chartCid: ch.chartCid });
    logAlert(m.subject);
    notifier.enqueue({ ...m, tag: '⚡', attachments: ch.attachments });
  })().finally(() => moving.delete(sym));
}

// если потоков нет — журнал обновляется по 15-минутным свечам
function journalFallback() {
  if (streamsOn) return;
  const evs = journal.update((s) => {
    const m15 = binance.cache.peek(`k:spot:${s}:15m:${cfg.candles.m15}`);
    if (!m15?.length) return null;
    const x = m15[m15.length - 1];
    return { hi: x.high, lo: x.low, last: x.close };
  });
  for (const ev of evs) notifyJournal(ev);
}

// ── ежедневный обзор ───────────────────────────────────────────────────────
async function sendDigest() {
  const list = [...results.entries()].filter(([k]) => !k.includes('@')).map(([, v]) => v);
  if (!list.length) return;
  const whalesDay = {};
  if (streamsOn) for (const r of list) { const s = flow.summary(r.symbol, 1440); if (s && s.whales.buy + s.whales.sell > 0) whalesDay[r.symbol] = s.whales.net; }
  const newsTop = list.flatMap((r) => r.news?.top ?? [])
    .filter((n) => Date.now() - n.time < 24 * 3600e3)
    .sort((a, b) => Math.abs(b.s) * b.w - Math.abs(a.s) * a.w)
    .filter((n, i, arr) => arr.findIndex((x) => x.title === n.title) === i).slice(0, 6);
  const m = R.digestMessage({
    results: list, market: market.snapshot(), journal: journal.recent(100), stats: journal.stats(30),
    liqMarket: streamsOn ? liq.marketSummary(1440) : null, whalesDay: streamsOn ? whalesDay : null, newsTop, health: health().text,
    events: calendar.upcoming(Date.now(), 7 * 24),
    trading: trader.enabled || trader.openTrades().length ? trader.status() : null,
  });
  logAlert(m.subject);
  await notifier.broadcast(m);
}

function digestDue() {
  if (!cfg.digest.enabled) return false;
  const d = new Date();
  return d.getHours() >= cfg.digest.hour && state.digestDay !== d.toLocaleDateString('sv-SE');
}

// ── здоровье и веб-панель ──────────────────────────────────────────────────
function health() {
  const age = lastCycleAt ? (Date.now() - lastCycleAt) / 1000 : null;
  const limit = Math.max(cfg.pollSeconds * 5, 600);
  const ok = age == null ? Date.now() - startedAt < limit * 2000 : age < limit;
  const b = binance.status(), n = notifier.status();
  const tr = trader.enabled || trader.openTrades().length ? trader : null;
  const tradeText = tr ? `; Bybit (${MODE_RU[tr.mode]}): ${tr.ready ? `открыто ${tr.openTrades().length}, запросов ${tr.client.stats.requests}, ошибок ${tr.client.stats.errors}` : `не работает — ${tr.problem}`}` : '';
  const text = `циклов ${cycles}, последний ${age == null ? '—' : `${Math.round(age)} с назад`}; Binance: вес ${b.weight.spot}/6000 (спот), ${b.weight.futures}/2400 (фьючерсы), запросов ${b.requests}, ошибок ${b.errors}; писем ${n.emails}, SMS ${n.sms}, ошибок отправки ${n.errors}${tradeText}`;
  return { ok, lastCycleSec: age == null ? null : Math.round(age), cycles, text, binance: b, notifier: n, trading: tr ? { ready: tr.ready, open: tr.openTrades().length, problem: tr.problem } : null, uptimeMin: Math.round((Date.now() - startedAt) / 60e3) };
}

const feedsSummary = () => {
  const groups = new Map();
  for (const f of news.status()) {
    const g = groups.get(f.name) ?? { name: f.name, ok: false, n: 0 };
    g.ok ||= f.ok; g.n++;
    groups.set(f.name, g);
  }
  return [...groups.values()];
};

const app = {
  results,
  health,
  chartSvg: (sym) => { const r = results.get(sym), c = candleCache.get(sym); return r && c ? chartSvg(r, c) : ''; },
  snapshot: () => ({
    results: [...results.entries()].filter(([k]) => !k.includes('@')).map(([, v]) => v),
    market: market.snapshot(),
    stats: journal.stats(30),
    journal: journal.recent(100),
    alerts: alertLog,
    whales: whaleLog.slice(0, 50),
    health: health(),
    streams: streamsOn ? [spotStream.status(), futStream.status()] : [],
    feeds: feedsSummary(),
    liqMarket: streamsOn ? liq.marketSummary(1440) : null,
    events: calendar.upcoming(Date.now(), 14 * 24).slice(0, 8),
    liqBig: streamsOn ? liq.biggest(null, 10) : [],
    news: [...results.values()].flatMap((r) => r.news?.top ?? []).filter((n, i, a) => a.findIndex((x) => x.title === n.title) === i).sort((a, b) => b.time - a.time).slice(0, 12),
    whales4h: streamsOn ? Object.fromEntries(coins.map((c) => [c.symbol, flow.summary(c.symbol, 240)?.whales]).filter(([, w]) => w)) : {},
    trading: trader.enabled || trader.openTrades().length ? trader.status() : null,
  }),
};

let restrictedAlerted = false;
const errorAlerted = new Set();
function onError(symbol, e) {
  const n = (errors.get(symbol) || 0) + 1;
  errors.set(symbol, n);
  lastErrors.set(symbol, e.message);
  console.error(`${new Date().toLocaleTimeString('ru-RU')} ${symbol}: ошибка — ${e.message}`);
}
const lastErrors = new Map();

// в конце цикла: одно письмо о проблемах вместо письма на каждую монету
function reportErrors() {
  if (once) return;
  for (const [s, n] of errors) if (n === 0) errorAlerted.delete(s);
  if (binance.restricted) {
    if (!restrictedAlerted) {
      restrictedAlerted = true;
      const subject = '⚠️ Crypto Watcher: Binance недоступен с этого сервера';
      const text = `Binance отвечает, что доступ из страны сервера ограничен:\n${binance.restricted}\n\nПеренесите сервер в другую страну (например, Германию или Финляндию) — иначе анализ работать не будет.`;
      logAlert(subject);
      notifier.enqueue({ subject, tag: '⚠️', text, html: `<p><b>${subject}</b></p><p>${text.replace(/\n/g, '<br>')}</p>` });
    }
    return;
  }
  const fresh = [...errors].filter(([s, n]) => n >= cfg.notify.errorAlertAfter && !errorAlerted.has(s)).map(([s]) => s);
  if (!fresh.length) return;
  for (const s of fresh) errorAlerted.add(s);
  const subject = `⚠️ Crypto Watcher: нет данных по ${fresh.length === 1 ? fresh[0] : `${fresh.length} монетам`}`;
  const lines = fresh.map((s) => `${s}: ${lastErrors.get(s)}`);
  const text = `${cfg.notify.errorAlertAfter}+ проверок подряд завершились ошибкой:\n${lines.join('\n')}\n\nПрограмма продолжает попытки и сама продолжит анализ, когда данные появятся.`;
  logAlert(subject);
  notifier.enqueue({ subject, tag: '⚠️', text, html: `<p><b>${subject}</b></p><p>${text.replace(/\n/g, '<br>')}</p>` });
}

// ── тест уведомлений ───────────────────────────────────────────────────────
if (testNotify) {
  console.log(`Отправляю тест в каналы: ${notifier.channels().join(', ')}`);
  if (!notifier.emailReady()) console.log('⚠️ Почта не настроена: заполните EMAIL_TO, SMTP_USER и SMTP_PASS в .env');
  if (!notifier.smsReady()) console.log('ℹ️ SMS не настроены: TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, SMS_TO');
  const what = manual ? manual.join(', ') : `автоматически топ-${cfg.universe.size}`;
  await notifier.broadcast({
    subject: '✅ Crypto Watcher: тестовое уведомление',
    text: `Если вы это читаете — уведомления настроены.\nМонеты: ${what}`,
    html: `<p>Если вы это читаете — уведомления настроены.</p><p>Монеты: ${what}</p>`,
    smsText: 'Crypto Watcher: test OK, notifications are working',
  });
  console.log('Готово. Ошибки каналов (если были) выведены выше.');
  process.exit(0);
}

// ── запуск ─────────────────────────────────────────────────────────────────
let running = true;
async function shutdown() {
  if (!running) return;
  running = false;
  console.log('\nОстанавливаюсь…');
  spotStream.stop(); futStream.stop(); flow.stop();
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); } catch { /* ignore */ }
  journal.save();
  trader.save();
  await Promise.race([notifier.flush(), sleep(10e3)]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => console.error('Необработанная ошибка:', e));

if (!BinanceStream.supported() && cfg.whales.enabled && !once) console.error('⚠️ Для китов, ликвидаций и живых зон нужен Node.js 22+ (WebSocket) — эти функции отключены');
await market.refresh();
const tradingOn = !once && (trader.enabled || trader.openTrades().length > 0);
if (tradingOn) {
  await trader.init();
  console.log(trader.describe());
}
await refreshUniverse(true);
if (!once) {
  startServer(cfg, app);
  setInterval(liveTick, 5000).unref();
  if (tradingOn) setInterval(() => { trader.tick().catch((e) => console.error('Bybit:', e.message)); }, cfg.trade.tickSeconds * 1000).unref();
  // сторож: если анализ завис (нет завершённых циклов слишком долго) — выходим, Docker/systemd перезапустят
  setInterval(() => {
    const since = Date.now() - (lastCycleAt || startedAt);
    const limit = Math.max(cfg.pollSeconds * 10, 15 * 60) * 1000;
    if (since > limit) { console.error(`Сторож: анализ не завершался ${Math.round(since / 60e3)} мин — перезапуск`); try { journal.save(); } catch { /* ignore */ } process.exit(1); }
  }, 60e3).unref();
  console.log(`Уведомления: ${notifier.channels().join(', ')}`);
  if (streamsOn) console.log(`Киты: ${cfg.whales.markets.join(' + ')}, порог от ${fmtUsd(cfg.whales.minUsd)}; письмо — от ${cfg.whales.alertX}× порога и в числе ${cfg.whales.targetPerDay} крупнейших покупок за сутки`);
  console.log(`Порог сигнала ±${cfg.signal.threshold}, подтверждение ${cfg.signal.confirmPolls} проверки, опрос каждые ${cfg.pollSeconds} с. Ctrl+C — выход.\n`);
}

let firstCycle = true;
do {
  const started = Date.now();
  try { await refreshUniverse(); } catch (e) { console.error('Ошибка обновления списка монет:', e.message); }
  if (!once) await syncStreams().catch((e) => console.error('Потоки:', e.message));
  market.refresh().catch(() => {});
  // биткоин — первым: от него зависит оценка альткоинов
  const ordered = [...coins].sort((a, b) => (/^BTC/.test(b.symbol) ? 1 : 0) - (/^BTC/.test(a.symbol) ? 1 : 0));
  if (!ordered.some((c) => /^BTC/.test(c.symbol))) {
    try { const r = analyze(await gather({ symbol: 'BTCUSDT', name: 'Bitcoin' }, { light: true }), cfg); market.setBtc(r); results.set('BTCUSDT@ctx', r); } catch { /* контекст не обязателен */ }
  }
  for (const c of ordered) {
    if (!running) break;
    try {
      const r = analyze(await gather(c), cfg);
      if (/^BTC/.test(c.symbol)) market.setBtc(r);
      if (once) console.log(`\n${R.signalText(r)}\n`);
      else {
        console.log(R.statusLine(r));
        if (verbose) console.log(R.signalText(r), '\n');
      }
      await handleResult(r);
      newsAlerts(r);
      errors.set(c.symbol, 0);
    } catch (e) { onError(c.symbol, e); }
    await sleep(150);
  }
  journalFallback();
  reportErrors();
  macroAlerts();
  lastCycleAt = Date.now();
  cycles++;
  if (!once && ((firstCycle && digestNow) || digestDue())) {
    state.digestDay = new Date().toLocaleDateString('sv-SE');
    saveState();
    await sendDigest().catch((e) => console.error('Обзор:', e.message));
  }
  firstCycle = false;
  if (!once && running) await sleep(Math.max(5000, cfg.pollSeconds * 1000 - (Date.now() - started)));
} while (!once && running);
