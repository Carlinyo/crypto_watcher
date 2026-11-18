import test from 'node:test';
import assert from 'node:assert/strict';
import { Bybit } from '../lib/bybit.js';
import { Trader, sizePosition, floorStep, roundTick } from '../lib/trader.js';
import { MockBybit } from './bybit-mock.js';
import cfg from '../config.js';

const PRICES = { BTCUSDT: 60000, ETHUSDT: 3000, SOLUSDT: 150, '1000PEPEUSDT': 0.01, SHIB1000USDT: 0.02 };
const mk = (mockOpts = {}, tradeOpts = {}) => {
  const ex = new MockBybit({ prices: { ...PRICES }, ...mockOpts });
  const c = structuredClone(cfg);
  Object.assign(c.trade, { enabled: true, apiKey: ex.apiKey, apiSecret: ex.apiSecret, mode: 'demo' }, tradeOpts);
  const events = [];
  const client = new Bybit({ apiKey: ex.apiKey, apiSecret: ex.apiSecret, mode: 'demo', fetchImpl: ex.fetch });
  const t = new Trader(c, { file: null, client, onEvent: (e) => events.push(e), log: () => {} });
  return { ex, t, events, c };
};
const sig = (symbol, action, price, stop, t1, t2) => ({ symbol, action, price, score: action === 'BUY' ? 0.5 : -0.5, confidence: 70, plan: { dir: action, stop, t1, t2, zone: [price, price], rrNow: 2 } });
const pos = (ex, sym, idx = 0) => ex.positions.get(`${sym}:${idx}`);

test('Bybit: округление под шаг цены и объёма', () => {
  assert.equal(floorStep(0.18762, '0.001'), 0.187);
  assert.equal(floorStep(12345.9, '100'), 12300);
  assert.equal(roundTick(59000.04, '0.10', 'down'), 59000);
  assert.equal(roundTick(0.00970049, '0.0000001', 'up'), 0.0097005);
});

test('Bybit: размер позиции от риска 2% с комиссиями и ограничение плечом', () => {
  const info = { qtyStep: '0.1', minQty: 0.1, minNotional: 5, maxMktQty: 0 };
  // стоп 2% от цены: убыток на монету 2 + 0.11 комиссий → 200 / 2.11 = 94.7 монеты (позиция $9 470 < $10 000)
  const a = sizePosition({ equity: 10000, available: 10000, riskPct: 2, leverage: 3, maxPositions: 3, feePct: 0.055, price: 100, stop: 98, info });
  assert.equal(a.ok, true);
  assert.equal(a.contracts, 94.7);
  assert.ok(Math.abs(a.riskUsd - 199.8) < 0.1);
  assert.equal(a.limitedBy, null);
  // стоп 0.5%: по риску вышло бы $32 800 — ограничиваем долей плеча ($10 000), риск падает до ~0.6%
  const b = sizePosition({ equity: 10000, available: 10000, riskPct: 2, leverage: 3, maxPositions: 3, feePct: 0.055, price: 100, stop: 99.5, info });
  assert.equal(b.contracts, 100);
  assert.match(b.limitedBy, /плечо ×3/);
  assert.ok(b.riskPct < 0.7);
  // слишком маленький счёт
  const c = sizePosition({ equity: 5, available: 5, riskPct: 2, leverage: 3, maxPositions: 3, feePct: 0.055, price: 100, stop: 98, info });
  assert.equal(c.ok, false);
});

test('Bybit: контракт для монеты — PEPE → 1000PEPEUSDT, SHIB → SHIB1000USDT', async () => {
  const { t } = mk();
  await t.init();
  assert.equal(t.ready, true, t.problem);
  assert.deepEqual([t.resolve('BTCUSDT').symbol, t.resolve('BTCUSDT').mult], ['BTCUSDT', 1]);
  assert.deepEqual([t.resolve('PEPEUSDT').symbol, t.resolve('PEPEUSDT').mult], ['1000PEPEUSDT', 1000]);
  assert.deepEqual([t.resolve('SHIBUSDT').symbol, t.resolve('SHIBUSDT').mult], ['SHIB1000USDT', 1000]);
  assert.equal(t.resolve('ZECUSDT'), null);
});

test('Bybit: лонг — стоп на бирже, две цели, безубыток после цели 1, стоп на цель 1, закрытие с прибылью', async () => {
  const { ex, t, events } = mk();
  await t.init();
  const res = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
  assert.equal(res.status, 'opened', res.reason);
  const tr = res.trade;
  assert.ok(tr.riskUsd <= 200 && tr.riskUsd > 150, `риск ${tr.riskUsd}`);
  assert.equal(pos(ex, 'BTCUSDT').stopLoss, 59000);
  const tps = [...ex.orders.values()].filter((o) => o.reduceOnly && o.orderStatus === 'New');
  assert.deepEqual(tps.map((o) => o.price).sort(), [61500, 63000]);
  assert.ok(Math.abs(tps[0].qty + tps[1].qty - pos(ex, 'BTCUSDT').size) < 1e-9);

  ex.setPrice('BTCUSDT', 61600); // цель 1 исполнилась
  await t.tick();
  assert.equal(tr.tp1Done, true);
  assert.ok(pos(ex, 'BTCUSDT').stopLoss > tr.entry, 'стоп в безубытке (с комиссией)');
  ex.setPrice('BTCUSDT', 62300); // больше полпути к цели 2
  await t.tick();
  assert.equal(tr.trailed, true);
  assert.equal(pos(ex, 'BTCUSDT').stopLoss, 61500);
  ex.setPrice('BTCUSDT', 61400); // откат — стоп на цели 1
  await t.tick();
  assert.equal(tr.status, 'closed');
  assert.equal(tr.why, 'trail');
  assert.ok(tr.pnl > 0 && tr.r > 1, `итог ${tr.pnl} (${tr.r}R)`);
  assert.deepEqual(events.map((e) => e.type), ['tp1', 'trail', 'closed']);
  assert.equal([...ex.orders.values()].filter((o) => o.orderStatus === 'New').length, 0, 'лишних ордеров не осталось');
});

test('Bybit: шорт по стопу — убыток около заложенного риска', async () => {
  const { ex, t } = mk();
  await t.init();
  const res = await t.onSignal(sig('ETHUSDT', 'SELL', 3000, 3060, 2900, 2800));
  assert.equal(res.status, 'opened', res.reason);
  assert.equal(pos(ex, 'ETHUSDT').side, 'Sell');
  ex.setPrice('ETHUSDT', 3070);
  await t.tick();
  const tr = res.trade;
  assert.equal(tr.why, 'stop');
  assert.ok(tr.r < -0.9 && tr.r > -1.1, `R ${tr.r}`);
});

test('Bybit: PEPE торгуется контрактом 1000PEPEUSDT с пересчётом цены', async () => {
  const { ex, t } = mk();
  await t.init();
  const res = await t.onSignal(sig('PEPEUSDT', 'BUY', 0.00001, 0.0000097, 0.0000105, 0.000011));
  assert.equal(res.status, 'opened', res.reason);
  const p = pos(ex, '1000PEPEUSDT');
  assert.equal(p.size % 100, 0);
  assert.equal(p.stopLoss, 0.0097);
  assert.equal(res.trade.entry.toPrecision(3), '0.0000100');
});

test('Bybit: защита — чужая позиция, лимит позиций, ушедшая цена, ключ с выводом, страна', async () => {
  {
    const { ex, t } = mk();
    await t.init();
    ex.route('POST', '/v5/order/create', { symbol: 'SOLUSDT', side: 'Buy', orderType: 'Market', qty: '1' });
    const r = await t.onSignal(sig('SOLUSDT', 'BUY', 150, 145, 160, 170));
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /не программой/);
  }
  {
    const { t } = mk({}, { maxPositions: 1 });
    await t.init();
    assert.equal((await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000))).status, 'opened');
    const r = await t.onSignal(sig('ETHUSDT', 'BUY', 3000, 2940, 3100, 3200));
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /максимум/);
  }
  {
    const { ex, t } = mk();
    await t.init();
    ex.setPrice('BTCUSDT', 60800);
    const r = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /ушла от расчётной/);
  }
  {
    const { t } = mk({ permissions: { ContractTrade: ['Order', 'Position'], Wallet: ['AccountTransfer', 'Withdraw'] } });
    await t.init();
    assert.equal(t.ready, false);
    assert.match(t.problem, /вывода/);
    const r = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
    assert.equal(r.status, 'error');
  }
  {
    const { ex, t } = mk();
    ex.httpStatus = 403;
    await t.init();
    assert.match(t.problem, /стран/);
  }
  {
    const { t } = mk({ ips: ['*'] });
    await t.init();
    assert.equal(t.ready, true);
    assert.match(t.warnings.join(' '), /не привязан к IP/);
  }
});

test('Bybit: обратный сигнал закрывает сделку и открывает противоположную', async () => {
  const { ex, t, events } = mk();
  await t.init();
  const a = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
  const b = await t.onSignal(sig('BTCUSDT', 'SELL', 60000, 61000, 58500, 57000));
  assert.equal(b.status, 'opened', b.reason);
  assert.equal(a.trade.status, 'closed');
  assert.equal(a.trade.why, 'reversed');
  assert.equal(b.reversed.id, a.trade.id);
  assert.equal(pos(ex, 'BTCUSDT').side, 'Sell');
  assert.equal(events.filter((e) => e.type === 'closed').length, 1);
});

test('Bybit: дневной лимит убытка останавливает новые сделки', async () => {
  const { ex, t, events } = mk({}, { dailyLossPct: 1 });
  await t.init();
  await t.onSignal(sig('ETHUSDT', 'SELL', 3000, 3060, 2900, 2800));
  ex.setPrice('ETHUSDT', 3070);
  await t.tick();
  assert.ok(t.state.paused, 'пауза включилась');
  assert.ok(events.some((e) => e.type === 'paused'));
  const r = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /остановлена/);
});

test('Bybit: снятый стоп возвращается, после цели 1 и отката — выход в безубыток, по сроку — закрытие', async () => {
  {
    const { ex, t, events } = mk();
    await t.init();
    await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
    pos(ex, 'BTCUSDT').stopLoss = 0; // кто-то снял стоп вручную
    await t.tick();
    assert.equal(pos(ex, 'BTCUSDT').stopLoss, 59000);
    assert.ok(events.some((e) => e.type === 'sl-restored'));
  }
  {
    const { ex, t } = mk();
    await t.init();
    const { trade } = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
    ex.setPrice('BTCUSDT', 61600); // цель 1
    ex.setPrice('BTCUSDT', 59900); // и сразу откат ниже входа, пока программа не успела перенести стоп
    await t.tick();
    assert.equal(trade.status, 'closed');
    assert.equal(trade.why, 'breakeven');
    assert.ok(trade.pnl > 0, 'половина взята на цели 1');
  }
  {
    const { t } = mk();
    await t.init();
    const { trade } = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
    trade.openedAt -= 73 * 3600e3;
    await t.tick();
    assert.equal(trade.why, 'expired');
  }
});

test('Bybit: режим хеджирования и команда «закрыть всё»', async () => {
  const { ex, t } = mk({ hedge: true });
  await t.init();
  const a = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
  const b = await t.onSignal(sig('ETHUSDT', 'SELL', 3000, 3060, 2900, 2800));
  assert.equal(a.trade.positionIdx, 1);
  assert.equal(b.trade.positionIdx, 2);
  const closed = await t.closeAll();
  assert.equal(closed.length, 2);
  assert.equal(ex.positions.size, 0);
  assert.ok(closed.every((x) => x.why === 'manual-all'));
});

test('Bybit: ручная пауза (--pause-trading) не даёт открывать сделки, --resume-trading снимает', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-')), file = path.join(dir, 'bybit.json');
  const { ex } = mk();
  const c = structuredClone(cfg);
  Object.assign(c.trade, { enabled: true, apiKey: ex.apiKey, apiSecret: ex.apiSecret });
  const t = new Trader(c, { file, client: new Bybit({ apiKey: ex.apiKey, apiSecret: ex.apiSecret, fetchImpl: ex.fetch }), log: () => {} });
  await t.init();
  Trader.pause(file, 'проверка');
  const a = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
  assert.equal(a.status, 'skipped');
  assert.match(a.reason, /приостановлена.*проверка/);
  Trader.resume(file);
  assert.equal((await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000))).status, 'opened');
  assert.ok(fs.existsSync(file), 'сделки сохранены на диск');
});

test('Bybit: ошибочные планы отклоняются — стоп у самой цены, стоп за ликвидацией, просадка за день', async () => {
  {
    const { t } = mk();
    await t.init();
    const r = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59950, 61500, 63000));
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /слишком близко/);
  }
  {
    const { t } = mk({}, { leverage: 20 });
    await t.init();
    const r = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 57000, 66000, 70000));
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /ликвидация/);
  }
  {
    const { ex, t, events } = mk();
    await t.init();
    ex.cash = 9300; // за день счёт потерял 7% (лимит 6%)
    const r = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /остановлена/);
    assert.ok(events.some((e) => e.type === 'paused'));
  }
});

test('Bybit: позицию перевернули вручную — сделка программы закрыта, чужая позиция не трогается', async () => {
  const { ex, t } = mk();
  await t.init();
  const { trade } = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
  const p = pos(ex, 'BTCUSDT');
  ex.reduce(p, p.size, 60000, 0.00055);
  ex.route('POST', '/v5/order/create', { symbol: 'BTCUSDT', side: 'Sell', orderType: 'Market', qty: '0.05' });
  await t.tick();
  assert.equal(trade.status, 'closed');
  assert.equal(trade.why, 'manual');
  assert.equal(pos(ex, 'BTCUSDT').side, 'Sell', 'ручной шорт остался');
});

test('Bybit: отменённая вручную цель выставляется снова', async () => {
  const { ex, t, events } = mk();
  await t.init();
  const { trade } = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
  ex.orders.get(`${trade.id}-t1`).orderStatus = 'Cancelled';
  trade.tpCheckedAt = 0;
  await t.tick();
  const again = ex.orders.get(`${trade.id}-t1r1`);
  assert.ok(again && again.orderStatus === 'New' && again.price === 61500);
  assert.equal(trade.tpIds.t1, `${trade.id}-t1r1`);
  assert.ok(events.some((e) => e.type === 'tp-restored'));
  await t.closeAll();
  assert.equal([...ex.orders.values()].filter((o) => o.orderStatus === 'New').length, 0, 'при закрытии сняты и новые цели');
});

test('Bybit: реальный счёт — только с ключом, привязанным к IP; лишние права — предупреждение', async () => {
  {
    const { t } = mk({ ips: ['*'] }, { mode: 'live' });
    t.mode = 'live';
    await t.init();
    assert.equal(t.ready, false);
    assert.match(t.problem, /привязан к IP/);
  }
  {
    const { t } = mk({ ips: ['*'] }, { mode: 'live', allowAnyIp: true });
    t.mode = 'live';
    await t.init();
    assert.equal(t.ready, true, t.problem);
  }
  {
    const { t } = mk({ permissions: { ContractTrade: ['Order', 'Position'], Spot: ['SpotTrade'], Wallet: [] } });
    await t.init();
    assert.match(t.warnings.join(' '), /лишние права \(Spot\)/);
  }
});

test('Bybit: дневной лимит числа сделок', async () => {
  const { t } = mk({}, { maxPerDay: 1 });
  await t.init();
  assert.equal((await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000))).status, 'opened');
  const r = await t.onSignal(sig('ETHUSDT', 'BUY', 3000, 2940, 3100, 3200));
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /дневной максимум/);
});

test('Bybit: при запуске находятся ордера программы без записи о сделке', async () => {
  const { ex, t, events } = mk();
  ex.route('POST', '/v5/order/create', { symbol: 'SOLUSDT', side: 'Buy', orderType: 'Market', qty: '10' });
  ex.route('POST', '/v5/order/create', { symbol: 'SOLUSDT', side: 'Sell', orderType: 'Limit', qty: '10', price: '160.000', reduceOnly: true, orderLinkId: 'cwlost123ab-t1' });
  await t.init();
  assert.equal(t.ready, true);
  assert.equal(t.orphans.length, 1);
  assert.match(t.warnings.join(' '), /без записи о сделке \(SOLUSDT\)/);
  assert.ok(events.some((e) => e.type === 'orphans'));
});
