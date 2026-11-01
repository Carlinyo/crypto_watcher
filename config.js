// Все настройки в одном месте. Значения можно переопределить переменными окружения (.env).
const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase()));
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

export default {
  // 'auto' — топ монет по капитализации и объёму; или свой список: BTCUSDT,ETHUSDT
  symbols: list(env.SYMBOLS, ['auto']),

  universe: {
    size: num(env.TOP_N, 15),
    refreshHours: num(env.TOP_REFRESH_HOURS, 24),
    candidates: 60,
    mcapWeight: 0.5,
    quote: 'USDT',
    exclude: list(env.EXCLUDE?.toLowerCase(), []),
    coingeckoUrl: 'https://api.coingecko.com/api/v3',
    coingeckoKey: env.COINGECKO_KEY || '',
    cacheFile: 'data/universe.json',
  },

  // 📈 акции США: бессрочные фьючерсы Binance на акции (контракты TRADIFI_PERPETUAL — NVDAUSDT, AAPLUSDT…)
  stocks: {
    // auto — крупнейшие компании США по капитализации; свой список тикеров: AAPL,NVDA,TSLA; 0 — не следить за акциями
    list: list(env.STOCKS, ['auto']),
    size: num(env.STOCKS_TOP, 15),
    // когда по акциям приходят сигналы: regular — основная сессия 9:30–16:00 по Нью-Йорку; extended — 4:00–20:00; any — всегда, когда идут торги
    hours: (env.STOCK_HOURS || 'regular').toLowerCase(),
    index: list(env.STOCK_INDEX, ['QQQ', 'SPY']),     // фон рынка акций (вместо биткоина у альткоинов): первый из доступных
    closedMinutes: 30,                                // по контракту нет сделок столько минут — торги закрыты
    candles: { m15: 1000, h1: 1500, h4: 1000, d1: 500 }, // больше истории: часы без торгов из неё выбрасываются
    cacheFile: 'data/stocks.json',
  },

  // сколько свечей держать по каждому таймфрейму
  candles: { m15: 400, h1: 500, h4: 500, d1: 500 },
  pollSeconds: num(env.POLL, 60),
  refresh: { h4Minutes: 5, d1Minutes: 30, derivativesMinutes: 5, fundingMinutes: 30 },

  api: {
    spot: env.BINANCE_SPOT || 'https://api.binance.com',
    futures: env.BINANCE_FUTURES || 'https://fapi.binance.com',
  },

  // базовые веса блоков (сумма = 1); дальше они подстраиваются под режим рынка
  weights: { levels: 0.18, trend: 0.22, derivatives: 0.14, flow: 0.14, indicators: 0.12, patterns: 0.1, news: 0.1 },

  signal: {
    threshold: num(env.THRESHOLD, 0.33),   // |оценка| выше → сигнал ПОКУПКА/ПРОДАЖА
    strong: 0.55,                           // |оценка| выше → «сильный», уверенность 100% по силе
    watchRatio: 0.6,                        // от 60% порога → «готовиться»
    minAgreement: num(env.MIN_AGREEMENT, 0.5), // доля веса блоков, согласных с направлением
    counterTrendExtra: 0.12,                // против старшего тренда нужна оценка выше на столько
    minRiskReward: num(env.MIN_RR, 1.5),
    cooldownMinutes: 120,                   // не повторять одинаковый сигнал чаще
    watchCooldownMinutes: 180,
    confirmPolls: num(env.CONFIRM_POLLS, 2), // сигнал должен держаться N проверок подряд
    zoneTriggerRatio: 0.7,                  // в зоне входа достаточно 70% порога
    zoneValidHours: 24,
  },

  levels: { proximityAtr: 0.6 },

  orderbook: {
    enabled: bool(env.ORDERBOOK, true),
    depthLimit: 1000,
    wallMult: 5,         // стена — корзина цен в 5+ раз крупнее медианной
    wallMinUsd: 50000,
    wallWhaleShare: 0.5, // и не меньше половины порога кита
    persistPolls: 3,     // считается настоящей, если стоит 3+ проверки подряд
  },

  derivatives: { enabled: bool(env.DERIVATIVES, true), period: '1h' },

  coinbase: { enabled: bool(env.COINBASE, true), api: 'https://api.exchange.coinbase.com', refreshSeconds: 120 },

  // 🎲 опционы Deribit по BTC и ETH: риск-реверсал, путы/коллы, «максимальная боль», подразумеваемая волатильность
  options: { enabled: bool(env.OPTIONS, true), api: 'https://www.deribit.com/api/v2', currencies: ['BTC', 'ETH'], refreshMinutes: 15 },

  market: { globalMinutes: 30, fearGreedUrl: 'https://api.alternative.me/fng/?limit=30' },

  news: {
    enabled: bool(env.NEWS, true),
    refreshMinutes: 10,
    perCoinMinutes: 20,
    lookbackHours: 24,
    halfLifeHours: 8,
    googleNews: bool(env.GOOGLE_NEWS, true),
    alerts: bool(env.NEWS_ALERTS, true),
    alertsPerDay: num(env.NEWS_ALERTS_PER_DAY, 8),
    rss: [
      { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', w: 1.0 },
      { name: 'The Block', url: 'https://www.theblock.co/rss.xml', w: 1.0 },
      { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', w: 0.9 },
      { name: 'Decrypt', url: 'https://decrypt.co/feed', w: 0.9 },
      { name: 'Blockworks', url: 'https://blockworks.co/feed', w: 0.9 },
      { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/', w: 0.8 },
      { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/', w: 0.8 },
      { name: 'BeInCrypto', url: 'https://beincrypto.com/feed/', w: 0.7 },
      { name: 'CryptoPotato', url: 'https://cryptopotato.com/feed/', w: 0.7 },
      { name: 'U.Today', url: 'https://u.today/rss', w: 0.6 },
      { name: 'NewsBTC', url: 'https://www.newsbtc.com/feed/', w: 0.6 },
      { name: 'Bitcoinist', url: 'https://bitcoinist.com/feed/', w: 0.6 },
    ],
    cryptopanicToken: env.CRYPTOPANIC_TOKEN || '',
    cryptopanicUrl: env.CRYPTOPANIC_URL || 'https://cryptopanic.com/api/developer/v2/posts/',
  },

  // 🐋 киты
  whales: {
    enabled: bool(env.WHALES, true),
    markets: list(env.WHALE_MARKETS, ['spot', 'futures']),
    minUsd: num(env.WHALE_MIN_USD, 250000),
    maxUsd: num(env.WHALE_MAX_USD, 5000000),
    volumeShare: num(env.WHALE_VOLUME_SHARE, 0.0005), // порог кита = 0.05% суточного объёма монеты
    clusterMs: 100,
    includeSells: bool(env.WHALE_SELLS, false),
    sms: bool(env.WHALE_SMS, false),
    alertX: num(env.WHALE_ALERT_X, 2),          // письмо — от 2× порога кита…
    targetPerDay: num(env.WHALE_PER_DAY, 3),     // …и только если покупка входит в N крупнейших за сутки
    maxPerDay: num(env.WHALE_MAX_PER_DAY, 30),   // общий лимит писем о китах в сутки
    cooldownMinutes: num(env.WHALE_COOLDOWN, 60),
    bypassX: 2,                                  // кит вдвое крупнее прошлого — сразу, без паузы
    largeShare: 0.1,                             // «крупные игроки» — ордера от 10% порога кита
    smallShare: 0.01,                            // «розница» — до 1% порога кита
    // серия: 3+ ордера, в сумме ≥ 4 порогов, в 3+ раза больше встречных, и (когда есть 2+ ч истории)
    // поток крупных ордеров за 10 мин — в верхних 2% всех 10-минутных отрезков за сутки
    series: { minutes: 10, minCount: 3, totalX: 4, partX: 0.25, oneSided: 3, topPct: num(env.WHALE_SERIES_TOP_PCT, 2) },
  },

  // ⚡ резкие движения: за 5 мин — от 1.2 ATR часа, за 15 мин — от 2 ATR (и не меньше 1%), объём ×2.5 к обычному
  move: {
    alerts: bool(env.MOVE_ALERTS, true),
    atrX5: num(env.MOVE_ATR_X5, 1.2),
    atrX15: num(env.MOVE_ATR_X15, 2),
    minPct: num(env.MOVE_MIN_PCT, 1),
    volX: num(env.MOVE_VOL_X, 2.5),
    cooldownMinutes: num(env.MOVE_COOLDOWN, 45),
    maxPerDay: num(env.MOVE_MAX_PER_DAY, 20),
  },

  streams: {
    spotWs: env.SPOT_WS || env.WHALE_SPOT_WS || 'wss://stream.binance.com:9443',
    spotFallback: env.SPOT_WS || env.WHALE_SPOT_WS ? [] : ['wss://data-stream.binance.vision'],
    // с апреля 2026 рыночные потоки фьючерсов Binance — только по пути /market
    futuresWs: env.FUTURES_WS || env.WHALE_FUTURES_WS || 'wss://fstream.binance.com/market',
  },

  // размер позиции в уведомлении (если указан депозит)
  risk: { deposit: num(env.DEPOSIT, 0), riskPct: num(env.RISK_PCT, 1), feePct: num(env.FEE_PCT, 0.2) },

  journal: { expireHours: num(env.SIGNAL_EXPIRE_HOURS, 72) },

  // 🤖 автоторговля на Bybit (USDT-фьючерсы) по сигналам ПОКУПКА / ПРОДАЖА
  trade: {
    enabled: bool(env.TRADE, false),
    mode: (env.TRADE_MODE || 'demo').toLowerCase(),  // demo — демо-счёт, live — настоящие деньги, testnet
    entry: (env.TRADE_ENTRY || 'zone').toLowerCase(), // zone — входить, когда цена в зоне входа; signal — сразу по сигналу
    apiKey: env.BYBIT_API_KEY || '',
    apiSecret: env.BYBIT_API_SECRET || '',
    baseUrl: env.BYBIT_URL || '',                     // по умолчанию — по режиму
    riskPct: num(env.TRADE_RISK_PCT, 2),              // убыток при срабатывании стопа, % баланса
    leverage: num(env.TRADE_LEVERAGE, 3),
    maxPositions: num(env.TRADE_MAX_POSITIONS, 3),
    maxNotionalUsd: num(env.TRADE_MAX_USD, 0),        // потолок одной позиции в $, 0 — без потолка (кроме плеча)
    dailyLossPct: num(env.TRADE_DAILY_LOSS_PCT, 6),   // убыток за день, после которого новые сделки — только завтра
    maxSlippagePct: num(env.TRADE_MAX_SLIPPAGE, 0.5), // цена на Bybit ушла от расчётной больше — сделку не открывать
    minRR: num(env.TRADE_MIN_RR, 1.2),                // минимальная прибыль/риск от цены входа на Bybit
    minConfidence: num(env.TRADE_MIN_CONFIDENCE, 0),
    shorts: bool(env.TRADE_SHORTS, true),
    symbols: list(env.TRADE_SYMBOLS, []),             // только эти монеты (пусто — все отслеживаемые)
    tp1Share: 0.5,                                    // доля позиции, которая закрывается на цели 1
    feePct: num(env.TRADE_FEE_PCT, 0.055),            // комиссия тейкера Bybit, % (учитывается в размере позиции)
    slTriggerBy: env.TRADE_SL_TRIGGER || 'LastPrice', // по какой цене срабатывает стоп: LastPrice или MarkPrice
    maxPerDay: num(env.TRADE_MAX_PER_DAY, 10),       // не больше сделок за день (защита от сбоя, который открывал бы сделку за сделкой)
    allowAnyIp: bool(env.TRADE_ALLOW_ANY_IP, false),  // реальный счёт с ключом без привязки к IP — только если явно разрешено
    stocks: bool(env.TRADE_STOCKS, false),            // открывать сделки и по акциям (фьючерсы на акции Bybit) — по умолчанию нет
    tickSeconds: 10,
  },

  // макрособытия США (ФРС, CPI, NFP): вокруг них новые входы откладываются, за несколько часов — предупреждение
  macro: {
    filter: bool(env.MACRO_FILTER, true),
    alerts: bool(env.MACRO_ALERTS, true),
    alertHours: num(env.MACRO_ALERT_HOURS, 3),
    file: 'data/events.json',
  },

  digest: { enabled: bool(env.DIGEST, true), hour: num(env.DIGEST_HOUR, 9) },

  // веб-панель: по умолчанию только с самого сервера. DASHBOARD_LOCAL_ONLY=1 — порт и так закрыт снаружи (как в docker-compose.yml)
  server: { port: num(env.PORT, 8080), host: env.HOST || '127.0.0.1', token: env.DASHBOARD_TOKEN || '', localOnly: bool(env.DASHBOARD_LOCAL_ONLY, false) },

  files: { state: env.STATE_FILE || 'data/state.json', journal: 'data/journal.json', market: 'data/market.json', trades: 'data/bybit.json' },

  notify: {
    console: true,
    email: {
      to: env.EMAIL_TO || '',
      from: env.EMAIL_FROM || env.SMTP_USER || '',
      host: env.SMTP_HOST || 'smtp.gmail.com',
      port: num(env.SMTP_PORT, 587), // 587 (STARTTLS) открыт у большинства хостингов, 465 часто блокируют
      user: env.SMTP_USER || '',
      pass: (env.SMTP_PASS || '').replace(/\s+/g, ''), // пароль приложения Google часто копируют с пробелами
    },
    // SMS — только сигналы ПОКУПКА / ПРОДАЖА
    sms: {
      to: env.SMS_TO || '',
      from: env.TWILIO_FROM || '',
      accountSid: env.TWILIO_SID || '',
      authToken: env.TWILIO_TOKEN || '',
      maxPerDay: num(env.SMS_MAX_PER_DAY, 20),       // защита от лишних расходов на SMS
    },
    // о чём писать на почту (подробно — в lib/policy.js); остальное видно в веб-панели
    events: list(env.EMAIL_EVENTS?.toLowerCase(), ['zone', 'trade', 'whales', 'critical']),
    batchSeconds: num(env.BATCH_SECONDS, 20),
    maxEmailsPerHour: num(env.MAX_EMAILS_PER_HOUR, 30),
    errorAlertAfter: num(env.ERROR_ALERT_AFTER, 10),
  },
};
