import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { MacroCalendar, nyToUtc } from '../lib/calendar.js';
import { TradeFlow } from '../lib/trades.js';
import { Journal } from '../lib/journal.js';
import { chartPng, chartSvg } from '../lib/chart.js';
import { Notifier } from '../lib/notifier.js';
import { analyze, decide } from '../lib/analyzer.js';
import { candlesFrom, rng } from './helpers.js';
import cfg from '../config.js';

test('Календарь: время ФРС и CPI с учётом летнего/зимнего времени США', () => {
  assert.equal(new Date(nyToUtc('2026-09-16', 14, 0)).toISOString(), '2026-09-16T18:00:00.000Z'); // летнее
  assert.equal(new Date(nyToUtc('2026-12-09', 14, 0)).toISOString(), '2026-12-09T19:00:00.000Z'); // зимнее
  assert.equal(new Date(nyToUtc('2027-03-10', 8, 30)).toISOString(), '2027-03-10T13:30:00.000Z'); // до перехода 14.03
  assert.equal(new Date(nyToUtc('2027-03-17', 14, 0)).toISOString(), '2027-03-17T18:00:00.000Z'); // после перехода
});

test('Календарь: окно риска до и после события, свои события из файла', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-'));
  const file = path.join(dir, 'events.json');
  const t = Date.UTC(2027, 5, 1, 12, 0);
  fs.writeFileSync(file, JSON.stringify([{ time: new Date(t).toISOString(), name: 'тестовое событие', impact: 3, before: 2, after: 1 }]));
  const c = new MacroCalendar(file);
  assert.equal(c.risk(t - 3 * 3600e3), null);
  const before = c.risk(t - 3600e3);
  assert.equal(before.phase, 'before');
  assert.equal(before.minutesTo, 60);
  assert.equal(c.risk(t + 30 * 60e3).phase, 'after');
  assert.equal(c.risk(t + 2 * 3600e3), null);
  const fomc = c.risk(nyToUtc('2026-12-09', 14, 0) - 2 * 3600e3);
  assert.equal(fomc.kind, 'fomc');
});

test('Фильтр макрособытий откладывает вход', () => {
  const base = { score: 0.5, agreement: 0.8, completeness: 1, regime: { thresholdAdj: 0 }, htf: 0.5, btcScore: 0.2, isBtc: false, badNews: null, plan: { rr: 2.5, rrNow: 2, zone: [99, 100] } };
  assert.equal(decide(base, cfg).action, 'BUY');
  const d = decide({ ...base, macro: { name: 'решение ФРС по ставке', minutesTo: 90, phase: 'before' } }, cfg);
  assert.equal(d.action, 'WATCH_BUY');
  assert.match(d.warnings[0], /через 1 ч 30 мин решение ФРС/);
});

test('Резкое движение: падение на объёме распознаётся, медленное — нет', () => {
  const f = new TradeFlow(cfg, {});
  f.setSymbols(['SOLUSDT'], new Map());
  f.setThresholdsFromTickers([{ symbol: 'SOLUSDT', quoteVolume: '600000000' }], []);
  const now = Date.now();
  const st = f.state('SOLUSDT');
  st.startedAt = now - 120 * 60e3;
  // 2 часа спокойной торговли около 100
  for (let m = 120; m >= 6; m--) f.handleTrade('spot', { s: 'SOLUSDT', p: String(100 + (m % 3) * 0.05), q: '50', T: now - m * 60e3, m: m % 2 === 0 });
  // за последние 5 минут — падение на 4% с огромным объёмом
  for (let k = 5; k >= 0; k--) for (let j = 0; j < 20; j++) f.handleTrade('spot', { s: 'SOLUSDT', p: String(100 - (5 - k) * 0.8), q: '400', T: now - k * 60e3 + j * 1000, m: true });
  for (const key of [...f.pending.keys()]) f.flush(key);
  const mv = f.detectMove('SOLUSDT', 0.008, cfg.move);
  assert.ok(mv, 'движение найдено');
  assert.ok(mv.change < -0.03);
  assert.ok(mv.volX > 2.5);
  assert.equal(f.detectMove('SOLUSDT', 0.05, cfg.move), null, 'при большом ATR то же движение — обычное');
  f.stop();
});

test('Журнал: после половины пути к цели 2 стоп подтягивается к цели 1', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-')), 'j.json');
  const j = new Journal(file, cfg);
  j.open({ symbol: 'X', price: 100, score: 0.5, confidence: 70, regime: { key: 'range' }, plan: { dir: 'BUY', zone: [99, 100], stop: 98, t1: 104, t2: 108 } });
  assert.equal(j.update(() => ({ hi: 104.2, lo: 100, last: 104 }))[0].type, 'tp1');
  const ev = j.update(() => ({ hi: 106.5, lo: 104, last: 106 }));
  assert.equal(ev[0].type, 'trail');
  assert.equal(j.openFor('X').stop, 104);
  const close = j.update(() => ({ hi: 105, lo: 103.5, last: 104 }));
  assert.equal(close[0].type, 'trail');
  assert.equal(close[0].r, 2, 'половина по цели 1 (+2R) и остаток по подтянутому стопу (+2R)');
});

test('График: корректный PNG нужного размера и SVG', () => {
  const r0 = rng(3);
  const closes = [100];
  for (let i = 1; i < 520; i++) closes.push(closes[i - 1] * (1 + (r0() - 0.5) * 0.02));
  const h1 = candlesFrom(closes, { wick: 0.4 });
  const res = analyze({ symbol: 'SOLUSDT', candles: { h1, h4: candlesFrom(closes.filter((_, i) => i % 4 === 0), { step: 4 * 3600e3 }) } }, cfg);
  res.action = 'WATCH_BUY';
  const png = chartPng(res, h1);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 760);
  assert.equal(png.readUInt32BE(20), 380);
  const idat = png.indexOf('IDAT');
  const len = png.readUInt32BE(idat - 4);
  const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + len));
  assert.equal(raw.length, (760 * 3 + 1) * 380);
  assert.match(chartSvg(res, h1), /^<svg[\s\S]*<\/svg>$/);
});

test('Склейка писем сохраняет вложения-графики', async () => {
  const c = structuredClone(cfg);
  Object.assign(c.notify.email, { to: 'a@b.c', user: 'u', pass: 'p' });
  c.notify.console = false;
  const n = new Notifier(c);
  const sent = [];
  n.mailer = { sendMail: async (m) => sent.push(m) };
  const foot = '<p data-cw-footer style="x">подпись</p>';
  n.enqueue({ subject: '🐋 A', text: 'a', html: `<html><body><img src="cid:1">${foot}</body></html>`, attachments: [{ cid: '1', content: Buffer.from('x') }] });
  n.enqueue({ subject: '⚡ B', text: 'b', html: `<html><body><img src="cid:2">${foot}</body></html>`, attachments: [{ cid: '2', content: Buffer.from('y') }] });
  clearTimeout(n.timer); n.timer = null;
  await n.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].attachments.map((a) => a.cid), ['1', '2']);
  assert.equal(sent[0].html.match(/подпись/g).length, 1, 'подпись только под последним уведомлением');
  assert.ok(sent[0].html.indexOf('cid:2') < sent[0].html.indexOf('подпись'));
});

test('«Готовиться» из очереди отменяется, если по монете уже пришёл сигнал', async () => {
  const c = structuredClone(cfg);
  Object.assign(c.notify.email, { to: 'a@b.c', user: 'u', pass: 'p' });
  c.notify.console = false;
  const n = new Notifier(c);
  const sent = [];
  n.mailer = { sendMail: async (m) => sent.push(m) };
  n.enqueue({ subject: '🟡 PEPE: готовиться', text: 'w', html: '<p>w</p>', key: 'watch:PEPEUSDT' });
  n.enqueue({ subject: '🐋 Кит купил BTC', text: 'k', html: '<p>k</p>' });
  assert.equal(n.drop('watch:PEPEUSDT'), 1);
  clearTimeout(n.timer); n.timer = null;
  await n.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Кит купил BTC/);
});

test('Письмо о резком движении: объём не показывается, пока нет 30 мин истории', async () => {
  const { moveMessage } = await import('../lib/report.js');
  const mv = { symbol: 'SOLUSDT', win: 5, change: -0.046, from: 98.8, to: 94.2, volX: 0.9, need: 0.032, hi: 99.3, lo: 94.2, enough: false };
  assert.doesNotMatch(moveMessage(mv, null).subject, /объём/);
  assert.match(moveMessage({ ...mv, volX: 3.4, enough: true }, null).subject, /\(объём ×3\.4\)/);
});
