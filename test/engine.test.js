import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../lib/plan.js';
import { Journal } from '../lib/journal.js';
import { analyze, decide } from '../lib/analyzer.js';
import { Notifier } from '../lib/notifier.js';
import { fmt, fmtUsd, pct } from '../lib/format.js';
import { candlesFrom, rng } from './helpers.js';
import cfg from '../config.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const zone = (low, high, strength, side, price, atr, kinds = ['poc']) => ({ low, high, price: (low + high) / 2, strength, side, kinds, sources: ['тест'], dist: side === 'support' ? price - high : low - price, distAtr: (side === 'support' ? price - high : low - price) / atr });

test('План покупки: вход в зоне поддержки, стоп за зоной и за скоплением стопов, цели у сопротивлений', () => {
  const price = 100, atr = 1;
  const levels = {
    inside: [],
    supports: [zone(98.5, 99.2, 2.5, 'support', price, atr)],
    resistances: [zone(103, 103.5, 2.0, 'resistance', price, atr), zone(106, 106.4, 1.5, 'resistance', price, atr)],
    pools: [{ side: 'low', price: 98.1 }],
  };
  const p = buildPlan({ dir: 'BUY', price, atr, levels, risk: { feePct: 0.2, deposit: 1000, riskPct: 1 } });
  assert.deepEqual(p.zone.map((x) => +x.toFixed(2)), [98.5, 99.35]);
  assert.ok(p.stop < 98.1, `стоп ниже скопления стопов: ${p.stop}`);
  assert.ok(Math.abs(p.t1 - 102.95) < 0.01 && Math.abs(p.t2 - 105.95) < 0.01);
  assert.ok(p.rr > p.rrNow, 'от зоны выгоднее, чем от текущей цены');
  assert.ok(Math.abs(p.size.riskUsd - 10) < 1e-9);
  assert.ok(p.size.qty > 0);
});

test('Зона только из круглых чисел не годится в опору плана', () => {
  const price = 100, atr = 1;
  const levels = { inside: [], supports: [zone(99, 99.2, 3, 'support', price, atr, ['round'])], resistances: [], pools: [] };
  const p = buildPlan({ dir: 'BUY', price, atr, levels });
  assert.equal(p.anchor, null);
});

test('Журнал: цель 1 → безубыток; стоп раньше цели при одновременном касании; статистика', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-')), 'j.json');
  const j = new Journal(file, cfg);
  const r = { symbol: 'BTCUSDT', price: 100, score: 0.5, confidence: 70, regime: { key: 'trend_up' }, plan: { dir: 'BUY', zone: [99, 100], stop: 98, t1: 104, t2: 108 } };
  j.open(r);
  let ev = j.update(() => ({ hi: 104.5, lo: 99.5, last: 104 }));
  assert.equal(ev[0].type, 'tp1');
  assert.equal(j.openFor('BTCUSDT').stop, 100, 'стоп перенесён в безубыток');
  ev = j.update(() => ({ hi: 101, lo: 99.9, last: 100 }));
  assert.equal(ev[0].type, 'breakeven');
  assert.equal(ev[0].r, 1, 'половина по цели 1 (+2R) и половина в ноль = +1R');
  j.open({ ...r, symbol: 'ETHUSDT' });
  ev = j.update((s) => (s === 'ETHUSDT' ? { hi: 105, lo: 97, last: 100 } : null));
  assert.equal(ev[0].type, 'stop', 'если задеты и стоп, и цель — считаем стоп');
  const st = j.stats(30);
  assert.equal(st.closed, 2);
  assert.equal(st.wins, 1);
  assert.equal(st.losses, 1);
});

function market(n, seed, drift = 0) {
  const r = rng(seed);
  const closes = [100];
  for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + drift + (r() - 0.5) * 0.02));
  return closes;
}

test('Анализ на синтетических данных: оценка в пределах, план и причины на месте', () => {
  const h1 = candlesFrom(market(520, 7, 0.0008), { wick: 0.4 });
  const h4 = candlesFrom(market(520, 8, 0.002), { step: 4 * 3600e3, wick: 1 });
  const d1 = candlesFrom(market(400, 9, 0.003), { step: 86400e3, wick: 2 });
  const m15 = candlesFrom(market(420, 10, 0.0002), { step: 900e3, wick: 0.2 });
  const r = analyze({ symbol: 'SOLUSDT', candles: { m15, h1, h4, d1 } }, cfg);
  assert.ok(Number.isFinite(r.score) && Math.abs(r.score) <= 1);
  assert.ok(['BUY', 'SELL', 'WATCH_BUY', 'WATCH_SELL', 'NEUTRAL'].includes(r.action));
  assert.ok(r.plan.stop > 0 && r.plan.t1 > 0);
  assert.ok(r.blocks.derivatives.disabled, 'без фьючерсных данных блок выключен');
  for (const [k, b] of Object.entries(r.blocks)) if (!b.disabled) assert.ok(Number.isFinite(b.score), `блок ${k}`);
  const w = Object.values(r.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(w - 1) < 1e-9, 'веса нормированы');
});

test('Решение: порог, согласие блоков, старший тренд, прибыль/риск', () => {
  const plan = { rr: 2.5, rrNow: 2, zone: [99, 100] };
  const base = { score: 0.4, agreement: 0.8, completeness: 1, regime: { thresholdAdj: 0 }, htf: 0.5, btcScore: 0.2, isBtc: false, badNews: null, plan };
  assert.equal(decide(base, cfg).action, 'BUY');
  assert.equal(decide({ ...base, score: 0.25 }, cfg).action, 'WATCH_BUY');
  assert.equal(decide({ ...base, score: 0.1 }, cfg).action, 'NEUTRAL');
  assert.equal(decide({ ...base, agreement: 0.3 }, cfg).action, 'WATCH_BUY');
  assert.equal(decide({ ...base, htf: -0.8 }, cfg).action, 'WATCH_BUY', 'против старшего тренда нужна оценка сильнее');
  assert.equal(decide({ ...base, htf: -0.8, score: 0.5 }, cfg).action, 'BUY');
  const lowRR = decide({ ...base, plan: { rr: 2, rrNow: 1.1, zone: [99, 100] } }, cfg);
  assert.equal(lowRR.action, 'WATCH_BUY');
  assert.equal(lowRR.zoneOk, true);
  const noRoom = decide({ ...base, plan: { rr: 1.2, rrNow: 1.1, zone: [99, 100] } }, cfg);
  assert.equal(noRoom.zoneOk, false, 'если и от зоны невыгодно — зону не ждём');
  assert.equal(decide({ ...base, score: -0.4, htf: -0.5 }, cfg).action, 'SELL');
});

test('Уведомления: обычные склеиваются в одно письмо, срочные уходят сразу с SMS', async () => {
  const c = structuredClone(cfg);
  Object.assign(c.notify.email, { to: 'a@b.c', user: 'u', pass: 'p' });
  Object.assign(c.notify.sms, { to: '+1', from: '+2', accountSid: 'AC', authToken: 't' });
  c.notify.console = false;
  const n = new Notifier(c);
  const sent = [];
  n.mailer = { sendMail: async (m) => sent.push(m) };
  const sms = [];
  n.sms = async (t) => { sms.push(t); return true; };
  n.enqueue({ subject: '🐋 Кит купил BTC', text: 'a', html: '<html><body>A</body></html>' });
  n.enqueue({ subject: '🟡 ETH: готовиться', text: 'b', html: '<html><body>B</body></html>' });
  clearTimeout(n.timer); n.timer = null;
  await n.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /2 уведомления/);
  assert.match(sent[0].html, /A[\s\S]*B/);
  await n.urgent({ subject: '🟢 ПОКУПКА', text: 't', html: '<p>x</p>', smsText: 'BUY X' });
  assert.equal(sent.length, 2);
  assert.deepEqual(sms, ['BUY X']);
});

test('Форматирование цен и сумм', () => {
  assert.equal(fmt(110234.5), '110 234.50');
  assert.equal(fmt(0.0000008911), '0.0000008911');
  assert.equal(fmtUsd(3.4e12), '$3.40T');
  assert.equal(fmtUsd(-1.5e6, { sign: true }), '−$1.50M');
  assert.equal(pct(0.0123, 1), '+1.2%');
});
