#!/usr/bin/env node
// Наблюдатель за криптовалютой: анализирует рынок и уведомляет о хорошей цене для покупки/продажи.
//
//   node index.js                       — следить за парами из .env (по умолчанию BTCUSDT)
//   node index.js ETHUSDT SOLUSDT       — следить за выбранными парами
//   node index.js BTCUSDT --once        — один подробный отчёт и выход
//   node index.js --test-notify         — отправить тестовое сообщение во все каналы
//   node index.js --no-whales           — без отслеживания китов
//   node index.js --interval 15m --htf 1h --threshold 0.3

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(dir, '.env');
if (fs.existsSync(envFile) && process.loadEnvFile) process.loadEnvFile(envFile);

const { default: cfg } = await import('./config.js');
const { fetchMarket } = await import('./lib/data.js');
const { analyze } = await import('./lib/analyzer.js');
const { NewsService } = await import('./lib/news.js');
const { Notifier, formatReport, statusLine } = await import('./lib/notifier.js');
const { sleep } = await import('./lib/http.js');
const { selectUniverse } = await import('./lib/universe.js');
const { WhaleWatcher } = await import('./lib/whales.js');
const { formatWhale, formatWhaleSms } = await import('./lib/notifier.js');

// ── аргументы командной строки ──
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const bool = (name) => { const i = args.indexOf(`--${name}`); if (i < 0) return false; args.splice(i, 1); return true; };
const once = bool('once');
const verbose = bool('verbose');
const testNotify = bool('test-notify');
if (bool('no-news')) cfg.news.enabled = false;
if (bool('no-whales')) cfg.whales.enabled = false;
cfg.interval = flag('interval') ?? cfg.interval;
cfg.higherInterval = flag('htf') ?? cfg.higherInterval;
cfg.signal.threshold = Number(flag('threshold') ?? cfg.signal.threshold);
cfg.pollSeconds = Number(flag('poll') ?? cfg.pollSeconds);
cfg.universe.size = Number(flag('top') ?? cfg.universe.size);

// ── список монет: вручную (аргументы / SYMBOLS) или автоматически (топ по капитализации и объёму) ──
const manual = args.length ? args.map((s) => s.toUpperCase())
  : cfg.symbols[0]?.toLowerCase() === 'auto' ? null : cfg.symbols.map((s) => s.toUpperCase());
let coins = manual ? manual.map((symbol) => ({ symbol })) : [];
let universeAt = 0;
const symbolsText = () => coins.map((c) => c.symbol.replace(/USDT$/, '')).join(', ');

const news = new NewsService(cfg);
const notifier = new Notifier(cfg);

// ── состояние сигналов сохраняется на диск, чтобы после перезапуска не слать повторы ──
const stateFile = path.resolve(dir, cfg.stateFile);
const state = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(stateFile, 'utf8')))) state.set(k, v); } catch { /* первый запуск */ }
function saveState() {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(Object.fromEntries(state), null, 2));
  } catch (e) { console.error('Не удалось сохранить состояние:', e.message); }
}

const errors = new Map(); // symbol → сколько проверок подряд неудачны
const lastResults = new Map(); // symbol → последний результат анализа (для писем о китах)

// ── 🐋 киты ──
const whaleSent = new Map(); // symbol → { at, usd } последнего уведомления
async function onWhale(ev) {
  const prev = whaleSent.get(ev.symbol);
  const cool = cfg.whales.cooldownMinutes * 60e3;
  const bigger = prev && ev.usd >= prev.usd * cfg.whales.bypassX;
  const summary = whales.summary(ev.symbol, 1);
  const line = `🐋 ${new Date(ev.time).toLocaleTimeString('ru-RU')} ${ev.side === 'buy' ? 'покупка' : 'продажа'} ${ev.symbol} ${ev.market} ${ev.type === 'series' ? `серия ×${ev.count}` : ''} ${(ev.usd / 1e6).toFixed(2)}M$`;
  if (prev && Date.now() - prev.at < cool && !bigger) { console.log(`${line} (уведомление недавно было — только в журнал)`); return; }
  whaleSent.set(ev.symbol, { at: Date.now(), usd: ev.usd });
  console.log(line);
  const name = coins.find((c) => c.symbol === ev.symbol)?.name;
  const { subject, text } = formatWhale(ev, summary, lastResults.get(ev.symbol), name);
  await notifier.broadcast({ subject, text, smsText: cfg.whales.sms ? formatWhaleSms(ev) : null });
}
const whales = new WhaleWatcher(cfg, (ev) => { onWhale(ev).catch((e) => console.error('🐋', e.message)); });

function coinTable(list) {
  return list.map((c, i) => `${String(i + 1).padStart(2)}. ${c.symbol.padEnd(10)}${c.name ? ` ${c.name}` : ''}`
    + (c.mcap ? ` — №${c.mcapRank} по капитализации, №${c.volRank} по объёму`
      : c.volRank ? ` — №${c.volRank} по объёму на Binance` : '')).join('\n');
}

async function refreshUniverse() {
  if (manual) return;
  if (coins.length && Date.now() - universeAt < cfg.universe.refreshHours * 3600e3) return;
  const res = await selectUniverse(cfg, path.resolve(dir, cfg.universe.cacheFile));
  const before = new Set(coins.map((c) => c.symbol));
  const first = coins.length === 0;
  coins = res.coins;
  universeAt = Date.now();
  if (!once) await whales.setSymbols(coins.map((c) => c.symbol)).catch((e) => console.error('🐋 Не удалось запустить:', e.message));
  const added = coins.filter((c) => !before.has(c.symbol)).map((c) => c.symbol);
  const removed = [...before].filter((s) => !coins.some((c) => c.symbol === s));

  console.log(`\nТоп-${coins.length} монет (${res.source}):\n${coinTable(coins)}\n`);
  if (once || (!first && !added.length && !removed.length)) return;
  const text = first
    ? `Crypto Watcher запущен.\nТаймфрейм: ${cfg.interval} / ${cfg.higherInterval}, проверка каждые ${cfg.pollSeconds} с.\nИсточник рейтинга: ${res.source}.\n\nОтслеживаю:\n${coinTable(coins)}`
    : `Список монет обновлён (${res.source}).\nДобавлены: ${added.join(', ') || '—'}\nУбраны: ${removed.join(', ') || '—'}\n\nТеперь отслеживаю:\n${coinTable(coins)}`;
  await notifier.broadcast({ subject: first ? '✅ Crypto Watcher запущен' : '🔄 Crypto Watcher: обновлён список монет', text });
}

async function check(symbol, name) {
  const [market, newsRes] = await Promise.all([
    fetchMarket(cfg, symbol),
    news.analyze(symbol, name).catch((e) => ({ score: 0, notes: [`ошибка новостей: ${e.message}`], disabled: true })),
  ]);
  market.whales = whales.summary(symbol, 4); // китовые деньги за 4 часа учитываются в блоке 3
  const r = analyze(symbol, market, newsRes, cfg);
  lastResults.set(symbol, r);

  if (once) { console.log(`\n${formatReport(r)}\n`); return; }
  console.log(statusLine(r));
  if (verbose) console.log(formatReport(r), '\n');

  // уведомляем о сигналах и о переходе в «готовность»; без повторов в течение cooldown
  const prev = state.get(symbol);
  if (r.action === 'NEUTRAL') {
    if (prev?.action !== 'NEUTRAL') { state.set(symbol, { action: 'NEUTRAL', at: Date.now() }); saveState(); }
    return;
  }
  const cooldown = cfg.signal.cooldownMinutes * 60e3;
  const fresh = prev && Date.now() - prev.at < cooldown;
  if (prev?.action === r.action && fresh) return;
  // «готовность» не шлём, если только что был полноценный сигнал в ту же сторону
  if (r.action.startsWith('WATCH') && prev?.action === r.action.replace('WATCH_', '') && fresh) return;

  await notifier.send(r);
  state.set(symbol, { action: r.action, at: Date.now(), price: r.price });
  saveState();
}

async function onError(symbol, e) {
  const n = (errors.get(symbol) || 0) + 1;
  errors.set(symbol, n);
  console.error(`${new Date().toLocaleTimeString('ru-RU')} ${symbol}: ошибка — ${e.message}`);
  if (n === cfg.notify.errorAlertAfter) {
    await notifier.broadcast({
      subject: `⚠️ Crypto Watcher: нет данных по ${symbol}`,
      text: `${n} проверок подряд по ${symbol} завершились ошибкой.\nПоследняя ошибка: ${e.message}\nПрограмма продолжает попытки.`,
    });
  }
}

if (testNotify) {
  console.log(`Отправляю тест в каналы: ${notifier.channels().join(', ')}`);
  await notifier.broadcast({
    subject: '✅ Crypto Watcher: тестовое уведомление',
    text: `Если вы это читаете — уведомления настроены.\nМонеты: ${manual ? manual.join(', ') : `автоматически топ-${cfg.universe.size} по капитализации и объёму`}\nТаймфрейм: ${cfg.interval} / ${cfg.higherInterval}`,
    smsText: 'Crypto Watcher: test OK, notifications are working',
  });
  console.log('Готово. Ошибки каналов (если были) выведены выше.');
  process.exit(0);
}

let running = true;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('\nОстанавливаюсь…'); running = false; process.exit(0); });
process.on('unhandledRejection', (e) => console.error('Необработанная ошибка:', e));

await refreshUniverse();
if (manual && !once && cfg.whales.enabled) await whales.setSymbols(manual).catch((e) => console.error('🐋 Не удалось запустить:', e.message));
console.log(`Слежу за: ${symbolsText()} | ТФ ${cfg.interval} (подтверждение ${cfg.higherInterval}) | порог ${cfg.signal.threshold} | опрос каждые ${cfg.pollSeconds} с`);
console.log(`Уведомления: ${notifier.channels().join(', ')}`);
if (cfg.whales.enabled && !once) console.log(`Киты: ${cfg.whales.markets.join(' + ')}, от ${(cfg.whales.minUsd / 1e3).toFixed(0)}K$ (порог зависит от объёма монеты)${cfg.whales.includeSells ? ', покупки и продажи' : ', только покупки'}`);
if (!once) console.log('Колонки: зоны торгов | тренд | деривативы | индикаторы | паттерны | новости. Ctrl+C — выход.\n');

do {
  const started = Date.now();
  try { await refreshUniverse(); } catch (e) { console.error('Ошибка обновления списка монет:', e.message); }
  for (const c of coins) {
    if (!running) break;
    try { await check(c.symbol, c.name); errors.set(c.symbol, 0); }
    catch (e) { await onError(c.symbol, e); }
    await sleep(250); // пауза между монетами, чтобы не упираться в лимиты API
  }
  // следующий цикл через POLL секунд от начала текущего
  if (!once && running) await sleep(Math.max(5000, cfg.pollSeconds * 1000 - (Date.now() - started)));
} while (!once && running);
