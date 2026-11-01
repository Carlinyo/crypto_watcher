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
//   node index.js --pause-trading     — приостановить новые сделки (--resume-trading — снять паузу)
//   node index.js --why               — почему нет сделок: разбор по шагам и последние решения программы
//   флаги: --top N --threshold X --poll S --verbose --no-news --no-whales --no-server
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// на старом Node.js не загрузится .env и не будет WebSocket — лучше сразу понятная ошибка, чем тихая работа без настроек
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`⛔ Нужен Node.js 22 или новее, а установлен ${process.version}. Обновите Node.js (см. README) или запускайте через Docker.`);
  process.exit(1);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(dir, '.env');
if (fs.existsSync(envFile) && process.loadEnvFile) {
  process.loadEnvFile(envFile);
  // в .env пароли и ключи: другие пользователи сервера не должны его читать
  try { if (process.platform !== 'win32' && fs.statSync(envFile).mode & 0o077) console.error(`⚠️ Файл .env с паролями доступен другим пользователям сервера — выполните: chmod 600 ${envFile}`); } catch { /* не критично */ }
}

const { default: cfg } = await import('./config.js');
const { Binance } = await import('./lib/binance.js');
const { BinanceStream } = await import('./lib/streams.js');
const { TradeFlow } = await import('./lib/trades.js');
const { Liquidations } = await import('./lib/liquidations.js');
const { OrderBookTracker } = await import('./lib/orderbook.js');
const { CoinbaseFeed } = await import('./lib/coinbase.js');
const { MarketContext } = await import('./lib/market.js');
const { NewsService } = await import('./lib/news.js');
const { OptionsFeed } = await import('./lib/options.js');
const { Journal } = await import('./lib/journal.js');
const { Notifier } = await import('./lib/notifier.js');
const { analyze } = await import('./lib/analyzer.js');
const { selectUniverse } = await import('./lib/universe.js');
const { startServer } = await import('./lib/server.js');
const { MacroCalendar } = await import('./lib/calendar.js');
const { Trader, MODE_RU } = await import('./lib/trader.js');
const { writeJsonAtomic, readJson } = await import('./lib/storage.js');
const { InstanceLock } = await import('./lib/lock.js');
const { priceInZone, zoneOf, signalEmail, resultProblem, zoneEntry, RETRY_CODES, TRADE_EVENT_CATEGORY, EMAIL_EVENT_NAMES } = await import('./lib/policy.js');
const { Decisions, diagnose, reasonKey, DECISION_KINDS } = await import('./lib/decisions.js');
const { loadStocks, stocksEnabled, stockSessionOpen, nextSessionOpen, sessionReason, stockZoneUntil, SESSION_RU, STOCK_CANDIDATES, tradedOnly, lastTradeTime } = await import('./lib/stocks.js');
const { chartPng, chartSvg } = await import('./lib/chart.js');
const { atr, lastValid } = await import('./lib/indicators.js');
const { sleep } = await import('./lib/http.js');
const { coinOf, fmt, fmtUsd, fmtMoney, fmtDate, fmtDuration, sgn, trades: nTrades, escapeHtml } = await import('./lib/format.js');
const R = await import('./lib/report.js');

// ── аргументы ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const bool = (n) => { const i = args.indexOf(`--${n}`); if (i < 0) return false; args.splice(i, 1); return true; };
const once = bool('once'), verbose = bool('verbose'), testNotify = bool('test-notify'), digestNow = bool('digest-now'), showStats = bool('stats');
const tradeCheck = bool('trade-check'), tradeStatus = bool('trade-status'), closeAll = bool('close-all');
const pauseTrading = bool('pause-trading'), resumeTrading = bool('resume-trading'), showWhy = bool('why');
if (bool('no-news')) cfg.news.enabled = false;
if (bool('no-whales')) cfg.whales.enabled = false;
if (bool('no-server') || once) cfg.server.port = 0;
cfg.signal.threshold = Number(flag('threshold') ?? cfg.signal.threshold);
cfg.pollSeconds = Number(flag('poll') ?? cfg.pollSeconds);
cfg.universe.size = Number(flag('top') ?? cfg.universe.size);
const cliSymbols = args.length > 0; // монеты и акции из командной строки — тогда автоматического списка акций нет
const manual = args.length ? args.map((s) => s.toUpperCase())
  : cfg.symbols[0]?.toLowerCase() === 'auto' ? null : cfg.symbols.map((s) => s.toUpperCase());

// ── проверка настроек: опасные значения автоторговли не применяются ──
const { validateConfig } = await import('./lib/validate.js');
const check = validateConfig(cfg);
const tradeWanted = cfg.trade.enabled;
for (const w of check.warnings) console.error(`⚠️ Настройки: ${w}`);
if (check.dashboard) console.error(`⚠️ ${check.dashboard}`);
if (check.tradeErrors.length) {
  console.error(`⛔ Ошибки в настройках автоторговли:\n  • ${check.tradeErrors.join('\n  • ')}`);
  if (cfg.trade.enabled) console.error('⛔ Новые сделки выключены до исправления .env (открытые сделки по-прежнему сопровождаются)');
  cfg.trade.enabled = false;
}

// ── компоненты ─────────────────────────────────────────────────────────────
const file = (f) => path.resolve(dir, f);
const binance = new Binance(cfg);
const notifier = new Notifier(cfg);
const news = new NewsService(cfg);
const market = new MarketContext(cfg, file(cfg.files.market));
const coinbase = new CoinbaseFeed(cfg);
const optionsFeed = new OptionsFeed(cfg);
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

// ── пауза автоторговли без остановки программы ─────────────────────────────
if (pauseTrading || resumeTrading) {
  const f = file(cfg.files.trades);
  if (pauseTrading) {
    Trader.pause(f, `команда --pause-trading, ${new Date().toLocaleString('ru-RU')}`);
    console.log('⏸ Автоторговля приостановлена: новые сделки не открываются, открытые сопровождаются как обычно.\n   Снять паузу: node index.js --resume-trading');
  } else {
    Trader.resume(f);
    console.log('▶️ Пауза снята — новые сделки снова открываются (если в .env TRADE=1).');
  }
  process.exit(0);
}

// состояние автоторговли — для разбора «почему нет сделок» (в панели, в state.json и командой --why)
const tradingInfo = () => ({
  wanted: tradeWanted, enabled: trader.enabled, configErrors: check.tradeErrors, hasKeys: trader.hasKeys(), mode: trader.mode, stocks: cfg.trade.stocks,
  ready: trader.ready, problem: trader.problem, userPause: trader.userPause(), paused: !!trader.state.paused,
  open: trader.openTrades().length, maxPositions: cfg.trade.maxPositions, entry: cfg.trade.entry, balance: trader.balance?.equity ?? null,
});
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return '?'; } })();

// ── почему нет сделок: разбор по данным работающей программы ───────────────
if (showWhy) {
  const saved = readJson(file(cfg.files.state), {}) ?? {};
  const s = saved.status, now = Date.now();
  console.log('Сделки: почему есть или нет\n');
  if (!s) console.log('⚠️ Нет данных работающей программы: она ещё не запускалась с версией 2.5 или новее (или запущена из другой папки). Запустите её и проверьте через 5–10 минут.\n');
  else {
    const age = now - s.at;
    console.log(`Данные работающей программы от ${fmtDate(s.at)} (${age < 60e3 ? 'только что' : `${fmtDuration(age)} назад`}), версия ${s.version}, монет ${s.coins}, циклов анализа ${s.cycles}`);
    if (age > Math.max(cfg.pollSeconds * 5, 600) * 1000) console.log(`⚠️ Программа ${fmtDuration(age)} не обновляла данные — похоже, она остановлена. Проверьте: docker compose ps и docker compose logs --tail 50`);
    if (s.trading && s.trading.wanted !== tradeWanted) console.log(`⚠️ В .env сейчас TRADE=${tradeWanted ? 1 : 0}, а работающая программа запущена с TRADE=${s.trading.wanted ? 1 : 0} — перезапустите её, чтобы настройка вступила в силу (в Docker: docker compose up -d)`);
    console.log('');
  }
  const trading = s?.trading ?? { ...tradingInfo(), problem: 'программа не запущена' };
  const zones = Object.entries(saved.zones ?? {}).map(([symbol, z]) => ({ symbol, ...z }));
  if (zones.length) {
    // текущие цены — чтобы показать, далеко ли до зон
    try {
      const px = await binance.call('spot', '/api/v3/ticker/price', { symbols: JSON.stringify(zones.map((z) => z.symbol)) }, { tries: 1, timeout: 6000 });
      for (const p of px ?? []) { const z = zones.find((x) => x.symbol === p.symbol); if (z) z.price = +p.price; }
    } catch { /* без цен — тоже понятно */ }
  }
  const d = diagnose({ trading, list: saved.decisions ?? [], zones, now, confirmPolls: s?.confirmPolls ?? cfg.signal.confirmPolls, stocks: s?.stocks ?? null });
  const ICON = { bad: '⛔', warn: '⚠️', ok: '✅', info: 'ℹ️' };
  for (const l of d.lines) console.log(`${ICON[l.level]} ${l.text}`);
  const recent = (saved.decisions ?? []).filter((x) => DECISION_KINDS[x?.kind]).slice(0, 25);
  console.log(recent.length ? '\nПоследние решения (новые сверху):' : '\nЖурнал решений пока пуст.');
  for (const x of recent) console.log(`  ${fmtDate(x.t)}  ${coinOf(x.sym).padEnd(6)} ${DECISION_KINDS[x.kind].emoji} ${DECISION_KINDS[x.kind].text}${x.n > 1 ? ` (×${x.n})` : ''} — ${x.why}`);
  process.exit(0);
}

// ── команды автоторговли ───────────────────────────────────────────────────
if (tradeCheck || tradeStatus || closeAll) {
  console.log(`Bybit: ${MODE_RU[trader.mode]} — ${trader.client.base}`);
  for (const er of check.tradeErrors) console.log(`⛔ Ошибка в .env: ${er}`);
  const up = trader.userPause();
  if (up) console.log(`⏸ Автоторговля на паузе с ${new Date(up.at).toLocaleString('ru-RU')} (${up.reason}) — снять: --resume-trading`);
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
    const savedStocks = readJson(file(cfg.stocks.cacheFile), null, { log: () => {} })?.stocks ?? [];
    if (savedStocks.length) {
      console.log(`Фьючерсы на акции на Bybit${cfg.trade.stocks ? '' : ' (сделки по акциям выключены — включить: TRADE_STOCKS=1)'}:`);
      for (const x of savedStocks) { const m = trader.resolve(x.symbol, { kind: 'stock' }); console.log(`  ${String(x.ticker ?? coinOf(x.symbol)).padEnd(6)} ${String(x.name ?? '').padEnd(20)} → ${m ? `${m.symbol}, плечо до ×${m.info.maxLev}` : 'нет на Bybit (или недоступен на этом счёте) — по этой акции сделок не будет'}`); }
    }
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
state = { ...state, ...(readJson(stateFile, {}) ?? {}) };
// совместимость с версией 1.x: там состояние хранилось как { BTCUSDT: {action, at} }
for (const [k, v] of Object.entries(state)) if (/USDT$/.test(k) && v?.action) { state.signals[k] = v; delete state[k]; }
// журнал решений: почему сильный сигнал стал (или не стал) сделкой — в панели и командой --why
const decisions = new Decisions(state.decisions);
state.decisions = decisions.list;
let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeJsonAtomic(stateFile, state, { pretty: true }); }
    catch (e) { console.error('Не удалось сохранить состояние:', e.message); }
  }, 500);
}

const results = new Map();
const candleCache = new Map(); // последние часовые свечи монеты — для графиков
const alertLog = [];
const whaleLog = [];
const errors = new Map();
let coins = manual ? manual.map((symbol) => ({ symbol })) : []; // крипта и акции (у акций kind: 'stock')
let universeAt = 0;
let stockInfo = { source: '', missing: [] };
let stockIndex = null;          // фон рынка акций: { symbol: 'QQQUSDT', name: 'QQQ' }
const closedNow = new Map();    // акции, по которым сейчас нет торгов: символ → { since, price }
const breadth = { crypto: null, stock: null }; // ширина рынка по итогам прошлого цикла

// ширина рынка: сколько монет (акций) растут и падают по тренду — «прилив» или «отлив» по всему рынку
function breadthOf(kind) {
  const list = [...results.entries()].filter(([k, r]) => !k.includes('@') && (r.kind ?? 'crypto') === kind && !closedNow.has(r.symbol)).map(([, r]) => r);
  if (list.length < 5) return null;
  const up = list.filter((r) => r.blocks.trend.score > 0.15).length, down = list.filter((r) => r.blocks.trend.score < -0.15).length;
  return { kind, n: list.length, up, down, value: (up - down) / list.length, avgScore: list.reduce((s, r) => s + r.score, 0) / list.length };
}
let lastCycleAt = 0, cycles = 0;
const startedAt = Date.now();

// о чём писать на почту — EMAIL_EVENTS (по умолчанию: цена в зоне входа, сделки, киты, сбои); остальное — в панели
const wants = (cat) => cfg.notify.events.includes(cat);
function logAlert(subject, sent = true) { alertLog.unshift({ t: Date.now(), subject, sent }); alertLog.length = Math.min(alertLog.length, 150); }

// ── список монет ───────────────────────────────────────────────────────────
async function refreshUniverse(force = false) {
  const due = force || !coins.length || Date.now() - universeAt > cfg.universe.refreshHours * 3600e3;
  if (!due && universeAt) return;
  let source = 'ваш список';
  const before = new Set(coins.map((c) => c.symbol));
  const first = universeAt === 0;
  let crypto = manual ? manual.map((symbol) => ({ symbol })) : coins.filter((c) => c.kind !== 'stock');
  if (!manual) {
    const res = await selectUniverse(cfg, file(cfg.universe.cacheFile), () => binance.ticker24h('spot'));
    crypto = res.coins;
    source = res.source;
  }
  universeAt = Date.now();
  await Promise.allSettled([binance.loadFuturesInfo()]);
  // свои символы из командной строки: фьючерс на акцию Binance (NVDAUSDT) — это акция, остальное — монеты
  if (cliSymbols) {
    for (const c of crypto) {
      if (binance.futuresOf(c.symbol) || !binance.stockOf(c.symbol)) continue;
      const t = c.symbol.replace(/USDT$/, ''), known = STOCK_CANDIDATES.find((x) => x.ticker.replace(/[^A-Z0-9]/g, '') === t || x.alt.includes(t));
      Object.assign(c, { kind: 'stock', ticker: known?.ticker ?? t, name: known?.name ?? null, query: known?.query ?? t });
    }
  }
  const stocksCli = crypto.filter((c) => c.kind === 'stock');
  crypto = crypto.filter((c) => c.kind !== 'stock');
  const cryptoSyms = crypto.map((c) => c.symbol);
  await Promise.allSettled([cryptoSyms.length ? binance.loadSpotInfo(cryptoSyms) : null]);
  // 📈 акции: крупнейшие компании США с фьючерсом на Binance (или список STOCKS из .env)
  const st = cliSymbols ? { stocks: stocksCli, missing: [], source: 'командная строка' } : loadStocks(cfg, binance.tradfi, file(cfg.stocks.cacheFile), new Set(cryptoSyms));
  stockInfo = { source: st.source, missing: st.missing };
  stockIndex = cfg.stocks.index.map((t) => `${t.toUpperCase()}USDT`).filter((x) => binance.stockOf(x)).map((x) => ({ symbol: x, name: x.slice(0, -4) }))[0] ?? null;
  coins = [...crypto, ...st.stocks];
  const symbols = coins.map((c) => c.symbol);
  await syncStreams();
  const added = symbols.filter((s) => !before.has(s)), removed = [...before].filter((s) => !symbols.includes(s));
  if (crypto.length) console.log(`\nМонеты (${source}):\n${R.coinsTable(crypto)}\n`);
  if (st.stocks.length) console.log(`Акции — ${st.source}, фьючерсы на акции Binance:\n${R.stocksTable(st.stocks)}\n`);
  if (st.missing.length) {
    const auto = String(cfg.stocks.list[0]).toLowerCase() === 'auto';
    const list = `${st.missing.slice(0, 8).join(', ')}${st.missing.length > 8 ? ` и ещё ${st.missing.length - 8}` : ''}`;
    console.log(!auto ? `⚠️ На Binance нет фьючерса на ${list} — эти акции пропущены`
      : st.stocks.length >= cfg.stocks.size ? `ℹ️ На Binance нет фьючерса на ${list} — вместо них в список вошли следующие по капитализации`
        : `ℹ️ На Binance нашлось только ${st.stocks.length} из ${cfg.stocks.size} крупнейших компаний (нет фьючерсов на ${list})`);
  }
  if (stocksEnabled(cfg) && !cliSymbols && !st.stocks.length) console.error(`⚠️ Акции: ${st.source} — следить пока не за чем, попробую при следующем обновлении списка`);
  if (once) return;
  if (first) {
    const m = R.startMessage({ coins: crypto, stocks: st.stocks, source, cfg, channels: notifier.channels(), trading: trader.describe(), events: cfg.notify.events.map((x) => EMAIL_EVENT_NAMES[x] ?? x) });
    logAlert(m.subject, wants('start'));
    if (wants('start')) await notifier.broadcast(m);
  } else if (added.length || removed.length) {
    const m = R.startMessage({ coins: crypto, stocks: st.stocks, source, cfg, channels: notifier.channels(), changed: { added, removed } });
    logAlert(m.subject, wants('start'));
    if (wants('start')) notifier.enqueue({ ...m, tag: '🔄' });
  }
}

// фьючерс по монете или акции: у монеты — USDⓈ-M контракт (PEPEUSDT → 1000PEPEUSDT), у акции — сам контракт на акцию
const perpOf = (c) => (c.kind === 'stock' ? binance.stockOf(c.symbol) ?? { symbol: c.symbol, mult: 1 } : binance.futuresOf(c.symbol));
const isStock = (sym) => coins.some((c) => c.symbol === sym && c.kind === 'stock');

// потоки, пороги китов и справочник фьючерсов: при сбое при старте — догоняем в следующих циклах
async function syncStreams() {
  await Promise.allSettled([binance.loadFuturesInfo()]);
  if (!streamsOn) return;
  const symbols = coins.map((c) => c.symbol);
  const perps = new Map(coins.map((c) => [c.symbol, perpOf(c)]).filter(([, p]) => p));
  flow.setSymbols(symbols, perps);
  liq.setSymbols(symbols, perps);
  const [st, ft] = await Promise.allSettled([binance.ticker24h('spot'), binance.ticker24h('futures')]);
  flow.setThresholdsFromTickers(st.value ?? [], ft.value ?? []);
  const crypto = coins.filter((c) => c.kind !== 'stock');
  if (cfg.whales.markets.includes('spot')) spotStream.setStreams(crypto.map((c) => `${c.symbol.toLowerCase()}@aggTrade`));
  const fsyms = crypto.map((c) => perpOf(c)?.symbol).filter(Boolean);
  // по акциям сделки идут только на фьючерсе — его поток нужен всегда (цена для зон входа, киты, поток ордеров)
  const stockSyms = coins.filter((c) => c.kind === 'stock').map((c) => perpOf(c).symbol);
  futStream.setStreams([...(cfg.whales.markets.includes('futures') ? fsyms : []), ...stockSyms].map((s) => `${s.toLowerCase()}@aggTrade`).concat('!forceOrder@arr'));
}

// ── сбор данных по монете ──────────────────────────────────────────────────
const val = (r) => (r.status === 'fulfilled' ? r.value : null);

async function gatherDeriv(fsym, { stock = false } = {}) {
  const p = cfg.derivatives.period, R5 = cfg.refresh.derivativesMinutes * 60e3;
  const res = await Promise.allSettled([
    binance.premiumIndex(fsym),
    binance.fundingRates(fsym, 100, cfg.refresh.fundingMinutes * 60e3),
    binance.openInterestHist(fsym, p, 500, R5),
    binance.ratio('topPosition', fsym, p, 48, R5),
    binance.ratio('globalAccount', fsym, p, 48, R5),
    binance.ratio('taker', fsym, p, 48, R5),
  ]);
  const [premium, fundingAll, oi, topPos, globalAcc, taker] = res.map(val);
  if (!premium && !oi) throw res[0].reason ?? new Error('нет данных по фьючерсам');
  // у акций бывает «особый» фандинг — это выплата дивидендов, а не перекос позиций; в оценку он не идёт
  const funding = stock && Array.isArray(fundingAll) ? fundingAll.filter((f) => !f.rateType || f.rateType === 'Regular') : fundingAll;
  return { premium, funding, oi, topPos, globalAcc, taker };
}

async function btcContext(symbol) {
  if (/^BTC/.test(symbol)) return null;
  const r = results.get('BTCUSDT') ?? results.get('BTCUSDT@ctx');
  const h1 = binance.cache.peek(`k:spot:BTCUSDT:1h:${cfg.candles.h1}`) ?? await binance.klines('BTCUSDT', '1h', cfg.candles.h1).catch(() => null);
  return h1 ? { h1, trend: r?.blocks?.trend?.score ?? market.btc?.trend ?? 0, score: r?.score ?? market.btc?.score ?? 0 } : null;
}

// фон рынка акций — индекс (QQQ), его анализ обновляется раз в цикл
function stockIndexContext(symbol) {
  if (!stockIndex || symbol === stockIndex.symbol) return null;
  const r = results.get(`${stockIndex.symbol}@ctx`), h1 = candleCache.get(stockIndex.symbol);
  return r && h1 ? { h1, trend: r.blocks?.trend?.score ?? 0, score: r.score, name: stockIndex.name } : null;
}

// 📈 акция: все данные — с фьючерса на акцию. Часы без сделок (биржа закрыта) из свечей выбрасываются;
// если сделок нет дольше closedMinutes — торги закрыты, анализ не нужен
async function gatherStock(c, { light = false } = {}) {
  const sym = perpOf(c).symbol, sc = cfg.stocks.candles;
  const k = (iv, n, ttl) => binance.klines(sym, iv, n, { market: 'futures', ...(ttl ? { ttlMs: ttl } : {}) });
  const [m15r, h1r, h4r, d1r] = await Promise.all([k('15m', sc.m15), k('1h', sc.h1), k('4h', sc.h4, cfg.refresh.h4Minutes * 60e3), k('1d', sc.d1, cfg.refresh.d1Minutes * 60e3)]);
  const [m15, h1, h4, d1] = [m15r, h1r, h4r, d1r].map(tradedOnly);
  const live = flow.lastPrice(c.symbol);
  const lastTrade = Math.max(live?.time ?? 0, lastTradeTime(m15r) ?? 0);
  // разовый отчёт (--once) строится и при закрытых торгах — по последним свечам
  if (!m15.length || !h1.length || (!once && Date.now() - lastTrade > cfg.stocks.closedMinutes * 60e3)) {
    return { closed: true, symbol: c.symbol, lastTrade: lastTrade || null, price: live?.price ?? m15[m15.length - 1]?.close ?? null };
  }
  const price = live && Date.now() - live.time < 90e3 ? live.price : m15[m15.length - 1].close;
  candleCache.set(c.symbol, h1);
  const base = { symbol: c.symbol, name: c.name, kind: 'stock', price, candles: { m15, h1, h4: h4.length ? h4 : null, d1: d1.length ? d1 : null }, market: null, macro: macroNow() };
  if (light) return base;

  const H = h1.map((x) => x.high), L = h1.map((x) => x.low), C = h1.map((x) => x.close);
  const atr1 = lastValid(atr(H.slice(0, -1), L.slice(0, -1), C.slice(0, -1), 14));
  const res = await Promise.allSettled([
    // стакан фьючерса на акцию тоньше крипты — 500 уровней хватает, а лимит запросов Binance расходуется вдвое меньше
    cfg.orderbook.enabled ? binance.depth(sym, { market: 'futures', limit: Math.min(500, cfg.orderbook.depthLimit) }) : null,
    cfg.derivatives.enabled ? gatherDeriv(sym, { stock: true }) : null,
    news.analyze(c.symbol, c.name, { stock: true, query: c.query }),
  ]);
  const [fBook, deriv, newsRes] = res.map(val);
  if (verbose) for (const r of res) if (r.status === 'rejected') console.error(`${c.symbol}: ${r.reason?.message}`);
  const bookRes = fBook ? book.analyze(c.symbol, { futures: { ...fBook, mult: 1 } }, price, atr1, flow.takeRange(c.symbol, 'book'), { futures: flow.threshold('futures', c.symbol) }) : null;
  let liqSum = null;
  if (streamsOn) { const h = liq.summary(c.symbol, 60); liqSum = { h1: h, h24: liq.summary(c.symbol, 1440), coverageMin: h.coverageMin }; }
  const flowSum = streamsOn ? { h1: flow.summary(c.symbol, 60), h4: flow.summary(c.symbol, 240) } : null;
  return { ...base, fut: null, deriv, liq: liqSum, flow: flowSum, book: bookRes, coinbase: null, news: newsRes, btc: stockIndexContext(c.symbol), breadth: breadth.stock };
}

const gather = (c, opts) => (c.kind === 'stock' ? gatherStock(c, opts) : gatherCrypto(c, opts));

async function gatherCrypto(c, { light = false } = {}) {
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
    optionsFeed.get(coinOf(sym)),
  ]);
  const [futH1, sBook, fBook, deriv, cb, newsRes, btc, opt] = res.map(val);
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
    options: opt, breadth: breadth.crypto,
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
  logAlert(m.subject, wants('journal'));
  if (wants('journal')) notifier.enqueue({ ...m, tag: m.subject.split(' ')[0] });
  else console.log(`📒 ${m.subject}`);
}

// анализ развернулся против открытого сигнала — предупредить один раз
function checkReversal(r) {
  const en = journal.openFor(r.symbol);
  if (!en || en.reversalWarned) return;
  const against = en.side === 'BUY' ? r.score <= -r.threshold * 0.7 : r.score >= r.threshold * 0.7;
  if (!against || r.action === (en.side === 'BUY' ? 'SELL' : 'BUY')) return; // сильный обратный сигнал закроет сделку сам
  en.reversalWarned = Date.now();
  journal.save();
  const m = R.reversalMessage(en, r, {});
  logAlert(m.subject, wants('reversal'));
  if (!wants('reversal')) { console.log(m.subject); return; }
  const ch = chartFor(r);
  notifier.enqueue({ ...R.reversalMessage(en, r, { chartCid: ch.chartCid }), tag: '⚠️', attachments: ch.attachments });
}

const ACT_RU = { BUY: 'ПОКУПКА', SELL: 'ПРОДАЖА' };
const zoneTxt = (p) => `${fmt(p.zone[0])}–${fmt(p.zone[1])}`;
function note(sym, kind, why, { dir = null, key = null, merge = true } = {}) {
  decisions.add({ sym, kind, dir, why, key }, { merge });
  saveState();
}

// итог попытки сделки — в журнал решений
function noteExec(r) {
  const x = r.exec;
  if (!x) return;
  if (x.status === 'opened') {
    const t = x.trade;
    note(r.symbol, 'opened', `${t.side === 'Buy' ? 'лонг' : 'шорт'} на ${fmtMoney(t.notional)} по ${fmt(t.entry)}, стоп ${fmt(t.stop)}, цели ${fmt(t.t1)}${t.single ? '' : ` / ${fmt(t.t2)}`}`, { dir: r.action, merge: false });
  } else note(r.symbol, x.code === 'off' ? 'off' : 'skipped', x.reason, { dir: r.action, key: x.code ?? null });
}

// сделка была бы, но автоторговля выключена — сказать об этом в письме и панели (если Bybit вообще настраивали)
function tradingOff(r = null) {
  if (r?.kind === 'stock' && trader.enabled && !cfg.trade.stocks) return { status: 'skipped', code: 'off', reason: 'сделки по акциям выключены (TRADE_STOCKS=0) — только сигнал', sms: 'BYBIT: stocks off', mode: trader.mode };
  if (!tradeWanted && !trader.hasKeys()) return null;
  const reason = tradeWanted ? `автоторговля выключена из-за ошибок в .env (${check.tradeErrors[0]})` : 'в .env стоит TRADE=0 — автоторговля выключена';
  return { status: 'skipped', code: 'off', reason, sms: 'BYBIT: off', mode: trader.mode };
}

async function handleResult(r, { zone = false } = {}) {
  // результат с нечисловыми значениями или перепутанными стопом и целями — не основание для письма и сделки
  const bad = resultProblem(r);
  if (bad) { console.error(`${r.symbol}: результат анализа отклонён — ${bad}`); onError(r.symbol, new Error(`результат анализа отклонён: ${bad}`)); return; }
  results.set(r.symbol, r);
  // как заканчивались похожие сигналы (для письма и панели) — до открытия записи по этому сигналу
  if (r.action !== 'NEUTRAL') r.history = journal.similar(r);
  if (once) return;
  // акция вне часов торгов (STOCK_HOURS): анализ виден в панели, но без сигналов, писем и сделок
  if (r.kind === 'stock' && !stockSessionOpen(cfg.stocks.hours)) return;
  checkReversal(r);
  const sym = r.symbol, now = Date.now();
  const st = state.signals[sym];
  const strong = r.action === 'BUY' || r.action === 'SELL';
  const cooldown = cfg.signal.cooldownMinutes * 60e3;

  // подтверждение: сильный сигнал (в том числе тот, которому не хватает только хорошей цены — r.setup)
  // должен продержаться confirmPolls проверок подряд
  let confirmed = zone;
  if (!zone) {
    const p = state.pending[sym];
    const recent = p && now - p.at < cfg.pollSeconds * 3000; // подтверждение должно быть свежим (не из прошлого запуска)
    if (r.setup) {
      const count = p?.action === r.setup && recent ? p.count + 1 : 1;
      state.pending[sym] = { action: r.setup, count, at: now };
      confirmed = count >= cfg.signal.confirmPolls;
    } else {
      if (recent && p.count < cfg.signal.confirmPolls) note(sym, 'unconfirmed', `сигнал ${ACT_RU[p.action]} продержался ${p.count} из ${cfg.signal.confirmPolls} проверок подряд`, { dir: p.action, key: 'unconfirmed' });
      delete state.pending[sym];
      // оценка дотянула до порога, но фильтр не пустил (мало подтверждений, против тренда, биткоин, новость, ФРС)
      if (Math.abs(r.score) >= r.threshold && r.warnings.length) note(sym, 'filtered', `оценка ${sgn(r.score)} достаточна для ${r.score > 0 ? 'покупки' : 'продажи'}, но ${r.warnings[0]}`, { dir: r.plan.dir, key: reasonKey(r.warnings[0]) });
    }
    if (strong && !confirmed) { saveState(); return; }
  }

  if (r.action === 'NEUTRAL') {
    if (st && st.action !== 'NEUTRAL') { state.signals[sym] = { action: 'NEUTRAL', at: now }; saveState(); }
    // картина выровнялась — зона больше не нужна
    if (state.zones[sym] && Math.abs(r.score) < r.threshold * 0.3) dropZone(sym, `оценка ${sgn(r.score)} — картина выровнялась`);
    return;
  }

  if (strong) {
    const z0 = zone ? state.zones[sym] : null;
    // письмо по этой зоне уже ушло, а сделка не открылась по причине, которая могла пройти сама, — пробуем ещё раз
    if (z0?.notifiedAt) { await retryZoneTrade(r, z0); return; }
    const fresh = st && now - st.at < cooldown;
    // тот же сигнал недавно уже был: пропускаем (вход в зоне — только если письмо о цене в зоне уже было)
    if (st?.action === r.action && fresh && (!zone || (st.notified !== false && st.inZone !== false))) return;
    // по монете уже открыта сделка в эту сторону — повторный сигнал ничего не добавит
    if (hasTrade(sym, r.action)) { if (state.zones[sym]) dropZone(sym, 'по монете уже открыта сделка в эту сторону', { log: false }); return; }
    const inZone = zone || priceInZone(zoneOf(r), r.price);
    // автоторговля: по умолчанию — когда цена в зоне входа (TRADE_ENTRY=zone), иначе сразу по сигналу
    const tradeNow = cfg.trade.entry === 'signal' || inZone;
    const tradeKind = r.kind !== 'stock' || cfg.trade.stocks; // акции — только при TRADE_STOCKS=1
    r.exec = !tradeNow ? null : trader.enabled && tradeKind ? await trader.onSignal(r, { zone }) : tradingOff(r);
    if (r.exec) console.log(`🤖 Bybit: ${r.exec.status === 'opened' ? `открыт ${r.exec.trade.side === 'Buy' ? 'лонг' : 'шорт'} ${coinOf(sym)} на ${fmtMoney(r.exec.trade.notional)}` : `без сделки — ${r.exec.reason}`}`);
    noteExec(r);
    const opened = r.exec?.status === 'opened';
    const send = signalEmail(cfg.notify.events, { inZone, opened });
    state.signals[sym] = { action: r.action, at: now, price: r.price, notified: send, inZone };

    if (opened) delete state.zones[sym];
    else if (!inZone) {
      // цена ещё не в зоне входа — ждём её: письмо, SMS и сделка — когда цена войдёт в зону и анализ подтвердит вход
      armZone(r, { setup: true });
      note(sym, 'wait', `сигнал ${ACT_RU[r.action]} подтверждён (оценка ${sgn(r.score)}), цена ${fmt(r.price)} ещё не в зоне ${zoneTxt(r.plan)} — жду`, { dir: r.action, key: 'wait' });
    } else if (trader.enabled && RETRY_CODES.has(r.exec?.code)) keepForRetry(r, now);
    else delete state.zones[sym];
    if (inZone && !r.exec) note(sym, 'signal', `цена ${fmt(r.price)} в зоне ${zoneTxt(r.plan)}${send ? ' — письмо отправлено' : ''}`, { dir: r.action, key: 'signal' });

    if (!send && !opened) {
      saveState();
      if (inZone) logAlert(R.signalSubject(r, { zone }), false);
      else {
        logAlert(`${R.signalSubject(r)} — жду цену в зоне ${zoneTxt(r.plan)}`, false);
        console.log(`⏳ ${coinOf(sym)}: ${r.action === 'BUY' ? 'покупка' : 'продажа'}, но цена ${fmt(r.price)} ещё не в зоне ${zoneTxt(r.plan)} — письмо придёт, когда войдёт`);
      }
      return;
    }
    // открытые сигналы в ту же сторону — того же вида (монеты движутся вместе с биткоином, акции — с рынком)
    r.exposure = journal.entries.filter((x) => x.status === 'open' && x.symbol !== sym && x.side === r.action && isStock(x.symbol) === (r.kind === 'stock')).map((x) => ({ symbol: x.symbol, opened: x.opened }));
    const { events } = journal.open(r);
    for (const ev of events) notifyJournal(ev);
    notifier.drop(`watch:${sym}`); // «готовиться» по этой монете, ещё ждущее в очереди писем, устарело
    saveState();
    const subject = R.signalSubject(r, { zone });
    logAlert(subject, send);
    if (!send) return; // сделка открыта, но письма о сделках выключены (EMAIL_EVENTS без trade и zone)
    const ch = chartFor(r);
    await notifier.urgent({ subject, text: R.signalText(r, { zone }), html: R.signalHtml(r, { zone, chartCid: ch.chartCid }), smsText: R.smsText(r, { zone }), attachments: ch.attachments });
    return;
  }

  // «готовиться» или сильный сигнал, которому не хватает только хорошей цены: запоминаем зону —
  // как только цена в неё войдёт, анализ запустится сразу. Если даже от зоны прибыль/риск плохой — точки входа нет.
  const base = r.action.replace('WATCH_', '');
  if (!r.zoneOk) {
    if (r.setup && confirmed) note(sym, 'filtered', r.reason, { dir: base, key: 'no-room' });
    if (state.zones[sym]) dropZone(sym, 'даже от зоны входа прибыль/риск мал — хорошей точки входа нет');
    return;
  }
  // в эту сторону по монете уже действуем (сигнал только что был или сделка открыта) — новую зону не ждём
  if ((st?.action === base && st.notified !== false && now - st.at < cooldown) || hasTrade(sym, base)) return;
  const prev = state.zones[sym];
  const setup = !!r.setup && confirmed; // сильный подтверждённый сигнал, которому не хватает только хорошей цены
  armZone(r, { setup });
  if (setup && !(prev?.dir === base && prev.setup)) note(sym, 'wait', `сигнал ${ACT_RU[base]} подтверждён (оценка ${sgn(r.score)}), но от текущей цены ${fmt(r.price)} прибыль/риск мал — жду цену в зоне ${zoneTxt(r.plan)}`, { dir: base, key: 'wait' });
  else if (!setup && prev?.dir !== base) note(sym, 'watch', `оценка ${sgn(r.score)} (порог ±${r.threshold.toFixed(2)}) — жду цену в зоне ${zoneTxt(r.plan)}`, { dir: base, key: 'watch' });
  if (st && (st.action === r.action || st.action === base) && now - st.at < cfg.signal.watchCooldownMinutes * 60e3) { saveState(); return; }
  const subject = R.signalSubject(r);
  logAlert(subject, wants('watch'));
  if (wants('watch')) {
    const ch = chartFor(r);
    notifier.enqueue({ subject, text: R.signalText(r), html: R.signalHtml(r, { chartCid: ch.chartCid }), tag: '🟡', attachments: ch.attachments, key: `watch:${sym}` });
  } else console.log(`⏳ ${subject}`);
  state.signals[sym] = { action: r.action, at: now, price: r.price, notified: wants('watch') };
  saveState();
}

const hasTrade = (sym, dir) => trader.openTrades().some((t) => t.symbol === sym && (t.side === 'Buy') === (dir === 'BUY'));

// акции: сигналы только в часы торгов (STOCK_HOURS, по умолчанию основная сессия США); монеты — всегда
const signalHours = (c) => c?.kind !== 'stock' || stockSessionOpen(cfg.stocks.hours);

// по акции нет сделок — торги закрыты: без анализа и без ошибок; последний анализ остаётся в панели
function marketClosed(c, b) {
  if (closedNow.has(c.symbol)) return;
  closedNow.set(c.symbol, { since: b.lastTrade, price: b.price });
  console.log(`🕒 ${coinOf(c.symbol)}: торги по акции закрыты${b.lastTrade ? ` (последняя сделка ${fmtDate(b.lastTrade)})` : ''} — жду открытия`);
}

// зона входа, которую ждём: как только цена в неё войдёт — свежий анализ, и если он подтвердит вход — письмо и сделка.
// setup — зона после подтверждённого сильного сигнала (для панели и разбора; правило входа то же)
function armZone(r, { setup = false } = {}) {
  const now = Date.now(), p = r.plan;
  const prev = state.zones[r.symbol];
  const same = prev?.dir === p.dir;
  state.zones[r.symbol] = {
    dir: p.dir, low: p.zone[0], high: p.zone[1], atr: r.stats.atr, stop: p.stop, t1: p.t1, t2: p.t2,
    at: same ? prev.at ?? now : now,
    // у акции зона живёт до конца следующего торгового дня — выходные и праздники её не съедают
    until: same && prev.notifiedAt ? prev.until : r.kind === 'stock' ? stockZoneUntil(now, cfg.signal.zoneValidHours) : now + cfg.signal.zoneValidHours * 3600e3,
    lastTrigger: same ? prev.lastTrigger ?? 0 : 0, lastTriggerPrice: same ? prev.lastTriggerPrice ?? null : null,
    setup: setup || (same && !!prev.setup),
    ...(same && prev.notifiedAt ? { notifiedAt: prev.notifiedAt, lastCode: prev.lastCode, tries: prev.tries } : {}),
  };
}

function dropZone(sym, why, { log = true } = {}) {
  const z = state.zones[sym];
  if (!z) return;
  delete state.zones[sym];
  saveState();
  if (log) note(sym, 'zone-off', `${z.dir === 'BUY' ? 'покупка' : 'продажа'} ${fmt(z.low)}–${fmt(z.high)}: ${why}`, { dir: z.dir, key: reasonKey(why) });
}

// цена в зоне, письмо ушло, но сделка не открылась по причине, которая может пройти сама (цена на Bybit ушла,
// лимит позиций, сбой связи) — зона остаётся ещё на 2 ч: при следующем подтверждённом входе пробуем снова
const MAX_TRIES = 6;
function keepForRetry(r, now) {
  const sym = r.symbol;
  if (state.zones[sym]?.dir !== r.plan.dir) armZone(r, { setup: true });
  const z = state.zones[sym];
  Object.assign(z, { notifiedAt: now, lastCode: r.exec.code, tries: 0, until: Math.min(z.until, now + 2 * 3600e3) });
}

async function retryZoneTrade(r, z) {
  const sym = r.symbol;
  if (!trader.enabled || hasTrade(sym, r.action) || !RETRY_CODES.has(z.lastCode) || (z.tries ?? 0) >= MAX_TRIES) return;
  z.tries = (z.tries ?? 0) + 1;
  r.exec = await trader.onSignal(r, { zone: true });
  if (state.zones[sym] === z) z.lastCode = r.exec?.code ?? null;
  console.log(`🤖 Bybit, повторная попытка ${z.tries}: ${r.exec?.status === 'opened' ? `открыт ${r.exec.trade.side === 'Buy' ? 'лонг' : 'шорт'} ${coinOf(sym)} на ${fmtMoney(r.exec.trade.notional)}` : `без сделки — ${r.exec?.reason}`}`);
  noteExec(r);
  if (r.exec?.status !== 'opened') { saveState(); return; }
  delete state.zones[sym];
  const send = signalEmail(cfg.notify.events, { inZone: true, opened: true });
  state.signals[sym] = { action: r.action, at: Date.now(), price: r.price, notified: send, inZone: true };
  saveState();
  r.history ??= journal.similar(r);
  const subject = R.signalSubject(r, { zone: true });
  logAlert(subject, send);
  if (!send) return;
  const ch = chartFor(r);
  await notifier.urgent({ subject, text: R.signalText(r, { zone: true }), html: R.signalHtml(r, { zone: true, chartCid: ch.chartCid }), smsText: R.smsText(r, { zone: true }), attachments: ch.attachments });
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
    logAlert(m.subject, wants('news'));
    if (wants('news')) notifier.enqueue({ ...m, tag: '📰' });
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
    logAlert(m.subject, wants('macro'));
    if (wants('macro')) notifier.enqueue({ ...m, tag: '📅' });
  }
  for (const [id, t] of Object.entries(state.macroAlerted)) if (now - t > 30 * 86400e3) delete state.macroAlerted[id];
  saveState();
}

// ── автоторговля: письма о сопровождении сделок ─────────────────────────────
function onTradeEvent(ev) {
  const m = R.tradeEventMessage(ev, { pnlToday: trader.state.pnlToday, stats: trader.stats(30), balance: trader.balance });
  const send = wants(TRADE_EVENT_CATEGORY[ev.type] ?? 'trade');
  console.log(m.subject);
  logAlert(m.subject, send);
  if (send) notifier.enqueue({ ...m, tag: '🤖' });
}

// ── киты ───────────────────────────────────────────────────────────────────
async function onWhale(ev, decision) {
  // акция вне часов сигналов (STOCK_HOURS): кит виден в панели, но письма нет — как и остальных писем по акциям
  if (decision.alert && isStock(ev.symbol) && !stockSessionOpen(cfg.stocks.hours)) decision = { ...decision, alert: false, reason: 'акция вне часов торгов' };
  const line = `🐋 ${new Date(ev.time).toLocaleTimeString('ru-RU')} ${ev.side === 'buy' ? 'покупка' : 'продажа'} ${coinOf(ev.symbol)} ${ev.market}${ev.type === 'series' ? ` серия ×${ev.count}` : ''} ${fmtUsd(ev.usd)}`;
  const { ref, ...rest } = ev;
  whaleLog.unshift({ ...rest, alerted: decision.alert });
  whaleLog.length = Math.min(whaleLog.length, 300);
  if (!decision.alert) { if (verbose) console.log(`${line} — без письма: ${decision.reason}`); return; }
  console.log(line);
  const ch = chartFor(results.get(ev.symbol));
  const trade = trader.openTrades().find((t) => t.symbol === ev.symbol) ?? null;
  const m = R.whaleMessage(ev, decision, { summary: flow.summary(ev.symbol, 60), result: results.get(ev.symbol), chartCid: ch.chartCid, trade, zone: state.zones[ev.symbol] ?? null, stock: isStock(ev.symbol) });
  logAlert(m.subject, wants('whales'));
  if (!wants('whales')) return;
  notifier.enqueue({ subject: m.subject, text: m.text, html: m.html, tag: '🐋', attachments: ch.attachments });
  if (cfg.whales.sms) notifier.sms(m.sms);
}

// ── живые проверки: зоны входа и журнал (каждые 5 с) ───────────────────────
const triggering = new Set();
async function zoneTrigger(sym, z) {
  const c = coins.find((x) => x.symbol === sym);
  if (!c) return;
  const b = await gather(c);
  if (b.closed) return; // торги по акции закрылись
  const r = analyze(b, cfg);
  results.set(sym, r);
  if (state.zones[sym] !== z) return; // пока шёл анализ, зону сняли или заменили
  const res = zoneEntry(z, r, { minRR: cfg.signal.minRiskReward, triggerRatio: cfg.signal.zoneTriggerRatio });
  console.log(`🎯 ${coinOf(sym)}: цена ${fmt(r.price)} в зоне ${fmt(z.low)}–${fmt(z.high)} — ${res.ok ? 'вход подтверждён' : `вход не подтверждён: ${res.why}`}`);
  if (!res.ok) {
    note(sym, 'zone-no', res.why, { dir: z.dir, key: res.code === 'veto' ? reasonKey(res.why) : res.code });
    if (res.flip) dropZone(sym, 'картина развернулась против входа'); // зона больше не актуальна
    return;
  }
  r.action = z.dir;
  await handleResult(r, { zone: true });
}

function liveTick() {
  const now = Date.now();
  for (const [sym, z] of Object.entries(state.zones)) {
    if (now > z.until) { dropZone(sym, z.notifiedAt ? 'время повторных попыток вышло' : `цена не дошла до зоны за ${cfg.signal.zoneValidHours} ч`); continue; }
    const rr = results.get(sym);
    const lp = flow.lastPrice(sym) ?? (rr ? { price: rr.price, time: rr.time } : null);
    const maxAge = streamsOn ? 60e3 : cfg.pollSeconds * 3000;
    if (!lp || now - lp.time > maxAge || triggering.has(sym)) continue;
    if (isStock(sym) && !stockSessionOpen(cfg.stocks.hours)) continue; // по акциям вход — только в часы торгов
    // цена прошла сквозь зону за стоп — зона пробита, ждать её больше нечего
    if (z.stop && (z.dir === 'BUY' ? lp.price < z.stop : lp.price > z.stop)) {
      console.log(`⏹ ${coinOf(sym)}: цена ${fmt(lp.price)} ушла за стоп ${fmt(z.stop)} — зона ${fmt(z.low)}–${fmt(z.high)} больше не актуальна`);
      dropZone(sym, `цена ${fmt(lp.price)} ушла за стоп ${fmt(z.stop)}`);
      continue;
    }
    if (!priceInZone(z, lp.price)) continue;
    // повторная проверка — через 10 минут, или раньше, если цена зашла глубже в зону (вход стал выгоднее)
    const deeper = z.lastTriggerPrice && (z.dir === 'BUY' ? lp.price <= z.lastTriggerPrice - 0.25 * z.atr : lp.price >= z.lastTriggerPrice + 0.25 * z.atr);
    const since = now - (z.lastTrigger || 0);
    if (since < 10 * 60e3 && !(deeper && since > 30e3)) continue;
    z.lastTrigger = now;
    z.lastTriggerPrice = lp.price;
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
  if (moving.has(sym) || !r0 || !signalHours(c)) return;
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
    try {
      const b = await gather(c);
      if (b.closed) return;
      r = analyze(b, cfg);
      await handleResult(r);
    } catch (e) { console.error(`⚡ ${sym}: ${e.message}`); }
    const ch = chartFor(r);
    const m = R.moveMessage(mv, r, { liq: streamsOn ? liq.summary(sym, 15) : null, flow: streamsOn ? flow.summary(sym, 15) : null, chartCid: ch.chartCid });
    logAlert(m.subject, wants('moves'));
    if (wants('moves')) notifier.enqueue({ ...m, tag: '⚡', attachments: ch.attachments });
  })().finally(() => moving.delete(sym));
}

// если потоков нет — журнал обновляется по 15-минутным свечам
function journalFallback() {
  if (streamsOn) return;
  const evs = journal.update((s) => {
    const m15 = isStock(s) ? binance.cache.peek(`k:futures:${s}:15m:${cfg.stocks.candles.m15}`) : binance.cache.peek(`k:spot:${s}:15m:${cfg.candles.m15}`);
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
  if (!cfg.digest.enabled || !wants('digest')) return false;
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
  if (cfg.options.enabled && optionsFeed.health.ok != null) groups.set('options', { name: 'опционы Deribit', ok: optionsFeed.health.ok, n: 1 });
  return [...groups.values()];
};

const stocksStatus = () => ({ on: coins.some((c) => c.kind === 'stock'), n: coins.filter((c) => c.kind === 'stock').length, hours: cfg.stocks.hours, trade: cfg.trade.stocks });
const zonesNow = () => Object.entries(state.zones).map(([symbol, z]) => ({ symbol, ...z, price: flow.lastPrice(symbol)?.price ?? results.get(symbol)?.price ?? null }));

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
    zones: zonesNow(),
    emailEvents: cfg.notify.events.map((x) => EMAIL_EVENT_NAMES[x] ?? x),
    why: diagnose({ trading: tradingInfo(), list: decisions.list, zones: zonesNow(), confirmPolls: cfg.signal.confirmPolls, stocks: stocksStatus() }),
    entryRule: { ratio: cfg.signal.zoneTriggerRatio, minRR: cfg.signal.minRiskReward },
    breadth: { ...breadth },
    options: Object.fromEntries(['BTC', 'ETH'].map((c) => [c, results.get(`${c}USDT`)?.options ?? null]).filter(([, v]) => v)),
    decisions: decisions.recent(40),
    stocks: {
      on: coins.some((c) => c.kind === 'stock'), source: stockInfo.source, missing: stockInfo.missing, index: stockIndex?.name ?? null, trade: cfg.trade.stocks,
      hours: SESSION_RU[cfg.stocks.hours] ?? cfg.stocks.hours, open: stockSessionOpen(cfg.stocks.hours), nextOpen: nextSessionOpen(cfg.stocks.hours), why: sessionReason(cfg.stocks.hours),
      closed: Object.fromEntries(closedNow),
    },
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
      logAlert(subject, wants('critical'));
      if (wants('critical')) notifier.enqueue({ subject, tag: '⚠️', text, html: `<p><b>${subject}</b></p><p>${text.replace(/\n/g, '<br>')}</p>` });
    }
    return;
  }
  const fresh = [...errors].filter(([s, n]) => n >= cfg.notify.errorAlertAfter && !errorAlerted.has(s)).map(([s]) => s);
  if (!fresh.length) return;
  for (const s of fresh) errorAlerted.add(s);
  const subject = `⚠️ Crypto Watcher: нет данных по ${fresh.length === 1 ? fresh[0] : `${fresh.length} монетам`}`;
  const lines = fresh.map((s) => `${s}: ${lastErrors.get(s)}`);
  const text = `${cfg.notify.errorAlertAfter}+ проверок подряд завершились ошибкой:\n${lines.join('\n')}\n\nПрограмма продолжает попытки и сама продолжит анализ, когда данные появятся.`;
  logAlert(subject, wants('critical'));
  if (wants('critical')) notifier.enqueue({ subject, tag: '⚠️', text, html: `<p><b>${subject}</b></p><p>${text.replace(/\n/g, '<br>')}</p>` });
}

// ── тест уведомлений ───────────────────────────────────────────────────────
if (testNotify) {
  console.log(`Отправляю тест в каналы: ${notifier.channels({ masked: true }).join(', ')}`);
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
const lock = new InstanceLock(file('data/instance.lock'));
function saveAll() {
  try { writeJsonAtomic(stateFile, state, { pretty: true }); } catch { /* ignore */ }
  try { journal.save(); } catch { /* ignore */ }
  try { trader.save(); } catch { /* ignore */ }
}
async function shutdown() {
  if (!running) return;
  running = false;
  console.log('\nОстанавливаюсь…');
  spotStream.stop(); futStream.stop(); flow.stop();
  // операция с биржей (вход, перенос стопа) не должна оборваться на середине
  await Promise.race([trader.queue, sleep(15e3)]);
  saveAll();
  await Promise.race([notifier.flush(), sleep(10e3)]);
  lock.release();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => console.error('Необработанная ошибка:', e));
process.on('uncaughtException', (e) => {
  console.error('Критическая ошибка — сохраняю состояние и перезапускаюсь:', e);
  saveAll();
  process.exit(1);
});

// две копии программы открыли бы каждую сделку дважды — вторая ждёт, пока первая не остановится
if (!once) {
  let res = lock.tryAcquire(), told = 0;
  while (!res.ok) {
    if (Date.now() - told > 5 * 60e3) {
      told = Date.now();
      console.error(`⚠️ Уже работает другая копия программы (${res.holder.host}, pid ${res.holder.pid}, запущена ${new Date(res.holder.startedAt).toLocaleString('ru-RU')}). Жду, пока она остановится…`);
    }
    await sleep(15e3);
    res = lock.tryAcquire();
  }
}

if (!BinanceStream.supported() && cfg.whales.enabled && !once) console.error('⚠️ Для китов, ликвидаций и живых зон нужен Node.js 22+ (WebSocket) — эти функции отключены');
// часы сервера: если они сильно врут, свечи считаются «устаревшими», а время сделок — неверным
const clockSkew = once ? null : await binance.serverTimeSkew().catch(() => null);
if (clockSkew != null && Math.abs(clockSkew) > 5e3) console.error(`⚠️ Часы сервера расходятся с Binance на ${(clockSkew / 1000).toFixed(1)} с — включите синхронизацию времени: timedatectl set-ntp true`);
await market.refresh();
const tradingOn = !once && (trader.enabled || trader.openTrades().length > 0);
const critical = (subject, text) => {
  logAlert(subject, wants('critical'));
  if (wants('critical')) notifier.enqueue({ subject, tag: '⚠️', text, html: `<p><b>${escapeHtml(subject)}</b></p><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>` });
};
if (clockSkew != null && Math.abs(clockSkew) > 60e3) critical('⚠️ Crypto Watcher: часы сервера врут', `Время сервера расходится с Binance на ${Math.round(clockSkew / 1000)} с. Из-за этого данные могут считаться устаревшими, а сделки — открываться с ошибками. Включите синхронизацию времени: timedatectl set-ntp true`);
if (!once && !tradeWanted && trader.hasKeys()) console.error('⚠️ Ключи Bybit заданы, но в .env TRADE=0 — сделки не открываются (сигналы и письма работают). Включить: TRADE=1');
if (!once && tradeWanted && check.tradeErrors.length) {
  critical('⚠️ Crypto Watcher: автоторговля выключена — ошибки в настройках', `В .env неверные значения:\n• ${check.tradeErrors.join('\n• ')}\n\nНовые сделки не открываются, пока вы не исправите .env и не перезапустите программу. Открытые сделки сопровождаются как обычно.`);
}
if (tradingOn) {
  await trader.init();
  console.log(trader.describe());
  if (trader.ready && trader.enabled && trader.mode === 'live') {
    const c = cfg.trade;
    critical('⚠️ Crypto Watcher: автоторговля на РЕАЛЬНОМ счёте Bybit включена', `Баланс ${fmtMoney(trader.balance?.equity)}. Риск ${c.riskPct}% на сделку, плечо до ×${c.leverage}, до ${c.maxPositions} позиций, дневной лимит убытка ${c.dailyLossPct}%${c.maxNotionalUsd > 0 ? `, потолок позиции ${fmtMoney(c.maxNotionalUsd)}` : ''}.\n\nОстановить новые сделки: node index.js --pause-trading; закрыть все сделки программы: node index.js --close-all.`);
  }
  if (!trader.ready) critical('⚠️ Crypto Watcher: автоторговля на Bybit не запустилась', `${trader.describe()}\n\nПроверьте ключ командой node index.js --trade-check. Сигналы и киты работают как обычно; программа будет пробовать подключиться снова каждые 10 минут.`);
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
  console.log(`Уведомления: ${notifier.channels({ masked: true }).join(', ')}`);
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
  const rank = (c) => (c.kind === 'stock' ? 2 : /^BTC/.test(c.symbol) ? 0 : 1);
  const ordered = [...coins].sort((a, b) => rank(a) - rank(b));
  if (ordered.some((c) => c.kind !== 'stock') && !ordered.some((c) => /^BTC/.test(c.symbol) && c.kind !== 'stock')) {
    try { const r = analyze(await gather({ symbol: 'BTCUSDT', name: 'Bitcoin' }, { light: true }), cfg); market.setBtc(r); results.set('BTCUSDT@ctx', r); } catch { /* контекст не обязателен */ }
  }
  // фон рынка акций (QQQ) — до анализа акций
  if (stockIndex && coins.some((c) => c.kind === 'stock')) {
    try {
      const b = await gatherStock({ symbol: stockIndex.symbol, name: stockIndex.name, kind: 'stock' }, { light: true });
      if (!b.closed) results.set(`${stockIndex.symbol}@ctx`, analyze(b, cfg));
    } catch { /* фон не обязателен */ }
  }
  for (const c of ordered) {
    if (!running) break;
    try {
      const b = await gather(c);
      if (b.closed) { marketClosed(c, b); errors.set(c.symbol, 0); await sleep(150); continue; }
      if (closedNow.delete(c.symbol)) console.log(`🔔 ${coinOf(c.symbol)}: торги по акции открылись`);
      const r = analyze(b, cfg);
      if (/^BTC/.test(c.symbol) && c.kind !== 'stock') market.setBtc(r);
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
  breadth.crypto = breadthOf('crypto');
  breadth.stock = breadthOf('stock');
  lastCycleAt = Date.now();
  cycles++;
  // короткий отчёт о работе — для команды --why (видно, что программа жива и с какими настройками работает)
  if (!once) { state.status = { at: lastCycleAt, version: VERSION, startedAt, cycles, coins: coins.length, confirmPolls: cfg.signal.confirmPolls, trading: tradingInfo(), stocks: stocksStatus() }; saveState(); }
  if (!once && ((firstCycle && digestNow) || digestDue())) {
    state.digestDay = new Date().toLocaleDateString('sv-SE');
    saveState();
    await sendDigest().catch((e) => console.error('Обзор:', e.message));
  }
  firstCycle = false;
  if (!once && running) await sleep(Math.max(5000, cfg.pollSeconds * 1000 - (Date.now() - started)));
} while (!once && running);
