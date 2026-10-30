import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, readJson } from '../lib/storage.js';
import { InstanceLock } from '../lib/lock.js';
import { validateConfig } from '../lib/validate.js';
import cfg from '../config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cw-safe-'));

test('Хранение: запись атомарная, файл только для владельца, повреждённый файл восстанавливается из копии', () => {
  const dir = tmp(), f = path.join(dir, 'state.json');
  writeJsonAtomic(f, { v: 1 });
  writeJsonAtomic(f, { v: 2 });
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(readJson(f), { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f}.bak`, 'utf8')), { v: 1 });
  fs.writeFileSync(f, '{"v": 3, "обрыв'); // запись оборвалась на середине
  const logs = [];
  assert.deepEqual(readJson(f, null, { log: (m) => logs.push(m) }), { v: 1 });
  assert.ok(logs.some((m) => /повреждён/.test(m)));
  assert.ok(fs.readdirSync(dir).some((x) => x.includes('.corrupt-')), 'испорченный файл сохранён для разбора');
  fs.writeFileSync(`${f}.bak`, 'мусор');
  assert.equal(readJson(f, 'по умолчанию', { log: () => {} }), 'по умолчанию');
  assert.ok(!fs.readdirSync(dir).some((x) => x.includes('.tmp-')), 'временных файлов не осталось');
});

test('Блокировка: вторая копия программы не запускается, пока первая работает', () => {
  const f = path.join(tmp(), 'instance.lock');
  const a = new InstanceLock(f), b = new InstanceLock(f);
  b.me.host = 'другой-сервер';
  assert.equal(a.tryAcquire().ok, true);
  const r = b.tryAcquire();
  assert.equal(r.ok, false);
  assert.equal(r.holder.id, a.me.id);
  a.release();
  assert.equal(b.tryAcquire().ok, true, 'после остановки первой — можно');
  b.release();
  // отметка устарела (процесс убит без остановки) — блокировка снимается
  const c = new InstanceLock(f), d = new InstanceLock(f, { staleMs: 50 });
  c.me.host = 'другой-сервер';
  c.tryAcquire();
  clearInterval(c.timer);
  writeJsonAtomic(f, { ...c.me, beat: Date.now() - 1000 });
  assert.equal(d.tryAcquire().ok, true);
  d.release();
  // тот же компьютер, процесс уже завершён — блокировка снимается
  const e = new InstanceLock(f);
  writeJsonAtomic(f, { id: 'x', pid: 999999, host: e.me.host, startedAt: 0, beat: Date.now() });
  assert.equal(e.tryAcquire().ok, true);
  e.release();
});

test('Настройки: опасные значения автоторговли не применяются, панель без пароля наружу не открывается', () => {
  const c = structuredClone(cfg);
  Object.assign(c.trade, { enabled: true, apiKey: 'k', apiSecret: 's', mode: 'liv', riskPct: 25, leverage: 100, baseUrl: 'https://evil.example.com', symbols: ['BTCUSDT', 'btc'] });
  c.notify.events = ['zone', 'whales', 'всё'];
  Object.assign(c.server, { host: '0.0.0.0', port: 8080, token: '', localOnly: false });
  const v = validateConfig(c);
  const all = v.tradeErrors.join('\n');
  assert.match(all, /TRADE_MODE=liv/);
  assert.match(all, /TRADE_RISK_PCT=25/);
  assert.match(all, /TRADE_LEVERAGE=100/);
  assert.match(all, /BYBIT_URL/);
  assert.match(all, /TRADE_SYMBOLS/);
  assert.equal(c.trade.mode, 'demo');
  assert.equal(c.trade.riskPct, 1);
  assert.equal(c.trade.leverage, 3);
  assert.equal(c.trade.baseUrl, '');
  assert.deepEqual(c.trade.symbols, ['BTCUSDT']);
  assert.deepEqual(c.notify.events, ['zone', 'whales']);
  assert.match(v.dashboard, /без пароля/);
  assert.equal(c.server.port, 0);
  // в Docker порт открыт только на самом сервере — так можно
  const d = structuredClone(cfg);
  Object.assign(d.server, { host: '0.0.0.0', port: 8080, token: '', localOnly: true });
  assert.equal(validateConfig(d).dashboard, null);
  // нормальные настройки — без ошибок
  const ok = structuredClone(cfg);
  Object.assign(ok.trade, { enabled: true, apiKey: 'k', apiSecret: 's', baseUrl: 'https://api-demo.bybit.com' });
  assert.deepEqual(validateConfig(ok).tradeErrors, []);
});

test('Почта: тема без переводов строк, контакты в журнале скрыты, неотправленное письмо уходит повторно', async () => {
  const { Notifier, cleanSubject, maskEmail, maskPhone } = await import('../lib/notifier.js');
  assert.equal(cleanSubject('🟢 ПОКУПКА\r\nBcc: someone@evil.com'), '🟢 ПОКУПКА Bcc: someone@evil.com');
  assert.equal(maskEmail('karenmeliqyan221@gmail.com'), 'k******@gmail.com');
  assert.equal(maskPhone('+37498628881'), '+374*****881');
  const c = structuredClone(cfg);
  Object.assign(c.notify.email, { to: 'a@b.c', user: 'u', pass: 'p' });
  c.notify.console = false;
  const n = new Notifier(c);
  clearInterval(n.retryTimer);
  assert.match(n.channels({ masked: true }).join(), /a\*@b\.c/);
  let fail = true;
  const sent = [];
  n.mailer = { sendMail: async (m) => { if (fail) throw new Error('SMTP недоступен'); sent.push(m); } };
  const errs = console.error;
  console.error = () => {};
  try {
    assert.equal(await n.email('Тема\nс переносом', 't', '<p>t</p>'), false);
    assert.equal(n.retryQ.length, 1);
    await n.runRetries(Date.now()); // рано — ещё не время
    assert.equal(sent.length, 0);
    fail = false;
    const log = console.log;
    console.log = () => {};
    await n.runRetries(Date.now() + 121e3);
    console.log = log;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, 'Тема с переносом');
    assert.equal(n.retryQ.length, 0);
  } finally { console.error = errs; }
});

test('Ссылки из новостей: только http(s)', async () => {
  const { safeHref } = await import('../lib/format.js');
  assert.equal(safeHref('https://www.coindesk.com/a?b=1'), 'https://www.coindesk.com/a?b=1');
  assert.equal(safeHref('javascript:alert(1)'), '');
  assert.equal(safeHref(' JAVASCRIPT:alert(1)'), '');
  assert.equal(safeHref('data:text/html,<script>x</script>'), '');
  assert.equal(safeHref('не ссылка'), '');
});

test('Веб-панель: пароль, заголовки безопасности, только чтение, /health без подробностей', async () => {
  const { startServer } = await import('../lib/server.js');
  const port = 38000 + Math.floor(Math.random() * 2000);
  const snap = {
    results: [], market: { global: null, fng: null }, stats: { total: 0 }, journal: [], alerts: [], whales: [], streams: [], feeds: [], liqBig: [], events: [], zones: [], emailEvents: [], trading: null, liqMarket: null, whales4h: {},
    health: { lastCycleSec: 1, text: 'внутренние подробности' },
    news: [{ title: 'Опасная ссылка', link: 'javascript:alert(1)', s: 0, time: Date.now(), source: 'x' }],
  };
  const app = { health: () => ({ ok: true, lastCycleSec: 1, cycles: 2, uptimeMin: 3, text: 'внутренние подробности' }), snapshot: () => snap, results: new Map(), chartSvg: () => '' };
  const log = console.log;
  console.log = () => {};
  const srv = startServer({ server: { port, host: '127.0.0.1', token: 'очень-длинный-пароль-панели' } }, app);
  await new Promise((r) => srv.once('listening', r));
  console.log = log;
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/?token=неверный`)).status, 401);
    const ok = await fetch(`${base}/?token=${encodeURIComponent('очень-длинный-пароль-панели')}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(ok.headers.get('x-frame-options'), 'DENY');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.match(ok.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await ok.text();
    assert.ok(!html.includes('javascript:'), 'опасная ссылка не попала на страницу');
    assert.match(html, /Опасная ссылка/);
    assert.equal((await fetch(`${base}/?token=x`, { method: 'POST' })).status, 405);
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.text, undefined, '/health без пароля не раскрывает подробности');
  } finally { srv.close(); }
});

test('SMS: дневной лимит защищает от лишних расходов', async () => {
  const { Notifier } = await import('../lib/notifier.js');
  const c = structuredClone(cfg);
  Object.assign(c.notify.sms, { to: '+37400000000', from: '+15550000000', accountSid: 'AC1', authToken: 't', maxPerDay: 2 });
  const n = new Notifier(c);
  clearInterval(n.retryTimer);
  let calls = 0;
  n.sendSms = async () => { calls++; };
  assert.equal(await n.sms('a'), true);
  assert.equal(await n.sms('b'), true);
  assert.equal(await n.sms('c'), false);
  assert.equal(calls, 2);
});

test('Настройки: лимит сделок в день и формат номера для SMS проверяются', () => {
  const c = structuredClone(cfg);
  Object.assign(c.trade, { maxPerDay: 0 });
  c.notify.sms.to = '98628881';
  const res = validateConfig(c);
  assert.ok(res.tradeErrors.some((x) => /TRADE_MAX_PER_DAY/.test(x)));
  assert.equal(c.trade.maxPerDay, 10);
  assert.ok(res.warnings.some((x) => /SMS_TO/.test(x)));
});
