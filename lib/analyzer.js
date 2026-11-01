// Объединяет все блоки анализа в одну оценку от −1 (продавать) до +1 (покупать),
// считает уверенность, отбирает главные причины «за» и «против», применяет фильтры
// и строит план сделки.
//
// Блоки:
//   levels      1. исторические зоны торгов (профили объёма, POC, уровни дня/недели/месяца, Фибо, стены…)
//   trend       2. тренд на 15m/1h/4h/1d/1w, Ишимоку, Supertrend, ADX, структура, биткоин как лидер, рынок в целом
//   derivatives 3. открытый интерес, фандинг, позиции топ-трейдеров и толпы, базис, ликвидации, карта ликвидаций (оценка), опционы Deribit (BTC, ETH)
//   flow        3. поток ордеров: дельта спот/фьючерсы, крупные против мелких, киты, стакан, премия Coinbase
//   indicators  3. RSI (5 таймфреймов), StochRSI, MACD, MFI, CMF, OBV, VWAP, Боллинджер, сжатие
//   patterns    4. свечные модели, фигуры, Smart Money, дивергенции (15m/1h/4h)
//   news        5. новости, индекс страха и жадности, общий фон рынка
import { clamp, lastValid, slope, mean, correlation, logReturns, sign, vwapRange } from './indicators.js';
import { computeTF, trendWord, toWeekly } from './tf.js';
import { liquidationMap } from './liqmap.js';
import { detectRegime } from './regime.js';
import { buildLevels, scoreLevels } from './levels.js';
import { detectPatterns } from './patterns.js';
import { buildPlan } from './plan.js';
import { fmt, fmtUsd, pct, sgn, fmtDuration, fmtDate } from './format.js';

export const BLOCK_NAMES = {
  levels: '1. Исторические зоны торгов',
  trend: '2. Тренд',
  derivatives: '3. Деривативы: OI, фандинг, позиции',
  flow: '3. Поток ордеров, киты, стакан',
  indicators: '3. Технические индикаторы',
  patterns: '4. Паттерны',
  news: '5. Новости и настроение рынка',
};

const wavg = (parts) => {
  const ok = parts.filter((p) => p && Number.isFinite(p[0]) && p[1] > 0);
  const w = ok.reduce((s, p) => s + p[1], 0);
  return w ? ok.reduce((s, p) => s + p[0] * p[1], 0) / w : 0;
};
const closed = (arr, closedOnly) => (arr?.length ? (closedOnly ? arr : arr.slice(0, -1)) : null);

// ── 2. Тренд ────────────────────────────────────────────────────────────────
// lead — «старший» актив: биткоин для альткоинов, индекс рынка акций (QQQ) для акций
const LEAD_CRYPTO = { nom: 'Биткоин', rsUp: 'Монета сильнее биткоина (растёт относительно BTC)', rsDown: 'Монета слабее биткоина (падает относительно BTC)' };
const leadOf = (kind, name) => (kind === 'stock'
  ? { nom: `Рынок акций (${name})`, rsUp: `Акция сильнее рынка (растёт относительно ${name})`, rsDown: `Акция слабее рынка (падает относительно ${name})` }
  : LEAD_CRYPTO);

function scoreTrend(tf, structure4, btc, isBtc, rs, lead = LEAD_CRYPTO, breadth = null) {
  const items = [], notes = [];
  const set = [['15m', tf.m15, 0.1], ['1h', tf.h1, 0.25], ['4h', tf.h4, 0.35], ['1d', tf.d1, 0.3], ['1w', tf.w1, 0.15]].filter(([, t]) => t);
  const mtf = wavg(set.map(([, t, w]) => [t.stack, w]));
  const words = set.map(([n, t]) => `${n} ${trendWord(t.stack)}`);
  notes.push(`по таймфреймам: ${words.join(' · ')}`);
  if (Math.abs(mtf) >= 0.2) items.push({ text: `Тренд по таймфреймам: ${words.join(', ')}`, s: mtf * 0.35 });

  const sl = (t) => (t?.atrV ? clamp((slope(t.ema50, 10) * 10) / t.atrV) : null);
  const slopeS = wavg([[sl(tf.h1), 0.4], [sl(tf.h4), 0.6]]);

  const h4 = tf.h4 ?? tf.h1;
  const a4 = lastValid(h4.adx.adx), pdi = lastValid(h4.adx.plusDI), mdi = lastValid(h4.adx.minusDI);
  const adxS = a4 != null && pdi + mdi > 0 ? ((pdi - mdi) / (pdi + mdi)) * Math.min(1, a4 / 25) : 0;
  if (a4 != null) notes.push(`ADX(4h) ${a4.toFixed(0)} — ${a4 < 18 ? 'тренда нет' : a4 < 25 ? 'тренд слабый' : a4 < 40 ? 'тренд сильный' : 'тренд очень сильный'}`);

  let ichS = null;
  if (h4.ich?.cloudTop != null) {
    const p = h4.close, ich = h4.ich;
    const tk = lastValid(ich.tenkan), kj = lastValid(ich.kijun);
    ichS = (p > ich.cloudTop ? 0.5 : p < ich.cloudBottom ? -0.5 : 0) + (tk > kj ? 0.25 : tk < kj ? -0.25 : 0) + (ich.futureBullish ? 0.25 : -0.25);
    notes.push(`Ишимоку(4h): цена ${p > ich.cloudTop ? 'над облаком' : p < ich.cloudBottom ? 'под облаком' : 'в облаке'}`);
  }
  const stDir = (t) => (t ? t.st.dir[t.st.dir.length - 1] : null);
  const stS = wavg([[stDir(tf.h1), 0.4], [stDir(tf.h4), 0.6]]);
  const structS = structure4 ?? 0;
  if (structS) notes.push(`структура 4h: ${structS > 0 ? 'повышающиеся максимумы и минимумы' : 'понижающиеся максимумы и минимумы'}`);

  const parts = [[mtf, 0.35], [slopeS, 0.1], [adxS, 0.1], [ichS, ichS == null ? 0 : 0.1], [stS, 0.1], [structS, 0.1]];
  if (!isBtc && btc) {
    const k = btc.corr != null ? Math.max(0, btc.corr) : 0.6;
    const v = clamp(btc.trend * k);
    parts.push([v, 0.1]);
    if (Math.abs(v) > 0.25) items.push({ text: `${lead.nom} ${btc.trend > 0 ? 'в восходящем' : 'в нисходящем'} тренде, корреляция с ним ${btc.corr != null ? btc.corr.toFixed(2) : '—'}`, s: v * 0.1 });
  }
  if (!isBtc && rs != null) {
    parts.push([rs, 0.05]);
    if (Math.abs(rs) >= 0.5) items.push({ text: rs > 0 ? lead.rsUp : lead.rsDown, s: rs * 0.05 });
  }
  // ширина рынка: сколько монет (акций) из отслеживаемых сейчас растут — «прилив» поднимает почти всех
  if (breadth?.n >= 5) {
    parts.push([breadth.value, 0.08]);
    const unit = breadth.kind === 'stock' ? 'акций' : 'монет';
    notes.push(`рынок в целом: растут ${breadth.up} из ${breadth.n} ${unit}, падают ${breadth.down}`);
    if (Math.abs(breadth.value) >= 0.5) items.push({ text: breadth.value > 0 ? `Рынок в целом растёт: ${breadth.up} из ${breadth.n} ${unit} в восходящем тренде` : `Рынок в целом падает: ${breadth.down} из ${breadth.n} ${unit} в нисходящем тренде`, s: breadth.value * 0.08 });
  }
  const raw = wavg(parts);
  const f = a4 == null ? 0.8 : a4 < 15 ? 0.6 : a4 < 20 ? 0.75 : a4 < 25 ? 0.9 : 1;
  return { score: clamp(raw * f), items, notes };
}

// ── 3а. Деривативы ─────────────────────────────────────────────────────────
// 🎲 опционы Deribit: риск-реверсал, путы/коллы, «максимальная боль» перед крупной экспирацией
function scoreOptions(o, price, rv30, now) {
  const items = [], notes = [], parts = [];
  const tx = [];
  if (o.pcr != null) tx.push(`путы/коллы по открытому интересу ${o.pcr.toFixed(2)}`);
  if (o.rr25 != null) tx.push(`риск-реверсал 25Δ на ${o.tenorDays} дн. ${sgn(o.rr25, 1)}`);
  if (o.atmIv != null) tx.push(`IV ${Math.round(o.atmIv * 100)}%${rv30 != null ? ` при фактической ${Math.round(rv30 * 100)}%` : ''}`);
  if (tx.length) notes.push(`опционы Deribit: ${tx.join(', ')}`);
  if (o.rr25 != null) {
    const s = clamp(o.rr25 / 8);
    if (Math.abs(o.rr25) >= 3) items.push({ text: o.rr25 > 0 ? `Опционы: коллы дороже путов (риск-реверсал ${sgn(o.rr25, 1)}) — рынок закладывается на рост` : `Опционы: путы дороже коллов (риск-реверсал ${sgn(o.rr25, 1)}) — платят за защиту от падения`, s: s * 0.08 });
    parts.push([s, 0.5]);
  }
  if (o.pcr != null) parts.push([o.pcr >= 1 ? -0.4 : o.pcr <= 0.45 ? 0.3 : 0, 0.2]);
  const e = o.nextBig;
  if (e?.maxPain && e.ts - now <= 2 * 86400e3) {
    const d = e.maxPain / price - 1;
    const s = clamp(d / 0.03) * 0.6;
    if (Math.abs(d) >= 0.01) items.push({ text: `Экспирация опционов ${fmtDate(e.ts)} на ${fmtUsd(e.oiUsd)}: «максимальная боль» ${fmt(e.maxPain)} (${pct(d, 1)}) — перед экспирацией цену может тянуть туда`, s: s * 0.06 });
    parts.push([s, 0.3]);
  }
  if (o.atmIv != null && rv30 != null && o.atmIv > rv30 * 1.35) notes.push('подразумеваемая волатильность заметно выше фактической — рынок ждёт сильного движения');
  return { score: parts.length ? clamp(wavg(parts)) : 0, items, notes };
}

function scoreDerivatives(d, liq, tf, regime, extra = {}) {
  if (!d) return { disabled: true, score: 0, items: [], notes: ['фьючерсов по монете на Binance нет — блок не учитывается'] };
  const items = [], notes = [];
  const parts = [];
  const C = tf.h1.C, n = C.length;
  const pch = (k) => (n > k ? C[n - 1] / C[n - 1 - k] - 1 : 0);
  const trendy = regime.key === 'trend_up' || regime.key === 'trend_down';
  const summary = {};

  // открытый интерес против цены
  if (d.oi?.length >= 26) {
    const oi = d.oi.map((x) => +x.sumOpenInterest);
    const m = oi.length;
    const ch = (k) => oi[m - 1] / oi[m - 1 - k] - 1;
    const q = (p, o, thrP, thrO) => {
      if (p > thrP && o > thrO) return [0.8, 'цена ↑ и OI ↑ — открываются новые лонги, рост подтверждён'];
      if (p > thrP && o < -thrO) return [0.2, 'цена ↑, OI ↓ — закрываются шорты, рост может быть недолгим'];
      if (p < -thrP && o > thrO) return [-0.8, 'цена ↓ и OI ↑ — открываются новые шорты, падение подтверждено'];
      if (p < -thrP && o < -thrO) return [-0.1, 'цена ↓, OI ↓ — закрываются лонги, падение может выдыхаться'];
      if (Math.abs(p) <= thrP && o > thrO * 2) return [0, 'OI растёт при стоящей цене — копятся позиции перед сильным движением'];
      return [0, null];
    };
    const [s4, t4] = q(pch(4), ch(4), 0.004, 0.01);
    const [s24, t24] = q(pch(24), ch(24), 0.01, 0.03);
    const s = 0.6 * s4 + 0.4 * s24;
    summary.oi4 = ch(4); summary.oi24 = ch(24);
    summary.oiUsd = +d.oi[m - 1].sumOpenInterestValue;
    notes.push(`открытый интерес: ${fmtUsd(summary.oiUsd)}, за 4 ч ${pct(ch(4), 1)}, за 24 ч ${pct(ch(24), 1)}`);
    if (t4 || t24) items.push({ text: `Открытый интерес: ${t4 ?? t24}`, s: s * 0.25 });
    const sorted = [...oi].sort((a, b) => a - b);
    const pctl = sorted.findIndex((x) => x >= oi[m - 1]) / sorted.length;
    summary.oiPctl = pctl;
    if (pctl >= 0.92) notes.push(`OI около максимума за ${Math.round(m / 24)} дн. — много позиций с плечом, возможны резкие ликвидации`);
    parts.push([s, 0.25]);
  }

  // фандинг
  if (d.premium?.lastFundingRate != null) {
    const r = +d.premium.lastFundingRate;
    let ivH = 8;
    if (d.funding?.length >= 3) {
      const ts = d.funding.map((x) => +x.fundingTime).sort((a, b) => a - b);
      const diffs = ts.slice(1).map((t, i) => (t - ts[i]) / 3600e3).filter((x) => x > 0.5);
      if (diffs.length) ivH = Math.round(diffs.sort((a, b) => a - b)[diffs.length >> 1]);
    }
    const r8 = (r * 8) / ivH;
    let s = r8 >= 0.0005 ? -0.7 : r8 >= 0.0002 ? -0.3 : r8 <= -0.0003 ? 0.7 : r8 < 0 ? 0.25 : 0;
    if (trendy) s *= 0.6;
    let pctlTxt = '';
    if (d.funding?.length >= 20) {
      const rates = d.funding.map((x) => +x.fundingRate);
      const above = rates.filter((x) => x < r).length / rates.length;
      if (above >= 0.95) { s -= 0.15; pctlTxt = ', максимум за месяц'; }
      if (above <= 0.05) { s += 0.15; pctlTxt = ', минимум за месяц'; }
      summary.funding3d = mean(rates.slice(-Math.round(72 / ivH)));
    }
    summary.funding = r; summary.fundingInterval = ivH; summary.fundingApr = r * (24 / ivH) * 365;
    notes.push(`фандинг ${(r * 100).toFixed(4)}% за ${ivH} ч (≈${(summary.fundingApr * 100).toFixed(1)}% годовых${pctlTxt})`);
    if (Math.abs(s) >= 0.25) items.push({ text: s < 0 ? `Фандинг высокий (${(r * 100).toFixed(3)}%) — толпа в лонгах, риск сброса` : `Фандинг отрицательный (${(r * 100).toFixed(3)}%) — толпа в шортах, возможен шорт-сквиз`, s: clamp(s) * 0.2 });
    parts.push([clamp(s), 0.2]);
  }

  // позиции: топ-трейдеры против толпы
  const lastR = (arr) => (arr?.length ? +arr[arr.length - 1].longShortRatio : null);
  const agoR = (arr, k) => (arr?.length > k ? +arr[arr.length - 1 - k].longShortRatio : null);
  const tp = lastR(d.topPos), tp24 = agoR(d.topPos, 24), ga = lastR(d.globalAcc), ga24 = agoR(d.globalAcc, 24);
  if (tp != null || ga != null) {
    let s = 0;
    if (tp != null && tp24 && ga != null && ga24) {
      const dTp = tp / tp24 - 1, dGa = ga / ga24 - 1;
      if (dTp > 0.05 && dGa < -0.02) { s += 0.6; items.push({ text: `Топ-трейдеры наращивают лонги (${pct(dTp, 0)} за сутки), а толпа их сокращает`, s: 0.6 * 0.2 }); }
      else if (dTp < -0.05 && dGa > 0.02) { s -= 0.6; items.push({ text: `Топ-трейдеры сокращают лонги (${pct(dTp, 0)} за сутки), а толпа покупает`, s: -0.6 * 0.2 }); }
    }
    if (ga != null) {
      const c = ga > 2.5 ? -0.4 : ga > 1.8 ? -0.2 : ga < 0.8 ? 0.4 : ga < 1 ? 0.2 : 0;
      s += c;
      if (Math.abs(c) >= 0.4) items.push({ text: c < 0 ? `Толпа сильно перекошена в лонги (лонг/шорт ${ga.toFixed(2)})` : `Толпа перекошена в шорты (лонг/шорт ${ga.toFixed(2)})`, s: c * 0.2 });
    }
    if (tp != null) s += tp > 1.3 ? 0.15 : tp < 0.8 ? -0.15 : 0;
    summary.topPos = tp; summary.globalAcc = ga;
    notes.push(`лонг/шорт: топ-трейдеры (позиции) ${tp?.toFixed(2) ?? '—'}, все аккаунты ${ga?.toFixed(2) ?? '—'}`);
    parts.push([clamp(s), 0.2]);
  }

  // базис: фьючерс дороже/дешевле спота
  if (d.premium?.markPrice && d.premium?.indexPrice) {
    const b = +d.premium.markPrice / +d.premium.indexPrice - 1;
    summary.basis = b;
    let s = b > 0.001 ? -0.3 : b < -0.001 ? 0.3 : 0;
    if (trendy) s *= 0.5;
    if (Math.abs(b) > 0.0005) notes.push(`базис ${pct(b, 3)} — фьючерс ${b > 0 ? 'дороже' : 'дешевле'} спота`);
    parts.push([s, 0.1]);
  }

  // агрессивные покупки/продажи на фьючерсах
  if (d.taker?.length >= 4) {
    const avg = mean(d.taker.slice(-4).map((x) => +x.buySellRatio));
    summary.taker = avg;
    const s = clamp((avg - 1) * 3);
    notes.push(`покупки/продажи по рынку на фьючерсах (4 ч): ${avg.toFixed(2)}`);
    if (Math.abs(s) >= 0.3) items.push({ text: `На фьючерсах ${s > 0 ? 'преобладают агрессивные покупки' : 'преобладают агрессивные продажи'} (${avg.toFixed(2)})`, s: s * 0.1 });
    parts.push([s, 0.1]);
  }

  // ликвидации
  if (liq && liq.coverageMin >= 30) {
    summary.liq1h = liq.h1; summary.liq24h = liq.h24;
    const L = liq.h1;
    notes.push(`ликвидации за 1 ч: лонги ${fmtUsd(L.long)}, шорты ${fmtUsd(L.short)}${L.intensity != null ? ` (×${L.intensity.toFixed(1)} к среднему)` : ''}`);
    if (L.total > 0 && L.intensity != null && L.intensity >= 2) {
      const dir = (L.long - L.short) / L.total; // ликвидировали лонги → вынужденные продажи позади → контртренд вверх
      const s = clamp(dir * Math.min(1, (L.intensity - 1) / 3));
      items.push({ text: dir > 0 ? `Каскад ликвидаций лонгов (${fmtUsd(L.long)} за час) — вынужденные продажи часто отмечают локальное дно` : `Каскад ликвидаций шортов (${fmtUsd(L.short)} за час) — вынужденные покупки часто отмечают локальную вершину`, s: s * 0.15 });
      parts.push([s, 0.15]);
    } else parts.push([0, 0.15]);
  }

  // 🧲 карта ликвидаций (оценка): к крупным скоплениям ликвидаций рядом с ценой её часто «тянет»
  const lm = extra.liqmap;
  if (lm) {
    summary.liqmap = lm;
    const c = (x) => `${fmtUsd(x.usd)} у ${fmt(x.price)} (${pct(x.price / extra.price - 1, 1)})`;
    if (lm.above.length || lm.below.length) notes.push(`карта ликвидаций (оценка): выше — шорты ${lm.above.map(c).join(', ') || '—'}; ниже — лонги ${lm.below.map(c).join(', ') || '—'}`);
    if (Math.abs(lm.bias) >= 0.3) {
      const s = clamp(lm.bias) * 0.6;
      items.push({ text: lm.bias > 0 ? `Выше цены скопились ликвидации шортов (≈${fmtUsd(lm.nearAbove)} рядом с ценой, оценка) — цену может «потянуть» вверх за ними` : `Ниже цены скопились ликвидации лонгов (≈${fmtUsd(lm.nearBelow)} рядом с ценой, оценка) — цену может «потянуть» вниз за ними`, s: s * 0.1 });
      parts.push([s, 0.12]);
    } else if (parts.length) parts.push([0, 0.06]);
  }
  // 🎲 опционы (BTC и ETH)
  if (extra.options) {
    const o = scoreOptions(extra.options, extra.price, extra.rv30, extra.now);
    summary.options = extra.options;
    items.push(...o.items);
    notes.push(...o.notes);
    parts.push([o.score, 0.15]);
  }

  if (!parts.length) return { disabled: true, score: 0, items, notes: ['данных по фьючерсам нет'] };
  return { score: clamp(wavg(parts)), items, notes, summary };
}

// ── 3б. Поток ордеров ──────────────────────────────────────────────────────
function cvdOf(candles, k) {
  const s = candles.slice(-k);
  let vol = 0, d = 0;
  for (const c of s) {
    const qv = c.quoteVolume || c.volume * c.close;
    const tb = c.takerBuyQuote || c.takerBuy * c.close;
    vol += qv; d += 2 * tb - qv;
  }
  return vol ? d / vol : 0;
}

function scoreFlow(tf, futH1, flow, book, cb, kind = 'crypto') {
  const onSpot = kind === 'stock' ? '' : ' на споте';
  const items = [], notes = [];
  const parts = [];
  const summary = {};
  const h1c = tf.h1.candles, C = tf.h1.C, n = C.length;
  const p24 = n > 24 ? C[n - 1] / C[n - 25] - 1 : 0;

  if (h1c.some((c) => c.takerBuy > 0)) {
    const s4 = cvdOf(h1c, 4), s24 = cvdOf(h1c, 24);
    let spotS = clamp((0.6 * s4 + 0.4 * s24) * 5);
    summary.spotCvd4 = s4; summary.spotCvd24 = s24;
    let futS = null, f24 = null;
    if (futH1?.length > 30) {
      const f4 = cvdOf(futH1, 4); f24 = cvdOf(futH1, 24);
      futS = clamp((0.6 * f4 + 0.4 * f24) * 6);
      summary.futCvd4 = f4; summary.futCvd24 = f24;
    }
    let s = futS == null ? spotS : 0.6 * spotS + 0.4 * futS;
    notes.push(`дельта объёма за 24 ч: ${kind === 'stock' ? 'контракт' : 'спот'} ${pct(s24, 1)}${f24 != null ? `, фьючерсы ${pct(f24, 1)}` : ''}; цена ${pct(p24, 1)}`);
    if (p24 < -0.01 && s24 > 0.03) { s += 0.3; items.push({ text: `Цена падает, а агрессивные покупки${onSpot} преобладают — скрытое накопление`, s: 0.3 * 0.3 }); }
    if (p24 > 0.01 && s24 < -0.03) { s -= 0.3; items.push({ text: `Цена растёт, а${onSpot} преобладают продажи — скрытое распределение`, s: -0.3 * 0.3 }); }
    if (f24 != null && p24 > 0.01 && s24 > 0.02 && f24 < 0) items.push({ text: 'Рост идёт за счёт спота, а не плеча — более устойчивый спрос', s: 0.05 });
    if (f24 != null && p24 > 0.01 && f24 > 0.03 && s24 < 0) items.push({ text: 'Рост держится на фьючерсах при продажах на споте — рост на плечах, хрупкий', s: -0.05 });
    if (Math.abs(s) >= 0.3 && !items.length) items.push({ text: `Дельта объёма ${s > 0 ? 'за покупателями' : 'за продавцами'} (${kind === 'stock' ? 'контракт' : 'спот'} ${pct(s4, 1)} за 4 ч)`, s: clamp(s) * 0.3 });
    parts.push([clamp(s), 0.3]);
  }

  // крупные против мелких и киты (из потока сделок)
  if (flow?.h1 && flow.h1.coverageMin >= 30) {
    const f = flow.h4 && flow.h4.coverageMin >= 120 ? flow.h4 : flow.h1;
    const largeD = f.spot.largeDelta + f.futures.largeDelta, largeT = f.spot.buyL + f.spot.sellL + f.futures.buyL + f.futures.sellL;
    const smallD = f.spot.smallDelta + f.futures.smallDelta;
    if (largeT > 0) {
      let s = clamp((largeD / largeT) * 1.5) * 0.7;
      if (sign(largeD) !== sign(smallD) && smallD !== 0) s += 0.3 * sign(largeD);
      summary.largeDelta = largeD; summary.smallDelta = smallD;
      notes.push(`крупные игроки за ${Math.round(f.coverageMin / 60) || 1} ч: ${fmtUsd(largeD, { sign: true })}, розница ${fmtUsd(smallD, { sign: true })}`);
      if (Math.abs(s) >= 0.35) items.push({ text: s > 0 ? `Крупные игроки покупают (${fmtUsd(largeD, { sign: true })})${smallD < 0 ? ', а розница продаёт' : ''}` : `Крупные игроки продают (${fmtUsd(largeD, { sign: true })})${smallD > 0 ? ', а розница покупает' : ''}`, s: clamp(s) * 0.2 });
      parts.push([clamp(s), 0.2]);
    }
    const w = (flow.h4 ?? flow.h1).whales;
    if (w.buy + w.sell > 0) {
      const net = (w.buy - w.sell) / (w.buy + w.sell);
      summary.whales = w;
      notes.push(`киты и крупные ордера за 4 ч: покупки ${fmtUsd(w.buy)} (${w.buyCount}), продажи ${fmtUsd(w.sell)} (${w.sellCount})`);
      if (Math.abs(net) > 0.3) items.push({ text: `Киты и крупные ордера за 4 ч: ${net > 0 ? 'перевес покупок' : 'перевес продаж'} (покупки ${fmtUsd(w.buy)}, продажи ${fmtUsd(w.sell)})`, s: clamp(net) * 0.2 });
      parts.push([clamp(net), 0.2]);
    } else parts.push([0, 0.1]);
  }

  if (book?.hasData) {
    items.push(...book.items);
    notes.push(...book.notes);
    summary.book = { imbalance: book.imbalance, walls: book.walls.length };
    parts.push([book.score, 0.2]);
  }

  if (cb && (cb.avg1h ?? cb.premium) != null) {
    const p = cb.avg1h ?? cb.premium;
    const s = clamp(p / 0.0015);
    summary.coinbase = p;
    notes.push(`премия Coinbase ${pct(p, 3)}${cb.avg1h != null ? ' (среднее за час)' : ''}`);
    if (Math.abs(p) >= 0.0008) items.push({ text: p > 0 ? `Премия Coinbase ${pct(p, 2)} — покупают американские/институциональные инвесторы` : `Цена на Coinbase ниже Binance (${pct(p, 2)}) — американские инвесторы продают`, s: s * 0.1 });
    parts.push([s, 0.1]);
  }

  if (!parts.length) return { disabled: true, score: 0, items, notes: ['нет данных о потоке ордеров'] };
  return { score: clamp(wavg(parts)), items, notes, summary };
}

// ── 3в. Индикаторы ─────────────────────────────────────────────────────────
function rsiScore(r, trendDir) {
  if (r == null) return null;
  if (trendDir > 0.3) return r < 30 ? 1 : r < 45 ? 0.7 : r < 55 ? 0.2 : r > 85 ? -0.8 : r > 75 ? -0.35 : 0;
  if (trendDir < -0.3) return r > 70 ? -1 : r > 55 ? -0.7 : r > 45 ? -0.2 : r < 15 ? 0.8 : r < 25 ? 0.35 : 0;
  return r < 25 ? 1 : r < 35 ? 0.6 : r > 75 ? -1 : r > 65 ? -0.6 : 0;
}

function scoreIndicators(tf, regime, trendDir, price) {
  const items = [], notes = [];
  const h1 = tf.h1, n = h1.C.length;

  // моментум
  const rs = [['15m', tf.m15, 0.15], ['1h', tf.h1, 0.35], ['4h', tf.h4, 0.35], ['1d', tf.d1, 0.15], ['1w', tf.w1, 0.1]].filter(([, t]) => t);
  const rv = rs.map(([nm, t, w]) => [nm, lastValid(t.rsi), w]);
  const rsiS = wavg(rv.map(([, r, w]) => [rsiScore(r, trendDir), w]));
  notes.push(`RSI: ${rv.map(([nm, r]) => `${nm} ${r?.toFixed(0) ?? '—'}`).join(' · ')}`);
  const over = rv.filter(([, r]) => r != null && r < 30).map(([nm]) => nm), overB = rv.filter(([, r]) => r != null && r > 70).map(([nm]) => nm);
  if (over.length >= 2) items.push({ text: `Перепроданность RSI сразу на ${over.join(', ')}`, s: 0.12 });
  else if (overB.length >= 2) items.push({ text: `Перекупленность RSI сразу на ${overB.join(', ')}`, s: -0.12 });
  else if (Math.abs(rsiS) >= 0.5) items.push({ text: `RSI: ${rv.map(([nm, r]) => `${nm} ${r?.toFixed(0)}`).join(', ')} — ${rsiS > 0 ? 'зона покупки с учётом тренда' : 'зона продажи с учётом тренда'}`, s: rsiS * 0.15 });

  const srsiS = (t) => {
    if (!t) return null;
    const k = t.srsi.k, d = t.srsi.d, m = k.length;
    const k1 = k[m - 1], d1 = d[m - 1], k0 = k[m - 2], d0 = d[m - 2];
    if ([k1, d1, k0, d0].some((x) => x == null)) return null;
    if (k0 <= d0 && k1 > d1 && Math.min(k0, k1) < 25) return 0.8;
    if (k0 >= d0 && k1 < d1 && Math.max(k0, k1) > 75) return -0.8;
    return k1 < 10 ? 0.3 : k1 > 90 ? -0.3 : 0;
  };
  const sr = wavg([[srsiS(tf.h1), 0.5], [srsiS(tf.h4), 0.5]]);
  if (Math.abs(sr) >= 0.6) items.push({ text: `StochRSI: разворот ${sr > 0 ? 'вверх из перепроданности' : 'вниз из перекупленности'}`, s: sr * 0.06 });

  const macdS = (t) => {
    if (!t) return null;
    const h = t.macd.hist, m = h.length;
    if (h[m - 1] == null || h[m - 4] == null) return null;
    const up = [1, 2, 3].some((k) => h[m - k] > 0 && h[m - k - 1] <= 0);
    const dn = [1, 2, 3].some((k) => h[m - k] < 0 && h[m - k - 1] >= 0);
    if (up) return 1;
    if (dn) return -1;
    return h[m - 1] > 0 ? (h[m - 1] > h[m - 2] ? 0.5 : 0.15) : (h[m - 1] < h[m - 2] ? -0.5 : -0.15);
  };
  const mc = wavg([[macdS(tf.h1), 0.5], [macdS(tf.h4), 0.5]]);
  if (Math.abs(mc) >= 0.6) items.push({ text: `MACD: ${mc > 0 ? 'импульс вверх' : 'импульс вниз'} (1h/4h)`, s: mc * 0.08 });

  const mf = lastValid(h1.mfi);
  const mfS = mf == null ? null : mf < 20 ? 0.7 : mf < 30 ? 0.3 : mf > 80 ? -0.7 : mf > 70 ? -0.3 : 0;
  if (mf != null) notes.push(`MFI(1h) ${mf.toFixed(0)}, CCI(1h) ${lastValid(h1.cci)?.toFixed(0) ?? '—'}`);
  if (mfS && Math.abs(mfS) >= 0.7) items.push({ text: mfS > 0 ? `MFI ${mf.toFixed(0)} — перепроданность с учётом объёма` : `MFI ${mf.toFixed(0)} — перекупленность с учётом объёма`, s: mfS * 0.05 });
  const cc = lastValid(h1.cci);
  const cciS = cc == null ? null : cc < -150 ? 0.4 : cc > 150 ? -0.4 : 0;
  const momentum = wavg([[rsiS, 0.45], [sr, 0.15], [mc, 0.25], [mfS, 0.1], [cciS, 0.05]]);

  // объём
  const cm = lastValid(h1.cmf);
  const cmfS = cm == null ? 0 : clamp(cm * 5);
  if (cm != null && Math.abs(cm) >= 0.1) items.push({ text: `Chaikin Money Flow ${cm.toFixed(2)} — ${cm > 0 ? 'приток денег' : 'отток денег'}`, s: cmfS * 0.06 });
  const ps = sign(slope(h1.C, 20)), os = sign(slope(h1.obv, 20));
  let obvS = os * 0.4;
  if (ps !== os && os !== 0) { obvS = os * 0.7; items.push({ text: `OBV расходится с ценой — ${os > 0 ? 'объём на стороне покупателей' : 'объём на стороне продавцов'}`, s: obvS * 0.05 }); }
  const lastC = h1.candles[n - 1];
  const vAvg = mean(h1.V.slice(-21, -1)) || 1;
  const vr = lastC.volume / vAvg;
  let spikeS = 0;
  if (vr > 1.8) { spikeS = sign(lastC.close - lastC.open) * 0.6; notes.push(`объём последней свечи 1h ×${vr.toFixed(1)} от среднего`); }
  let vwapS = 0;
  const vw = vwapRange(h1.candles, n - 24);
  if (vw) {
    const z = vw.sd ? (price - vw.vwap) / vw.sd : 0;
    const rangey = regime.key === 'range' || regime.key === 'transition';
    vwapS = rangey ? clamp(-z / 2.5) : clamp(sign(price - vw.vwap) * 0.4 - (Math.abs(z) > 2.5 ? sign(z) * 0.3 : 0));
    notes.push(`VWAP 24 ч ${fmt(vw.vwap)}, цена ${z >= 0 ? '+' : ''}${z.toFixed(1)}σ`);
    if (Math.abs(z) >= 2) items.push({ text: `Цена отклонилась от VWAP на ${z.toFixed(1)}σ — ${z < 0 ? 'перепродана относительно средней цены сделок' : 'перекуплена относительно средней цены сделок'}`, s: (rangey ? -sign(z) : -sign(z) * 0.5) * 0.06 });
  }
  const volume = wavg([[cmfS, 0.35], [obvS, 0.25], [spikeS, 0.15], [vwapS, 0.25]]);

  // волатильность / возврат к среднему
  const b = lastValid(h1.bb.pctB);
  const rangey = regime.key === 'range' || regime.key === 'squeeze' || regime.key === 'transition';
  let bbS = 0;
  if (b != null) {
    if (b < 0) bbS = rangey ? 0.7 : 0.2;
    else if (b < 0.1) bbS = rangey ? 0.35 : 0.1;
    else if (b > 1) bbS = rangey ? -0.7 : -0.2;
    else if (b > 0.9) bbS = rangey ? -0.35 : -0.1;
    notes.push(`Боллинджер %B ${b.toFixed(2)}`);
  }
  const sqOn = h1.sq.on, sqM = h1.sq.momentum, m2 = sqOn.length;
  let sqS = 0;
  const firedNow = sqOn[m2 - 1] === false && sqOn.slice(-4, -1).some((x) => x === true);
  if (sqOn[m2 - 1] === true) { sqS = sign(sqM[m2 - 1] ?? 0) * 0.3; notes.push('сжатие волатильности (TTM Squeeze) — скоро сильное движение'); }
  else if (firedNow) {
    sqS = sign(sqM[m2 - 1] ?? 0) * 0.7;
    items.push({ text: `Выход из сжатия волатильности ${sqS > 0 ? 'вверх' : 'вниз'}`, s: sqS * 0.08 });
  }
  const vol = wavg([[bbS, 0.6], [sqS, 0.4]]);

  return { score: clamp(0.45 * momentum + 0.3 * volume + 0.25 * vol), items, notes, summary: { rsi: Object.fromEntries(rv.map(([nm, r]) => [nm, r])), mfi: mf, cmf: cm } };
}

// ── 4. Паттерны ───────────────────────────────────────────────────────────
function scorePatterns(sets, lv, price, atr) {
  const items = [], notes = [];
  const atSup = lv.supports.some((z) => z.strength >= 0.9 && z.distAtr <= 0.6);
  const atRes = lv.resistances.some((z) => z.strength >= 0.9 && z.distAtr <= 0.6);
  let sum = 0;
  const targets = [];
  const list = [];
  for (const { tf, w, res } of sets) {
    if (!res) continue;
    for (const p of res.found) {
      if (p.info || !p.score) { notes.push(`${p.name} (${tf})`); continue; }
      let mult = w;
      if (p.kind === 'candle') mult *= p.dir > 0 ? (atSup ? 1.4 : 0.6) : (atRes ? 1.4 : 0.6);
      const v = p.score * mult;
      sum += v;
      list.push({ p, tf, v });
      if (p.target) targets.push({ price: p.target, dir: p.dir, name: p.name });
    }
  }
  const score = Math.tanh(sum / 1.5);
  for (const { p, tf, v } of list.sort((a, b) => Math.abs(b.v) - Math.abs(a.v))) {
    const text = `${p.name[0].toUpperCase()}${p.name.slice(1)} (${tf})${p.target ? `, цель фигуры ${fmt(p.target)}` : ''}`;
    items.push({ text, s: Math.tanh(v / 1.5) * 0.5 });
  }
  notes.unshift(...list.slice(0, 6).map(({ p, tf, v }) => `${v > 0 ? '▲' : '▼'} ${p.name} (${tf})`));
  if (!list.length) notes.push('явных паттернов нет');
  return { score, items, notes, targets };
}

// ── 5. Новости и настроение ────────────────────────────────────────────────
function scoreNews(news, market, isBtc) {
  const items = [], notes = [];
  const parts = [];
  if (news && !news.disabled) {
    items.push(...news.items);
    notes.push(...news.notes);
    parts.push([news.score, 0.6]);
  }
  const f = market?.fng;
  if (f) {
    const v = f.value;
    const s = v <= 20 ? 0.6 : v <= 35 ? 0.25 : v >= 80 ? -0.6 : v >= 65 ? -0.25 : 0;
    notes.push(`индекс страха и жадности ${v} (${f.label})${f.change7d ? `, за неделю ${f.change7d > 0 ? '+' : ''}${f.change7d}` : ''}`);
    if (Math.abs(s) >= 0.6) items.push({ text: s > 0 ? `Крайний страх на рынке (${v}) — исторически хорошее время для покупок` : `Крайняя жадность на рынке (${v}) — исторически время фиксировать прибыль`, s: s * 0.25 });
    parts.push([s, 0.25]);
  }
  const g = market?.global;
  if (g) {
    let s = g.mcapChange24h != null ? clamp(g.mcapChange24h / 8) : 0;
    const txt = [];
    if (g.mcapChange24h != null) txt.push(`капитализация рынка за 24 ч ${g.mcapChange24h >= 0 ? '+' : ''}${g.mcapChange24h.toFixed(1)}%`);
    if (g.btcDom != null) txt.push(`доминация BTC ${g.btcDom.toFixed(1)}%${g.btcDomChange24h != null ? ` (${g.btcDomChange24h >= 0 ? '+' : ''}${g.btcDomChange24h.toFixed(2)})` : ''}`);
    if (!isBtc && g.btcDomChange24h != null) {
      if (g.btcDomChange24h > 0.5) { s -= 0.4; items.push({ text: 'Доминация биткоина растёт — деньги уходят из альткоинов', s: -0.4 * 0.15 }); }
      else if (g.btcDomChange24h < -0.5) { s += 0.4; items.push({ text: 'Доминация биткоина падает — деньги перетекают в альткоины', s: 0.4 * 0.15 }); }
    }
    if (g.stableDomChange24h != null && g.stableDomChange24h > 0.2) { s -= 0.3; txt.push('растёт доля стейблкоинов (уход в «кэш»)'); }
    const st7 = g.stable7d;
    if (st7) {
      txt.push(`стейблкоины за ${st7.days} дн. ${fmtUsd(st7.abs, { sign: true })}`);
      if (st7.rel > 0.01) { s += 0.2; items.push({ text: `Капитализация стейблкоинов за неделю ${fmtUsd(st7.abs, { sign: true })} — на рынок приходит ликвидность`, s: 0.2 * 0.15 }); }
      else if (st7.rel < -0.01) { s -= 0.2; items.push({ text: `Капитализация стейблкоинов за неделю ${fmtUsd(st7.abs, { sign: true })} — ликвидность уходит`, s: -0.2 * 0.15 }); }
    }
    notes.push(txt.join(', '));
    parts.push([clamp(s), 0.15]);
  }
  if (!parts.length) return { disabled: true, score: 0, items, notes: ['новости и фон рынка недоступны'] };
  return { score: clamp(wavg(parts)), items, notes };
}

/**
 * Полный анализ монеты.
 * @param {object} b — набор данных (см. index.js gather()); обязательны только свечи 1h
 * @param {object} cfg
 */
export function analyze(b, cfg) {
  const { symbol } = b;
  const kind = b.kind === 'stock' ? 'stock' : 'crypto';
  const isBtc = kind === 'crypto' && /^BTC/.test(symbol);
  const leadName = kind === 'stock' ? b.btc?.name ?? 'индекс' : 'BTC';
  const co = !!b.closedOnly;
  const raw = b.candles;
  const c15 = closed(raw.m15, co), c1 = closed(raw.h1, co), c4 = closed(raw.h4, co), cD = closed(raw.d1, co);
  const tf = { m15: computeTF(c15, '15m'), h1: computeTF(c1, '1h'), h4: computeTF(c4, '4h'), d1: computeTF(cD, '1d'), w1: computeTF(cD ? toWeekly(cD) : null, '1w') };
  if (!tf.h1) throw new Error(`${symbol}: недостаточно часовых свечей для анализа`);
  const price = b.price ?? raw.h1[raw.h1.length - 1].close;
  const atr1 = tf.h1.atrV, atr4 = tf.h4?.atrV ?? atr1 * 2;
  const regime = detectRegime(tf);

  // паттерны на трёх таймфреймах
  const pat = (t, c, atrV, maxAge) => (t && c ? detectPatterns(c, { rsi: t.rsi, macdHist: t.macd.hist, cvd: t.cvd }, atrV, { fmt, maxDivAge: maxAge }) : null);
  const p15 = pat(tf.m15, c15, tf.m15?.atrV, 10), p1 = pat(tf.h1, c1, atr1, 12), p4 = pat(tf.h4, c4, atr4, 8);

  // уровни: + стены стакана + FVG и ордер-блоки
  const extra = [...(b.book?.levelCands ?? [])];
  for (const [res, tfn, w] of [[p1, '1h', 0.45], [p4, '4h', 0.6]]) {
    for (const z of res?.zones ?? []) {
      extra.push({
        price: (z.low + z.high) / 2, low: z.low, high: z.high, w: z.kind === 'ob' ? w + 0.1 : w,
        label: `${z.kind === 'ob' ? 'ордер-блок' : 'FVG'} ${tfn} (${z.side === 'bull' ? 'бычий' : 'медвежий'})`, kind: z.kind,
      });
    }
  }
  const lv = buildLevels({ price, atr1h: atr1, atr4h: atr4, m15: raw.m15, h1: raw.h1, h4: raw.h4, d1: raw.d1, extra });

  // корреляция с биткоином и относительная сила
  let btcCtx = null, rs = null;
  if (!isBtc && b.btc?.h1?.length > 60) {
    const map = new Map(b.btc.h1.map((c) => [c.time, c.close]));
    const pairs = c1.slice(-200).filter((c) => map.has(c.time)).map((c) => [c.close, map.get(c.time)]);
    if (pairs.length > 50) {
      const { corr } = correlation(logReturns(pairs.map((p) => p[0])), logReturns(pairs.map((p) => p[1])));
      btcCtx = { corr, trend: b.btc.trend ?? 0, score: b.btc.score ?? 0 };
      const ratio = pairs.map((p) => p[0] / p[1]);
      const r20 = mean(ratio.slice(-20)), r50 = mean(ratio.slice(-50));
      rs = clamp(((r20 / r50 - 1) * 100) / 3);
    }
  }

  // фактическая волатильность за 30 дней (годовая) — для сравнения с опционами
  const dC = cD?.map((x) => x.close) ?? [];
  const rets = logReturns(dC.slice(-31));
  const rv30 = rets.length >= 20 ? Math.sqrt(rets.reduce((s, x) => s + x * x, 0) / rets.length) * Math.sqrt(365) : null;
  const liqmap = b.deriv?.oi ? liquidationMap({ oi: b.deriv.oi, candles: raw.h1, price, atr: atr1 }) : null;

  const blocks = {
    levels: scoreLevels(lv, price, atr1, tf.h1.C, fmt, cfg.levels),
    trend: scoreTrend(tf, p4?.structure.trend ?? p1?.structure.trend, btcCtx, isBtc, rs, leadOf(kind, leadName), b.breadth ?? null),
    derivatives: scoreDerivatives(b.deriv, b.liq, tf, regime, { liqmap, options: b.options ?? null, price, rv30, now: b.now ?? Date.now() }),
    flow: scoreFlow(tf, closed(b.fut?.h1, co), b.flow, b.book, b.coinbase, kind),
    indicators: null,
    patterns: scorePatterns([{ tf: '15m', w: 0.5, res: p15 }, { tf: '1h', w: 1, res: p1 }, { tf: '4h', w: 1.5, res: p4 }], lv, price, atr1),
    news: scoreNews(b.news, b.market, isBtc),
  };
  blocks.indicators = scoreIndicators(tf, regime, blocks.trend.score, price);

  // веса с учётом режима рынка
  const weights = {};
  let wAll = 0, wOn = 0;
  for (const [k, w0] of Object.entries(cfg.weights)) {
    const w = w0 * (regime.w[k] ?? 1);
    wAll += w0;
    if (!blocks[k] || blocks[k].disabled) continue;
    weights[k] = w; wOn += w0;
  }
  const wSum = Object.values(weights).reduce((s, x) => s + x, 0);
  for (const k of Object.keys(weights)) weights[k] /= wSum;
  const score = clamp(Object.entries(weights).reduce((s, [k, w]) => s + w * blocks[k].score, 0));
  const completeness = wAll ? wOn / wAll : 0;
  let agreeW = 0;
  for (const [k, w] of Object.entries(weights)) if (sign(blocks[k].score) === sign(score) && Math.abs(blocks[k].score) > 0.1) agreeW += w;
  const agreement = agreeW;

  // решение
  const dir = score >= 0 ? 'BUY' : 'SELL';
  const htf = wavg([[tf.h4?.stack, 0.4], [tf.d1?.stack, 0.4], [tf.w1?.stack, 0.2]]);
  const now = b.now ?? Date.now();
  const badNews = (b.news?.alerts ?? []).find((a) => a.impact <= -2.5 && a.direct && now - a.time < 6 * 3600e3) ?? null;
  const plan = buildPlan({
    dir, price, atr: atr1, levels: lv, stopMult: regime.stopMult,
    patternTargets: blocks.patterns.targets.filter((t) => t.dir === (dir === 'BUY' ? 1 : -1)).map((t) => t.price),
    risk: cfg.risk,
  });
  const macro = b.macro?.risk ?? null;
  const core = { score, agreement, completeness, regime: { thresholdAdj: regime.thresholdAdj }, htf, btcScore: btcCtx?.score ?? null, isBtc, kind, leadName, badNews: badNews ? { event: badNews.event, title: badNews.title } : null, macro, plan };
  const dec = decide(core, cfg);

  // главные причины
  const all = [];
  for (const [k, blk] of Object.entries(blocks)) {
    if (!blk || blk.disabled) continue;
    for (const it of blk.items ?? []) if (it.s) all.push({ text: it.text, v: it.s * (weights[k] ?? 0), block: k });
  }
  const pro = all.filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 6);
  const contra = all.filter((x) => x.v < 0).sort((a, b) => a.v - b.v).slice(0, 6);

  // статистика
  const H1 = raw.h1, m = H1.length;
  const chg = (k) => (m > k ? price / H1[m - 1 - k].close - 1 : null);
  const last24 = H1.slice(-24);
  const stats = {
    change1h: chg(1), change4h: chg(4), change24h: chg(24), change7d: raw.d1?.length > 7 ? price / raw.d1[raw.d1.length - 8].close - 1 : null,
    high24h: Math.max(...last24.map((c) => c.high)), low24h: Math.min(...last24.map((c) => c.low)),
    volume24h: last24.reduce((s, c) => s + (c.quoteVolume || c.volume * c.close), 0),
    atr: atr1, atrPct: atr1 / price,
  };

  return {
    symbol, name: b.name ?? null, kind, price, time: now, dataTime: H1[m - 1].closeTime ?? H1[m - 1].time,
    liqmap, options: b.options ?? null, breadth: b.breadth ?? null, rv30,
    regime: { key: regime.key, label: regime.label, adx4: regime.adx4, atrPct: regime.atrPct, squeeze: regime.squeeze, thresholdAdj: regime.thresholdAdj, stopMult: regime.stopMult },
    score, agreement, completeness, ...dec, plan, weights, blocks,
    core: { htf, btcScore: core.btcScore, isBtc, kind, leadName, badNews: core.badNews, macro },
    macro: b.macro ?? null,
    reasons: { pro, contra },
    levels: {
      inside: lv.inside.filter((z) => z.strength >= 0.8).slice(0, 1),
      supports: lv.supports.filter((z) => z.strength >= 0.8).slice(0, 5),
      resistances: lv.resistances.filter((z) => z.strength >= 0.8).slice(0, 5),
      prev: lv.prev, naked: lv.naked.slice(-5), fib: lv.fib ? { up: lv.fib.up, hi: lv.fib.hi, lo: lv.fib.lo } : null,
      poc: { short: lv.profiles.short?.poc, mid: lv.profiles.mid?.poc, long: lv.profiles.long?.poc, macro: lv.profiles.macro?.poc },
    },
    tfs: Object.fromEntries(Object.entries(tf).filter(([, t]) => t).map(([k, t]) => [k, { trend: trendWord(t.stack), stack: t.stack, rsi: lastValid(t.rsi), atr: t.atrV }])),
    stats,
    news: b.news ? { top: b.news.top ?? [], alerts: b.news.alerts ?? [] } : null,
    btcCorr: btcCtx?.corr ?? null,
  };
}

/**
 * Решение по готовой оценке: порог, фильтры, прибыль/риск. Вынесено отдельно,
 * чтобы бэктест мог перебирать пороги без повторного расчёта всего анализа.
 */
export function decide(d, cfg) {
  const sc = cfg.signal;
  const { score, agreement, completeness, regime, htf, btcScore, isBtc, badNews, macro, plan, kind = 'crypto', leadName = 'индекс' } = d;
  const stock = kind === 'stock';
  const thr = sc.threshold + (regime?.thresholdAdj ?? 0);
  let action = 'NEUTRAL';
  const warnings = [];
  if (Math.abs(score) >= thr) action = score > 0 ? 'BUY' : 'SELL';
  else if (Math.abs(score) >= thr * sc.watchRatio) action = score > 0 ? 'WATCH_BUY' : 'WATCH_SELL';
  const downgrade = (why) => { if (action === 'BUY' || action === 'SELL') { action = `WATCH_${action}`; warnings.push(why); } };

  // запреты на вход: считаются для направления оценки при любой её силе — вход в зоне по более слабой
  // оценке проверяет их тоже (иначе зона сработала бы перед заседанием ФРС или после плохой новости)
  const buyDir = score >= 0;
  const vetoes = [];
  if (buyDir && htf <= -0.6 && score < thr + sc.counterTrendExtra) vetoes.push('сигнал против старшего тренда (4h, 1d и неделя смотрят вниз) — нужна более сильная оценка');
  if (!buyDir && htf >= 0.6 && -score < thr + sc.counterTrendExtra) vetoes.push('сигнал против старшего тренда (4h, 1d и неделя смотрят вверх) — нужна более сильная оценка');
  if (!isBtc && btcScore != null && buyDir && btcScore <= -0.45 && score < thr + 0.1) vetoes.push(stock ? `рынок акций (${leadName}) сейчас сильно медвежий — покупки акций рискованны` : 'биткоин сейчас сильно медвежий — покупки альткоинов рискованны');
  if (!isBtc && btcScore != null && !buyDir && btcScore >= 0.45 && -score < thr + 0.1) vetoes.push(stock ? `рынок акций (${leadName}) сейчас сильно бычий — продажа против рынка рискованна` : 'биткоин сейчас сильно бычий — продажа против рынка рискованна');
  if (badNews) vetoes.push(`свежая негативная новость (${badNews.event.toLowerCase()}): «${badNews.title}» — дождитесь реакции рынка`);
  if (macro && cfg.macro?.filter !== false) {
    vetoes.push(macro.phase === 'before'
      ? `через ${fmtDuration(macro.minutesTo * 60e3)} ${macro.name} — возможны резкие движения, новый вход лучше отложить`
      : `${macro.name} было ${fmtDuration(-macro.minutesTo * 60e3)} назад — рынок ещё нервный, дождитесь успокоения`);
  }

  if (agreement < sc.minAgreement) downgrade(`мало подтверждений: в одну сторону смотрят блоки весом только ${(agreement * 100).toFixed(0)}%`);
  for (const v of vetoes) downgrade(v);
  // сильный сигнал, прошедший все фильтры: ему может не хватать только хорошей цены (прибыль/риск ниже)
  const setup = action === 'BUY' || action === 'SELL' ? action : null;

  let reason = '';
  let zoneOk = plan.rr >= sc.minRiskReward;
  if ((action === 'BUY' || action === 'SELL') && plan.rrNow < sc.minRiskReward) {
    reason = zoneOk
      ? `прибыль/риск от текущей цены ${plan.rrNow.toFixed(2)} ниже ${sc.minRiskReward} — лучше дождаться цены в зоне ${fmt(plan.zone[0])}–${fmt(plan.zone[1])}`
      : `до ближайшей цели мало места: прибыль/риск ${plan.rrNow.toFixed(2)} (даже от зоны входа ${plan.rr.toFixed(2)}) — хорошей точки входа пока нет`;
    action = `WATCH_${action}`;
  }
  if (action === 'NEUTRAL') zoneOk = false;

  const confidence = Math.round(100 * Math.min(1, Math.abs(score) / sc.strong) * (0.4 + 0.6 * agreement) * Math.sqrt(completeness));
  return {
    action, setup, vetoes, warnings, reason, zoneOk, threshold: thr, confidence,
    confidenceLabel: confidence >= 75 ? 'высокая' : confidence >= 50 ? 'средняя' : 'низкая',
    strength: Math.abs(score) >= sc.strong ? 'сильный' : 'умеренный',
  };
}
