import test from 'node:test';
import assert from 'node:assert/strict';
import { marketStatus, nextSession, sessionOn, sessionAfter, etToUtc, etParts } from '../lib/usmarket.js';

const Z = (s) => Date.parse(s);

test('Биржа США: часы торгов с учётом летнего и зимнего времени', () => {
  // зимнее время (EST, UTC−5): 9:30 по Нью-Йорку = 14:30 UTC
  assert.equal(etToUtc('2026-11-02', 570), Z('2026-11-02T14:30:00Z'));
  // летнее время (EDT, UTC−4): 9:30 = 13:30 UTC
  assert.equal(etToUtc('2026-07-06', 570), Z('2026-07-06T13:30:00Z'));
  // дни перехода: 8 марта 2026 — на летнее, 1 ноября 2026 — на зимнее
  assert.equal(sessionOn('2026-03-06').open, Z('2026-03-06T14:30:00Z'));
  assert.equal(sessionOn('2026-03-09').open, Z('2026-03-09T13:30:00Z'));
  assert.equal(sessionOn('2026-10-30').close, Z('2026-10-30T20:00:00Z'));
  assert.equal(sessionOn('2026-11-02').close, Z('2026-11-02T21:00:00Z'));
  assert.deepEqual(etParts(Z('2026-11-02T15:00:00Z')).min, 600);
});

test('Биржа США: открыта, ещё не открылась, выходной, праздник, сокращённый день', () => {
  const open = marketStatus(Z('2026-11-02T15:00:00Z')); // понедельник, 10:00 по Нью-Йорку
  assert.equal(open.open, true);
  assert.equal(open.closesAt, Z('2026-11-02T21:00:00Z'));
  const early = marketStatus(Z('2026-11-02T14:29:00Z'));
  assert.equal(early.open, false);
  assert.equal(early.reason, 'торги ещё не начались');
  assert.equal(early.opensAt, Z('2026-11-02T14:30:00Z'));
  const sat = marketStatus(Z('2026-10-31T16:00:00Z'));
  assert.equal(sat.reason, 'выходной');
  assert.equal(sat.opensAt, Z('2026-11-02T14:30:00Z'));
  const after = marketStatus(Z('2026-10-30T21:00:00Z'));
  assert.equal(after.reason, 'торги на сегодня закончились');
  const thanks = marketStatus(Z('2026-11-26T16:00:00Z'));
  assert.match(thanks.reason, /праздник в США \(День благодарения\)/);
  assert.equal(thanks.opensAt, Z('2026-11-27T14:30:00Z'));
  const short = marketStatus(Z('2026-11-27T17:00:00Z'));
  assert.equal(short.open, true);
  assert.equal(short.early, true);
  assert.equal(short.closesAt, Z('2026-11-27T18:00:00Z'), 'в пятницу после Дня благодарения — до 13:00');
  assert.equal(sessionOn('2026-07-03'), null, 'День независимости (перенесён на пятницу)');
  assert.equal(sessionOn('2027-03-26'), null, 'Страстная пятница 2027');
  assert.equal(marketStatus(Z('2029-01-03T15:00:00Z')).beyondCalendar, true);
});

test('Биржа США: следующая сессия', () => {
  assert.equal(nextSession(Z('2026-12-24T19:00:00Z')).date, '2026-12-28', 'после сокращённого 24.12 и Рождества — понедельник');
  assert.equal(sessionAfter(Z('2026-10-30T19:00:00Z')).date, '2026-11-02', 'зона, найденная в пятницу, живёт до закрытия понедельника');
});
