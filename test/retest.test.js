// v2.8 — вход на ретесте: уровень для входа, касание, подтверждение 15-минутной свечой, стоп за ретестом,
// отмена, когда уровень не удержался; план без «зоны у текущей цены»; бэктест-логика та же, что у программы.
import test from 'node:test';
import assert from 'node:assert/strict';
import cfg from '../config.js';
import { levelRole, isConfirmation, confirmRetest, retestFailed, retestPlan, retestStep, retestEntry, touches, levelText, M15 } from '../lib/entry.js';
import { buildPlan } from '../lib/plan.js';
import { decide } from '../lib/analyzer.js';
import { candlesFrom, leg } from './helpers.js';

const H = 3600e3;
const T0 = Date.UTC(2026, 10, 2); // 2 ноября 2026, 00:00 UTC
const zone = (low, high, strength, side, price, atr, kinds = ['poc']) => ({ low, high, price: (low + high) / 2, strength, side, kinds, sources: ['тест'], dist: side === 'support' ? price - high : side === 'resistance' ? low - price : 0, distAtr: (side === 'support' ? price - high : side === 'resistance' ? low - price : 0) / atr });
const candle = (time, open, high, low, close) => ({ time, open, high, low, close, volume: 100, closeTime: time + M15 - 1 });
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('Роль уровня: пробитое сопротивление, обычная поддержка, «не с той стороны»', () => {
  // 30 часов под уровнем 100–101, пробой вверх и 5 часов выше
  const h1 = candlesFrom([...Array(30).fill(99), 101.6, 102, 102.4, 102.2, 102.5, 102.8], { start: T0 });
  const r = levelRole({ low: 100, high: 101 }, 'BUY', h1);
  assert.equal(r.role, 'breakout');
  assert.equal(r.brokeAt, T0 + 30 * H, 'время свечи пробоя');
  assert.equal(r.age, 5);
  assert.equal(levelRole({ low: 95, high: 96 }, 'BUY', h1).role, 'level', 'цена всё время выше — обычная поддержка');
  // цена подходит к уровню снизу: последнее закрытие вне уровня было ниже — для покупки это сопротивление
  const fromBelow = candlesFrom([...Array(20).fill(103), ...leg(103, 99, 8), 100.4, 100.6], { start: T0 });
  assert.equal(levelRole({ low: 100, high: 101 }, 'BUY', fromBelow).role, 'against');
  assert.equal(levelRole({ low: 100, high: 101 }, 'SELL', fromBelow).role, 'breakout', 'для продажи тот же уровень — пробитая поддержка');
  assert.equal(levelRole({ low: 100, high: 101 }, 'BUY', candlesFrom(Array(10).fill(100.5))).role, null, 'всё время внутри — роль не ясна');
  assert.equal(levelRole({ low: 100, high: 101 }, 'BUY', []).role, 'level', 'без истории — обычный уровень');
  // пробой давнее 72 часов — уже обычная поддержка
  const old = candlesFrom([...Array(10).fill(99), ...Array(80).fill(103)], { start: T0 });
  assert.equal(levelRole({ low: 100, high: 101 }, 'BUY', old).role, 'level');
  // боковик: цена дважды прошла уровень туда и обратно — это не уровень
  const chop = candlesFrom([99, 102, 99, 102, 99, 102.5, 102.8], { start: T0 });
  assert.deepEqual(levelRole({ low: 100, high: 101 }, 'BUY', chop), { role: null, chop: true });
  assert.equal(levelRole({ low: 100, high: 101 }, 'BUY', candlesFrom([99, 102, 99, 102.5], { start: T0 })).role, 'breakout', 'ложный пробой и новый — ещё пробой');
  // объём свечи пробоя к среднему
  const vol = h1.map((c, i) => ({ ...c, volume: i === 30 ? 300 : 100 }));
  assert.ok(near(levelRole({ low: 100, high: 101 }, 'BUY', vol).volRatio, 3));
});

test('Подтверждение ретеста: свеча от уровня в сторону сделки, не вдогонку', () => {
  const z = { dir: 'BUY', level: { low: 100, high: 101 }, low: 100, high: 101.15, atr: 1 };
  const t = T0;
  assert.equal(isConfirmation(z, candle(t, 100.6, 101.2, 99.9, 101.05)), true, 'растущая свеча с закрытием над серединой и в верхней половине');
  assert.equal(isConfirmation(z, candle(t, 101.4, 101.5, 99.8, 101.3)), true, 'падающая, но закрылась над уровнем с длинной нижней тенью');
  assert.equal(isConfirmation(z, candle(t, 100.8, 100.9, 100.1, 100.3)), false, 'закрылась ниже середины уровня');
  assert.equal(isConfirmation(z, candle(t, 100.2, 101.3, 100.1, 100.6)), false, 'закрытие в нижней половине свечи');
  assert.equal(isConfirmation(z, candle(t, 100.4, 101.9, 100.2, 101.8)), false, 'дальше 0.6 ATR над уровнем — вход был бы вдогонку');
  assert.equal(isConfirmation(z, candle(t, 100.4, 101.3, 100.2, 100.45)), false, 'почти без движения от уровня (ниже середины)');
  const s = { dir: 'SELL', level: { low: 100, high: 101 }, low: 99.85, high: 101, atr: 1 };
  assert.equal(isConfirmation(s, candle(t, 100.4, 101.1, 99.8, 99.95)), true, 'продажа — зеркально');
  assert.equal(isConfirmation(s, candle(t, 100.2, 100.9, 100.1, 100.7)), false);
  // касание: для покупки — до верха зоны (с запасом 0.05 ATR), для продажи — до низа
  assert.equal(touches(z, 101.2), true);
  assert.equal(touches(z, 101.3), false);
  assert.equal(touches(s, 99.8), true);
  assert.equal(touches(s, 99.7), false);
});

test('Подтверждение по закрытым 15-минутным свечам с момента касания; экстремум ретеста — для стопа', () => {
  const touchedAt = T0 + 10 * 60e3; // касание в 00:10
  const z = { dir: 'BUY', level: { low: 100, high: 101 }, low: 100, high: 101.15, atr: 1, touchedAt, touchExt: 100.9 };
  const m15 = [
    candle(T0 - M15, 102, 102.2, 101.6, 101.7),     // до касания — не считается
    candle(T0, 101.7, 101.8, 100.3, 100.5),         // 00:00 — касание, закрылась у середины, падающая
    candle(T0 + M15, 100.5, 101.25, 100.1, 101.1),  // 00:15 — растущая, закрылась над уровнем: подтверждение
    candle(T0 + 2 * M15, 101.1, 101.2, 100.9, 101), // 00:30 — ещё не закрыта
  ];
  const wait = confirmRetest(z, m15, { now: T0 + M15 + 60e3 });
  assert.equal(wait.ok, false, 'в 00:16 последняя закрытая — 00:00, без разворота');
  assert.match(wait.why, /без разворота/);
  const ok = confirmRetest(z, m15, { now: T0 + 2 * M15 + 5e3 });
  assert.equal(ok.ok, true);
  assert.equal(ok.candle.time, T0 + M15);
  assert.equal(ok.ext, 100.1, 'минимум ретеста — по всем свечам с касания');
  assert.match(ok.why, /отскок от уровня 100\.00–101\.00: цена опускалась до 100\.10, 15-минутная свеча \d\d:\d\d закрылась на 101\.10/);
  assert.match(confirmRetest({ ...z, touchedAt: T0 + 3 * M15 }, m15, { now: T0 + 3 * M15 + 60e3 }).why, /жду закрытия 15-минутной свечи/);
  // закрылась ниже уровня — ждём, удержится ли (часовая свеча решит)
  const below = confirmRetest(z, [candle(T0, 100.5, 100.6, 99.5, 99.7)], { now: T0 + M15 + 5e3 });
  assert.equal(below.below, true);
  // отскочила слишком далеко без подтверждения — новое касание
  const away = confirmRetest(z, [candle(T0, 100.4, 102.4, 100.2, 102.3)], { now: T0 + M15 + 5e3 });
  assert.equal(away.away, true);
  assert.match(away.why, /вдогонку/);
});

test('Уровень не удержался: часовая свеча после касания закрылась за ним', () => {
  const z = { dir: 'BUY', level: { low: 100, high: 101 }, atr: 1, touchedAt: T0 + 30 * 60e3 };
  const h1 = candlesFrom([102, 99.7], { start: T0 - H, wick: 0.1 });
  assert.match(retestFailed(z, h1, { now: T0 + H + 1000 }), /^уровень 100\.00–101\.00 не удержался: часовая свеча закрылась ниже \(99\.70+\)$/);
  assert.equal(retestFailed(z, h1, { now: T0 + 50 * 60e3 }), null, 'часовая свеча ещё не закрылась');
  assert.equal(retestFailed(z, candlesFrom([102, 100.5], { start: T0 - H }), { now: T0 + H + 1000 }), null, 'закрылась внутри уровня — держится');
  assert.equal(retestFailed({ ...z, touchedAt: null }, h1, { now: T0 + 2 * H }), null, 'без касания не проверяется');
  // старые закрытия под уровнем (до пробоя и касания) не в счёт
  assert.equal(retestFailed(z, candlesFrom([98, 98.5, 102], { start: T0 - 2 * H }), { now: T0 + H + 1000 }), null);
});

test('План входа на ретесте: стоп за минимумом ретеста, прибыль/риск — от текущей цены', () => {
  const plan = { dir: 'BUY', zone: [99, 100], entry: 99.5, stop: 99.6, t1: 104, t2: 106, rr: 3, rrNow: 2, notes: [], size: null };
  const z = { dir: 'BUY', low: 100, high: 101.15, stop: 99.7, atr: 1 };
  const p = retestPlan(plan, z, { price: 101, ext: 99.8, atr: 1, risk: { feePct: 0 } });
  assert.deepEqual(p.zone, [100, 101.15], 'зона — та, которую ждали');
  assert.ok(near(p.stop, 99.6), 'стоп — на 0.2 ATR за минимумом ретеста');
  assert.ok(near(p.rrNow, 3 / 1.4), `прибыль/риск от цены 101: ${p.rrNow}`);
  assert.match(p.notes.at(-1), /за минимумом ретеста 99\.80/);
  assert.equal(retestPlan(plan, z, { price: 101, ext: 100.5, atr: 1 }).stop, 99.7, 'ретест неглубокий — стоп зоны');
  const sp = retestPlan({ ...plan, dir: 'SELL', t1: 96 }, { dir: 'SELL', low: 99, high: 100, stop: 100.3, atr: 1 }, { price: 99.2, ext: 100.2, atr: 1, risk: { feePct: 0 } });
  assert.ok(near(sp.stop, 100.4), 'продажа — за максимумом ретеста');
});

test('Живая проверка: касание → ожидание закрытия 15-минутной свечи → проверка; ушла — новое касание', () => {
  const z = { dir: 'BUY', level: { low: 100, high: 101 }, low: 100, high: 101.15, atr: 1, touchedAt: null };
  const t = T0 + 3 * 60e3;
  assert.equal(retestStep(z, { now: t, price: 102 }), 'wait');
  assert.equal(retestStep(z, { now: t + 5e3, price: 101.5, lo: 101.1, hi: 101.6 }), 'touch', 'минимум между проверками дошёл до зоны');
  assert.equal(z.touchExt, 101.1);
  assert.equal(retestStep(z, { now: t + 10e3, price: 100.6, lo: 100.4 }), 'hold', 'свеча ещё не закрылась');
  assert.equal(z.touchExt, 100.4);
  assert.equal(retestStep(z, { now: T0 + M15 + 2e3, price: 100.8 }), 'hold', 'через 2 с после закрытия — рано, биржа может не отдать свечу');
  assert.equal(retestStep(z, { now: T0 + M15 + 6e3, price: 100.8 }), 'check');
  assert.equal(retestStep(z, { now: T0 + M15 + 11e3, price: 100.9 }), 'hold', 'одна проверка на свечу');
  assert.equal(retestStep(z, { now: T0 + 2 * M15 + 6e3, price: 101 }), 'check');
  assert.equal(retestStep(z, { now: T0 + 2 * M15 + 20e3, price: 102.2 }), 'away', 'ушла дальше ATR без подтверждения');
  assert.equal(z.touchedAt, null);
  assert.equal(retestStep(z, { now: T0 + 3 * M15, price: 101.1 }), 'touch', 'вернулась — новое касание');
});

test('Решение по ретесту: вход, ожидание, отказ анализа, провал уровня', () => {
  const touchedAt = T0 + 5 * 60e3;
  const z = { dir: 'BUY', level: { low: 100, high: 101, role: 'breakout' }, low: 100, high: 101.15, stop: 99.7, atr: 1, touchedAt, touchExt: 100.4 };
  const m15 = [candle(T0, 101.3, 101.4, 100.4, 100.7), candle(T0 + M15, 100.7, 101.3, 100.6, 101.2)];
  const r = { price: 101.2, score: 0.4, threshold: 0.3, vetoes: [], stats: { atr: 1 }, regime: { stopMult: 1 }, plan: { dir: 'BUY', zone: [100, 101.15], entry: 100.6, stop: 99.7, t1: 105, t2: 107, rr: 4, rrNow: 2.5, notes: [] } };
  const h1 = candlesFrom([102, 101.2], { start: T0 - H, wick: 0.1 });
  const opts = { m15, h1, minRR: 1.5, triggerRatio: 0.7, risk: { feePct: 0 } };
  const d = retestEntry(z, r, { ...opts, now: T0 + 2 * M15 + 5e3 });
  assert.equal(d.kind, 'entry');
  assert.ok(near(d.plan.stop, 99.7), 'стоп зоны (ретест неглубокий)');
  assert.equal(d.retest.level.role, 'breakout');
  assert.equal(retestEntry(z, r, { ...opts, now: T0 + M15 + 5e3 }).kind, 'wait', 'первая свеча — без разворота');
  assert.equal(retestEntry(z, { ...r, score: 0.15 }, { ...opts, now: T0 + 2 * M15 + 5e3 }).code, 'weak', 'анализ ослаб — вход не пускает');
  assert.equal(retestEntry(z, { ...r, vetoes: ['через 2 ч FOMC'] }, { ...opts, now: T0 + 2 * M15 + 5e3 }).code, 'veto');
  const flip = retestEntry(z, { ...r, score: -0.35 }, { ...opts, now: T0 + 2 * M15 + 5e3 });
  assert.equal(flip.kind, 'no');
  assert.equal(flip.flip, true, 'оценка развернулась — зона снимается');
  assert.equal(retestEntry(z, { ...r, plan: { ...r.plan, t1: 101.1 } }, { ...opts, now: T0 + 2 * M15 + 5e3 }).kind, 'no', 'цель у самого уровня');
  const failH1 = candlesFrom([102, 99.6], { start: T0 - H, wick: 0.1 });
  assert.equal(retestEntry(z, r, { ...opts, h1: failH1, now: T0 + H + 5e3 }).kind, 'fail');
});

test('План: вход от пробитого уровня, а не «вдогонку»; уровень с другой стороны не годится', () => {
  const atr = 1, price = 103;
  // пробой сопротивления 100–101: 30 часов под ним, потом рывок до 103
  const h1 = candlesFrom([...Array(30).fill(99.2), ...leg(99.2, 103, 6)], { start: T0 });
  const broken = zone(100, 101, 1.6, 'support', price, atr);
  const deeper = zone(97, 97.6, 2.5, 'support', price, atr);
  const levels = { inside: [], supports: [broken, deeper], resistances: [zone(106, 106.5, 2, 'resistance', price, atr)], pools: [] };
  const p = buildPlan({ dir: 'BUY', price, atr, levels, h1 });
  assert.equal(p.entryType, 'retest');
  assert.deepEqual(p.zone, [100, 101.15], 'зона — пробитый уровень и 0.15 ATR над ним, а не текущая цена');
  assert.equal(p.level.role, 'breakout');
  assert.ok(p.stop < 100, 'стоп — под уровнем');
  assert.ok(p.rrNow < p.rr, 'от текущей цены вход хуже — ждём ретест');

  // как в 2.7: опоры в 2.5 ATR нет — зона у текущей цены
  const far = { inside: [], supports: [zone(99, 99.5, 2.5, 'support', price, atr)], resistances: levels.resistances, pools: [] };
  const legacy = buildPlan({ dir: 'BUY', price, atr, levels: far, h1, mode: 'legacy' });
  assert.equal(legacy.entryType, 'legacy');
  assert.deepEqual(legacy.zone, [102.5, 103], 'старый план покупал «вдогонку» у текущей цены');
  const none = buildPlan({ dir: 'BUY', price, atr, levels: { ...far, supports: [zone(94, 94.5, 2.5, 'support', price, atr)] }, h1 });
  assert.equal(none.entryType, 'none', 'новый — уровня рядом нет, точки входа нет');
  assert.equal(none.level, null);
  assert.match(none.notes.join(' '), /вдогонку не вхожу/);
  assert.equal(buildPlan({ dir: 'BUY', price, atr, levels: far, h1 }).level.low, 99, 'сильная поддержка в 3.5 ATR — годится для ретеста');

  // цена внутри зоны, пришла снизу: для покупки это сопротивление — опора ниже
  const up = candlesFrom([...Array(20).fill(98), ...leg(98, 100.5, 5)], { start: T0 });
  const inside = { ...zone(100, 101, 2, 'inside', 100.5, atr), dist: 0 };
  const below = zone(98.6, 99.1, 1.6, 'support', 100.5, atr);
  const lv = { inside: [inside], supports: [below], resistances: [zone(104, 104.5, 2, 'resistance', 100.5, atr)], pools: [] };
  const q = buildPlan({ dir: 'BUY', price: 100.5, atr, levels: lv, h1: up });
  assert.equal(q.level.low, 98.6, 'не покупаем «в сопротивление» — ждём поддержку ниже');
  assert.equal(buildPlan({ dir: 'BUY', price: 100.5, atr, levels: lv, h1: up, mode: 'legacy' }).anchor.low, 100, 'старый план брал зону, в которую цена упирается');
});

test('Решение: без уровня для ретеста сильный сигнал не входит вдогонку', () => {
  const plan = { dir: 'BUY', zone: [102.5, 103], stop: 101.5, t1: 106, rr: 2, rrNow: 2, entryType: 'none', level: null };
  const core = { score: 0.5, agreement: 0.8, completeness: 1, regime: { thresholdAdj: 0 }, htf: 0.5, btcScore: 0.3, isBtc: false, badNews: null, macro: null, plan };
  const d = decide(core, cfg);
  assert.equal(d.action, 'WATCH_BUY');
  assert.equal(d.zoneOk, false, 'зону не ждём — уровня нет');
  assert.match(d.reason, /нет уровня.*вдогонку не вхожу/);
  const ok = decide({ ...core, plan: { ...plan, entryType: 'retest', level: { low: 100, high: 101 } } }, cfg);
  assert.equal(ok.action, 'BUY');
  assert.equal(decide({ ...core, plan: { ...plan, entryType: 'legacy' } }, cfg).action, 'BUY', 'как в 2.7 (touch, signal) — без этого правила');
});

test('Тексты: уровень для ретеста', () => {
  assert.match(levelText({ role: 'breakout', low: 148.5, high: 149.8, brokeAt: Date.UTC(2026, 10, 5, 10), volRatio: 1.8 }, 'BUY'), /^пробитое сопротивление 148\.50–149\.80 \(пробой 05\.11 \d\d:00, на объёме ×1\.8\)$/);
  assert.match(levelText({ role: 'breakout', brokeAt: Date.UTC(2026, 10, 5, 10), volRatio: 0.6 }, 'SELL'), /пробитая поддержка.*без объёма — осторожно/);
  assert.equal(levelText({ role: 'level' }, 'BUY'), 'поддержка');
  assert.equal(levelText({ role: 'level', low: 97.85, high: 97.85 }, 'BUY'), 'поддержка 97.8500', 'уровень из одной цены — одним числом');
  assert.equal(levelText({ role: 'level' }, 'SELL'), 'сопротивление');
});

test('Письмо о входе на ретесте: тема, заголовок, строка «Вход», SMS', async () => {
  const { signalSubject, signalText, signalHtml, smsText } = await import('../lib/report.js');
  const level = { low: 148.5, high: 149.8, role: 'breakout', brokeAt: Date.UTC(2026, 10, 5, 10), volRatio: 2.1 };
  const r = {
    symbol: 'SOLUSDT', kind: 'crypto', action: 'BUY', price: 150.1, score: 0.42, threshold: 0.3, confidence: 71, confidenceLabel: 'средняя', agreement: 0.7,
    regime: { label: 'восходящий тренд' }, stats: { change1h: 0.002, change24h: 0.03, change7d: 0.08, volume24h: 6e8 }, time: Date.UTC(2026, 10, 6, 9),
    plan: { dir: 'BUY', zone: [148.5, 150], entry: 149.25, stop: 147.6, t1: 156, t2: 160, t3: null, rr: 2.9, rrNow: 2.4, notes: ['стоп — за минимумом ретеста 148.20'], anchor: { sources: ['POC 1h'] }, t1Why: ['макс. прошлой недели'], t2Why: ['по ATR'], stopPct: -0.011, t1Pct: 0.045, t2Pct: 0.072, invalidation: 'закрытие часовой свечи ниже 147.60', level, entryType: 'retest' },
    retest: { level, ext: 148.2, why: 'отскок от уровня 148.50–149.80: цена опускалась до 148.20, 15-минутная свеча 13:15 закрылась на 150.10', touchedAt: Date.UTC(2026, 10, 6, 8) },
    warnings: [], reason: '', reasons: { pro: [], contra: [] }, blocks: {}, weights: {}, levels: { inside: [], supports: [], resistances: [] }, tfs: {},
  };
  assert.equal(signalSubject(r, { zone: true }), '🎯 SOL: ретест 148.50–149.80 удержался — ПОКУПКА по 150.10');
  const txt = signalText(r, { zone: true });
  assert.match(txt, /^🎯 РЕТЕСТ ПОДТВЕРЖДЁН\. 🟢 ПОКУПКА SOLUSDT/);
  assert.match(txt, /\nВход: ретест: пробитое сопротивление 148\.50–149\.80 \(пробой 05\.11 \d\d:00, на объёме ×2\.1\) — цена опускалась до 148\.20: уровень удержался\n/);
  assert.match(signalHtml(r, { zone: true }), /Ретест уровня 148\.50–149\.80 подтверждён — уровень удержался/);
  assert.match(smsText(r, { zone: true }), /^RETEST BUY SOL 150\.10 \| zone 148\.50-150\.00 SL 147\.60/);
  // сигнал ещё ждёт ретеста — правило входа видно в письме
  const waiting = { ...r, retest: undefined, action: 'WATCH_BUY' };
  assert.match(signalText(waiting), /\nВход: на ретесте: пробитое сопротивление 148\.50–149\.80 \(пробой .*\) — когда цена вернётся к уровню и 15-минутная свеча закроется вверх от него\n/);
  assert.equal(signalSubject(waiting), '🟡 SOL: готовиться к покупке, ждать ретест 148.50–149.80');
  assert.match(signalText({ ...waiting, plan: { ...r.plan, level: null, entryType: 'none' } }), /Вход: пока нет: рядом нет уровня для входа на ретесте — вдогонку не вхожу/);
});

test('Анализ рывка из боковика: вход — на ретесте главного пробитого уровня, цель — максимум после пробоя', async () => {
  const { analyze } = await import('../lib/analyzer.js');
  // 30 дней боковика 95–100, затем за 6 часов рывок до 104 — цена далеко от уровня
  let s = 7;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const end = Date.UTC(2026, 10, 6, 12), n = 30 * 96, m15 = [];
  let p = 97.5;
  for (let i = 0; i < n; i++) {
    const t = end - (n - i) * M15, left = n - i;
    const target = left > 24 ? 97.5 + 2.3 * Math.sin(i / 40) : 99.8 + (104 - 99.8) * (1 - left / 24);
    const o = p;
    p += (target - p) * 0.3 + (rnd() - 0.5) * 0.25;
    m15.push({ time: t, open: o, high: Math.max(o, p) + rnd() * 0.15, low: Math.min(o, p) - rnd() * 0.15, close: p, volume: 100 * (left <= 24 ? 2.5 : 1) * (0.6 + rnd()), takerBuy: 50 * (left <= 24 ? 3 : 1), trades: 10, closeTime: t + M15 - 1 });
  }
  const agg = (k) => {
    const out = [];
    for (let i = 0; i + k <= m15.length; i += k) {
      const g = m15.slice(i, i + k);
      out.push({ time: g[0].time, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g.at(-1).close, volume: g.reduce((a, x) => a + x.volume, 0), takerBuy: g.reduce((a, x) => a + x.takerBuy, 0), trades: 40, closeTime: g.at(-1).closeTime });
    }
    return out;
  };
  const h1 = agg(4);
  const r = analyze({ symbol: 'SOLUSDT', candles: { m15: m15.slice(-400), h1: h1.slice(-500), h4: agg(16), d1: agg(96) }, closedOnly: true, now: end, price: m15.at(-1).close, legacyPlan: true }, cfg);
  const pl = r.plan, atr = r.stats.atr;
  assert.equal(pl.dir, 'BUY');
  assert.equal(pl.entryType, 'retest');
  assert.equal(pl.level.role, 'breakout');
  assert.ok(pl.level.high >= 99.5 && pl.level.low <= 100.5, `уровень — верх боковика: ${pl.level.low}–${pl.level.high}`);
  assert.ok(r.price - pl.zone[1] > 5 * atr, 'зона — у уровня, а не у текущей цены после рывка');
  const hiAfter = Math.max(...h1.slice(-6).map((c) => c.high));
  assert.ok(Math.abs(pl.t1 - (hiAfter - 0.05 * atr)) < 1e-9, 'цель 1 — максимум после пробоя');
  assert.ok(pl.rr >= 1.5, `от уровня прибыль/риск хороший: ${pl.rr}`);
  assert.ok(r.planLegacy.zone[1] >= r.price - 0.01, 'план 2.7 покупал у текущей цены, на самом верху рывка');
});
