// Макрокалендарь США — события, вокруг которых крипта резко двигается:
//   • решение ФРС по ставке (FOMC) — 14:00 по Нью-Йорку во второй день заседания;
//   • инфляция CPI и отчёт о занятости NFP — 8:30 по Нью-Йорку.
// Даты — из официальных расписаний ФРС и BLS на 2026–2027 годы. Время переводится в UTC
// с учётом перехода США на летнее время. Свои события можно добавить в data/events.json:
//   [{ "time": "2026-12-18T13:30:00Z", "name": "PCE", "impact": 2 }]
import fs from 'node:fs';

const FOMC = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08'];
const CPI = ['2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-12', '2026-09-11',
  '2026-10-14', '2026-11-10', '2026-12-10', '2027-01-13', '2027-02-11', '2027-03-10', '2027-04-13', '2027-05-12', '2027-06-10',
  '2027-07-14', '2027-08-11', '2027-09-14', '2027-10-14', '2027-11-10', '2027-12-10'];
const NFP = ['2026-01-09', '2026-02-11', '2026-03-06', '2026-04-03', '2026-05-08', '2026-06-05', '2026-07-02', '2026-08-07', '2026-09-04',
  '2026-10-02', '2026-11-06', '2026-12-04', '2027-01-08', '2027-02-05', '2027-03-05', '2027-04-02', '2027-05-07', '2027-06-04',
  '2027-07-02', '2027-08-06', '2027-09-03', '2027-10-08', '2027-11-05', '2027-12-03'];

export const KINDS = {
  fomc: { name: 'решение ФРС по ставке', impact: 3, before: 3, after: 2, at: [14, 0] },
  cpi: { name: 'инфляция в США (CPI)', impact: 2, before: 1.5, after: 1, at: [8, 30] },
  nfp: { name: 'отчёт о занятости в США (NFP)', impact: 2, before: 1.5, after: 1, at: [8, 30] },
};

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Время по Нью-Йорку → UTC (летнее/зимнее время определяется автоматически) */
export function nyToUtc(date, hh, mm) {
  const [y, m, d] = date.split('-').map(Number);
  for (const off of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, hh + off, mm);
    const p = Object.fromEntries(NY.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (+p.day === d && +p.hour % 24 === hh && +p.minute === mm) return t;
  }
  return Date.UTC(y, m - 1, d, hh + 5, mm);
}

function builtIn() {
  const out = [];
  for (const [kind, dates] of [['fomc', FOMC], ['cpi', CPI], ['nfp', NFP]]) {
    const k = KINDS[kind];
    for (const d of dates) out.push({ id: `${kind}-${d}`, kind, name: k.name, impact: k.impact, before: k.before, after: k.after, t: nyToUtc(d, ...k.at) });
  }
  return out;
}

export class MacroCalendar {
  constructor(file) {
    this.file = file;
    this.base = builtIn();
    this.user = [];
    this.loadedAt = 0;
    this.reload();
  }

  reload() {
    this.loadedAt = Date.now();
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.user = (Array.isArray(raw) ? raw : []).map((e, i) => ({
        id: `user-${i}-${e.time}`, kind: 'user', name: String(e.name || 'событие'), impact: Number(e.impact) || 2,
        before: Number(e.before) || 1.5, after: Number(e.after) || 1, t: Date.parse(e.time),
      })).filter((e) => Number.isFinite(e.t));
    } catch { this.user = []; }
  }

  all() {
    if (Date.now() - this.loadedAt > 3600e3) this.reload();
    return [...this.base, ...this.user].sort((a, b) => a.t - b.t);
  }

  upcoming(now = Date.now(), hours = 168) {
    return this.all().filter((e) => e.t >= now && e.t <= now + hours * 3600e3);
  }

  /** Событие, рядом с которым мы сейчас находимся (до или после), — самое важное из таких */
  risk(now = Date.now()) {
    const near = this.all().filter((e) => now >= e.t - e.before * 3600e3 && now <= e.t + e.after * 3600e3);
    if (!near.length) return null;
    const e = near.sort((a, b) => b.impact - a.impact || Math.abs(a.t - now) - Math.abs(b.t - now))[0];
    return { id: e.id, kind: e.kind, name: e.name, impact: e.impact, t: e.t, minutesTo: Math.round((e.t - now) / 60e3), phase: now < e.t ? 'before' : 'after' };
  }

  next(now = Date.now()) {
    return this.all().find((e) => e.t >= now) ?? null;
  }
}
