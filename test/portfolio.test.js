// v3.0 — счёт целиком: сделки бэктеста и правила защиты капитала
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateAccount, accountText } from '../lib/portfolio.js';
import cfg from '../config.js';

const H = 3600e3, T = Date.UTC(2026, 8, 1);
const rules = (o = {}) => ({ ...cfg.trade, riskPct: 2, leverage: 3, maxPositions: 3, maxSameSide: 2, maxOpenRiskPct: 4, lossStreakPause: 3, lossPauseHours: 12, weeklyLossPct: 10, dailyLossPct: 6, maxDrawdownPct: 15, cooldownHours: 6, volRiskMult: 0.5, maxPerDay: 10, feePct: 0.055, ...o });
// сделка: монета, сторона, вход через h0 часов, длится dur часов, итог r, стоп 5% (плечо не ограничивает)
const tr = (sym, side, h0, dur, r, o = {}) => ({ sym, side, t0: T + h0 * H, t1: T + (h0 + dur) * H, r, stopPct: 0.05, ...o });
const near = (a, b, eps) => Math.abs(a - b) <= eps;

test('Счёт: риск 2% на сделку, сложный процент, потолок позиции плечом', () => {
  const a = simulateAccount([tr('BTCUSDT', 'BUY', 0, 5, 2), tr('ETHUSDT', 'BUY', 10, 5, 2)], rules());
  assert.equal(a.taken, 2);
  assert.ok(near(a.returnPct, 7.98, 0.1), `две сделки по +2R при риске ~1.96%: ${a.returnPct}`);
  assert.equal(a.maxDdPct, 0);
  assert.deepEqual([a.wins, a.losses], [2, 0]);
  // стоп 0.5%: по риску позиция была бы $32 800 — ограничена долей плеча $10 000, убыток по стопу 0.5% баланса
  const b = simulateAccount([tr('BTCUSDT', 'BUY', 0, 5, -1, { stopPct: 0.005 })], rules());
  assert.ok(near(b.returnPct, -0.5, 0.01), `${b.returnPct}`);
  assert.ok(near(b.maxDdPct, 0.5, 0.01));
  assert.deepEqual(simulateAccount([], rules()).taken, 0);
});

test('Счёт: не больше двух сделок в одну сторону, трёх позиций и 4% суммарного риска', () => {
  const four = [tr('BTCUSDT', 'BUY', 0, 20, 1), tr('ETHUSDT', 'BUY', 1, 20, 1), tr('SOLUSDT', 'BUY', 2, 20, 1), tr('XRPUSDT', 'BUY', 3, 20, 1)];
  const a = simulateAccount(four, rules());
  assert.equal(a.taken, 2);
  assert.deepEqual(a.skipped, { 'same side': 2 });
  const old = simulateAccount(four, rules(), { protect: false });
  assert.equal(old.taken, 3, 'без правил защиты — три позиции в одну сторону');
  assert.deepEqual(old.skipped, { 'max positions': 1 });
  // покупка и продажа открыты: третьей сделке риска не осталось; первая уже в безубытке — место есть
  const mix = [tr('BTCUSDT', 'BUY', 0, 20, 1), tr('ETHUSDT', 'SELL', 1, 20, 1), tr('SOLUSDT', 'BUY', 2, 20, 1)];
  assert.deepEqual(simulateAccount(mix, rules()).skipped, { 'open risk': 1 });
  mix[0].safeAt = T + 1.5 * H;
  const safe = simulateAccount(mix, rules());
  assert.equal(safe.taken, 3);
  assert.equal(safe.total, 3);
});

test('Счёт: серия убытков — после двух риск вдвое меньше, после трёх пауза; пауза по монете', () => {
  const seq = [tr('BTCUSDT', 'BUY', 0, 2, -1), tr('ETHUSDT', 'BUY', 3, 2, -1), tr('SOLUSDT', 'BUY', 6, 2, -1), tr('XRPUSDT', 'BUY', 10, 2, 3), tr('ADAUSDT', 'BUY', 21, 2, 3)];
  const a = simulateAccount(seq, rules({ dailyLossPct: 0 }));
  assert.deepEqual(a.skipped, { 'loss streak': 1 }, 'сделка через 2 часа после третьего убытка пропущена');
  assert.equal(a.taken, 4);
  // убытки: 1.96% + 1.96% + 0.98% (третья — с половинным риском); пятая (+3R) тоже с половинным риском
  const lost = 10000 * (1 - 0.01957) * (1 - 0.01957) * (1 - 0.00978);
  assert.ok(near(a.equity, lost * (1 + 3 * 0.00978), 3), `${a.equity}`);
  assert.ok(near(a.maxDdPct, (1 - lost / 10000) * 100, 0.02));
  // пауза по монете: убыток по SOL, через 3 часа снова SOL — нет; другая монета — да
  const cd = simulateAccount([tr('SOLUSDT', 'BUY', 0, 2, -1), tr('SOLUSDT', 'SELL', 5, 2, 2), tr('ETHUSDT', 'SELL', 5, 2, 2), tr('SOLUSDT', 'SELL', 9, 2, 2)], rules());
  assert.deepEqual(cd.skipped, { cooldown: 1 });
  assert.equal(cd.taken, 3);
});

test('Счёт: дневной и недельный лимиты убытка, остановка по просадке', () => {
  const day = simulateAccount([tr('BTCUSDT', 'BUY', 0, 1, -1), tr('ETHUSDT', 'BUY', 2, 1, -1), tr('SOLUSDT', 'SELL', 4, 1, 2), tr('XRPUSDT', 'SELL', 30, 1, 2)], rules({ dailyLossPct: 3 }));
  assert.deepEqual(day.skipped, { 'daily loss': 1 }, 'после −3.9% за день новых сделок нет до завтра');
  assert.equal(day.taken, 3);
  assert.ok(near(day.worstDayPct, -3.9, 0.1), `${day.worstDayPct}`);
  const week = simulateAccount([tr('BTCUSDT', 'BUY', 0, 1, -1), tr('ETHUSDT', 'BUY', 24, 1, -1), tr('SOLUSDT', 'SELL', 72, 1, 2), tr('XRPUSDT', 'SELL', 9 * 24, 1, 2)], rules({ weeklyLossPct: 3.5 }));
  assert.deepEqual(week.skipped, { 'weekly loss': 1 });
  assert.equal(week.taken, 3, 'через 9 дней убытки вышли из недельного окна');
  // просадка 5% от максимума — остановка: дальше сделок нет
  const losses = Array.from({ length: 6 }, (_, i) => tr(`C${i}USDT`, i % 2 ? 'SELL' : 'BUY', i * 30, 2, -1));
  const dd = simulateAccount(losses, rules({ maxDrawdownPct: 5, lossStreakPause: 0, weeklyLossPct: 0, dailyLossPct: 0 }));
  assert.equal(dd.taken, 4, '−2%, −2%, −1%, −1% → просадка 5.7%');
  assert.deepEqual(dd.skipped, { drawdown: 2 });
  assert.equal(dd.halted, T + (3 * 30 + 2) * H);
  const none = simulateAccount(losses, rules({ maxDrawdownPct: 5 }), { protect: false });
  assert.equal(none.taken, 6, 'без защиты — все шесть убытков подряд полным риском');
  assert.ok(none.maxDdPct > 11 && dd.maxDdPct < 6);
  assert.match(accountText(dd), /^−5\.7% \(\$10[\s ]000 → \$9[\s ]4\d\d\), просадка до 5\.7%, худший день −2\.0%; сделок 4 из 6 \(пропущено: 2 — остановка по просадке\); ⛔ торговля остановлена по просадке 2026-09-04$/);
});

test('Счёт: в волатильном рынке риск вдвое меньше; не больше N сделок в день', () => {
  const v = simulateAccount([tr('BTCUSDT', 'BUY', 0, 2, -1, { regime: 'volatile' })], rules());
  assert.ok(near(v.returnPct, -0.98, 0.02), `${v.returnPct}`);
  const many = Array.from({ length: 5 }, (_, i) => tr(`C${i}USDT`, i % 2 ? 'SELL' : 'BUY', i * 2, 1, 0.1));
  const a = simulateAccount(many, rules({ maxPerDay: 3 }));
  assert.deepEqual(a.skipped, { 'daily trades': 2 });
  assert.ok(a.curve.length >= 2 && a.curve.at(-1)[1] === a.equity);
});
