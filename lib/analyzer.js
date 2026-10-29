// Объединяет все блоки анализа в одну оценку от -1 (продавать) до +1 (покупать)
// и строит план сделки: вход, стоп, цели, соотношение прибыль/риск.
import { ema, sma, rsi, macd, bollinger, atr, adx, obv, slope, last, clamp } from './indicators.js';
import { volumeProfile } from './volumeProfile.js';
import { detectPatterns } from './patterns.js';

export const fmt = (p) => (p == null ? '—' : p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4));
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// ── 1. Исторические зоны торгов ─────────────────────────────────────────────
function scoreVolumeProfile(candles, price, atrV, extraLevels, cfg) {
  const vp = volumeProfile(candles.slice(-cfg.lookback), cfg);
  const levels = [vp.poc, vp.vah, vp.val, ...vp.hvn];
  const below = levels.filter((x) => x < price).sort((a, b) => b - a);
  const above = levels.filter((x) => x > price).sort((a, b) => a - b);
  const prox = cfg.proximityAtr * atrV;
  const notes = [`POC ${fmt(vp.poc)}, Value Area ${fmt(vp.val)} – ${fmt(vp.vah)}`];
  let s = 0;

  if (below[0] != null && price - below[0] <= prox) { s += 0.6; notes.push(`цена у зоны крупных торгов снизу ${fmt(below[0])} (поддержка)`); }
  if (above[0] != null && above[0] - price <= prox) { s -= 0.6; notes.push(`цена у зоны крупных торгов сверху ${fmt(above[0])} (сопротивление)`); }
  if (price < vp.val) { s += 0.3; notes.push('цена ниже Value Area — «дёшево» относительно истории'); }
  else if (price > vp.vah) { s -= 0.3; notes.push('цена выше Value Area — «дорого» относительно истории'); }
  if (vp.lvn.some((x) => Math.abs(x - price) < vp.step)) notes.push('цена в зоне низкого объёма — возможен быстрый проход');

  // Уровни для плана сделки: зоны объёма + свинг-уровни
  const all = [...levels, ...extraLevels];
  return {
    score: clamp(s), notes, vp,
    supports: all.filter((x) => x < price).sort((a, b) => b - a),
    resistances: all.filter((x) => x > price).sort((a, b) => a - b),
  };
}

// ── 2. Тренд ────────────────────────────────────────────────────────────────
function emaStack(closes) {
  const e20 = last(ema(closes, 20)), e50 = last(ema(closes, 50)), e200 = last(ema(closes, 200));
  const p = last(closes);
  if (e200 == null) return { s: sign(p - e20) * 0.5 + sign(e20 - e50) * 0.5, e20, e50, e200 };
  return { s: (sign(p - e20) + sign(e20 - e50) + sign(e50 - e200)) / 3, e20, e50, e200 };
}

function scoreTrend(C, ind, htfCandles, atrV) {
  const notes = [];
  const ltf = emaStack(C);
  const htf = emaStack(htfCandles.slice(0, -1).map((c) => c.close));
  const sl = clamp((slope(ind.ema50, 10) * 10) / atrV); // насколько EMA50 сдвинулась за 10 баров в ATR
  const a = last(ind.adx.adx), pdi = last(ind.adx.plusDI), mdi = last(ind.adx.minusDI);
  const strength = a == null ? 0.7 : a < 18 ? 0.45 : a < 25 ? 0.75 : 1;

  const s = clamp((0.4 * ltf.s + 0.25 * sl + 0.35 * htf.s) * strength);
  const word = (x) => (x > 0.3 ? 'восходящий' : x < -0.3 ? 'нисходящий' : 'боковой');
  notes.push(`рабочий ТФ: ${word(ltf.s)} (EMA20 ${fmt(ltf.e20)}, EMA50 ${fmt(ltf.e50)}, EMA200 ${fmt(ltf.e200)})`);
  notes.push(`старший ТФ: ${word(htf.s)}`);
  if (a != null) notes.push(`ADX ${a.toFixed(1)} — ${a < 18 ? 'тренда нет' : a < 25 ? 'тренд слабый' : 'тренд сильный'}, ${pdi > mdi ? '+DI > -DI' : '-DI > +DI'}`);
  return { score: s, notes };
}

// ── 3а. Деривативы и поток ордеров ──────────────────────────────────────────
function scoreDerivatives(closed, d, whales) {
  const notes = [], parts = [];
  const seg = closed.slice(-24);
  const vol = seg.reduce((s, c) => s + c.volume, 0);
  const delta = seg.reduce((s, c) => s + (2 * c.takerBuy - c.volume), 0);
  const cvd = vol ? delta / vol : 0;
  const priceCh = (last(seg).close - seg[0].open) / seg[0].open;

  let cvdScore = clamp(cvd * 4);
  if (priceCh < 0 && cvd > 0.04) { cvdScore = clamp(cvdScore + 0.3); notes.push('цена падает, а агрессивные покупки преобладают — скрытое накопление'); }
  if (priceCh > 0 && cvd < -0.04) { cvdScore = clamp(cvdScore - 0.3); notes.push('цена растёт, а агрессивные продажи преобладают — скрытое распределение'); }
  notes.push(`дельта объёма (CVD) за 24 бара: ${pct(cvd)}, цена ${pct(priceCh)}`);
  parts.push([cvdScore, 0.3]);

  if (d?.openInterest?.length >= 2) {
    const oi = d.openInterest;
    const o0 = oi[Math.max(0, oi.length - 25)].oi, o1 = last(oi).oi;
    const oiCh = (o1 - o0) / o0;
    let s = 0, txt = 'открытый интерес почти не меняется';
    if (priceCh > 0 && oiCh > 0.01) { s = 0.8; txt = 'цена ↑ и OI ↑ — открываются новые лонги, рост подтверждён'; }
    else if (priceCh > 0 && oiCh < -0.01) { s = 0.2; txt = 'цена ↑, OI ↓ — закрываются шорты, рост может быть недолгим'; }
    else if (priceCh < 0 && oiCh > 0.01) { s = -0.8; txt = 'цена ↓ и OI ↑ — открываются новые шорты, падение подтверждено'; }
    else if (priceCh < 0 && oiCh < -0.01) { s = -0.2; txt = 'цена ↓, OI ↓ — ликвидации лонгов, падение может выдыхаться'; }
    notes.push(`открытый интерес ${pct(oiCh)}: ${txt}`);
    parts.push([s, 0.35]);
  }

  if (d?.funding != null) {
    const f = d.funding;
    const s = f > 0.0005 ? -0.7 : f > 0.0002 ? -0.25 : f < -0.0003 ? 0.7 : f < 0 ? 0.25 : 0;
    notes.push(`фандинг ${(f * 100).toFixed(4)}%${s < -0.5 ? ' — толпа в лонгах, риск сброса' : s > 0.5 ? ' — толпа в шортах, возможен шорт-сквиз' : ''}`);
    parts.push([s, 0.15]);
  }

  if (d?.longShort?.length) {
    const r = last(d.longShort);
    const s = r > 2.5 ? -0.6 : r > 1.8 ? -0.3 : r < 0.7 ? 0.6 : r < 1 ? 0.3 : 0;
    notes.push(`лонг/шорт аккаунтов: ${r.toFixed(2)}`);
    parts.push([s, 0.1]);
  }

  if (d?.takerRatio?.length) {
    const r6 = d.takerRatio.slice(-6);
    const avg = r6.reduce((a, b) => a + b, 0) / r6.length;
    notes.push(`покупки/продажи тейкеров на фьючерсах: ${avg.toFixed(2)}`);
    parts.push([clamp((avg - 1) * 3), 0.1]);
  }

  if (whales?.active && whales.buy + whales.sell > 0) {
    const net = (whales.buy - whales.sell) / (whales.buy + whales.sell);
    const m = (x) => `$${(x / 1e6).toFixed(2)}M`;
    notes.push(`киты за ${whales.hours}ч: покупки ${m(whales.buy)}, продажи ${m(whales.sell)} — ${net > 0.2 ? 'крупные деньги покупают' : net < -0.2 ? 'крупные деньги продают' : 'баланс'}`);
    parts.push([clamp(net), 0.2]);
  }

  if (!d?.available) notes.push('фьючерсных данных по паре нет — учитывается только поток спота');
  const w = parts.reduce((s, [, x]) => s + x, 0);
  return { score: clamp(parts.reduce((s, [v, x]) => s + v * x, 0) / w), notes };
}

// ── 3б. Классические индикаторы ─────────────────────────────────────────────
function scoreIndicators(closed, ind) {
  const notes = [], parts = [];
  const n = closed.length;
  const r = last(ind.rsi);
  const rs = r < 30 ? 1 : r < 40 ? 0.4 : r > 70 ? -1 : r > 60 ? -0.4 : 0;
  notes.push(`RSI ${r.toFixed(1)}${r < 30 ? ' — перепроданность' : r > 70 ? ' — перекупленность' : ''}`);
  parts.push([rs, 0.3]);

  const h = ind.macd.hist;
  let ms = 0, mt = '';
  const crossUp = [1, 2, 3].some((k) => h[n - k] > 0 && h[n - k - 1] <= 0);
  const crossDn = [1, 2, 3].some((k) => h[n - k] < 0 && h[n - k - 1] >= 0);
  if (crossUp) { ms = 1; mt = 'свежее пересечение вверх'; }
  else if (crossDn) { ms = -1; mt = 'свежее пересечение вниз'; }
  else if (h[n - 1] > 0) { ms = h[n - 1] > h[n - 2] ? 0.5 : 0.15; mt = h[n - 1] > h[n - 2] ? 'импульс вверх растёт' : 'импульс вверх слабеет'; }
  else { ms = h[n - 1] < h[n - 2] ? -0.5 : -0.15; mt = h[n - 1] < h[n - 2] ? 'импульс вниз растёт' : 'импульс вниз слабеет'; }
  notes.push(`MACD: ${mt}`);
  parts.push([ms, 0.3]);

  const b = last(ind.bb.pctB);
  const bs = b < 0 ? 0.7 : b < 0.1 ? 0.35 : b > 1 ? -0.7 : b > 0.9 ? -0.35 : 0;
  const widths = ind.bb.width.slice(-120).filter((x) => x != null);
  const squeeze = last(ind.bb.width) <= Math.min(...widths) * 1.1;
  notes.push(`Боллинджер %B ${b.toFixed(2)}${squeeze ? ', сжатие — скоро сильное движение' : ''}`);
  parts.push([bs, 0.2]);

  // OBV против цены
  const C = closed.map((c) => c.close);
  const ps = sign(slope(C, 20)), os = sign(slope(ind.obv, 20));
  const lastC = last(closed);
  const volRatio = last(ind.volSma) ? lastC.volume / last(ind.volSma) : 1;
  let vs = os * 0.4;
  if (ps !== os && os !== 0) notes.push(`OBV расходится с ценой — ${os > 0 ? 'объём поддерживает покупателей' : 'объём на стороне продавцов'}`);
  if (volRatio > 1.5) { vs += sign(lastC.close - lastC.open) * 0.5; notes.push(`объём последней свечи ×${volRatio.toFixed(1)} от среднего`); }
  parts.push([clamp(vs), 0.2]);

  return { score: clamp(parts.reduce((s, [v, w]) => s + v * w, 0)), notes };
}

// ── План сделки ─────────────────────────────────────────────────────────────
function buildPlan(dir, price, atrV, supports, resistances) {
  const near = (arr, minDist) => arr.find((x) => Math.abs(x - price) >= minDist);
  if (dir === 'BUY') {
    const sup = supports.find((x) => price - x <= 3 * atrV);
    const stop = sup != null ? Math.min(sup - 0.3 * atrV, price - 0.8 * atrV) : price - 1.5 * atrV;
    const t1 = near(resistances, atrV) ?? price + 3 * atrV;
    const t2 = resistances.find((x) => x > t1 + atrV) ?? t1 + 2 * atrV;
    const zone = sup != null ? [sup, sup + 0.3 * atrV] : [price - 0.5 * atrV, price];
    return { entry: price, stop, t1, t2, rr: (t1 - price) / (price - stop), zone };
  }
  const res = resistances.find((x) => x - price <= 3 * atrV);
  const stop = res != null ? Math.max(res + 0.3 * atrV, price + 0.8 * atrV) : price + 1.5 * atrV;
  const t1 = near(supports, atrV) ?? price - 3 * atrV;
  const t2 = supports.find((x) => x < t1 - atrV) ?? t1 - 2 * atrV;
  const zone = res != null ? [res - 0.3 * atrV, res] : [price, price + 0.5 * atrV];
  return { entry: price, stop, t1, t2, rr: (price - t1) / (stop - price), zone };
}

export const BLOCK_NAMES = {
  volumeProfile: '1. Зоны крупных торгов',
  trend: '2. Тренд',
  derivatives: "3. Открытый интерес, поток, киты",
  indicators: '3. Тех. индикаторы',
  patterns: '4. Паттерны',
  news: '5. Новости и настроения',
};

export function analyze(symbol, market, news, cfg) {
  const all = market.ltf;
  const price = last(all).close;            // текущая цена (свеча ещё формируется)
  const closed = all.slice(0, -1);          // индикаторы — только по закрытым свечам
  const C = closed.map((c) => c.close), H = closed.map((c) => c.high), L = closed.map((c) => c.low), V = closed.map((c) => c.volume);
  const atrV = last(atr(H, L, C, 14));

  const ind = {
    ema50: ema(C, 50), rsi: rsi(C, 14), macd: macd(C), bb: bollinger(C, 20, 2),
    adx: adx(H, L, C, 14), obv: obv(C, V), volSma: sma(V, 20),
  };

  const pat = detectPatterns(closed, ind.rsi, atrV);
  const swing = [...pat.pivots.highs.slice(-6), ...pat.pivots.lows.slice(-6)].map((p) => p.price);
  const vpBlock = scoreVolumeProfile(all, price, atrV, swing, cfg.volumeProfile);

  const blocks = {
    volumeProfile: vpBlock,
    trend: scoreTrend(C, ind, market.htf, atrV),
    derivatives: scoreDerivatives(closed, market.deriv, market.whales),
    indicators: scoreIndicators(closed, ind),
    patterns: { score: pat.score, notes: pat.found.length ? pat.found.map((p) => p.name) : ['явных паттернов нет'] },
    news: news ?? { score: 0, notes: ['новости недоступны'], disabled: true },
  };

  let sum = 0, wsum = 0, agreeW = 0;
  for (const [k, w] of Object.entries(cfg.weights)) {
    const b = blocks[k];
    if (!b || b.disabled) continue;
    sum += w * b.score; wsum += w;
  }
  const score = wsum ? sum / wsum : 0;
  for (const [k, w] of Object.entries(cfg.weights)) {
    const b = blocks[k];
    if (b && !b.disabled && sign(b.score) === sign(score) && Math.abs(b.score) > 0.1) agreeW += w;
  }
  const agreement = wsum ? agreeW / wsum : 0; // доля веса блоков, согласных с итогом

  const { threshold, strong, minRiskReward } = cfg.signal;
  let action = 'NEUTRAL', reason = '';
  if (Math.abs(score) >= threshold) action = score > 0 ? 'BUY' : 'SELL';
  else if (Math.abs(score) >= threshold * 0.6) action = score > 0 ? 'WATCH_BUY' : 'WATCH_SELL';

  const dir = score >= 0 ? 'BUY' : 'SELL';
  const plan = buildPlan(dir, price, atrV, vpBlock.supports, vpBlock.resistances);
  if ((action === 'BUY' || action === 'SELL') && plan.rr < minRiskReward) {
    reason = `соотношение прибыль/риск ${plan.rr.toFixed(2)} ниже ${minRiskReward} — лучше дождаться цены в зоне ${fmt(plan.zone[0])}–${fmt(plan.zone[1])}`;
    action = action === 'BUY' ? 'WATCH_BUY' : 'WATCH_SELL';
  }

  return {
    symbol, price, atr: atrV, score, agreement, action,
    strength: Math.abs(score) >= strong ? 'сильный' : 'умеренный',
    reason, plan, blocks, newsTop: news?.top ?? [], time: Date.now(),
  };
}
