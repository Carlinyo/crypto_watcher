import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeFlow } from '../lib/trades.js';
import { OrderBookTracker } from '../lib/orderbook.js';
import { Liquidations } from '../lib/liquidations.js';
import { whaleMessage } from '../lib/report.js';
import { validateConfig } from '../lib/validate.js';
import cfg from '../config.js';

// whales — настройки китов поверх обычных; по умолчанию здесь без нижней границы письма (WHALE_EMAIL_MIN_USD=0):
// эти тесты проверяют основные правила — порог, серию, паузу; граница проверяется отдельно, в конце файла
const mkFlow = (events, whales = { emailMinUsd: 0 }) => {
  const c = structuredClone(cfg);
  Object.assign(c.whales, whales);
  const f = new TradeFlow(c, { onWhale: (ev, d) => events.push({ ev, d }) });
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

// ── письмо только от WHALE_EMAIL_MIN_USD (по умолчанию $30M) ──
const flushAll = (f) => { for (const k of [...f.pending.keys()]) f.flush(k); };

test('Киты: письмо — только когда одна сделка от $30M', () => {
  assert.equal(cfg.whales.emailMinUsd, 30_000_000, 'значение по умолчанию');
  const events = [];
  const f = mkFlow(events, {});
  const go = (usd, side = 'buy') => { trade(f, 'spot', 'BTCUSDT', 60000, usd, side); flushAll(f); return events[events.length - 1]; };
  const small = go(7_500_000); // кит (порог $1M), раньше письмо пришло бы
  assert.equal(small.ev.type, 'single');
  assert.equal(small.d.alert, false);
  assert.match(small.d.reason, /меньше порога уведомления \(от \$30M\)/);
  const big = go(34_200_000);
  assert.deepEqual([big.ev.type, big.d.alert, big.d.rule], ['single', true, 'от $30M']);
  const m = whaleMessage(big.ev, big.d, {});
  assert.equal(m.subject, '🐋 Кит купил BTC на $34.20M (спот)');
  assert.match(m.text, /уведомление: от \$30M/);
  assert.equal(go(45_000_000, 'sell').d.alert, false, 'продажи по умолчанию не присылаются');
  f.stop();
  // WHALE_SELLS=1 — крупные продажи тоже
  const ev2 = [];
  const f2 = mkFlow(ev2, { includeSells: true });
  trade(f2, 'spot', 'BTCUSDT', 60000, 31_000_000, 'sell'); flushAll(f2);
  assert.equal(ev2[0].d.alert, true);
  assert.equal(whaleMessage(ev2[0].ev, ev2[0].d, {}).subject, '🐋 Кит продал BTC на $31.00M (спот)');
  f2.stop();
});

test('Киты: набор за 10 минут — письмо, когда крупные покупки вместе дошли до $30M', () => {
  const events = [];
  const f = mkFlow(events, {});
  const go = (usd, side = 'buy', market = 'spot') => { trade(f, market, 'BTCUSDT', 60000, usd, side); flushAll(f); };
  go(9_000_000); go(8_000_000); go(600_000); go(7_000_000); // $24.6M: киты и крупный ордер поменьше — до суммы не дошли
  assert.equal(events.filter((e) => e.d.alert).length, 0);
  assert.equal(events.filter((e) => e.ev.type === 'series').length, 0, 'набор меньше $30M в список не попадает');
  go(100_000);  // мелочь (меньше четверти порога кита) в набор не идёт
  go(6_000_000); // теперь $30.6M
  const series = events.filter((e) => e.ev.type === 'series');
  assert.equal(series.length, 1);
  assert.ok(Math.abs(series[0].ev.usd - 30_600_000) < 1, `${series[0].ev.usd}`);
  assert.equal(series[0].ev.count, 5);
  assert.deepEqual([series[0].d.alert, series[0].d.rule], [true, 'от $30M']);
  const m = whaleMessage(series[0].ev, series[0].d, {});
  assert.equal(m.subject, '🐋 Кит скупает BTC: $30.60M за 10 мин (спот)');
  assert.match(m.text, /5 крупных покупок за 10 мин на \$30\.60M/);
  assert.equal(events.filter((e) => e.d.alert).length, 1, 'одно письмо, а не по письму на каждую сделку');
  // покупки продолжаются: следующие 10 минут по этому рынку набор заново не объявляется
  go(5_000_000);
  assert.equal(events.filter((e) => e.ev.type === 'series').length, 1);
  f.stop();
});

test('Киты: спот и фьючерсы считаются отдельно, покупки вперемешку с продажами — не набор', () => {
  const events = [];
  const f = mkFlow(events, {});
  const go = (usd, side, market = 'spot') => { trade(f, market, 'BTCUSDT', 60000, usd, side); flushAll(f); };
  // $36M покупок против $15M продаж — меньше чем втрое: это активный рынок, а не кит
  go(12_000_000, 'buy'); go(8_000_000, 'sell'); go(12_000_000, 'buy'); go(7_000_000, 'sell'); go(12_000_000, 'buy');
  assert.equal(events.filter((e) => e.ev.type === 'series').length, 0);
  assert.equal(events.filter((e) => e.d.alert).length, 0);
  // на фьючерсах $20M и на споте остаток — вместе больше $30M, но это разные рынки
  const ev2 = [];
  const f2 = mkFlow(ev2, {});
  const go2 = (usd, market) => { trade(f2, market, 'BTCUSDT', 60000, usd, 'buy'); flushAll(f2); };
  f2.thresholds.set('futures:BTCUSDT', 1_000_000);
  go2(10_000_000, 'futures'); go2(10_000_000, 'futures'); go2(8_000_000, 'spot'); go2(8_000_000, 'spot');
  assert.equal(ev2.filter((e) => e.d.alert || e.ev.type === 'series').length, 0);
  go2(11_000_000, 'futures'); // фьючерсы: $31M
  const s = ev2.filter((e) => e.ev.type === 'series');
  assert.deepEqual([s.length, s[0].ev.market, s[0].d.alert], [1, 'futures', true]);
  f.stop(); f2.stop();
});

test('Киты: после письма о сделке от $30M новое — только если набор вдвое больше', () => {
  const events = [];
  const f = mkFlow(events, {});
  const go = (usd) => { trade(f, 'spot', 'BTCUSDT', 60000, usd, 'buy'); flushAll(f); return events[events.length - 1]; };
  assert.equal(go(32_000_000).d.alert, true);
  const next = go(9_000_000); // всего за 10 минут $41M — это тот же кит, письмо уже было
  assert.equal(events.filter((e) => e.d.alert).length, 1);
  assert.match(next.d.reason, /недавно было уведомление|меньше порога уведомления/);
  f.stop();
  // одна сделка от $30M приходит всегда — и сразу после письма о наборе, и вторая подряд
  const ev3 = [];
  const f3 = mkFlow(ev3, {});
  const go3 = (usd) => { trade(f3, 'spot', 'BTCUSDT', 60000, usd, 'buy'); flushAll(f3); };
  go3(16_000_000); go3(15_000_000); // набор $31M — письмо
  go3(35_000_000);                  // и тут же одна сделка на $35M — тоже письмо
  go3(31_000_000);                  // ещё одна
  assert.deepEqual(ev3.filter((e) => e.d.alert).map((e) => [e.ev.type, Math.round(e.ev.usd / 1e6)]), [['series', 31], ['single', 35], ['single', 31]]);
  f3.stop();
  // а если покупки за те же 10 минут удвоились — второе письмо с общей суммой
  const ev2 = [];
  const f2 = mkFlow(ev2, {});
  const go2 = (usd) => { trade(f2, 'spot', 'BTCUSDT', 60000, usd, 'buy'); flushAll(f2); };
  go2(32_000_000); go2(20_000_000); go2(14_000_000);
  const alerts = ev2.filter((e) => e.d.alert);
  assert.deepEqual(alerts.map((e) => e.ev.type), ['single', 'series']);
  assert.ok(Math.abs(alerts[1].ev.usd - 66_000_000) < 1);
  f2.stop();
});

test('Киты: маленькая монета — серия на $1.2M при границе $30M письма не даёт; граница настраивается', () => {
  const events = [];
  const f = mkFlow(events, {});
  for (let i = 0; i < 12; i++) { trade(f, 'spot', 'PEPEUSDT', 0.00001, 100_000, 'buy'); flushAll(f); }
  trade(f, 'spot', 'PEPEUSDT', 0.00001, 1_500_000, 'buy'); flushAll(f); // кит по меркам PEPE
  assert.equal(events.filter((e) => e.d.alert).length, 0);
  assert.equal(events.filter((e) => e.ev.type === 'single').length, 1, 'в панели кит виден, письма нет');
  f.stop();
  // WHALE_EMAIL_MIN_USD=1000000 — граница $1M: та же покупка даёт письмо
  const ev2 = [];
  const f2 = mkFlow(ev2, { emailMinUsd: 1_000_000 });
  trade(f2, 'spot', 'PEPEUSDT', 0.00001, 1_500_000, 'buy'); flushAll(f2);
  assert.deepEqual([ev2[0].d.alert, ev2[0].d.rule], [true, 'от $1M']);
  f2.stop();
});

test('Киты: от $30M письмо приходит, даже если за сутки были киты крупнее', () => {
  const run = (whales) => {
    const events = [];
    const f = mkFlow(events, whales);
    const st = f.state('BTCUSDT'), now = Date.now();
    st.startedAt = now - 8 * 3600e3; // программа работает давно: действует правило «в числе крупнейших за сутки»
    for (const usd of [50e6, 45e6, 40e6]) st.whales.push({ t: now - 2 * 3600e3, side: 'buy', usd, market: 'spot', whale: true, price: 60000 });
    trade(f, 'spot', 'BTCUSDT', 60000, 31_000_000, 'buy'); flushAll(f);
    f.stop();
    return events[0].d;
  };
  assert.deepEqual([run({}).alert, run({}).rule], [true, 'от $30M']);
  const legacy = run({ emailMinUsd: 0 }); // без границы — как раньше: только крупнейшая покупка дня
  assert.equal(legacy.alert, false);
  assert.match(legacy.reason, /входит в 1 крупнейших за сутки/);
  // граница ниже обычного порога (BTC: 2 × $1M) ничего не меняет — правило крупнейших за сутки остаётся
  assert.equal(run({ emailMinUsd: 500_000 }).alert, false);
});

test('Киты: настройка WHALE_EMAIL_MIN_USD читается из .env и проверяется', async () => {
  const old = process.env.WHALE_EMAIL_MIN_USD;
  process.env.WHALE_EMAIL_MIN_USD = '10000000   # от $10 млн';
  try {
    const { default: c } = await import('../config.js?whale-min');
    assert.equal(c.whales.emailMinUsd, 10_000_000);
  } finally {
    if (old === undefined) delete process.env.WHALE_EMAIL_MIN_USD; else process.env.WHALE_EMAIL_MIN_USD = old;
  }
  const bad = structuredClone(cfg);
  bad.whales.emailMinUsd = -5;
  const v = validateConfig(bad);
  assert.equal(bad.whales.emailMinUsd, 30_000_000);
  assert.ok(v.warnings.some((w) => /WHALE_EMAIL_MIN_USD=-5/.test(w)));
  const zero = structuredClone(cfg);
  zero.whales.emailMinUsd = 0;
  assert.equal(validateConfig(zero).warnings.some((w) => /WHALE_EMAIL_MIN_USD/.test(w)), false, '0 — без границы, это не ошибка');
  assert.equal(zero.whales.emailMinUsd, 0);
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
