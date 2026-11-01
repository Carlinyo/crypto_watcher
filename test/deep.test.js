// v2.7 — более глубокий анализ: недельные свечи, карта ликвидаций, опционы Deribit, ширина рынка,
// история похожих сигналов и раздел «Подробнее» в письмах.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cfg from '../config.js';
import { toWeekly } from '../lib/tf.js';
import { liquidationMap } from '../lib/liqmap.js';
import { parseOption, bsDelta, maxPain, analyzeOptions, OptionsFeed } from '../lib/options.js';
import { Journal } from '../lib/journal.js';
import { analyze } from '../lib/analyzer.js';
import { deepLines, signalText, signalHtml, digestMessage, optionsText } from '../lib/report.js';
import { candlesFrom, rng } from './helpers.js';

const H = 3600e3, DAY = 86400e3;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

test('Недельные свечи: неделя с понедельника, объёмы складываются, последняя неделя — текущая', () => {
  // 1 октября 2026 — четверг: 4 дня первой недели, 7 дней второй, 3 дня третьей
  const closes = Array.from({ length: 14 }, (_, i) => 100 + i);
  const d1 = candlesFrom(closes, { step: DAY, start: Date.UTC(2026, 9, 1), volume: 10 });
  const w = toWeekly(d1);
  assert.equal(w.length, 3);
  assert.deepEqual(w.map((x) => x.time), [Date.UTC(2026, 8, 28), Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 12)]);
  for (const x of w) assert.equal(new Date(x.time).getUTCDay(), 1, 'неделя начинается в понедельник');
  assert.deepEqual(w.map((x) => x.volume), [40, 70, 30]);
  assert.deepEqual(w.map((x) => x.takerBuy), [20, 35, 15]);
  assert.equal(w[0].open, d1[0].open);
  assert.equal(w[0].close, d1[3].close);
  assert.equal(w[1].high, Math.max(...d1.slice(4, 11).map((c) => c.high)));
  assert.equal(w[1].low, Math.min(...d1.slice(4, 11).map((c) => c.low)));
  assert.equal(w[2].close, d1[13].close);
  assert.equal(w[0].trades, 40);
  assert.deepEqual(toWeekly(null), []);
});

// ровный рынок у 100: каждый час открытый интерес растёт на 100 монет, покупатели-агрессоры — 60%
function flatMarket({ hours = 48, extra = 2 } = {}) {
  const start = Date.UTC(2026, 9, 1);
  const candles = candlesFrom(Array(hours + extra).fill(100), { start, step: H, wick: 0.3 }).map((c) => ({ ...c, takerBuy: c.volume * 0.6 }));
  const oi = Array.from({ length: hours }, (_, i) => ({ timestamp: start + i * H, sumOpenInterest: 1000 + 100 * i, sumOpenInterestValue: (1000 + 100 * i) * 100 }));
  return { candles, oi };
}

test('Карта ликвидаций: новые позиции раскладываются по плечам, лонги ликвидируются ниже, шорты выше', () => {
  const { candles, oi } = flatMarket();
  const m = liquidationMap({ oi, candles, price: 100, atr: 0.6 });
  // 47 часов по +100 монет × $100 = $470k новых позиций: 60% лонгов, 40% шортов
  assert.deepEqual(m.below.map((x) => +x.price.toFixed(2)), [98.5, 96.5, 90.5], 'лонги 50×, 25×, 10× — от ближних к дальним');
  assert.deepEqual(m.above.map((x) => +x.price.toFixed(2)), [101.5, 103.5, 109.5], 'шорты 50×, 25×, 10×');
  assert.ok(near(m.below[2].usd, 470e3 * 0.6 * 0.3), 'лонги 10×: 30% от лонгов');
  assert.ok(near(m.above[2].usd, 470e3 * 0.4 * 0.3), 'шорты 10×: 30% от шортов');
  // рядом с ценой (±3%): лонги 98.5 и 99.5 против шортов 100.5 и 101.5 — ликвидаций лонгов больше
  assert.ok(near(m.nearBelow, 470e3 * 0.6 * 0.4) && near(m.nearAbove, 470e3 * 0.4 * 0.4));
  assert.ok(near(m.bias, -0.2), `перевес вниз: ${m.bias}`);
  assert.equal(m.oiUsd, 5700 * 100);
  assert.equal(liquidationMap({ oi: oi.slice(0, 20), candles, price: 100 }), null, 'мало истории — карты нет');
});

test('Карта ликвидаций: пройденные ценой уровни сработали, при падении интереса позиции закрываются', () => {
  const { candles, oi } = flatMarket();
  // после последнего замера цена прокололась до 96 — лонги с ликвидацией выше 96 уже ликвидированы
  const swept = candles.map((c, i) => (i === candles.length - 1 ? { ...c, low: 96 } : c));
  const m = liquidationMap({ oi, candles: swept, price: 100, atr: 0.6 });
  assert.deepEqual(m.below.map((x) => +x.price.toFixed(2)), [90.5]);
  assert.equal(m.nearBelow, 0);
  assert.ok(m.bias > 0.9, 'рядом остались только шорты — перевес вверх');
  // открытый интерес упал вдвое — все скопления уменьшились пропорционально
  const before = liquidationMap({ oi, candles, price: 100, atr: 0.6 });
  const last = oi[oi.length - 1];
  const oi2 = [...oi, { timestamp: last.timestamp + H, sumOpenInterest: last.sumOpenInterest / 2, sumOpenInterestValue: last.sumOpenInterestValue / 2 }];
  const after = liquidationMap({ oi: oi2, candles, price: 100, atr: 0.6 });
  const k = 1 - 285e3 / 470e3;
  assert.ok(near(after.below[0].usd, before.below[0].usd * k), 'уменьшение пропорциональное');
  assert.ok(near(after.above[2].usd, before.above[2].usd * k));
});

test('Опционы: разбор названия, дельта, «максимальная боль»', () => {
  assert.deepEqual(parseOption('BTC-27DEC26-90000-C'), { cur: 'BTC', expiry: Date.UTC(2026, 11, 27, 8), strike: 90000, type: 'C' });
  assert.deepEqual(parseOption('ETH-3JAN27-3500-P'), { cur: 'ETH', expiry: Date.UTC(2027, 0, 3, 8), strike: 3500, type: 'P' });
  assert.equal(parseOption('BTC-PERPETUAL'), null);
  assert.equal(parseOption('BTC-27XYZ26-1-C'), null);
  const c = bsDelta('C', 100, 100, 0.5, 30 / 365), p = bsDelta('P', 100, 100, 0.5, 30 / 365);
  assert.ok(c > 0.5 && c < 0.56, `дельта колла на деньгах ${c}`);
  assert.ok(near(p, c - 1), 'паритет: дельта пута = дельта колла − 1');
  assert.ok(bsDelta('C', 100, 150, 0.5, 30 / 365) < 0.02, 'далёкий колл почти не реагирует');
  assert.ok(near(bsDelta('C', 100, 50, 0.5, 30 / 365), 1, 1e-3));
  assert.equal(bsDelta('C', 100, 100, 0, 0.1), null);
  const list = [{ strike: 100, type: 'C', oi: 10 }, { strike: 110, type: 'C', oi: 10 }, { strike: 90, type: 'P', oi: 10 }, { strike: 100, type: 'P', oi: 10 }];
  assert.equal(maxPain(list), 100);
  assert.equal(maxPain([{ strike: 100, type: 'C', oi: 10 }, { strike: 120, type: 'P', oi: 50 }]), 120, 'много путов на 120 — боль меньше всего на 120');
});

// книга опционов как в ответе Deribit: 4 экспирации, страйки 70–130 тыс., улыбка с наклоном slope
const NOW = Date.UTC(2026, 10, 1); // 1 ноября 2026
function optionBook({ slope = 0.3, F = 100000, putOi = 30 } = {}) {
  const exp = [['6NOV26', 100, 100], ['27NOV26', 20, putOi], ['25DEC26', 20, putOi], ['26MAR27', 20, putOi]];
  const rows = [];
  for (const [e, callOi, pOi] of exp) {
    for (let K = 70000; K <= 130000; K += 5000) {
      const iv = 50 + slope * 100 * (K / F - 1); // в процентах, как mark_iv у Deribit
      rows.push({ instrument_name: `BTC-${e}-${K}-C`, open_interest: callOi, mark_iv: iv, underlying_price: F });
      rows.push({ instrument_name: `BTC-${e}-${K}-P`, open_interest: pOi, mark_iv: iv, underlying_price: F });
    }
  }
  rows.push({ instrument_name: 'BTC-PERPETUAL', open_interest: 1e9 }); // не опцион — пропускается
  rows.push({ instrument_name: 'BTC-30OCT26-100000-C', open_interest: 500, mark_iv: 40, underlying_price: F }); // уже истёк
  return rows;
}

test('Опционы: перекос улыбки, путы/коллы, ближайшая крупная экспирация', () => {
  const up = analyzeOptions(optionBook({ slope: 0.3 }), { now: NOW });
  assert.equal(up.spot, 100000);
  assert.equal(up.tenorDays, 26, 'срок около месяца — экспирация 27 ноября');
  assert.ok(up.rr25 > 1, `коллы дороже путов — риск-реверсал положительный: ${up.rr25}`);
  assert.ok(near(up.atmIv, 0.5), 'IV на деньгах');
  // путы: 100×13 + 30×13×3, коллы: 100×13 + 20×13×3
  assert.ok(near(up.pcr, 2470 / 2080));
  assert.ok(near(up.oiUsd, (2600 + 3 * 650) * 100000));
  assert.equal(up.nextBig.ts, Date.UTC(2026, 10, 6, 8), 'крупная экспирация 6 ноября');
  assert.equal(up.nextBig.maxPain, 100000);
  assert.equal(up.expiries.length, 4);
  assert.ok(!('list' in up.expiries[0]) && !('list' in up.nextBig), 'списки опционов наружу не отдаются');

  const down = analyzeOptions(optionBook({ slope: -0.3 }), { now: NOW });
  assert.ok(down.rr25 < -1, `путы дороже — риск-реверсал отрицательный: ${down.rr25}`);
  // наклон 0.3 на 100% страйка: 25Δ-колл около 110 тыс. (IV ≈ 53%), 25Δ-пут около 92 тыс. (IV ≈ 47.6%)
  assert.ok(up.rr25 > 5 && up.rr25 < 6.5 && down.rr25 < -5 && down.rr25 > -6.5, `величина: ${up.rr25}, ${down.rr25}`);
  assert.equal(analyzeOptions(optionBook({ slope: 0 }), { now: NOW }).rr25, 0, 'ровная улыбка — перекоса нет');
  assert.equal(analyzeOptions(optionBook().slice(0, 15), { now: NOW }), null, 'мало опционов — разбора нет');
  assert.equal(analyzeOptions(null), null);
  // после 6 ноября крупной экспирации в ближайшую неделю нет
  assert.equal(analyzeOptions(optionBook(), { now: Date.UTC(2026, 10, 7) }).nextBig, null);
});

test('Опционы Deribit: только BTC и ETH, кэш, при сбое — прошлые данные', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0, fail = false, body = null;
  globalThis.fetch = async (url) => {
    calls++;
    assert.match(String(url), /^https:\/\/www\.deribit\.com\/api\/v2\/public\/get_book_summary_by_currency\?currency=BTC&kind=option$/);
    return fail ? new Response('bad', { status: 400 }) : new Response(JSON.stringify(body ?? { jsonrpc: '2.0', result: optionBook() }), { status: 200 });
  };
  try {
    const feed = new OptionsFeed(cfg);
    assert.equal(await feed.get('SOL'), null);
    assert.equal(calls, 0, 'для других монет запросов нет');
    const a = await feed.get('BTC');
    assert.ok(a && a.pcr > 0 && feed.health.ok === true);
    await feed.get('BTC');
    assert.equal(calls, 1, 'повтор в пределах 15 минут — из кэша');
    feed.cache.get('BTC').at -= 16 * 60e3;
    fail = true;
    const b = await feed.get('BTC');
    assert.equal(calls, 2);
    assert.deepEqual(b, a, 'при сбое — последние известные данные');
    assert.equal(feed.health.ok, false);
    // сбой затянулся больше чем на 2 часа — устаревшие опционы не используются
    feed.cache.get('BTC').at -= 16 * 60e3;
    feed.cache.get('BTC').okAt -= 3 * 3600e3;
    assert.equal(await feed.get('BTC'), null);
    assert.equal(calls, 3);
    // ответ без списка (ошибка Deribit) — сбой, а не «опционов нет»
    fail = false;
    body = { jsonrpc: '2.0', error: { message: 'too_many_requests', code: 10028 } };
    feed.cache.get('BTC').at -= 16 * 60e3;
    assert.equal(await feed.get('BTC'), null);
    assert.equal(feed.health.ok, false);
    assert.match(feed.health.lastError, /Deribit: неожиданный ответ — too_many_requests/);
    body = null;
    assert.equal(await new OptionsFeed({ ...cfg, options: { ...cfg.options, enabled: false } }).get('BTC'), null, 'OPTIONS=0 — выключено');
    assert.equal(calls, 4);
  } finally { globalThis.fetch = realFetch; }
});

test('Журнал: как заканчивались похожие сигналы', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-j-')), 'journal.json');
  const j = new Journal(file, cfg);
  const now = Date.UTC(2026, 10, 1);
  const e = (side, result, regime, o = {}) => ({ symbol: 'SOLUSDT', kind: 'crypto', side, regime, status: 'closed', result, tp1: result > 0, closed: now - 5 * DAY, ...o });
  j.entries = [
    e('BUY', 1.5, 'trend_up'), e('BUY', -1, 'trend_up'), e('BUY', 2, 'range'), e('BUY', -1, 'range'), e('BUY', 0.5, 'range'),
    e('SELL', 2, 'trend_down'), // другая сторона
    e('BUY', 3, 'trend_up', { kind: 'stock' }), // акция
    e('BUY', 3, 'trend_up', { closed: now - 400 * DAY }), // слишком давно
    e('BUY', null, 'trend_up', { status: 'open', closed: null }), // ещё открыт
  ];
  const r = { plan: { dir: 'BUY' }, regime: { key: 'trend_up' }, kind: 'crypto' };
  const h = j.similar(r, { now });
  assert.equal(h.n, 5, 'в том же режиме мало — берём все покупки по монетам');
  assert.equal(h.regime, false);
  assert.ok(near(h.winRate, 3 / 5) && near(h.avgR, 2 / 5) && near(h.tp1, 3 / 5));
  const h2 = j.similar(r, { now, minN: 2 });
  assert.equal(h2.n, 2);
  assert.equal(h2.regime, true, 'хватает — только тот же режим рынка');
  assert.deepEqual(j.similar({ ...r, kind: 'stock' }, { now }).n, 1);
  assert.deepEqual(j.similar({ plan: { dir: 'SELL' }, regime: { key: 'range' } }, { now }), { n: 1, regime: false, winRate: 1, avgR: 2, tp1: 1 });
  assert.deepEqual(new Journal(path.join(path.dirname(file), 'none.json'), cfg).similar(r), { n: 0, regime: false, winRate: null, avgR: null, tp1: null });
});

// полный набор данных для анализа: свечи всех таймфреймов и история открытого интереса
function bundle(extra = {}) {
  const series = (n, seed, drift, vol = 0.02) => {
    const r = rng(seed);
    const c = [100];
    for (let i = 1; i < n; i++) c.push(c[i - 1] * (1 + drift + (r() - 0.5) * vol));
    return c;
  };
  const end = Date.UTC(2026, 9, 31);
  const h1c = series(520, 7, 0.0004, 0.008);
  const h1 = candlesFrom(h1c, { start: end - 520 * H, wick: 0.3 });
  const h4 = candlesFrom(series(520, 8, 0.001, 0.02), { start: end - 520 * 4 * H, step: 4 * H, wick: 1 });
  const d1 = candlesFrom(series(400, 9, 0.002, 0.04), { start: end - 400 * DAY, step: DAY, wick: 2 });
  const m15 = candlesFrom(series(420, 10, 0.0001, 0.004), { start: end - 420 * 900e3, step: 900e3, wick: 0.1 });
  const oi = h1.slice(-200).map((c, i) => ({ timestamp: c.time, sumOpenInterest: 1e6 + i * 2000, sumOpenInterestValue: (1e6 + i * 2000) * c.close }));
  return { symbol: 'BTCUSDT', name: 'Bitcoin', candles: { m15, h1, h4, d1 }, deriv: { oi }, now: end, ...extra };
}

test('Анализ: неделя, карта ликвидаций, опционы и ширина рынка учитываются в оценке', () => {
  const opt = (rr25, pcr = 0.8) => ({ spot: 100, oiUsd: 5e9, pcr, atmIv: 0.6, rr25, tenorDays: 28, expiries: [], nextBig: null });
  const bear = analyze(bundle({ options: opt(-7, 1.3) }), cfg);
  const bull = analyze(bundle({ options: opt(7, 0.4) }), cfg);
  assert.ok(bear.tfs.w1 && typeof bear.tfs.w1.trend === 'string', 'недельный таймфрейм есть');
  assert.ok(Number.isFinite(bear.rv30) && bear.rv30 > 0, 'фактическая волатильность посчитана');
  assert.ok(bear.liqmap && Array.isArray(bear.liqmap.above) && Array.isArray(bear.liqmap.below), 'карта ликвидаций построена');
  assert.equal(bear.blocks.derivatives.summary.liqmap, bear.liqmap);
  assert.deepEqual(bear.options, opt(-7, 1.3));
  const texts = (r) => r.blocks.derivatives.items.map((x) => x.text).join(' | ');
  assert.match(texts(bear), /путы дороже коллов \(риск-реверсал −7\.0\)/);
  assert.match(texts(bull), /коллы дороже путов \(риск-реверсал \+7\.0\)/);
  assert.ok(bull.blocks.derivatives.score > bear.blocks.derivatives.score, 'перекос опционов двигает оценку');
  assert.ok(bear.blocks.derivatives.notes.some((n) => /^опционы Deribit: путы\/коллы по открытому интересу 1\.30/.test(n)));

  const breadth = (up, down) => ({ kind: 'crypto', n: 15, up, down, value: (up - down) / 15 });
  const wide = analyze(bundle({ breadth: breadth(13, 1) }), cfg), narrow = analyze(bundle({ breadth: breadth(1, 13) }), cfg);
  assert.ok(wide.blocks.trend.score > narrow.blocks.trend.score, 'ширина рынка влияет на тренд');
  assert.ok(wide.blocks.trend.items.some((x) => /^Рынок в целом растёт: 13 из 15 монет/.test(x.text)));
  assert.ok(narrow.blocks.trend.notes.some((x) => /рынок в целом: растут 1 из 15 монет, падают 13/.test(x)));
  assert.equal(analyze(bundle(), cfg).options, null, 'для монет без опционов — пусто');
});

test('Письмо: раздел «Подробнее» — неделя, ход за сутки, сценарий отмены, ликвидации, опционы, рынок, история', () => {
  const r = {
    symbol: 'BTCUSDT', kind: 'crypto', action: 'BUY', price: 100000,
    tfs: { w1: { trend: 'вверх', rsi: 61.2 }, d1: { atr: 2500 } },
    plan: { dir: 'BUY', stop: 97000 },
    levels: { supports: [{ low: 98000, high: 98500, price: 98250 }, { low: 94000, high: 95000, price: 94500 }], resistances: [] },
    liqmap: { above: [{ price: 103000, usd: 5e8 }], below: [{ price: 96000, usd: 3e8 }], bias: 0.2 },
    options: { pcr: 0.8, rr25: 4.2, atmIv: 0.55, nextBig: { ts: Date.UTC(2026, 10, 6, 8), oiUsd: 4e9, maxPain: 95000 } },
    rv30: 0.42,
    breadth: { kind: 'crypto', n: 15, up: 11, down: 3 },
    history: { n: 8, regime: true, winRate: 0.625, avgR: 0.41 },
  };
  const L = Object.fromEntries(deepLines(r));
  assert.equal(L['Недельный тренд'], 'вверх, RSI недели 61');
  assert.match(L['Обычный ход за сутки'], /^±2\.5% — примерно от 97 500\.00 до 102 500\.00$/);
  assert.match(L['Если не сработает'], /^за стопом 97 000\.00 цена может уйти к следующей поддержке 94 000\.00 – 95 000\.00 \(−5\.0%\)$/);
  assert.equal(L['Ликвидации (оценка)'], 'выше — шорты: $500.00M у 103 000.00 (+3.0%); ниже — лонги: $300.00M у 96 000.00 (−4.0%)');
  assert.match(L['Опционы Deribit'], /^путы\/коллы 0\.80; риск-реверсал \+4\.2 \(коллы дороже — ждут роста\); IV 55% при фактической 42%; экспирация 06\.11 \S+ на \$4\.00B, «максимальная боль» 95 000\.00$/);
  assert.equal(L['Рынок в целом'], 'растут 11 из 15 монет, падают 3');
  assert.equal(L['Похожие сигналы'], '8 за полгода (та же сторона и режим рынка): успешных 63%, в среднем +0.41R');
  // мало истории; продажа без уровней за стопом; нейтрально — без сценария и истории
  assert.equal(Object.fromEntries(deepLines({ ...r, history: { n: 2 } }))['Похожие сигналы'], 'пока только 2 — статистика накопится');
  assert.equal(Object.fromEntries(deepLines({ ...r, history: { n: 0 } }))['Похожие сигналы'], 'пока не было — статистика накопится');
  const sell = Object.fromEntries(deepLines({ ...r, action: 'SELL', plan: { dir: 'SELL', stop: 103000 } }));
  assert.equal(sell['Если не сработает'], 'за стопом 103 000.00 сильных уровней рядом нет — движение может продолжиться');
  const flat = Object.fromEntries(deepLines({ ...r, action: 'NEUTRAL' }));
  assert.ok(!('Если не сработает' in flat) && !('Похожие сигналы' in flat));
  assert.deepEqual(deepLines({ symbol: 'XUSDT', action: 'NEUTRAL', price: 1 }), []);
  assert.equal(optionsText(null), null);
  assert.equal(optionsText({ rr25: 0.3 }), 'риск-реверсал +0.3 (без перекоса)');
});

test('Письмо и обзор целиком: раздел «Подробнее» и опционы на месте', () => {
  const r = Object.assign(analyze(bundle({ options: { spot: 100, oiUsd: 5e9, pcr: 1.1, atmIv: 0.6, rr25: -4, tenorDays: 28, expiries: [], nextBig: null }, breadth: { kind: 'crypto', n: 15, up: 4, down: 9, value: -5 / 15 } }), cfg),
    { history: { n: 6, regime: false, winRate: 0.5, avgR: 0.2 } });
  const forced = { ...r, action: 'BUY' };
  const txt = signalText(forced);
  assert.match(txt, /\nПОДРОБНЕЕ:\n {2}Недельный тренд: /);
  assert.match(txt, /Опционы Deribit: путы\/коллы 1\.10; риск-реверсал −4\.0 \(путы дороже — страхуются от падения\)/);
  assert.match(txt, /Похожие сигналы: 6 за полгода \(та же сторона\): успешных 50%/);
  const html = signalHtml(forced);
  assert.match(html, /Подробнее<\/h3>/);
  assert.match(html, /Рынок в целом<\/b>.*растут 4 из 15 монет, падают 9/s);
  const d = digestMessage({ results: [r], market: null, journal: [], stats: null, liqMarket: null, whalesDay: null, newsTop: [], health: null });
  assert.match(d.text, /Рынок в целом: растут 4 из 15 монет, падают 9/);
  assert.match(d.text, /Опционы BTC \(Deribit\): путы\/коллы 1\.10/);
  assert.match(d.html, /Опционы BTC \(Deribit\)/);
});
