// ↔️ Торговля в боковике: поиск диапазона, сделка от границы, вход после разворота у границы
import test from 'node:test';
import assert from 'node:assert/strict';
import { findRange, rangeTrade, rangePlan, rangeVetoes } from '../lib/range.js';
import { retestEntry, isRangeZone, freshPlanFor, entryCheck, levelText } from '../lib/entry.js';
import { analyze, decide } from '../lib/analyzer.js';
import { candlesFrom, path, rng } from './helpers.js';
import { rangeVerdict, selfTestLines } from '../lib/selftest.js';
import cfg from '../config.js';

const ATR = 1;
// 4+ дня качелей между ~95 и ~105: шесть проходов через диапазон, немного шума
function rangeCloses(n = 110, seed = 3) {
  const r = rng(seed);
  const base = path([100], [104.5, 9], [95.5, 9], [104.5, 9], [95.5, 9], [104.5, 9], [95.5, 9], [104.5, 9], [95.5, 9], [104.5, 9], [95.5, 9], [100, 9], [96.2, 6]);
  return base.slice(0, n).map((c) => c + (r() - 0.5) * 0.6);
}
const H1 = (closes, o = {}) => candlesFrom(closes, { wick: 0.4, ...o });

test('Боковик: находится по качелям между границами; тренд, узкий и сломанный диапазон — не боковик', () => {
  const rg = findRange(H1(rangeCloses()), { atr: ATR });
  assert.equal(rg.ok, true, rg.why);
  assert.ok(rg.low > 94 && rg.low < 96 && rg.high > 104 && rg.high < 106, `${rg.low}–${rg.high}`);
  assert.ok(rg.touchesLow >= 2 && rg.touchesHigh >= 2 && rg.rotations >= 3);
  assert.match(rg.why, /^боковик 9\d\.\d+–10\d\.\d+ \(\d+\.\d%\) за 4 дня: касаний снизу \d, сверху \d$/);
  // тренд: ровный рост
  const up = findRange(H1(path([100], [130, 110])), { atr: ATR });
  assert.equal(up.ok, false);
  assert.match(up.why, /наклон|широкий|подтверждены слабо/);
  // узкий: качели в 1.5 ATR
  const narrow = findRange(H1(rangeCloses().map((c) => 100 + (c - 100) * 0.15)), { atr: ATR });
  assert.equal(narrow.ok, false);
  assert.match(narrow.why, /узкий/);
  // сломан: последние часы закрылись ниже границы
  const br = rangeCloses(107).concat([94.6, 93.8, 93.5]);
  const broken = findRange(H1(br), { atr: ATR });
  assert.equal(broken.ok, false);
  assert.equal(broken.broken, 'down');
  assert.match(broken.why, /боковик сломан: часовая свеча закрылась ниже/);
  assert.equal(findRange(H1(rangeCloses(50)), { atr: ATR }).ok, false, 'мало истории');
});

test('Боковик: у нижней границы — покупка, у верхней — продажа, в середине — ничего; план от границы', () => {
  const rg = findRange(H1(rangeCloses()), { atr: ATR });
  const buy = rangeTrade(rg, { price: rg.low + 0.1 * rg.width, atr: ATR, risk: { feePct: 0.11 } });
  assert.equal(buy.dir, 'BUY');
  const p = buy.plan;
  assert.ok(p.stop < rg.low - 0.3, 'стоп за нижней границей');
  assert.equal(p.t1, rg.mid);
  assert.ok(p.t2 > rg.mid && p.t2 < rg.high);
  assert.ok(p.zone[0] === rg.low && p.zone[1] > p.zone[0]);
  assert.equal(p.entryType, 'range');
  assert.equal(p.level.role, 'range');
  assert.ok(p.rr >= 1.5, `прибыль/риск от зоны ${p.rr}`);
  assert.equal(rangeTrade(rg, { price: rg.high - 0.1 * rg.width, atr: ATR }).dir, 'SELL');
  const sp = rangePlan(rg, 'SELL', { price: rg.high - 0.05 * rg.width, atr: ATR });
  assert.ok(sp.stop > rg.high && sp.t1 === rg.mid && sp.t2 < rg.mid);
  assert.equal(rangeTrade(rg, { price: rg.mid, atr: ATR }), null, 'в середине боковика не входим');
  assert.equal(rangeTrade(rg, { price: rg.low, atr: ATR, regimeKey: 'trend_up' }), null, 'не в режиме боковика — не торгуем');
  assert.equal(rangeTrade(rg, { price: rg.low, atr: ATR, regimeKey: 'squeeze' }), null, 'сжатие — перед пробоем, от границ не торгуем');
  assert.match(levelText(p.level, 'BUY'), /^нижняя граница боковика 9\d\.\d+–9\d\.\d+ \(боковик 9\d\.\d+–10\d\.\d+ за 4 дн\., касаний снизу \d, сверху \d\)$/);
});

test('Боковик: запреты — оценка сильно против, старший тренд, биткоин, новость, макро', () => {
  const base = { dir: 'BUY', score: 0, thr: 0.33, htf: 0, btcScore: 0, isBtc: false, badNews: null, macro: null };
  assert.deepEqual(rangeVetoes(base, cfg), []);
  assert.deepEqual(rangeVetoes({ ...base, score: -0.1 }, cfg), [], 'слабая оценка против — не помеха');
  assert.match(rangeVetoes({ ...base, score: -0.2 }, cfg)[0], /общая оценка против/);
  assert.match(rangeVetoes({ ...base, htf: -0.7 }, cfg)[0], /старший тренд/);
  assert.match(rangeVetoes({ ...base, btcScore: -0.5 }, cfg)[0], /биткоин/);
  assert.equal(rangeVetoes({ ...base, btcScore: -0.5, isBtc: true }, cfg).length, 0);
  assert.match(rangeVetoes({ ...base, badNews: { event: 'Взлом' } }, cfg)[0], /взлом/);
  assert.match(rangeVetoes({ ...base, macro: { name: 'заседание ФРС' } }, cfg)[0], /ФРС/);
  assert.match(rangeVetoes({ ...base, dir: 'SELL', htf: 0.7 }, cfg)[0], /старший тренд/);
});

test('Решение: в боковике у границы сильного сигнала нет — сделка от границы; RANGE_TRADES=0 и вход «touch» — без неё', () => {
  const rg = findRange(H1(rangeCloses()), { atr: ATR });
  const rt = rangeTrade(rg, { price: rg.low + 0.08 * rg.width, atr: ATR, risk: cfg.risk });
  const core = { score: 0.05, agreement: 0.3, completeness: 1, regime: { thresholdAdj: 0 }, htf: 0.1, btcScore: 0.1, isBtc: false, kind: 'crypto', badNews: null, macro: null, plan: { ...rt.plan, entryType: 'none', rr: 0.5, rrNow: 0.3 }, range: rt };
  const d = decide(core, cfg);
  assert.equal(d.action, 'BUY');
  assert.equal(d.isRange, true);
  assert.equal(d.setup, 'BUY', 'подтверждение — как у сильного сигнала');
  assert.equal(d.plan, rt.plan);
  assert.equal(d.zoneOk, true);
  assert.match(d.reason, /^боковик .*: цена у нижней границы — покупка после разворота 15-минутной свечи от границы$/);
  assert.ok(d.confidence >= 40 && d.confidence <= 80);
  assert.equal(decide(core, { ...cfg, range: { enabled: false } }).isRange, false);
  assert.equal(decide(core, { ...cfg, trade: { ...cfg.trade, entry: 'touch' } }).isRange, false);
  const against = decide({ ...core, score: -0.25 }, cfg);
  assert.equal(against.isRange, false);
  assert.match(against.rangeVetoes[0], /общая оценка против/);
  // сильный трендовый сигнал важнее боковика
  const strong = decide({ ...core, score: 0.6, agreement: 0.8, plan: { ...rt.plan, entryType: 'bounce', rr: 2, rrNow: 2 } }, cfg);
  assert.equal(strong.isRange, false);
  assert.equal(strong.action, 'BUY');
});

test('Вход от границы: касание → разворот 15-минутной свечи → сделка; оценка около нуля входу не мешает', () => {
  const closes = rangeCloses();
  const h1 = H1(closes);
  const rg = findRange(h1, { atr: ATR });
  const rt = rangeTrade(rg, { price: rg.low + 0.05 * rg.width, atr: ATR, risk: cfg.risk });
  const p = rt.plan;
  const now = h1.at(-1).closeTime + 1 + 40 * 60e3;
  const z = { dir: 'BUY', low: p.zone[0], high: p.zone[1], atr: ATR, stop: p.stop, level: p.level, touchedAt: now - 30 * 60e3, touchExt: rg.low - 0.1 };
  assert.equal(isRangeZone(z), true);
  // 15-минутные свечи: касание и разворот вверх от границы
  const t0 = Math.floor((now - 30 * 60e3) / 900e3) * 900e3;
  const m15 = [
    { time: t0, closeTime: t0 + 899999, open: rg.low + 0.6, high: rg.low + 0.7, low: rg.low - 0.1, close: rg.low + 0.1 },
    { time: t0 + 900e3, closeTime: t0 + 1799999, open: rg.low + 0.1, high: rg.low + 0.9, low: rg.low + 0.05, close: rg.low + 0.85 },
  ];
  const px = rg.low + 0.85;
  const r = { price: px, score: 0.02, threshold: 0.33, vetoes: [], rangeVetoes: [], plan: { dir: 'SELL' }, core: { range: rangeTrade(rg, { price: px, atr: ATR, risk: cfg.risk }) }, stats: { atr: ATR }, regime: { stopMult: 1 }, range: { ok: true } };
  const d = retestEntry(z, r, { m15, h1, now, minRR: 1.5, risk: cfg.risk });
  assert.equal(d.kind, 'entry', d.why);
  assert.ok(d.plan.stop <= rg.low - 0.1 - 0.2 * ATR + 1e-9, 'стоп за минимумом касания');
  assert.equal(d.plan.t1, rg.mid);
  assert.equal(d.retest.level.role, 'range');
  // боковик пропал из свежего анализа — не входим
  const gone = retestEntry(z, { ...r, core: { range: null }, range: { ok: false, why: 'боковик сломан: …', broken: 'down' } }, { m15, h1, now, minRR: 1.5, risk: cfg.risk });
  assert.equal(gone.kind, 'no');
  assert.match(gone.why, /боковик больше не подтверждается/);
  assert.equal(gone.flip, true);
  // запрет боковика
  const v = entryCheck(z, { ...r, rangeVetoes: ['старший тренд против'] }, d.plan, { minRR: 1.5 });
  assert.deepEqual([v.ok, v.code], [false, 'veto']);
  assert.equal(freshPlanFor({ ...z, dir: 'SELL' }, r), null, 'свежий план в другую сторону — не наш');
});

test('Анализ: настоящий расчёт на свечах боковика даёт сведения о боковике', () => {
  const closes = rangeCloses(110);
  const h1 = H1(closes);
  const m15 = candlesFrom(closes.slice(-100).flatMap((c) => [c, c, c, c]), { wick: 0.15, step: 900e3, start: h1.at(-100).time });
  const d1 = candlesFrom(Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 9) * 4), { step: 86400e3, wick: 2, start: h1[0].time - 200 * 86400e3 });
  const h4 = candlesFrom(Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 5) * 4), { step: 4 * 3600e3, wick: 1, start: h1.at(-1).time - 300 * 4 * 3600e3 });
  const r = analyze({ symbol: 'TESTUSDT', candles: { m15, h1: [...candlesFrom(Array(400).fill(100).map((c, i) => c + Math.sin(i / 7) * 4), { wick: 0.4, start: h1[0].time - 400 * 3600e3 }), ...h1], h4, d1 }, closedOnly: false }, cfg);
  assert.equal(typeof r.range.ok, 'boolean');
  assert.ok('why' in r.range && 'dir' in r.range);
  if (r.isRange) {
    assert.equal(r.plan.entryType, 'range');
    assert.ok(r.planTrend, 'обычный план тоже сохраняется (для бэктеста)');
  }
});

test('Самопроверка: сделки от границ боковика в минусе на истории — выключаются до следующей проверки', () => {
  const st = (o) => ({ n: 14, wins: 6, winRate: 0.43, avgR: 0.12, sumR: 1.7, pf: 1.25, ...o });
  assert.equal(rangeVerdict({ byVia: {} }), null);
  assert.deepEqual(rangeVerdict({ byVia: { 'боковик': st() } }), { n: 14, avgR: 0.12, pf: 1.25, off: false, enough: true });
  assert.equal(rangeVerdict({ byVia: { 'боковик': st({ avgR: -0.2, pf: 0.7 }) } }).off, true);
  assert.equal(rangeVerdict({ byVia: { 'боковик': st({ n: 6, avgR: -0.5, pf: 0.3 }) } }).off, false, 'мало сделок — не выключаем');
  const res = { at: Date.now(), days: 60, symbols: ['A'], stats: { n: 80, winRate: 0.4, avgR: 0.1, pf: 1.2, sumR: 8 }, byVia: { 'ретест': st({ n: 66 }), 'боковик': st({ avgR: -0.2, pf: 0.7 }) } };
  assert.match(selfTestLines(res).join('\n'), /Сделки от границ боковика: 14 сделок, в среднем −0\.20R, PF 0\.70 — в минусе: такие сделки выключены до следующей проверки\./);
  const c = structuredClone(cfg);
  c.range.autoOff = true;
  const rg = findRange(H1(rangeCloses()), { atr: ATR });
  const rt = rangeTrade(rg, { price: rg.low + 0.08 * rg.width, atr: ATR, risk: cfg.risk });
  const d = decide({ score: 0.05, agreement: 0.3, completeness: 1, regime: { thresholdAdj: 0 }, htf: 0, btcScore: 0, isBtc: false, kind: 'crypto', plan: { ...rt.plan, entryType: 'none', rr: 0.5, rrNow: 0.3 }, range: rt }, c);
  assert.equal(d.isRange, false);
});
