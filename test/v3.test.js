// v3.0 — выход по развороту, проверка спреда, виды входа в статистике, самопроверка на истории
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bybit } from '../lib/bybit.js';
import { Trader } from '../lib/trader.js';
import { MockBybit } from './bybit-mock.js';
import { SelfTest, verdict, selfTestDue, selfTestLines, retryWaitMs, childExecArgv } from '../lib/selftest.js';
import { tradeEventMessage, digestMessage } from '../lib/report.js';
import { validateConfig } from '../lib/validate.js';
import cfg from '../config.js';

const PRICES = { BTCUSDT: 60000, ETHUSDT: 3000, SOLUSDT: 150 };
const mk = (tradeOpts = {}, mockOpts = {}) => {
  const ex = new MockBybit({ prices: { ...PRICES }, ...mockOpts });
  const c = structuredClone(cfg);
  Object.assign(c.trade, { enabled: true, apiKey: ex.apiKey, apiSecret: ex.apiSecret, mode: 'demo' }, tradeOpts);
  const events = [];
  const client = new Bybit({ apiKey: ex.apiKey, apiSecret: ex.apiSecret, mode: 'demo', fetchImpl: ex.fetch });
  const t = new Trader(c, { file: null, client, onEvent: (e) => events.push(e), log: () => {} });
  return { ex, t, events };
};
const sig = (symbol, action, price, stop, t1, t2, extra = {}) => ({ symbol, action, price, score: action === 'BUY' ? 0.5 : -0.5, confidence: 70, plan: { dir: action, stop, t1, t2, zone: [price, price], rrNow: 2 }, ...extra });
const DAY = 86400e3, H = 3600e3;

test('Разворот: подтверждённый сигнал против открытой сделки закрывает её, не дожидаясь стопа', async () => {
  const { ex, t, events } = mk();
  await t.init();
  const res = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
  assert.equal(res.status, 'opened');
  assert.equal(await t.exitOnSignal('BTCUSDT', 'BUY'), null, 'сигнал в ту же сторону — сделка остаётся');
  assert.equal(await t.exitOnSignal('ETHUSDT', 'SELL'), null, 'по другой монете сделок нет');
  ex.setPrice('BTCUSDT', 59600); // цена пошла против, до стопа 59000 ещё далеко
  const shut = await t.exitOnSignal('BTCUSDT', 'SELL');
  assert.equal(shut, res.trade);
  assert.equal(shut.status, 'closed');
  assert.equal(shut.why, 'reversal');
  assert.ok(shut.r < -0.3 && shut.r > -0.6, `убыток меньше полного стопа: ${shut.r}R`);
  assert.equal(ex.positions.get('BTCUSDT:0')?.size ?? 0, 0, 'позиция на бирже закрыта');
  assert.equal([...ex.orders.values()].filter((o) => o.orderStatus === 'New').length, 0, 'цели сняты');
  const ev = events.find((e) => e.type === 'closed');
  assert.match(tradeEventMessage(ev).text, /Причина: разворот — подтверждён сигнал в обратную сторону/);
  // TRADE_EXIT_ON_REVERSAL=0 — как раньше: сделка ждёт стоп или вход в обратную сторону
  const o = mk({ exitOnReversal: false });
  await o.t.init();
  await o.t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
  assert.equal(await o.t.exitOnSignal('BTCUSDT', 'SELL'), null);
  assert.equal(o.t.openTrades().length, 1);
});

test('Вход: широкий спред на Bybit — сделка не открывается; меньший риск по итогу самопроверки', async () => {
  const wide = mk({}, { spread: 0.002 }); // покупка и продажа расходятся на 0.4%
  await wide.t.init();
  const r = await wide.t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
  assert.equal(r.code, 'wide spread');
  assert.match(r.reason, /большой разрыв между ценами покупки и продажи \(0\.40%, допустимо 0\.15%\)/);
  assert.equal((await mk({ maxSpreadPct: 0 }, { spread: 0.002 }).t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000))).code !== 'wide spread', true, '0 — не проверять');
  const { t } = mk();
  await t.init();
  t.extraRisk = { mult: 0.5, note: 'риск ×0.5: самопроверка на истории в минусе' };
  const a = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000));
  assert.equal(a.status, 'opened');
  assert.ok(a.trade.riskUsd < 105 && a.trade.riskUsd > 80, `${a.trade.riskUsd}`);
  assert.match(a.trade.warnings.join(' '), /самопроверка на истории в минусе/);
  assert.equal(t.riskStatus().extra, 'риск ×0.5: самопроверка на истории в минусе', 'видно в панели, в строке защиты');
  t.extraRisk = null;
  assert.equal(t.riskStatus().extra, null);
});

test('Статистика: вид входа записывается в сделку; итоги недели', async () => {
  const { ex, t } = mk();
  await t.init();
  const a = await t.onSignal(sig('BTCUSDT', 'BUY', 60000, 59000, 61500, 63000, { retest: { level: { role: 'breakout', low: 59800, high: 59900 } }, regime: { key: 'trend_up' } }), { zone: true });
  assert.equal(a.trade.setup, 'retest');
  assert.equal(a.trade.regime, 'trend_up');
  const b = await t.onSignal(sig('ETHUSDT', 'SELL', 3000, 3060, 2900, 2800, { retest: { level: { role: 'level', low: 3010, high: 3020 } } }), { zone: true });
  assert.equal(b.trade.setup, 'bounce');
  ex.setPrice('BTCUSDT', 63100); // обе цели
  ex.setPrice('ETHUSDT', 3070);  // стоп
  await t.tick(); await t.tick();
  const st = t.stats(30);
  assert.equal(st.n, 2);
  assert.deepEqual(Object.keys(st.bySetup).sort(), ['bounce', 'retest']);
  assert.ok(st.bySetup.retest.sumR > 1 && st.bySetup.bounce.sumR < -0.9);
  const w = t.weekSummary();
  assert.equal(w.n, 2);
  assert.equal(w.best.symbol, 'BTCUSDT');
  assert.equal(w.worst.symbol, 'ETHUSDT');
  assert.equal(t.status().week.n, 2);
  // по понедельникам итоги недели — в ежедневном обзоре
  const base = { results: [], market: null, journal: [], stats: null, liqMarket: null, whalesDay: null, newsTop: [], health: null, trading: t.status() };
  const mon = digestMessage({ ...base, now: new Date(2026, 10, 16, 9) }), tue = digestMessage({ ...base, now: new Date(2026, 10, 17, 9) });
  assert.match(mon.text, /Итоги недели: 2 сделки, в плюс 50%, итог [+−]\$[\d\s .,]+ \([+−]\d+\.\dR\); лучшая — BTC лонг \+\$[\d\s .,]+ \(\+\d\.\d\dR\); худшая — ETH шорт −\$[\d\s .,]+ \(−\d\.\d\dR\)/);
  assert.match(mon.html, /Итоги недели/);
  assert.doesNotMatch(tue.text, /Итоги недели/);
});

const stats = (o) => ({ n: 80, wins: 36, losses: 40, winRate: 0.47, tp1: 0.45, avgR: 0.2, sumR: 16, pf: 1.4, maxDD: 5, ...o });
const result = (o = {}) => ({
  at: Date.now(), days: 60, step: 2, symbols: Array(15).fill('X'), threshold: 0.33, entry: 'retest', stats: stats(o.stats), perDay: 1.33,
  halves: { first: stats({ n: 40 }), second: stats({ n: 40, ...(o.second ?? {}) }) },
  compare: { retest: stats(o.stats), touch: stats({ n: 200, avgR: -0.04, pf: 0.95 }), signal: stats({ n: 260, avgR: -0.1, pf: 0.8 }) },
  account: { protect: { start: 10000, equity: 11200, returnPct: 12, maxDdPct: 4.2, taken: 70, total: 80, skipped: { 'same side': 10 }, halted: null, worstDayPct: -2.1, curve: [[1, 10000], [2, 11200]] }, plain: { start: 10000, equity: 11500, returnPct: 15, maxDdPct: 9.1, taken: 80, total: 80, skipped: {}, halted: null, worstDayPct: -4 } },
  risk: { riskPct: 2 }, ...o.top,
});

test('Самопроверка: вывод по итогу бэктеста и текст для панели', () => {
  assert.equal(verdict(result()).level, 'good');
  assert.equal(verdict(result()).mult, 1);
  const bad = verdict(result({ stats: { avgR: -0.12, pf: 0.78 } }));
  assert.deepEqual([bad.level, bad.mult], ['bad', 0.5]);
  assert.match(bad.text, /в минусе \(в среднем −0\.12R на сделку, PF 0\.78\)/);
  assert.equal(verdict(result({ stats: { avgR: 0.02, pf: 1.04 } })).level, 'weak');
  assert.equal(verdict(result({ stats: { n: 12 } })).level, 'few', 'мало сделок — без вывода и без уменьшения риска');
  assert.equal(verdict(result({ stats: { n: 12, avgR: -1, pf: 0.1 } })).mult, 1);
  assert.equal(verdict(null).level, 'few');
  assert.match(verdict(result({ second: { pf: 0.8 } })).text, /во второй половине периода — в минусе: результат неустойчив/);
  const L = selfTestLines(result());
  assert.equal(L.length, 5);
  assert.equal(L[0], 'За 60 дней по 15 монетам: 80 сделок (1.3 в день), в плюс 47%, в среднем +0.20R на сделку, PF 1.40.');
  assert.match(L[1], /^Счёт с риском 2% на сделку и правилами защиты: \+12\.0% \(\$10[\s ]000 → \$11[\s ]200\), просадка до 4\.2%, худший день −2\.1%; сделок 70 из 80 \(пропущено: 10 — уже есть сделки в ту же сторону\)\.$/);
  assert.equal(L[2], 'Без правил защиты: +15.0%, просадка до 9.1%.');
  assert.equal(L[3], 'Вход на ретесте против входа при касании зоны (как в 2.7): +0.20R против −0.04R на сделку, PF 1.40 против 0.95.');
  assert.match(L[4], /^Вывод: на истории стратегия в плюсе/);
  assert.match(selfTestLines(result({ stats: { avgR: -0.12, pf: 0.78 } })).at(-1), /в минусе.*Пока так, риск новых сделок уменьшен вдвое\.$/);
  assert.match(selfTestLines(result({ stats: { avgR: -0.12, pf: 0.78 } }), { guard: false }).at(-1), /PF 0\.78\)\.$/, 'SELF_TEST_GUARD=0 — про уменьшение риска не пишем');
  assert.deepEqual(selfTestLines(null), []);
  assert.match(selfTestLines(result({ top: { symbols: Array(20).fill('X'), stocks: 5 } }))[0], /^За 60 дней по 15 монетам и 5 акциям: 80 сделок/);
});

test('Самопроверка: когда запускать', () => {
  const c = { enabled: true, everyDays: 7 }, now = Date.now();
  assert.equal(selfTestDue(c, { now, last: null, upMs: 5 * 60e3 }), false, 'первые 10 минут после запуска — рано');
  assert.equal(selfTestDue(c, { now, last: null, upMs: 11 * 60e3 }), true, 'итога ещё нет');
  assert.equal(selfTestDue(c, { now, last: { at: now - 3 * DAY }, upMs: H }), false, 'итог свежий');
  assert.equal(selfTestDue(c, { now, last: { at: now - 8 * DAY }, upMs: H }), true, 'итог старше недели');
  assert.equal(selfTestDue(c, { now, last: null, upMs: H, lastTry: now - 2 * H }), false, 'после неудачи — не раньше чем через 6 часов');
  assert.equal(selfTestDue(c, { now, last: null, upMs: H, running: true }), false);
  assert.equal(selfTestDue({ ...c, enabled: false }, { now, last: null, upMs: H }), false, 'SELF_TEST=0');
  // бэктест получает ключи запуска программы, кроме отладчика, слежения за файлами и своего потолка памяти
  assert.deepEqual(childExecArgv(['--import', './hook.mjs', '--max-old-space-size=512', '--inspect=0.0.0.0:9229', '--watch-path', './lib', '--watch', '--disable-proto=delete']), ['--import', './hook.mjs', '--disable-proto=delete']);
  // неудачи подряд — паузы между попытками растут: 6, 6, 12, 24, 48 ч… но не больше недели
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((f) => retryWaitMs(f) / H), [6, 6, 12, 24, 48, 168]);
  assert.equal(selfTestDue(c, { now, last: null, upMs: H, lastTry: now - 10 * H, fails: 3 }), false);
  assert.equal(selfTestDue(c, { now, last: null, upMs: H, lastTry: now - 25 * H, fails: 3 }), true);
});

test('Самопроверка: бэктест отдельным процессом — итог читается, ошибка и зависание не мешают программе', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-st-'));
  const c = { selftest: { enabled: true, days: 60, everyDays: 7, step: 2, guard: true, file: 'data/selftest.json' } };
  // вместо настоящего бэктеста — маленький сценарий: пишет итог туда, куда просит --json
  const script = (body) => fs.writeFileSync(path.join(dir, 'backtest.js'), `const fs=require('fs'),path=require('path');const a=process.argv;const f=path.join(__dirname,a[a.indexOf('--json')+1]);${body}`);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
  const st = new SelfTest(c, { dir });
  assert.equal(st.result, null);
  assert.equal(st.verdict(), null);
  script(`fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify({at:Date.now(),days:+a[a.indexOf('--days')+1],symbols:['A','B'],stats:{n:40,winRate:0.5,avgR:-0.2,pf:0.7,sumR:-8},args:a.slice(2)}));`);
  const res = await st.run({ symbols: ['BTCUSDT', '--inspect', 'NVDAUSDT', 'a b'] });
  assert.ok(res, st.lastError);
  assert.equal(res.days, 60);
  assert.ok(['--json', 'data/selftest.json', '--step', '2', '--compare', '--quiet'].every((x) => res.args.includes(x)));
  assert.equal(st.verdict().level, 'bad');
  assert.equal(st.status().level, 'bad');
  assert.match(st.lines().at(-1), /риск новых сделок уменьшен вдвое\.$/);
  assert.doesNotMatch(new SelfTest(c, { dir, guard: () => false }).lines().at(-1), /уменьшен/, 'сделки выключены — риск уменьшать не у чего');
  assert.equal(st.running, false);
  assert.equal(st.fails, 0);
  assert.deepEqual(res.args.slice(0, 2), ['BTCUSDT', 'NVDAUSDT'], 'что проверять — передаётся бэктесту, мусор отброшен');
  assert.equal(new SelfTest(c, { dir }).result.stats.n, 40, 'итог переживает перезапуск');
  // бэктест упал — прошлый итог остаётся, ошибка видна
  script(`console.error('boom: no data');process.exit(3);`);
  assert.equal(await st.run(), null);
  assert.match(st.lastError, /boom: no data/);
  assert.equal(st.result.stats.n, 40);
  assert.equal(st.due(Date.now()), false, 'сразу не повторяем');
  assert.equal(st.fails, 1);
  assert.equal(st.status().retryHours, 6);
  // счёт неудач переживает перезапуск: программа, упавшая во время проверки, не запускает её снова и снова
  const again = new SelfTest(c, { dir });
  assert.equal(again.fails, 1);
  again.startedAt = Date.now() - H;
  assert.equal(again.due(Date.now()), false);
  assert.equal(again.due(Date.now() + 7 * H), false, 'итог ещё свежий');
  again.result = null;
  assert.equal(again.due(Date.now() + 7 * H), true);
  // бэктест завис — останавливаем по времени
  script(`setInterval(()=>{},1000);`);
  assert.equal(await st.run({ timeoutMs: 300 }), null);
  assert.match(st.lastError, /слишком долго/);
  assert.equal(st.fails, 2);
  assert.equal(st.retryHours(), 12);
  // проверку запустили командой --selftest рядом с работающей программой — она подхватывает новый итог
  assert.equal(st.reload(), false, 'файл не менялся');
  const f = path.join(dir, 'data/selftest.json');
  fs.writeFileSync(f, JSON.stringify({ at: Date.now() + 1000, days: 60, symbols: ['A'], stats: { n: 50, winRate: 0.5, avgR: 0.3, pf: 1.6, sumR: 15 } }));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  fs.writeFileSync(path.join(dir, 'data/selftest-try.json'), JSON.stringify({ at: Date.now(), fails: 0 }));
  assert.equal(st.reload(), true);
  assert.equal(st.verdict().level, 'good');
  assert.equal(st.fails, 0);
  assert.equal(st.status().error, null);
  assert.equal(st.reload(), false);
  // программа останавливается во время проверки: бэктест снимается, попытка не считается неудачной
  script(`setInterval(()=>{},1000);`);
  const p = st.run({ timeoutMs: 60e3 });
  assert.equal(st.fails, 1);
  await new Promise((r) => setTimeout(r, 150));
  st.stop();
  assert.equal(await p, null);
  assert.deepEqual([st.fails, st.lastTry, st.running, st.child], [0, 0, false, null]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data/selftest-try.json'), 'utf8')), { at: 0, fails: 0 });
  st.stop(); // без запущенной проверки — ничего не делает
  // устаревший итог (старше двух периодов) выводов не даёт
  st.result.at = Date.now() - 15 * DAY;
  assert.equal(st.verdict(), null);
  assert.equal(st.status().stale, true);
});

test('Обзор: самопроверка одной строкой и выводом', () => {
  const st = { at: Date.UTC(2026, 10, 9, 3), stale: false, lines: ['За 60 дней по 15 монетам: 80 сделок.', 'Счёт…', 'Вывод: на истории стратегия в плюсе.'] };
  const d = digestMessage({ results: [], market: null, journal: [], stats: null, liqMarket: null, whalesDay: null, newsTop: [], health: null, selftest: st });
  assert.match(d.text, /🧪 Самопроверка на истории \(09\.11 \d\d:00\): За 60 дней по 15 монетам: 80 сделок\.\nВывод: на истории стратегия в плюсе\./);
  assert.match(d.html, /Вывод: на истории стратегия в плюсе\./);
  assert.doesNotMatch(digestMessage({ results: [], market: null, journal: [], stats: null, newsTop: [], health: null, selftest: { ...st, stale: true } }).text, /Самопроверка/);
});

test('Настройки 3.0: значения по умолчанию и проверка', () => {
  assert.equal(cfg.trade.exitOnReversal, true);
  assert.equal(cfg.trade.maxSpreadPct, 0.15);
  assert.deepEqual([cfg.selftest.enabled, cfg.selftest.days, cfg.selftest.everyDays, cfg.selftest.guard], [true, 60, 7, true]);
  const c = structuredClone(cfg);
  Object.assign(c.selftest, { days: 5, everyDays: 0 });
  c.trade.maxSpreadPct = -1;
  const v = validateConfig(c);
  assert.deepEqual([c.selftest.days, c.selftest.everyDays, c.trade.maxSpreadPct], [60, 7, 0.15]);
  assert.ok(v.warnings.some((w) => /SELF_TEST_DAYS=5/.test(w)) && v.warnings.some((w) => /SELF_TEST_EVERY_DAYS=0/.test(w)));
  assert.ok(v.tradeErrors.some((w) => /TRADE_MAX_SPREAD=-1/.test(w)));
});

test('Настройки: пояснение в конце строки .env не меняет значение', async () => {
  const keys = { SELF_TEST: '0   # выключить', SELF_TEST_DAYS: '90  # дней', TRADE_EXIT_ON_REVERSAL: 'off # ждать стоп', TRADE_MAX_SPREAD: '0.3\t# шире', TRADE_SYMBOLS: 'BTCUSDT, ETHUSDT  # только эти', TOP_N: '# пусто', TRADE_MODE: 'demo   # демо-счёт', TRADE_ENTRY: 'zone # на ретесте', TRADE_SL_TRIGGER: 'MarkPrice # по маркировочной' };
  const old = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  Object.assign(process.env, keys);
  try {
    const { default: c } = await import('../config.js?inline-comments');
    assert.equal(c.selftest.enabled, false);
    assert.equal(c.selftest.days, 90);
    assert.equal(c.trade.exitOnReversal, false);
    assert.equal(c.trade.maxSpreadPct, 0.3);
    assert.deepEqual(c.trade.symbols, ['BTCUSDT', 'ETHUSDT']);
    assert.equal(c.universe.size, 15, 'одно пояснение без значения — значение по умолчанию');
    assert.deepEqual([c.trade.mode, c.trade.entry, c.trade.slTriggerBy], ['demo', 'retest', 'MarkPrice']);
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
