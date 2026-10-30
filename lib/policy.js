// Что присылать на почту и когда цена «в зоне входа».
//
// EMAIL_EVENTS — список того, о чём писать (по умолчанию: zone,trade,whales,critical):
//   zone        — сигнал ПОКУПКА/ПРОДАЖА, когда цена в зоне входа (в том числе «🎯 цена вошла в зону»)
//   signals     — все сигналы ПОКУПКА/ПРОДАЖА сразу, даже если цена ещё не в зоне
//   watch       — «готовиться»: зона найдена, цена до неё ещё не дошла
//   trade       — сделки Bybit: открытие (в письме о сигнале) и закрытие с итогом
//   trade-steps — сделки Bybit: цель 1 взята, стоп перенесён
//   whales      — киты
//   news, macro, moves, reversal, journal, digest, start — новости, события ФРС/CPI, резкие движения,
//                 разворот анализа против сигнала, журнал сигналов, ежедневный обзор, запуск программы
//   critical    — сбои и защита счёта: Binance/Bybit недоступны, ключ не работает, дневной лимит убытка, снятый стоп
// Всё, о чём письма нет, видно в веб-панели.
// SMS — только вместе с письмом о сигнале ПОКУПКА/ПРОДАЖА.

export const EMAIL_EVENT_NAMES = {
  zone: 'сигналы, когда цена в зоне входа', signals: 'все сигналы сразу', watch: '«готовиться»',
  trade: 'открытие и закрытие сделок Bybit', 'trade-steps': 'цель 1 и перенос стопа', whales: 'киты',
  news: 'новости', macro: 'макрособытия', moves: 'резкие движения', reversal: 'разворот против сигнала',
  journal: 'журнал сигналов', digest: 'ежедневный обзор', start: 'запуск', critical: 'сбои и защита счёта',
};

export const DEFAULT_EMAIL_EVENTS = ['zone', 'trade', 'whales', 'critical'];

/** Цена в зоне входа: для покупки — не выше верха зоны (с запасом 0.05 ATR) и не сильно ниже низа (0.4 ATR); для продажи — зеркально */
export function priceInZone({ dir, low, high, atr = 0 }, price) {
  if (!(price > 0) || !(low > 0) || !(high > 0)) return false;
  return dir === 'BUY'
    ? price <= high + 0.05 * atr && price >= low - 0.4 * atr
    : price >= low - 0.05 * atr && price <= high + 0.4 * atr;
}

export const zoneOf = (r) => ({ dir: r.plan?.dir, low: r.plan?.zone?.[0], high: r.plan?.zone?.[1], atr: r.stats?.atr ?? 0 });

/** Письмо (и SMS) о сигнале ПОКУПКА/ПРОДАЖА */
export function signalEmail(events, { inZone, opened }) {
  if (events.includes('signals')) return true;
  if (opened && events.includes('trade')) return true;
  return events.includes('zone') && inZone;
}

/** Результат анализа нельзя использовать: не числа или стоп, зона и цель перепутаны. null — всё в порядке */
export function resultProblem(r) {
  if (!r || !Number.isFinite(r.score) || !(r.price > 0)) return 'оценка или цена — не число';
  if (r.action === 'NEUTRAL') return null;
  const p = r.plan, z = p?.zone;
  if (!p || ![p.stop, p.t1, z?.[0], z?.[1]].every((x) => Number.isFinite(x) && x > 0)) return 'в плане сделки не числа';
  const ok = p.dir === 'BUY' ? p.stop < z[0] && z[0] <= z[1] && z[1] < p.t1 : p.t1 < z[0] && z[0] <= z[1] && z[1] < p.stop;
  return ok ? null : 'стоп, зона входа и цель расположены неправильно';
}

/** Категория письма о событии сделки Bybit */
export const TRADE_EVENT_CATEGORY = {
  closed: 'trade', tp1: 'trade-steps', trail: 'trade-steps',
  'sl-restored': 'critical', 'tp-restored': 'critical', orphans: 'critical', paused: 'critical', resumed: 'critical', offline: 'critical', online: 'critical',
};
