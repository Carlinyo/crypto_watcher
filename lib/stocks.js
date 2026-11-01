// 📈 Акции США. С 2026 года на Binance Futures торгуются бессрочные контракты на акции (contractType
// TRADIFI_PERPETUAL: NVDAUSDT, AAPLUSDT…): цена следует за акцией, а данные — те же, что у крипты:
// свечи, стакан, поток сделок, открытый интерес, фандинг. Поэтому акции анализируются тем же движком.
//
// Торги по такому контракту идут по расписанию акции (не 24/7): когда сделок нет — программа считает
// торги закрытыми и акцию пропускает. Сигналы по умолчанию — только в основную сессию биржи США.
import { writeJsonAtomic, readJson } from './storage.js';
import { marketStatus, sessionOn, sessionAfter, etParts, etToUtc } from './usmarket.js';

// Крупнейшие компании США по капитализации на 30.10.2026 (ChartRow) — с запасом: если какой-то акции
// на Binance нет, её место займёт следующая. [тикер, название, поисковый запрос новостей, другие тикеры]
export const STOCK_CANDIDATES = [
  ['AAPL', 'Apple'], ['NVDA', 'NVIDIA'], ['MSFT', 'Microsoft'], ['GOOGL', 'Alphabet', 'Alphabet Google', ['GOOG']], ['AMZN', 'Amazon'],
  ['TSM', 'TSMC'], ['SPCX', 'SpaceX', 'SpaceX', ['SPACEX']], ['TSLA', 'Tesla'], ['META', 'Meta Platforms'], ['AVGO', 'Broadcom'],
  ['LLY', 'Eli Lilly'], ['BRK-B', 'Berkshire Hathaway', 'Berkshire Hathaway', ['BRKB', 'BRK']], ['MU', 'Micron', 'Micron Technology'],
  ['WMT', 'Walmart'], ['JPM', 'JPMorgan Chase', 'JPMorgan'],
  ['AMD', 'AMD', 'AMD chips'], ['V', 'Visa'], ['XOM', 'Exxon Mobil'], ['JNJ', 'Johnson & Johnson'], ['ASML', 'ASML'],
  ['MA', 'Mastercard'], ['ABBV', 'AbbVie'], ['CVX', 'Chevron'], ['COST', 'Costco'], ['PLTR', 'Palantir'],
  ['CSCO', 'Cisco'], ['KO', 'Coca-Cola'], ['ORCL', 'Oracle'], ['PG', 'Procter & Gamble'], ['MRK', 'Merck'],
  ['NFLX', 'Netflix'], ['BAC', 'Bank of America'], ['INTC', 'Intel'],
].map(([ticker, name, query = name, alt = []]) => ({ ticker, name, query, alt }));

const clean = (t) => String(t).toUpperCase().replace(/USDT$/, '').replace(/[^A-Z0-9]/g, '');
export const stocksEnabled = (cfg) => !['0', 'off', 'no', 'false', 'нет'].includes(String(cfg.stocks?.list?.[0] ?? 'auto').toLowerCase());

/**
 * Список акций: в режиме auto — первые size кандидатов, у которых есть контракт на Binance; иначе — список из .env.
 * @param {Map<string, object>} tradfi — контракты TRADIFI_PERPETUAL с Binance (символ → описание)
 * @param {Set<string>} [taken] — символы, уже занятые криптовалютами (совпадения тикеров пропускаются)
 */
export function selectStocks(cfg, tradfi, taken = new Set()) {
  const s = cfg.stocks;
  if (!stocksEnabled(cfg)) return { stocks: [], missing: [], source: 'акции выключены (STOCKS=0)' };
  const manual = String(s.list[0]).toLowerCase() !== 'auto';
  const known = new Map(STOCK_CANDIDATES.map((c) => [clean(c.ticker), c]));
  const wanted = manual ? s.list.map((t) => known.get(clean(t)) ?? { ticker: clean(t), name: null, query: null, alt: [] }) : STOCK_CANDIDATES;
  const stocks = [], missing = [];
  for (const c of wanted) {
    if (!manual && stocks.length >= s.size) break;
    const symbol = [c.ticker, ...c.alt].map((t) => `${clean(t)}USDT`).find((x) => tradfi.has(x) && !taken.has(x));
    if (!symbol) { missing.push(c.ticker); continue; }
    stocks.push({ symbol, base: symbol.slice(0, -4), ticker: c.ticker, name: c.name ?? null, query: c.query ?? c.name ?? clean(c.ticker), kind: 'stock', rank: stocks.length + 1 });
  }
  return { stocks, missing, source: manual ? 'ваш список (STOCKS)' : 'крупнейшие компании США по капитализации' };
}

/** Список акций с запасным вариантом: справочник Binance недоступен — берём последний сохранённый */
export function loadStocks(cfg, tradfi, file, taken) {
  if (!stocksEnabled(cfg)) return { stocks: [], missing: [], source: 'акции выключены (STOCKS=0)' };
  if (tradfi?.size) {
    const res = selectStocks(cfg, tradfi, taken);
    if (res.stocks.length) { try { writeJsonAtomic(file, { at: Date.now(), ...res }, { pretty: true }); } catch { /* не критично */ } }
    return res;
  }
  const saved = readJson(file, null, { log: () => {} });
  if (saved?.stocks?.length) return { ...saved, stocks: saved.stocks.filter((x) => !taken?.has(x.symbol)), source: `${saved.source}, сохранённый список` };
  return { stocks: [], missing: [], source: 'справочник фьючерсов на акции Binance недоступен' };
}

// ── часы торгов США: по календарю NYSE (праздники и сокращённые дни — lib/usmarket.js) ──
export const SESSION_RU = { regular: 'основная сессия 9:30–16:00 по Нью-Йорку', extended: 'с 4:00 до 20:00 по Нью-Йорку', any: 'всё время, пока идут торги' };
const EXT_FROM = 4 * 60, EXT_TO = 20 * 60;

/** Можно ли сейчас давать сигналы по акциям: regular — основная сессия, extended — 4:00–20:00 в торговые дни, any — всегда */
export function stockSessionOpen(hours = 'regular', now = Date.now()) {
  if (hours === 'any') return true;
  if (hours === 'extended') { const p = etParts(now); return !!sessionOn(p.date) && p.min >= EXT_FROM && p.min < EXT_TO; }
  return marketStatus(now).open;
}

/** Когда начнётся время сигналов (сейчас — если уже идёт) */
export function nextSessionOpen(hours = 'regular', now = Date.now()) {
  if (hours === 'any' || stockSessionOpen(hours, now)) return now;
  if (hours !== 'extended') return marketStatus(now).opensAt ?? null;
  const today = etParts(now).date;
  for (let i = 0; i < 14; i++) {
    const s = sessionOn(new Date(Date.parse(`${today}T12:00:00Z`) + i * 86400e3).toISOString().slice(0, 10));
    const t = s && etToUtc(s.date, EXT_FROM);
    if (t > now) return t;
  }
  return null;
}

/** Почему сейчас нет сигналов по акциям: «выходной», «праздник в США (…)», «торги на сегодня закончились» */
export function sessionReason(hours = 'regular', now = Date.now()) {
  if (stockSessionOpen(hours, now)) return null;
  const st = marketStatus(now);
  return st.open ? 'вне выбранных часов' : st.reason;
}

/** До какого момента ждать цену в зоне входа по акции: до конца следующего торгового дня (выходные не съедают зону) */
export function stockZoneUntil(now = Date.now(), minHours = 24) {
  return Math.max(now + minHours * 3600e3, sessionAfter(now)?.close ?? 0);
}

/** Свечи без сделок (часы, когда контракт не торгуется) — из анализа убираются */
export const tradedOnly = (candles) => (candles ?? []).filter((c) => c.trades > 0 || (c.trades == null && c.volume > 0));

/** Время последней сделки по свечам: конец последней свечи, в которой были сделки */
export function lastTradeTime(candles) {
  for (let i = (candles?.length ?? 0) - 1; i >= 0; i--) {
    const c = candles[i];
    if (c.trades > 0 || (c.trades == null && c.volume > 0)) return Math.min(Date.now(), c.closeTime ?? c.time);
  }
  return null;
}
