import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cfg from '../config.js';
import { selectStocks, loadStocks, stocksEnabled, tradedOnly, lastTradeTime, stockSessionOpen, nextSessionOpen, sessionReason, stockZoneUntil, STOCK_CANDIDATES } from '../lib/stocks.js';
import { analyze, decide } from '../lib/analyzer.js';
import { signalSubject, smsText, whaleMessage } from '../lib/report.js';
import { validateConfig } from '../lib/validate.js';
import { Bybit } from '../lib/bybit.js';
import { Trader } from '../lib/trader.js';
import { MockBybit, DEFAULT_INSTRUMENTS } from './bybit-mock.js';
import { candlesFrom, rng } from './helpers.js';

const Z = (s) => Date.parse(s);
const tradfi = (...syms) => new Map(syms.map((s) => [s, { symbol: s, base: s.slice(0, -4), mult: 1 }]));
const withStocks = (o) => ({ ...cfg, stocks: { ...cfg.stocks, ...o } });

test('Список акций: крупнейшие компании США, у которых есть фьючерс на Binance', () => {
  assert.equal(STOCK_CANDIDATES[0].ticker, 'AAPL');
  assert.ok(STOCK_CANDIDATES.length >= 25, 'кандидатов с запасом');
  // нет SpaceX и Tesla — их места занимают следующие по капитализации
  const all = STOCK_CANDIDATES.map((c) => `${c.ticker.replace(/[^A-Z]/g, '')}USDT`).filter((s) => !['SPCXUSDT', 'TSLAUSDT'].includes(s));
  const res = selectStocks(withStocks({ list: ['auto'], size: 15 }), tradfi(...all, 'XAUUSDT'));
  assert.equal(res.stocks.length, 15);
  assert.deepEqual(res.missing, ['SPCX', 'TSLA']);
  assert.equal(res.stocks[0].symbol, 'AAPLUSDT');
  assert.equal(res.stocks[0].kind, 'stock');
  assert.ok(res.stocks.some((s) => s.symbol === 'AMDUSDT'), 'вместо выбывших — следующие по списку');
  assert.ok(!res.stocks.some((s) => s.symbol === 'XAUUSDT'), 'золото — не акция из списка');
  // другие тикеры одной компании: GOOG вместо GOOGL, BRKB для Berkshire
  const alt = selectStocks(withStocks({ list: ['auto'], size: 3 }), tradfi('GOOGUSDT', 'BRKBUSDT', 'MUUSDT'));
  assert.deepEqual(alt.stocks.map((s) => s.symbol), ['GOOGUSDT', 'BRKBUSDT', 'MUUSDT']);
  assert.equal(alt.stocks[1].name, 'Berkshire Hathaway');
  // символ, уже занятый монетой, акцией не становится
  assert.ok(!selectStocks(withStocks({ list: ['auto'], size: 2 }), tradfi('AAPLUSDT', 'NVDAUSDT'), new Set(['AAPLUSDT'])).stocks.some((s) => s.symbol === 'AAPLUSDT'));
});

test('Свой список акций в .env и выключение', () => {
  const res = selectStocks(withStocks({ list: ['nvda', 'TSLA', 'PLTR', 'XYZ'] }), tradfi('NVDAUSDT', 'TSLAUSDT', 'PLTRUSDT'));
  assert.deepEqual(res.stocks.map((s) => s.symbol), ['NVDAUSDT', 'TSLAUSDT', 'PLTRUSDT']);
  assert.equal(res.stocks[0].name, 'NVIDIA');
  assert.deepEqual(res.missing, ['XYZ']);
  assert.equal(stocksEnabled(withStocks({ list: ['0'] })), false);
  assert.equal(selectStocks(withStocks({ list: ['0'] }), tradfi('NVDAUSDT')).stocks.length, 0);
  // проверка настроек: неверные часы и тикеры
  const c = structuredClone(cfg);
  Object.assign(c.stocks, { hours: 'night', list: ['AAPL', 'bad ticker!'] });
  const v = validateConfig(c);
  assert.equal(c.stocks.hours, 'regular');
  assert.deepEqual(c.stocks.list, ['AAPL']);
  assert.ok(v.warnings.some((w) => /STOCK_HOURS/.test(w)) && v.warnings.some((w) => /STOCKS:/.test(w)));
});

test('Справочник Binance недоступен — берётся последний сохранённый список акций', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-stocks-'));
  const file = path.join(dir, 'stocks.json');
  const c = withStocks({ list: ['auto'], size: 2 });
  const first = loadStocks(c, tradfi('AAPLUSDT', 'NVDAUSDT', 'MSFTUSDT'), file);
  assert.deepEqual(first.stocks.map((s) => s.symbol), ['AAPLUSDT', 'NVDAUSDT']);
  const again = loadStocks(c, new Map(), file);
  assert.deepEqual(again.stocks.map((s) => s.symbol), ['AAPLUSDT', 'NVDAUSDT']);
  assert.match(again.source, /сохранённый список/);
  assert.equal(loadStocks(c, new Map(), path.join(dir, 'нет.json')).stocks.length, 0);
});

test('Свечи без сделок выбрасываются; время последней сделки', () => {
  const k = candlesFrom([100, 101, 102, 102, 102], { step: 900e3, start: Z('2026-10-30T19:00:00Z') });
  k[3].trades = 0; k[4].trades = 0; k[3].volume = 0; k[4].volume = 0;
  assert.equal(tradedOnly(k).length, 3);
  assert.equal(lastTradeTime(k), k[2].closeTime);
  assert.equal(lastTradeTime([]), null);
});

test('Часы сигналов по акциям: основная сессия, расширенные часы, всегда; зона живёт до конца следующего торгового дня', () => {
  assert.equal(stockSessionOpen('regular', Z('2026-11-02T15:00:00Z')), true);   // понедельник 10:00 по Нью-Йорку
  assert.equal(stockSessionOpen('regular', Z('2026-11-02T13:00:00Z')), false);  // 8:00 — до открытия
  assert.equal(stockSessionOpen('extended', Z('2026-11-02T13:00:00Z')), true);
  assert.equal(stockSessionOpen('regular', Z('2026-10-31T16:00:00Z')), false);  // суббота
  assert.equal(stockSessionOpen('any', Z('2026-10-31T16:00:00Z')), true);
  assert.equal(stockSessionOpen('regular', Z('2026-11-26T16:00:00Z')), false);  // День благодарения
  assert.equal(nextSessionOpen('regular', Z('2026-10-31T16:00:00Z')), Z('2026-11-02T14:30:00Z'));
  assert.equal(nextSessionOpen('extended', Z('2026-10-31T16:00:00Z')), Z('2026-11-02T09:00:00Z'));
  assert.equal(sessionReason('regular', Z('2026-10-31T16:00:00Z')), 'выходной');
  assert.match(sessionReason('regular', Z('2026-11-26T16:00:00Z')), /праздник в США/);
  assert.equal(sessionReason('regular', Z('2026-11-02T15:00:00Z')), null);
  // зона, найденная в пятницу, ждёт цену до закрытия понедельника
  assert.equal(stockZoneUntil(Z('2026-10-30T19:00:00Z')), Z('2026-11-02T21:00:00Z'));
});

test('Анализ акции: фон рынка — индекс, а не биткоин; тексты про акции', () => {
  const r0 = rng(7);
  const closes = [];
  let p = 180;
  for (let i = 0; i < 520; i++) { p *= 1 + (r0() - 0.47) * 0.006; closes.push(p); }
  const h1 = candlesFrom(closes, { step: 3600e3, start: Z('2026-06-01T13:30:00Z') });
  const idx = candlesFrom(closes.map((x, i) => 500 + i * 0.4), { step: 3600e3, start: Z('2026-06-01T13:30:00Z') });
  const r = analyze({ symbol: 'NVDAUSDT', name: 'NVIDIA', kind: 'stock', candles: { m15: null, h1, h4: null, d1: null }, btc: { h1: idx, trend: 0.8, score: 0.5, name: 'QQQ' } }, cfg);
  assert.equal(r.kind, 'stock');
  assert.equal(r.core.kind, 'stock');
  const texts = JSON.stringify([r.reasons, r.blocks.trend.items, r.blocks.flow]);
  assert.doesNotMatch(texts, /[Бб]иткоин|BTC|спот/);
  // запрет по фону рынка — со словами про акции
  const plan = { rr: 2.5, rrNow: 2, zone: [99, 100] };
  const d = decide({ score: 0.36, agreement: 0.8, completeness: 1, regime: { thresholdAdj: 0 }, htf: 0.5, btcScore: -0.6, isBtc: false, kind: 'stock', leadName: 'QQQ', badNews: null, macro: null, plan }, cfg);
  assert.match(d.vetoes[0], /рынок акций \(QQQ\) сейчас сильно медвежий — покупки акций рискованны/);
});

test('Письма и SMS по акции помечены — их не спутать с монетой', () => {
  const r = { symbol: 'NVDAUSDT', kind: 'stock', name: 'NVIDIA', action: 'BUY', price: 187.4, confidence: 62, plan: { dir: 'BUY', zone: [185.1, 186.3], stop: 181, t1: 196, t2: 203, rrNow: 2.1 } };
  assert.match(signalSubject(r), /ПОКУПКА NVDA \(акция\) по 187/);
  assert.match(signalSubject(r, { zone: true }), /^🎯 NVDA \(акция\): цена в зоне покупки/);
  assert.match(smsText(r), /^BUY NVDA stock 187/);
  assert.doesNotMatch(signalSubject({ ...r, kind: 'crypto', symbol: 'SOLUSDT' }), /акция/);
  const ev = { type: 'single', market: 'futures', symbol: 'NVDAUSDT', side: 'buy', usd: 2e6, qty: 10700, price: 187, from: 187, to: 187, trades: 1, time: Date.now(), threshold: 5e5 };
  assert.match(whaleMessage(ev, { alert: true }, { stock: true }).subject, /Кит купил NVDA \(акция\) на \$2\.00M \(фьючерсы\)/);
});

test('Bybit: фьючерс на акцию — только для акции, тикер монеты на акцию не попадает', async () => {
  const instruments = [...DEFAULT_INSTRUMENTS, { symbol: 'NVDAUSDT', tick: '0.01', step: '0.01', minQty: '0.01', maxMkt: '10000', maxLev: '20', symbolType: 'stock' }, { symbol: 'AIUSDT', tick: '0.0001', step: '1', minQty: '1', maxMkt: '1000000', maxLev: '50', symbolType: 'stock' }];
  const ex = new MockBybit({ instruments, prices: { BTCUSDT: 60000, NVDAUSDT: 187 } });
  const c = structuredClone(cfg);
  Object.assign(c.trade, { enabled: true, apiKey: ex.apiKey, apiSecret: ex.apiSecret, mode: 'demo' });
  const t = new Trader(c, { file: null, client: new Bybit({ apiKey: ex.apiKey, apiSecret: ex.apiSecret, mode: 'demo', fetchImpl: ex.fetch }), log: () => {} });
  await t.loadInstruments();
  assert.equal(t.resolve('NVDAUSDT', { kind: 'stock' })?.symbol, 'NVDAUSDT', 'фьючерсы на акции загружаются отдельным запросом');
  assert.equal(t.resolve('NVDAUSDT'), null, 'монета NVDA на акцию не попадает');
  assert.equal(t.resolve('AIUSDT'), null, 'совпадение тикера монеты и акции');
  assert.equal(t.resolve('BTCUSDT', { kind: 'stock' }), null);
  assert.equal(t.resolve('BTCUSDT')?.symbol, 'BTCUSDT');
});

test('Почему нет сделок: по акциям — выходной на бирже и выключенные сделки по акциям', async () => {
  const { diagnose } = await import('../lib/decisions.js');
  const trading = { wanted: true, hasKeys: true, ready: true, mode: 'demo', entry: 'zone', open: 0, maxPositions: 3, configErrors: [] };
  const d = diagnose({ trading, now: Z('2026-10-31T16:00:00Z'), stocks: { on: true, hours: 'regular', trade: false } });
  assert.ok(d.lines.some((l) => /Акции: сейчас сигналов нет — выходной; снова с 02\.11/.test(l.text)));
  assert.ok(d.lines.some((l) => /TRADE_STOCKS=0/.test(l.text)));
  const open = diagnose({ trading, now: Z('2026-11-02T15:00:00Z'), stocks: { on: true, hours: 'regular', trade: true } });
  assert.ok(!open.lines.some((l) => /Акции:|TRADE_STOCKS/.test(l.text)));
});
