// Журнал решений: что программа решила по каждому сильному сигналу и зоне входа — и почему.
// Отвечает на вопрос «почему не открылась сделка» в веб-панели и командой node index.js --why.
//
// Запись: { t, sym, kind, dir, why, key, n } — если то же самое повторяется в течение часа,
// растёт n (одна запись на эпизод, а не на каждую проверку).
import { coinOf, fmt, fmtMoney, fmtDate, plural, pct } from './format.js';
import { stockSessionOpen, nextSessionOpen, sessionReason } from './stocks.js';

export const DECISION_KINDS = {
  filtered: { emoji: '🚫', text: 'отсеян фильтром' },
  unconfirmed: { emoji: '↩️', text: 'не подтвердился' },
  wait: { emoji: '⏳', text: 'жду цену в зоне' },
  watch: { emoji: '🟡', text: 'готовиться' },
  'zone-no': { emoji: '🎯', text: 'в зоне, вход не подтверждён' },
  'zone-off': { emoji: '⏹', text: 'зона снята' },
  signal: { emoji: '🎯', text: 'сигнал в зоне' },
  opened: { emoji: '🤖', text: 'сделка открыта' },
  skipped: { emoji: '✋', text: 'сделка не открыта' },
  off: { emoji: '⏸', text: 'без сделки: автоторговля выключена' },
};

/** Ключ для группировки похожих причин: числа не важны («через 2 ч FOMC» и «через 1 ч FOMC» — одно и то же) */
export const reasonKey = (s) => String(s ?? '').replace(/[+\-−]?\d[\d.,]*/g, '#').slice(0, 90);

const valid = (x) => !!x && typeof x === 'object' && Number.isFinite(x.t) && typeof x.sym === 'string' && !!DECISION_KINDS[x.kind];

export class Decisions {
  constructor(list = [], { max = 300 } = {}) {
    this.list = Array.isArray(list) ? list.filter(valid) : [];
    this.max = max;
  }

  /** Записать решение. merge=false — всегда отдельной строкой (например, открытая сделка) */
  add({ sym, kind, dir = null, why, key = null }, { now = Date.now(), mergeMinutes = 60, merge = true } = {}) {
    const k = key ?? reasonKey(why);
    const i = merge ? this.list.findIndex((x) => x.sym === sym && x.kind === kind && x.key === k && now - x.t < mergeMinutes * 60e3) : -1;
    if (i >= 0) {
      const x = this.list[i];
      this.list.splice(i, 1);
      this.list.unshift({ ...x, t: now, why, dir: dir ?? x.dir, n: (x.n ?? 1) + 1, first: x.first ?? x.t });
    } else {
      this.list.unshift({ t: now, sym, kind, dir, why, key: k, n: 1 });
      if (this.list.length > this.max) this.list.length = this.max;
    }
    return this.list[0];
  }

  recent(n = 30) { return this.list.slice(0, n); }
}

/** Сводка за последние часы: сколько эпизодов каждого вида и самые частые причины */
export function summarize(list = [], { hours = 24, now = Date.now() } = {}) {
  const recent = list.filter((x) => valid(x) && x.t >= now - hours * 3600e3);
  const count = (...kinds) => recent.filter((x) => kinds.includes(x.kind)).length;
  const top = (kind) => {
    const g = new Map();
    for (const x of recent) {
      if (x.kind !== kind) continue;
      const e = g.get(x.key) ?? { why: x.why, n: 0, coins: new Set() };
      e.n++;
      e.coins.add(coinOf(x.sym));
      g.set(x.key, e);
    }
    return [...g.values()].sort((a, b) => b.n - a.n).map((e) => ({ why: e.why, n: e.n, coins: [...e.coins] }));
  };
  return {
    hours,
    filtered: count('filtered'), unconfirmed: count('unconfirmed'), wait: count('wait'), watch: count('watch'),
    zoneNo: count('zone-no'), zoneOff: count('zone-off'), inZone: count('signal', 'opened', 'skipped', 'off'),
    opened: count('opened'), skipped: count('skipped'), off: count('off'),
    topFiltered: top('filtered'), topZoneNo: top('zone-no'), topSkipped: top('skipped'), topZoneOff: top('zone-off'),
  };
}

const times = (n) => plural(n, ['раз', 'раза', 'раз']);
const MODE = { demo: 'демо-счёт', live: 'реальный счёт', testnet: 'тестовая сеть' };
const listWhy = (arr, n = 2) => arr.slice(0, n).map((x) => `${x.why}${x.n > 1 ? ` (${times(x.n)})` : ''}`).join('; ');

// подсказка по тексту ошибки Bybit
function hint(problem = '') {
  if (/403|стран/i.test(problem)) return ' Похоже, Bybit не принимает запросы из страны сервера — нужен сервер в стране, где Bybit работает (см. README, раздел про автоторговлю).';
  if (/ключ|подпис|прав|IP/i.test(problem)) return ' Проверьте ключ: node index.js --trade-check.';
  return ' Проверка: node index.js --trade-check.';
}

/** Сколько цене идти до зоны: для покупки — вниз до верха зоны, для продажи — вверх до низа; внутри — «в зоне» */
export function zoneDistance(z) {
  if (!(z.price > 0)) return null;
  const buy = z.dir === 'BUY';
  if (buy ? z.price > z.high * 1.0005 : z.price < z.low * 0.9995) return `до зоны ${pct(buy ? z.high / z.price - 1 : z.low / z.price - 1, 1)}`;
  if (buy ? z.price < z.low : z.price > z.high) return buy ? 'ниже зоны' : 'выше зоны';
  return 'в зоне';
}

/** Зона входа одной строкой: «SOL покупка 148.50–149.80, сильный сигнал (цена 152.10, до зоны −2.3%)» */
export function zoneLine(z) {
  const where = z.price > 0 ? ` (цена ${fmt(z.price)}, ${zoneDistance(z)})` : '';
  return `${coinOf(z.symbol)} ${z.dir === 'BUY' ? 'покупка' : 'продажа'} ${fmt(z.low)}–${fmt(z.high)}${z.setup ? ', сильный сигнал' : ''}${where}`;
}

/**
 * Почему нет сделок: разбор по шагам — автоторговля, сигналы, зоны входа, отказы биржи.
 * trading — состояние автоторговли работающей программы; zones — зоны, которые ждём сейчас (с текущей ценой, если известна).
 * @returns {{ lines: {level: 'bad'|'warn'|'ok'|'info', text: string}[], summary: object }}
 */
export function diagnose({ trading = null, list = [], zones = [], now = Date.now(), hours = 24, confirmPolls = 2, stocks = null } = {}) {
  const lines = [];
  const add = (level, text) => lines.push({ level, text });
  const t = trading ?? {};

  // 1. автоторговля
  if (!t.wanted) {
    add(t.hasKeys ? 'bad' : 'info', `Автоторговля выключена: программа запущена без TRADE=1 в .env${t.hasKeys ? ', хотя ключи Bybit заданы' : ''}. Сигналы приходят на почту, но сделки на Bybit не открываются. Включить: TRADE=1 в .env и перезапуск программы (в Docker — docker compose up -d).`);
  }
  else if (t.configErrors?.length) add('bad', `Автоторговля выключена из-за ошибок в .env: ${t.configErrors.join('; ')}. Исправьте .env и перезапустите программу.`);
  else if (!t.hasKeys) add('bad', 'Не заданы BYBIT_API_KEY и BYBIT_API_SECRET в .env — без ключа сделки не открываются.');
  else if (!t.ready) add('bad', `Bybit не подключён: ${t.problem ?? 'идёт запуск'}.${hint(t.problem ?? '')} Программа сама пробует подключиться каждые 10 минут.`);
  else add('ok', `Автоторговля работает: ${MODE[t.mode] ?? t.mode}${t.balance != null ? `, баланс ${fmtMoney(t.balance)}` : ''}; вход — ${t.entry === 'signal' ? 'сразу по сигналу' : 'когда цена в зоне входа'}.`);
  if (t.wanted && t.userPause) add('bad', `Автоторговля на паузе${t.userPause.reason ? ` (${t.userPause.reason})` : ''} — новые сделки не открываются. Снять паузу: node index.js --resume-trading.`);
  if (t.wanted && t.paused) add('warn', 'Сегодня достигнут дневной лимит убытка — новые сделки только завтра.');
  if (t.ready && t.maxPositions && t.open >= t.maxPositions) add('warn', `Открыто ${t.open} из ${t.maxPositions} позиций — новых сделок не будет, пока одна из них не закроется.`);
  // 📈 акции: часы торгов и отдельный переключатель сделок
  if (stocks?.on) {
    if (!stockSessionOpen(stocks.hours, now)) {
      const next = nextSessionOpen(stocks.hours, now);
      add('info', `Акции: сейчас сигналов нет — ${sessionReason(stocks.hours, now)}${next ? `; снова с ${fmtDate(next)} (по времени сервера)` : ''}.`);
    }
    if (t.wanted && !stocks.trade) add('info', 'Сделки по акциям выключены (TRADE_STOCKS=0): по акциям приходят только сигналы. Включить: TRADE_STOCKS=1 в .env.');
  }

  // 2. сигналы
  const s = summarize(list, { hours, now });
  if (!s.wait && !s.inZone) {
    const parts = [];
    if (s.filtered) parts.push(`сильная оценка появлялась ${times(s.filtered)}, но её отсеяли фильтры — чаще всего: ${listWhy(s.topFiltered)}`);
    if (s.unconfirmed) parts.push(`${times(s.unconfirmed)} сигнал не продержался ${confirmPolls} проверки подряд`);
    add('info', parts.length
      ? `За ${hours} ч не было ни одного подтверждённого сигнала ПОКУПКА/ПРОДАЖА: ${parts.join('; ')}.`
      : `За ${hours} ч не было ни одного подтверждённого сигнала ПОКУПКА/ПРОДАЖА — у рынка нет чёткого направления, программа ждёт. Это нормально: она входит только при сильной и подтверждённой картине.`);
  } else {
    add('info', `За ${hours} ч: подтверждённых сигналов, ждавших цену в зоне входа, — ${s.wait}; сигналов в зоне входа — ${s.inZone}; сделок открыто — ${s.opened}.`);
    if (s.wait && !s.inZone && !s.zoneNo) add('info', 'Цена ни разу не дошла до зон входа: программа не покупает «вдогонку», а ждёт отката к зоне — так вход лучше, а стоп ближе. Входить сразу по сигналу: TRADE_ENTRY=signal в .env (вход хуже, риск выше; сравнить заранее: node backtest.js --entry signal).');
    if (s.filtered) add('info', `Ещё ${times(s.filtered)} сильную оценку отсеяли фильтры — чаще всего: ${listWhy(s.topFiltered)}.`);
  }
  if (s.watch) add('info', `«Готовиться» (оценка слабее порога) — ${times(s.watch)}: по такой зоне вход будет, если цена в неё войдёт и оценка окрепнет.`);

  // 3. цена в зоне, но без сделки
  if (s.zoneNo) add('info', `Цена доходила до зоны ${times(s.zoneNo)}, но вход не подтвердился — чаще всего: ${listWhy(s.topZoneNo)}.`);
  if (s.skipped) add('warn', `Сделка не открыта ${times(s.skipped)} — ${listWhy(s.topSkipped, 3)}.`);
  if (s.opened) add('ok', `Сделок открыто за ${hours} ч: ${s.opened}.`);

  // 4. что ждём сейчас
  if (zones.length) add('info', `Сейчас жду цену в зоне входа: ${zones.map(zoneLine).join('; ')}.`);
  return { lines, summary: s };
}
