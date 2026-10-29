import {Process} from './envConfig.js'
// Все настройки в одном месте. Секреты задаются через переменные окружения (.env).
export default {
  // 'auto' — автоматически топ монет по капитализации и объёму; или свой список: BTCUSDT,ETHUSDT
  symbols: (Process.env.SYMBOLS || 'auto').split(',').map((s) => s.trim()).filter(Boolean),

  universe: {
    size: Number(Process.env.TOP_N || 15),             // сколько монет отслеживать
    refreshHours: Number(Process.env.TOP_REFRESH_HOURS || 24), // как часто пересматривать список
    candidates: 60,     // из скольких крупнейших по капитализации выбирать
    mcapWeight: 0.5,    // вес места по капитализации (остальное — по объёму торгов)
    quote: 'USDT',
    exclude: (Process.env.EXCLUDE || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean), // напр. doge,trx
    coingeckoUrl: 'https://api.coingecko.com/api/v3',
    coingeckoKey: Process.env.COINGECKO_KEY || '', // необязательно (бесплатный demo-ключ)
    cacheFile: 'data/universe.json',
  },
  interval: Process.env.INTERVAL || '1h',     // рабочий таймфрейм
  higherInterval: Process.env.HTF || '4h',    // старший таймфрейм для подтверждения тренда
  candles: 500,                               // сколько свечей загружать
  pollSeconds: Number(Process.env.POLL || 60), // как часто проверять цену

  api: {
    spot: 'https://api.binance.com',
    futures: 'https://fapi.binance.com',
  },

  // Вес каждого блока анализа в итоговой оценке (сумма = 1)
  weights: {
    volumeProfile: 0.20, // 1. исторические зоны торгов
    trend: 0.25,         // 2. тренд
    derivatives: 0.20,   // 3. открытый интерес, фандинг, поток ордеров
    indicators: 0.15,    // 3. RSI, MACD, Боллинджер, объём
    patterns: 0.10,      // 4. паттерны
    news: 0.10,          // 5. новости и настроения рынка
  },

  signal: {
    threshold: Number(Process.env.THRESHOLD || 0.35), // |оценка| выше → сигнал
    strong: 0.55,                                     // |оценка| выше → сильный сигнал
    minRiskReward: 1.5,   // не уведомлять, если прибыль/риск хуже этого
    cooldownMinutes: 120, // не повторять одинаковый сигнал чаще
  },

  volumeProfile: {
    lookback: 300,     // сколько свечей учитывать в профиле объёма
    bins: 60,          // число ценовых корзин
    valueArea: 0.70,   // доля объёма в Value Area
    proximityAtr: 0.6, // «цена у уровня» = ближе чем 0.6 ATR
  },

  news: {
    enabled: true,
    refreshMinutes: 10,
    lookbackHours: 24,
    rss: [
      'https://cointelegraph.com/rss',
      'https://www.coindesk.com/arc/outboundfeeds/rss/',
      'https://decrypt.co/feed',
    ],
    cryptopanicToken: Process.env.CRYPTOPANIC_TOKEN || '', // необязательно
    cryptopanicUrl: Process.env.CRYPTOPANIC_URL || 'https://cryptopanic.com/api/developer/v2/posts/',
    fearGreedUrl: 'https://api.alternative.me/fng/?limit=1',
  },

  // 🐋 Отслеживание китов — крупные рыночные покупки в реальном времени
  whales: {
    enabled: Process.env.WHALES !== '0',
    markets: (Process.env.WHALE_MARKETS || 'spot,futures').split(',').map((s) => s.trim()),
    minUsd: Number(Process.env.WHALE_MIN_USD || 250000),   // меньше этой суммы — не кит, для любой монеты
    maxUsd: Number(Process.env.WHALE_MAX_USD || 5000000),  // порог не выше этого даже для BTC
    volumeShare: Number(Process.env.WHALE_VOLUME_SHARE || 0.0005), // порог = 0.05% суточного объёма монеты
    clusterMs: 100,          // сделки одного ордера приходят почти одновременно — склеиваем
    includeSells: Process.env.WHALE_SELLS === '1', // уведомлять и о крупных продажах
    sms: Process.env.WHALE_SMS === '1',            // дублировать китовые покупки по SMS (по умолчанию — только почта)
    cooldownMinutes: Number(Process.env.WHALE_COOLDOWN || 30), // не чаще раза в N минут по монете…
    bypassX: 2,              // …если только новый кит не крупнее прошлого в 2 раза
    series: { minutes: 10, minCount: 3, totalX: 3, partX: 0.25 }, // покупка частями: 3+ сделки по ¼ порога, в сумме ≥ 3 порогов за 10 мин
    spotWs: Process.env.WHALE_SPOT_WS || 'wss://stream.binance.com:9443',
    futuresWs: Process.env.WHALE_FUTURES_WS || 'wss://fstream.binance.com',
  },

  // файл, где хранится последний сигнал по каждой паре — чтобы после перезапуска не было повторов
  stateFile: Process.env.STATE_FILE || 'data/state.json',

  notify: {
    console: true,

    // Почта через SMTP (для Gmail нужен «пароль приложения», см. README)
    email: {
      to: Process.env.EMAIL_TO || '',
      from: Process.env.EMAIL_FROM || Process.env.SMTP_USER || '',
      host: Process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(Process.env.SMTP_PORT || 465),
      user: Process.env.SMTP_USER || '',
      pass: Process.env.SMTP_PASS || '',
    },

    // SMS через Twilio
    sms: {
      to: Process.env.SMS_TO || '',
      from: Process.env.TWILIO_FROM || '',
      accountSid: Process.env.TWILIO_SID || '',
      authToken: Process.env.TWILIO_TOKEN || '',
      // SMS приходит только на сигналы ПОКУПКА / ПРОДАЖА, всё остальное — на почту
    },

    // предупредить, если по паре столько проверок подряд закончились ошибкой
    errorAlertAfter: Number(Process.env.ERROR_ALERT_AFTER || 10),
  },
};
