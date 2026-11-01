import test from 'node:test';
import assert from 'node:assert/strict';
import cfg from '../config.js';
import { decide } from '../lib/analyzer.js';
import { zoneEntry, RETRY_CODES } from '../lib/policy.js';
import { Decisions, summarize, diagnose, reasonKey, zoneDistance } from '../lib/decisions.js';
import { Trader } from '../lib/trader.js';

const plan = { dir: 'BUY', rr: 2.5, rrNow: 2, zone: [99, 100], stop: 97, t1: 106, t2: 110, entry: 99.5 };
const core = { score: 0.4, agreement: 0.8, completeness: 1, regime: { thresholdAdj: 0 }, htf: 0.5, btcScore: 0.2, isBtc: false, badNews: null, macro: null, plan };
const FOMC = { phase: 'before', minutesTo: 90, name: 'решение ФРС по ставке' };

test('Запреты на вход считаются и для оценки слабее порога (вход в зоне перед ФРС не проходит)', () => {
  const weak = decide({ ...core, score: 0.25, macro: FOMC }, cfg);
  assert.equal(weak.action, 'WATCH_BUY');
  assert.equal(weak.warnings.length, 0, 'у «готовиться» предупреждений нет');
  assert.match(weak.vetoes[0], /ФРС/, 'но запрет на вход есть');
  const r = { score: 0.25, threshold: weak.threshold, price: 99.5, vetoes: weak.vetoes, plan: { ...plan, rrNow: 2 } };
  const z = { dir: 'BUY', low: 99, high: 100 };
  const res = zoneEntry(z, r);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'veto');
  // биткоин сильно против — тоже запрет для альткоина; для самого биткоина — нет
  assert.match(decide({ ...core, score: 0.25, btcScore: -0.6 }, cfg).vetoes[0], /биткоин/);
  assert.equal(decide({ ...core, score: 0.25, btcScore: -0.6, isBtc: true }, cfg).vetoes.length, 0);
  // для продажи запрет по биткоину зеркальный
  assert.equal(decide({ ...core, score: -0.25, btcScore: -0.6 }, cfg).vetoes.length, 0);
});

test('Сильный сигнал, которому не хватает только хорошей цены, помечается (setup), отсеянный фильтром — нет', () => {
  const lowRR = decide({ ...core, plan: { ...plan, rrNow: 1.1 } }, cfg);
  assert.equal(lowRR.action, 'WATCH_BUY');
  assert.equal(lowRR.setup, 'BUY');
  assert.equal(decide(core, cfg).setup, 'BUY');
  assert.equal(decide({ ...core, agreement: 0.3 }, cfg).setup, null);
  assert.equal(decide({ ...core, macro: FOMC }, cfg).setup, null);
  assert.equal(decide({ ...core, score: 0.25 }, cfg).setup, null);
  // предупреждения для сильного сигнала — как раньше (первая причина)
  assert.match(decide({ ...core, agreement: 0.3, macro: FOMC }, cfg).warnings[0], /мало подтверждений/);
});

test('Цена в зоне: вход, если свежая оценка не слабее 70% порога, прибыль/риск хороший и нет запретов', () => {
  const z = { dir: 'BUY', low: 99, high: 100 };
  const r = { score: 0.05, threshold: 0.33, price: 99.6, vetoes: [], plan: { ...plan, rrNow: 2 } };
  const weak = zoneEntry(z, r);
  assert.equal(weak.ok, false);
  assert.equal(weak.code, 'weak');
  assert.match(weak.why, /оценка \+0\.05 — для входа нужна не слабее 0\.23 \(70% порога\)/);
  const ok = zoneEntry(z, { ...r, score: 0.24 });
  assert.equal(ok.ok, true);
  assert.equal(ok.plan, r.plan, 'план — свежего анализа');
  assert.equal(zoneEntry(z, { ...r, score: 0.24, plan: { ...plan, rrNow: 1.3 } }).code, 'rr');
  // направление сменилось — входа нет; сильный разворот — зону пора снять
  assert.equal(zoneEntry(z, { ...r, score: -0.05 }).code, 'flip');
  assert.equal(zoneEntry(z, { ...r, score: -0.05 }).flip, false);
  assert.equal(zoneEntry(z, { ...r, score: -0.3 }).flip, true);
  // продажа — зеркально
  assert.equal(zoneEntry({ dir: 'SELL', low: 100, high: 101 }, { ...r, score: -0.3 }).ok, true);
});

test('Повтор сделки — только для отказов, которые могут пройти сами', () => {
  for (const c of ['price moved', 'low R:R', 'max positions', 'error']) assert.ok(RETRY_CODES.has(c), c);
  for (const c of ['shorts off', 'not in list', 'daily loss limit', 'off', 'already open']) assert.ok(!RETRY_CODES.has(c), c);
  const t = new Trader(cfg, { file: null, client: { mode: 'demo', hasKeys: () => true } });
  assert.equal(t.skip('цена ушла', 'price moved').code, 'price moved');
  assert.equal(t.error('нет связи').code, 'error');
});

test('Журнал решений: повтор за час — та же строка, после часа — новая', () => {
  const d = new Decisions();
  const t0 = Date.now() - 3 * 3600e3;
  d.add({ sym: 'SOLUSDT', kind: 'filtered', why: 'через 2 ч ФРС' }, { now: t0 });
  d.add({ sym: 'SOLUSDT', kind: 'filtered', why: 'через 1 ч ФРС' }, { now: t0 + 30 * 60e3 });
  assert.equal(d.list.length, 1);
  assert.equal(d.list[0].n, 2);
  assert.equal(d.list[0].why, 'через 1 ч ФРС', 'текст — последний');
  d.add({ sym: 'SOLUSDT', kind: 'filtered', why: 'через 1 ч ФРС' }, { now: t0 + 2 * 3600e3 });
  assert.equal(d.list.length, 2);
  d.add({ sym: 'SOLUSDT', kind: 'opened', why: 'лонг' }, { now: t0, merge: false });
  d.add({ sym: 'SOLUSDT', kind: 'opened', why: 'лонг' }, { now: t0, merge: false });
  assert.equal(d.list.filter((x) => x.kind === 'opened').length, 2, 'сделки не склеиваются');
  assert.equal(reasonKey('оценка +0.38, порог 0.33'), reasonKey('оценка +0.41, порог 0.35'));
  // мусор в сохранённом файле не ломает журнал
  const d2 = new Decisions([null, { t: 'x' }, { t: 1, sym: 'BTCUSDT', kind: 'нет такого' }, { t: 1, sym: 'BTCUSDT', kind: 'wait', why: 'ok', key: 'wait' }]);
  assert.equal(d2.list.length, 1);
  const big = new Decisions([], { max: 5 });
  for (let i = 0; i < 9; i++) big.add({ sym: `C${i}USDT`, kind: 'wait', why: 'x' });
  assert.equal(big.list.length, 5);
  assert.equal(big.list[0].sym, 'C8USDT');
});

const tradingOk = { wanted: true, hasKeys: true, ready: true, mode: 'demo', balance: 10000, entry: 'zone', open: 0, maxPositions: 3, configErrors: [] };

test('Почему нет сделок: автоторговля выключена или Bybit не подключён — это первая строка', () => {
  const off = diagnose({ trading: { wanted: false, hasKeys: true } });
  assert.equal(off.lines[0].level, 'bad', 'ключи заданы, а TRADE=0 — скорее всего, забыли включить');
  assert.match(off.lines[0].text, /TRADE=1.*хотя ключи Bybit заданы/);
  assert.equal(diagnose({ trading: { wanted: false, hasKeys: false } }).lines[0].level, 'info', 'Bybit не настраивали — просто сигналы');
  const geo = diagnose({ trading: { ...tradingOk, ready: false, problem: 'Bybit отклонил запрос (HTTP 403): доступ из страны сервера запрещён' } });
  assert.match(geo.lines[0].text, /не подключён.*стран/);
  const paused = diagnose({ trading: { ...tradingOk, userPause: { at: 1, reason: 'команда' } } });
  assert.ok(paused.lines.some((l) => /--resume-trading/.test(l.text)));
  const full = diagnose({ trading: { ...tradingOk, open: 3 } });
  assert.ok(full.lines.some((l) => /3 из 3 позиций/.test(l.text)));
  assert.equal(diagnose({ trading: tradingOk }).lines[0].level, 'ok');
});

test('Почему нет сделок: сигналов не было, их отсеяли фильтры или цена не дошла до зоны', () => {
  const now = Date.now();
  const none = diagnose({ trading: tradingOk, list: [], now });
  assert.ok(none.lines.some((l) => /не было ни одного подтверждённого сигнала.*нет чёткого направления/.test(l.text)));

  const d = new Decisions();
  d.add({ sym: 'SOLUSDT', kind: 'filtered', why: 'оценка +0.38 достаточна для покупки, но биткоин сейчас сильно медвежий' }, { now: now - 3 * 3600e3 });
  d.add({ sym: 'ETHUSDT', kind: 'filtered', why: 'оценка +0.36 достаточна для покупки, но биткоин сейчас сильно медвежий' }, { now: now - 2 * 3600e3 });
  d.add({ sym: 'ETHUSDT', kind: 'unconfirmed', why: 'сигнал ПОКУПКА продержался 1 из 2 проверок подряд', key: 'unconfirmed' }, { now });
  const filt = diagnose({ trading: tradingOk, list: d.list, now });
  const line = filt.lines.find((l) => /отсеяли фильтры/.test(l.text));
  assert.ok(line, 'видно, что сильные оценки отсеяли фильтры');
  assert.match(line.text, /биткоин сейчас сильно медвежий.*\(2 раза\)/);
  assert.match(line.text, /не продержался 2 проверки/);

  d.add({ sym: 'SOLUSDT', kind: 'wait', why: 'сигнал ПОКУПКА подтверждён, цена ещё не в зоне', key: 'wait' }, { now });
  const far = diagnose({ trading: tradingOk, list: d.list, now, zones: [{ symbol: 'SOLUSDT', dir: 'BUY', low: 148.5, high: 149.8, price: 152.1, setup: true }] });
  assert.ok(far.lines.some((l) => /ни разу не дошла до зон входа.*TRADE_ENTRY=signal/.test(l.text)));
  assert.ok(far.lines.some((l) => /SOL покупка 148\.50–149\.80, сильный сигнал \(цена 152\.10, до зоны −1\.5%\)/.test(l.text)));
  // расстояние до зоны: цена внутри — «в зоне», для продажи цене нужно подняться
  assert.equal(zoneDistance({ dir: 'SELL', low: 164.49, high: 166.76, price: 165.61 }), 'в зоне');
  assert.equal(zoneDistance({ dir: 'SELL', low: 100, high: 102, price: 98 }), 'до зоны +2.0%');
  assert.equal(zoneDistance({ dir: 'BUY', low: 100, high: 102, price: 99 }), 'ниже зоны');
  assert.equal(zoneDistance({ dir: 'BUY', low: 100, high: 102, price: 101 }), 'в зоне');

  d.add({ sym: 'SOLUSDT', kind: 'skipped', why: 'цена на Bybit ушла от расчётной на 0.7%', key: 'price moved' }, { now });
  d.add({ sym: 'SOLUSDT', kind: 'zone-no', why: 'оценка сменила знак (−0.04)', key: 'flip' }, { now });
  const s = summarize(d.list, { now });
  assert.equal(s.inZone, 1);
  assert.equal(s.zoneNo, 1);
  const rej = diagnose({ trading: tradingOk, list: d.list, now });
  assert.ok(rej.lines.some((l) => l.level === 'warn' && /Сделка не открыта 1 раз — цена на Bybit ушла/.test(l.text)));
  assert.ok(rej.lines.some((l) => /доходила до зоны 1 раз.*сменила знак/.test(l.text)));
  // давние записи (больше суток) в разбор не попадают
  assert.equal(summarize(d.list, { now: now + 30 * 3600e3 }).inZone, 0);
});
