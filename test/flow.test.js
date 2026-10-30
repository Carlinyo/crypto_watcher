import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeFlow } from '../lib/trades.js';
import { OrderBookTracker } from '../lib/orderbook.js';
import { Liquidations } from '../lib/liquidations.js';
import { whaleMessage } from '../lib/report.js';
import cfg from '../config.js';

const mkFlow = (events) => {
  const f = new TradeFlow(cfg, { onWhale: (ev, d) => events.push({ ev, d }) });
  f.setSymbols(['BTCUSDT', 'PEPEUSDT'], new Map([['BTCUSDT', { symbol: 'BTCUSDT', mult: 1 }], ['PEPEUSDT', { symbol: '1000PEPEUSDT', mult: 1000 }]]));
  f.setThresholdsFromTickers([{ symbol: 'BTCUSDT', quoteVolume: '2000000000' }, { symbol: 'PEPEUSDT', quoteVolume: '300000000' }], [{ symbol: '1000PEPEUSDT', quoteVolume: '1200000000' }]);
  return f;
};
const trade = (f, market, s, p, usd, side, T = Date.now()) => f.handleTrade(market, { s, p: String(p), q: String(usd / p), T, m: side === 'sell' });

test('Порог кита — доля суточного объёма в пределах [min, max]', () => {
  const f = mkFlow([]);
  assert.equal(f.threshold('spot', 'BTCUSDT'), 1_000_000); // 0.05% от $2B
  assert.equal(f.threshold('spot', 'PEPEUSDT'), 250_000);  // минимум
  assert.equal(f.threshold('futures', 'PEPEUSDT'), 600_000);
  f.stop();
});

test('Части одного рыночного ордера склеиваются в одну сделку кита', () => {
  const events = [];
  const f = mkFlow(events);
  const T = Date.now();
  // 4 части по $0.9M с одинаковым временем = один ордер $3.6M (порог $1M, в первые часы письмо от 3×)
  for (let i = 0; i < 4; i++) trade(f, 'spot', 'BTCUSDT', 60000 + i, 900_000, 'buy', T);
  for (const k of [...f.pending.keys()]) f.flush(k);
  assert.equal(events.length, 1);
  assert.ok(Math.abs(events[0].ev.usd - 3_600_000) < 1);
  assert.equal(events[0].ev.trades, 4);
  assert.equal(events[0].d.alert, true);
  f.stop();
});

test('Пауза по монете и обход паузы китом вдвое крупнее', () => {
  const events = [];
  const f = mkFlow(events);
  const big = (usd) => { trade(f, 'spot', 'BTCUSDT', 60000, usd, 'buy'); for (const k of [...f.pending.keys()]) f.flush(k); return events[events.length - 1].d; };
  assert.equal(big(3_500_000).alert, true);
  assert.equal(big(3_600_000).alert, false, 'вторая похожая покупка попадает под паузу');
  assert.equal(big(7_500_000).alert, true, 'вдвое крупнее — без паузы');
  f.stop();
});

test('Продажи китов не уведомляются по умолчанию, но учитываются в статистике', () => {
  const events = [];
  const f = mkFlow(events);
  trade(f, 'spot', 'BTCUSDT', 60000, 5_000_000, 'sell');
  for (const k of [...f.pending.keys()]) f.flush(k);
  assert.equal(events[0].d.alert, false);
  const s = f.summary('BTCUSDT', 60);
  assert.equal(s.whales.sell, 5_000_000);
  assert.equal(s.whales.sellCount, 1);
  f.stop();
});

test('Фьючерсы 1000PEPE: цена делится на множитель, объём в $ не меняется', () => {
  const events = [];
  const f = mkFlow(events);
  trade(f, 'futures', '1000PEPEUSDT', 0.0123, 2_000_000, 'buy');
  for (const k of [...f.pending.keys()]) f.flush(k);
  assert.ok(Math.abs(f.lastPrice('PEPEUSDT').price - 0.0000123) < 1e-12);
  assert.ok(Math.abs(events[0].ev.usd - 2_000_000) < 1);
  f.stop();
});

test('Серия покупок засчитывается только если она односторонняя', () => {
  const events = [];
  const f = mkFlow(events);
  // порог кита PEPE (спот) $250K; части по $100K — меньше порога, но ≥ 25% порога
  const part = (side) => { trade(f, 'spot', 'PEPEUSDT', 0.00001, 100_000, side); for (const k of [...f.pending.keys()]) f.flush(k); };
  for (let i = 0; i < 4; i++) { part('buy'); part('sell'); }
  assert.equal(events.filter((e) => e.ev.type === 'series').length, 0, 'покупки и продажи вперемешку — не серия');
  for (let i = 0; i < 8; i++) part('buy'); // покупок $1.2M против продаж $0.4M — в 3 раза больше
  const series = events.filter((e) => e.ev.type === 'series');
  assert.equal(series.length, 1);
  assert.ok(series[0].ev.usd >= 1_000_000);
  assert.equal(series[0].d.alert, true);
  f.stop();
});

test('Одиночный кит вместе с парой ордеров поменьше не превращается в «серию»', () => {
  const events = [];
  const f = mkFlow(events);
  const go = (usd) => { trade(f, 'spot', 'PEPEUSDT', 0.00001, usd, 'buy'); for (const k of [...f.pending.keys()]) f.flush(k); };
  go(1_500_000); // кит: порог PEPE (спот) $250K
  go(100_000); go(100_000); go(100_000);
  assert.equal(events.filter((e) => e.ev.type === 'single').length, 1);
  assert.equal(events.filter((e) => e.ev.type === 'series').length, 0);
  f.stop();
});

test('Серия должна быть необычной для самой монеты (сравнение с потоком крупных ордеров за сутки)', () => {
  const run = (histPerMin) => {
    const events = [];
    const f = mkFlow(events);
    const st = f.state('PEPEUSDT');
    const nowMin = Math.floor(Date.now() / 60e3);
    st.startedAt = Date.now() - 4 * 3600e3;
    // 4 часа истории: каждую минуту крупные покупки на histPerMin (последние 10 минут — пусто)
    for (let m = nowMin - 240; m <= nowMin - 11; m++) st.minutes.spot.set(m, { buy: histPerMin, sell: histPerMin, buyL: histPerMin, sellL: histPerMin, buyS: 0, sellS: 0, n: 2 });
    for (let i = 0; i < 12; i++) { trade(f, 'spot', 'PEPEUSDT', 0.00001, 100_000, 'buy'); for (const k of [...f.pending.keys()]) f.flush(k); }
    f.stop();
    return events.filter((e) => e.ev.type === 'series');
  };
  // монета, где крупные покупки по $150K в минуту — обычное дело: $1.2M за 10 мин ничем не выделяются
  assert.equal(run(150_000).length, 0);
  // тихая монета: те же $1.2M за 10 мин — больше, чем в любом 10-минутном отрезке за 4 часа
  const s = run(20_000);
  assert.equal(s.length, 1);
  assert.equal(Math.round(s[0].ev.rank.pct), 100);
  assert.equal(s[0].ev.rank.hours, 4);
  assert.equal(s[0].d.alert, true);
  const m = whaleMessage(s[0].ev, s[0].d, {});
  assert.match(m.text, /Необычность: поток крупных покупок за 10 мин больше, чем в 100% таких отрезков за последние 4 ч/);
});

test('Крупные и мелкие ордера считаются отдельно', () => {
  const f = mkFlow([]);
  trade(f, 'spot', 'BTCUSDT', 60000, 200_000, 'buy');  // ≥ 10% порога — крупный
  trade(f, 'spot', 'BTCUSDT', 60000, 5_000, 'sell', Date.now() + 500); // < 1% порога — розница
  for (const k of [...f.pending.keys()]) f.flush(k);
  const s = f.summary('BTCUSDT', 60).spot;
  assert.equal(s.buyL, 200_000);
  assert.equal(s.sellS, 5_000);
  assert.equal(s.largeDelta, 200_000);
  f.stop();
});

test('Стакан: перекос и стена, переехавшая стена — не событие, снятая — спуфинг', () => {
  const ob = new OrderBookTracker(cfg);
  const book = (wallAt, wallUsd) => {
    const bids = [], asks = [];
    for (let i = 1; i <= 400; i++) {
      const pb = 100 * (1 - i * 0.0001), pa = 100 * (1 + i * 0.0001);
      bids.push([pb, (pb === wallAt ? wallUsd : 2000) / pb]);
      asks.push([pa, 1500 / pa]);
    }
    return { bids, asks };
  };
  const wallP = 100 * (1 - 80 * 0.0001);
  let r;
  for (let k = 0; k < 4; k++) r = ob.analyze('X', { spot: book(wallP, 400_000) }, 100, 0.5, { hi: 100, lo: 100 }, { spot: 300_000 });
  assert.ok(r.imbalance.b1 > 0, 'покупок больше');
  assert.ok(r.walls.some((w) => w.side === 'bid' && w.polls >= 3), 'стена найдена и живёт');
  // стена исчезла, когда цена подошла к ней вплотную, но не коснулась → «снята»
  r = ob.analyze('X', { spot: book(-1, 0) }, wallP * 1.002, 0.5, { hi: 100, lo: wallP * 1.001 }, { spot: 300_000 });
  assert.equal(r.events.filter((e) => e.fate === 'pulled').length, 1);
  // новая стена появилась и «переехала» рядом — события нет
  const ob2 = new OrderBookTracker(cfg);
  for (let k = 0; k < 4; k++) ob2.analyze('Y', { spot: book(wallP, 400_000) }, 100, 0.5, null, { spot: 300_000 });
  const moved = 100 * (1 - 84 * 0.0001);
  r = ob2.analyze('Y', { spot: book(moved, 400_000) }, 100, 0.5, null, { spot: 300_000 });
  assert.equal(r.events.length, 0);
});

test('Ликвидации: лонги — это ордера SELL, сводка и интенсивность', () => {
  const l = new Liquidations();
  l.setSymbols(['ETHUSDT'], new Map([['ETHUSDT', { symbol: 'ETHUSDT', mult: 1 }]]));
  l.startedAt = Date.now() - 2 * 3600e3;
  l.handle({ e: 'forceOrder', E: Date.now(), o: { s: 'ETHUSDT', S: 'SELL', ap: '3000', z: '100', p: '3000', q: '100', T: Date.now() } });
  l.handle({ e: 'forceOrder', E: Date.now(), o: { s: 'ETHUSDT', S: 'BUY', ap: '3000', z: '10', p: '3000', q: '10', T: Date.now() } });
  const s = l.summary('ETHUSDT', 60);
  assert.equal(s.long, 300_000);
  assert.equal(s.short, 30_000);
  assert.ok(s.intensity > 1);
});
