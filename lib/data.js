// Рыночные данные с публичного API Binance (ключ не нужен)
import { getJSON } from './http.js';

const FUT_PERIODS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];
const toFuturesPeriod = (i) => (FUT_PERIODS.includes(i) ? i : ['1m', '3m'].includes(i) ? '5m' : '1h');

export async function fetchKlines(cfg, symbol, interval, limit) {
  const url = `${cfg.api.spot}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const rows = await getJSON(url);
  return rows.map((k) => ({
    time: k[0],
    open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    volume: +k[5],
    closeTime: k[6],
    takerBuy: +k[9], // объём агрессивных покупок → дельта / CVD
  }));
}

// 3. Деривативы: открытый интерес, фандинг, соотношение лонгов/шортов, поток тейкеров
export async function fetchDerivatives(cfg, symbol, interval) {
  const p = toFuturesPeriod(interval);
  const q = (path, extra = '') => getJSON(`${cfg.api.futures}${path}?symbol=${symbol}${extra}`, { tries: 2 });
  const [oi, prem, ls, taker] = await Promise.allSettled([
    q('/futures/data/openInterestHist', `&period=${p}&limit=48`),
    q('/fapi/v1/premiumIndex'),
    q('/futures/data/globalLongShortAccountRatio', `&period=${p}&limit=24`),
    q('/futures/data/takerlongshortRatio', `&period=${p}&limit=24`),
  ]);
  const val = (r) => (r.status === 'fulfilled' ? r.value : null);
  const arr = (r) => (Array.isArray(val(r)) && val(r).length ? val(r) : null);

  return {
    available: !!(arr(oi) || val(prem)),
    period: p,
    openInterest: arr(oi)?.map((x) => ({ time: x.timestamp, oi: +x.sumOpenInterest, value: +x.sumOpenInterestValue })) ?? null,
    funding: val(prem)?.lastFundingRate != null ? +val(prem).lastFundingRate : null,
    longShort: arr(ls)?.map((x) => +x.longShortRatio) ?? null,
    takerRatio: arr(taker)?.map((x) => +x.buySellRatio) ?? null,
  };
}

export async function fetchMarket(cfg, symbol) {
  const [ltf, htf, deriv] = await Promise.all([
    fetchKlines(cfg, symbol, cfg.interval, cfg.candles),
    fetchKlines(cfg, symbol, cfg.higherInterval, 300),
    fetchDerivatives(cfg, symbol, cfg.interval).catch(() => ({ available: false })),
  ]);
  return { ltf, htf, deriv };
}
