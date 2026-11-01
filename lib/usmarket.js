// Биржа США (NYSE и Nasdaq): часы торгов, праздники и сокращённые дни.
// Основная сессия — 9:30–16:00 по Нью-Йорку: по Еревану это 17:30–24:00 летом и 18:30–01:00 зимой
// (переход на летнее время в США учитывается автоматически).
// Праздники и сокращённые дни — по официальному календарю NYSE на 2026–2028 годы.

const TZ = 'America/New_York';

export const HOLIDAYS = {
  '2026-01-01': 'Новый год', '2026-01-19': 'День Мартина Лютера Кинга', '2026-02-16': 'День президентов',
  '2026-04-03': 'Страстная пятница', '2026-05-25': 'День памяти', '2026-06-19': 'Джунтинс',
  '2026-07-03': 'День независимости', '2026-09-07': 'День труда', '2026-11-26': 'День благодарения', '2026-12-25': 'Рождество',
  '2027-01-01': 'Новый год', '2027-01-18': 'День Мартина Лютера Кинга', '2027-02-15': 'День президентов',
  '2027-03-26': 'Страстная пятница', '2027-05-31': 'День памяти', '2027-06-18': 'Джунтинс',
  '2027-07-05': 'День независимости', '2027-09-06': 'День труда', '2027-11-25': 'День благодарения', '2027-12-24': 'Рождество',
  '2028-01-17': 'День Мартина Лютера Кинга', '2028-02-21': 'День президентов', '2028-04-14': 'Страстная пятница',
  '2028-05-29': 'День памяти', '2028-06-19': 'Джунтинс', '2028-07-04': 'День независимости', '2028-09-04': 'День труда',
  '2028-11-23': 'День благодарения', '2028-12-25': 'Рождество',
};
// сокращённые дни: торги до 13:00 по Нью-Йорку
export const EARLY_CLOSE = { '2026-11-27': 780, '2026-12-24': 780, '2027-11-26': 780, '2028-07-03': 780, '2028-11-24': 780 };
export const CALENDAR_UNTIL = '2028-12-31';

const OPEN_MIN = 9 * 60 + 30, CLOSE_MIN = 16 * 60;
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtET = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});

/** Время по Нью-Йорку: дата YYYY-MM-DD, часы, минуты, день недели (0 — воскресенье) */
export function etParts(ts) {
  const p = Object.fromEntries(fmtET.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const h = +p.hour % 24, mi = +p.minute;
  return { date: `${p.year}-${p.month}-${p.day}`, y: +p.year, mo: +p.month, d: +p.day, h, mi, min: h * 60 + mi, dow: WD[p.weekday] };
}

/** Момент (UTC) для времени по Нью-Йорку: дата + минуты от полуночи */
export function etToUtc(date, minutes) {
  const [y, mo, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, 0, minutes); // то же время, как если бы оно было по UTC
  const offsetAt = (t) => { const p = etParts(t); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - t; }; // сдвиг Нью-Йорка от UTC
  let t = wall - offsetAt(wall);
  const o2 = offsetAt(t);
  if (wall - o2 !== t) t = wall - o2; // между двумя моментами сменилось летнее/зимнее время
  return t;
}

const addDays = (date, n) => {
  const [y, mo, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { date: t.toISOString().slice(0, 10), dow: t.getUTCDay() };
};

/** Торговая сессия дня (null — выходной или праздник) */
export function sessionOn(date) {
  const { dow } = addDays(date, 0);
  if (dow === 0 || dow === 6 || HOLIDAYS[date]) return null;
  const closeMin = EARLY_CLOSE[date] ?? CLOSE_MIN;
  return { date, open: etToUtc(date, OPEN_MIN), close: etToUtc(date, closeMin), early: closeMin < CLOSE_MIN };
}

/** Ближайшая сессия, которая ещё не закончилась (текущая, если торги идут) */
export function nextSession(now = Date.now()) {
  const today = etParts(now).date;
  for (let i = 0; i < 14; i++) {
    const s = sessionOn(addDays(today, i).date);
    if (s && s.close > now) return s;
  }
  return null;
}

/** Последняя сессия, которая началась до этого момента */
export function lastSession(now = Date.now()) {
  const today = etParts(now).date;
  for (let i = 0; i < 14; i++) {
    const s = sessionOn(addDays(today, -i).date);
    if (s && s.open <= now) return s;
  }
  return null;
}

/** Сессия после следующей: зона входа по акции живёт до закрытия следующего торгового дня */
export function sessionAfter(now = Date.now()) {
  const s = nextSession(now);
  return s ? nextSession(s.close + 1) : null;
}

/**
 * Состояние биржи: открыта ли она сейчас, когда закроется или откроется и почему закрыта.
 * @returns {{ open: boolean, opensAt?: number, closesAt?: number, early?: boolean, reason?: string, beyondCalendar: boolean }}
 */
export function marketStatus(now = Date.now()) {
  const p = etParts(now);
  const beyondCalendar = p.date > CALENDAR_UNTIL;
  const s = nextSession(now);
  if (s && s.open <= now) return { open: true, closesAt: s.close, early: s.early, beyondCalendar };
  const today = sessionOn(p.date);
  const reason = HOLIDAYS[p.date] ? `праздник в США (${HOLIDAYS[p.date]})`
    : p.dow === 0 || p.dow === 6 ? 'выходной'
      : today && now < today.open ? 'торги ещё не начались' : 'торги на сегодня закончились';
  return { open: false, opensAt: s?.open ?? null, reason, beyondCalendar };
}

