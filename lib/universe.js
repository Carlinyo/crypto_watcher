// Автоматический выбор монет: топ по капитализации и объёму торгов.
// Источник рейтинга — CoinGecko; в список попадают только монеты с парой к USDT на Binance.
// Стейблкоины, обёрнутые и стейкинговые токены, токены золота исключаются.
import fs from 'node:fs';
import path from 'node:path';
import { getJSON } from './http.js';

const STABLE = new Set(['usdt', 'usdc', 'dai', 'fdusd', 'tusd', 'usdp', 'usde', 'usds', 'pyusd', 'usdd', 'busd', 'susde',
  'susds', 'usd0', 'rlusd', 'usd1', 'frax', 'fxusd', 'eurc', 'euri', 'eur', 'gusd', 'lusd', 'usdtb', 'bsc-usd', 'usdx', 'usdb',
  'usdf', 'usdg', 'aeur', 'xusd', 'bfusd', 'usyc', 'buidl', 'ustb']);
const NON_MARKET = new Set(['wbtc', 'weth', 'steth', 'wsteth', 'weeth', 'cbbtc', 'wbeth', 'reth', 'meth', 'jitosol', 'bnsol',
  'lbtc', 'solvbtc', 'xaut', 'paxg', 'btcb', 'msol', 'cbeth', 'ezeth', 'rseth']);
const NAME_RE = /wrapped|staked|bridged|restaked|liquid staking|tokenized|treasury/i;

export const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'BNBUSDT', 'SOLUSDT', 'DOGEUSDT', 'TRXUSDT', 'ADAUSDT',
  'LINKUSDT', 'AVAXUSDT', 'SUIUSDT', 'XLMUSDT', 'HBARUSDT', 'LTCUSDT', 'TONUSDT'];

function isExcluded(c, extra) {
  const s = c.symbol.toLowerCase();
  if (STABLE.has(s) || NON_MARKET.has(s) || extra.includes(s)) return true;
  if (NAME_RE.test(c.name || '')) return true;
  if (/usd|eur/.test(s) && c.price && Math.abs(c.price - 1) < 0.05) return true; // похоже на стейблкоин
  return false;
}

async function binanceVolumes(cfg, quote) {
  const tickers = await getJSON(`${cfg.api.spot}/api/v3/ticker/24hr?type=MINI`, { tries: 2, timeout: 30000 });
  return new Map(tickers
    .filter((t) => t.symbol.endsWith(quote) && +t.quoteVolume > 0 && +t.count > 0)
    .map((t) => [t.symbol, +t.quoteVolume]));
}

// Основной способ: рейтинг CoinGecko (капитализация + мировой объём)
async function fromCoinGecko(cfg, onBinance) {
  const u = cfg.universe;
  const headers = u.coingeckoKey ? { 'x-cg-demo-api-key': u.coingeckoKey } : {};
  const markets = await getJSON(
    `${u.coingeckoUrl}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${u.candidates}&page=1`,
    { tries: 3, headers },
  );
  const cands = markets
    .map((c) => ({ base: c.symbol.toUpperCase(), symbol: c.symbol.toUpperCase() + u.quote, name: c.name,
      price: c.current_price, mcap: c.market_cap || 0, volume: c.total_volume || 0 }))
    .filter((c) => !isExcluded({ symbol: c.base, name: c.name, price: c.price }, u.exclude))
    .filter((c) => onBinance.has(c.symbol));
  // одинаковые тикеры у разных проектов — оставляем крупнейший
  const seen = new Set();
  return cands.filter((c) => !seen.has(c.symbol) && seen.add(c.symbol));
}

// Запасной способ: если CoinGecko недоступен — только объём на Binance
function fromBinanceOnly(cfg, volumes) {
  const u = cfg.universe;
  return [...volumes.entries()]
    .map(([symbol, volume]) => ({ symbol, base: symbol.slice(0, -u.quote.length), name: null, mcap: 0, volume }))
    .filter((c) => !/(UP|DOWN|BULL|BEAR)$/.test(c.base) && !isExcluded({ symbol: c.base }, u.exclude))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, u.candidates);
}

export function rankCoins(cands, size, mcapWeight = 0.5) {
  const byM = [...cands].sort((a, b) => b.mcap - a.mcap);
  const byV = [...cands].sort((a, b) => b.volume - a.volume);
  const rM = new Map(byM.map((c, i) => [c.symbol, i + 1]));
  const rV = new Map(byV.map((c, i) => [c.symbol, i + 1]));
  return cands
    .map((c) => ({ ...c, mcapRank: rM.get(c.symbol), volRank: rV.get(c.symbol),
      score: mcapWeight * rM.get(c.symbol) + (1 - mcapWeight) * rV.get(c.symbol) }))
    .sort((a, b) => a.score - b.score || a.mcapRank - b.mcapRank)
    .slice(0, size);
}

export async function selectUniverse(cfg, cacheFile) {
  const u = cfg.universe;
  let coins = null, source = '';
  try {
    const volumes = await binanceVolumes(cfg, u.quote);
    try {
      coins = rankCoins(await fromCoinGecko(cfg, volumes), u.size, u.mcapWeight);
      source = 'CoinGecko (капитализация + объём)';
    } catch (e) {
      console.error(`CoinGecko недоступен (${e.message}) — выбираю по объёму Binance`);
      coins = rankCoins(fromBinanceOnly(cfg, volumes), u.size, 0);
      source = 'Binance (только объём)';
    }
  } catch (e) {
    console.error(`Не удалось получить рейтинг монет: ${e.message}`);
  }

  if (coins?.length) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), source, coins }, null, 2));
    } catch { /* не критично */ }
    return { coins, source, at: Date.now() };
  }

  // сеть недоступна — берём последний сохранённый список, а если его нет — список по умолчанию
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return { ...cached, source: `${cached.source}, сохранённый список` };
  } catch {
    return { coins: DEFAULT_SYMBOLS.slice(0, u.size).map((symbol) => ({ symbol, base: symbol.slice(0, -4) })), source: 'список по умолчанию', at: 0 };
  }
}
