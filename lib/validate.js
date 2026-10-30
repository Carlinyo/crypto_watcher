// Проверка настроек при запуске. Опасные значения автоторговли не применяются молча:
// автоторговля выключается, а неверное значение заменяется безопасным (чтобы открытые сделки
// продолжали сопровождаться), и об этом приходит письмо. Остальное — предупреждения в журнале.
import { EMAIL_EVENT_NAMES } from './policy.js';

export const BYBIT_HOSTS = ['api.bybit.com', 'api.bytick.com', 'api-demo.bybit.com', 'api-testnet.bybit.com', 'api.bybit.kz', 'api.bybitgeorgia.ge', 'api.bybit.ae', 'api.bybit.tr', 'api.bybit.id', 'api.bybit.eu', 'api.manepa.jp', 'api-testnet.manepa.jp'];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function validateConfig(cfg) {
  const tradeErrors = [], warnings = [];
  let dashboard = null;
  const t = cfg.trade;
  // [ключ, название в .env, проверка, безопасное значение]
  const rules = [
    ['mode', 'TRADE_MODE', (v) => ['demo', 'live', 'testnet'].includes(v), 'demo', 'demo, live или testnet'],
    ['entry', 'TRADE_ENTRY', (v) => ['zone', 'signal'].includes(v), 'zone', 'zone или signal'],
    ['riskPct', 'TRADE_RISK_PCT', (v) => v >= 0.05 && v <= 5, 1, 'от 0.05 до 5 (% баланса на сделку)'],
    ['leverage', 'TRADE_LEVERAGE', (v) => v >= 1 && v <= 20, 3, 'от 1 до 20'],
    ['maxPositions', 'TRADE_MAX_POSITIONS', (v) => Number.isInteger(v) && v >= 1 && v <= 10, 3, 'целое от 1 до 10'],
    ['dailyLossPct', 'TRADE_DAILY_LOSS_PCT', (v) => v >= 0.5 && v <= 30, 6, 'от 0.5 до 30'],
    ['maxSlippagePct', 'TRADE_MAX_SLIPPAGE', (v) => v >= 0.05 && v <= 3, 0.5, 'от 0.05 до 3'],
    ['minRR', 'TRADE_MIN_RR', (v) => v >= 0.5 && v <= 10, 1.2, 'от 0.5 до 10'],
    ['minConfidence', 'TRADE_MIN_CONFIDENCE', (v) => v >= 0 && v <= 100, 0, 'от 0 до 100'],
    ['feePct', 'TRADE_FEE_PCT', (v) => v >= 0 && v <= 1, 0.055, 'от 0 до 1'],
    ['maxNotionalUsd', 'TRADE_MAX_USD', (v) => v >= 0, 0, '0 или больше'],
    ['slTriggerBy', 'TRADE_SL_TRIGGER', (v) => ['LastPrice', 'MarkPrice', 'IndexPrice'].includes(v), 'LastPrice', 'LastPrice или MarkPrice'],
    ['maxPerDay', 'TRADE_MAX_PER_DAY', (v) => Number.isInteger(v) && v >= 1 && v <= 50, 10, 'целое от 1 до 50'],
  ];
  for (const [k, name, ok, safe, hint] of rules) {
    const v = t[k];
    if ((typeof v === 'number' && !Number.isFinite(v)) || !ok(v)) {
      tradeErrors.push(`${name}=${v}: допустимо ${hint}`);
      t[k] = safe;
    }
  }
  if (t.baseUrl) {
    let host = null, https = false;
    try { const u = new URL(t.baseUrl); host = u.hostname; https = u.protocol === 'https:'; } catch { /* ниже */ }
    if (!https || !BYBIT_HOSTS.includes(host)) { tradeErrors.push(`BYBIT_URL=${t.baseUrl}: разрешены только официальные адреса Bybit по https (${BYBIT_HOSTS.slice(0, 4).join(', ')}…)`); t.baseUrl = ''; }
  }
  const badSyms = t.symbols.filter((s) => !/^[A-Z0-9]{2,20}USDT$/.test(s));
  if (badSyms.length) { tradeErrors.push(`TRADE_SYMBOLS: ${badSyms.join(', ')} — нужен формат BTCUSDT`); t.symbols = t.symbols.filter((s) => !badSyms.includes(s)); }
  if (t.enabled && (!t.apiKey || !t.apiSecret)) tradeErrors.push('TRADE=1, но не заданы BYBIT_API_KEY и BYBIT_API_SECRET');
  if (t.enabled && t.mode === 'live' && !(t.maxNotionalUsd > 0)) warnings.push('реальный счёт без TRADE_MAX_USD: размер позиции ограничен только риском и плечом — для первых недель лучше задать потолок');
  if (t.allowAnyIp && t.mode === 'live') warnings.push('TRADE_ALLOW_ANY_IP=1: реальный счёт с ключом без привязки к IP — если ключ утечёт, им сможет торговать кто угодно');
  const sms = cfg.notify.sms;
  if (!(Number.isInteger(sms.maxPerDay) && sms.maxPerDay >= 0)) { warnings.push(`SMS_MAX_PER_DAY=${sms.maxPerDay}: нужно целое число — беру 20`); sms.maxPerDay = 20; }
  if (sms.to && !/^\+\d{8,15}$/.test(sms.to)) warnings.push(`SMS_TO=${sms.to}: номер нужен в международном формате, например +37498123456`);

  const unknown = cfg.notify.events.filter((x) => !EMAIL_EVENT_NAMES[x]);
  if (unknown.length) { warnings.push(`EMAIL_EVENTS: неизвестные категории ${unknown.join(', ')} — пропускаю`); cfg.notify.events = cfg.notify.events.filter((x) => EMAIL_EVENT_NAMES[x]); }
  const em = cfg.notify.email;
  if (em.to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.to)) warnings.push(`EMAIL_TO=${em.to}: похоже на опечатку в адресе`);
  if (em.user && !em.pass) warnings.push('SMTP_USER задан, а SMTP_PASS — нет: письма отправляться не будут');

  const sv = cfg.server;
  if (sv.port && !LOOPBACK.has(sv.host) && !sv.token && !sv.localOnly) {
    dashboard = `веб-панель не запущена: она открыта бы на ${sv.host}:${sv.port} всему интернету без пароля. Задайте DASHBOARD_TOKEN (длинный случайный) или HOST=127.0.0.1`;
    sv.port = 0;
  }
  if (sv.token && sv.token.length < 16) warnings.push('DASHBOARD_TOKEN короче 16 символов — его легко подобрать');
  return { tradeErrors, warnings, dashboard };
}
