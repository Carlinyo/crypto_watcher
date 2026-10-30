// Режим рынка и подстройка весов анализа под него.
// В тренде важнее трендовые сигналы, в боковике — уровни и осцилляторы, при сжатии — пробои,
// при высокой волатильности — деривативы и поток ордеров (и стопы шире, порог строже).
import { percentileRank, lastValid } from './indicators.js';

export const REGIMES = {
  trend_up: { label: 'восходящий тренд', w: { trend: 1.35, levels: 0.9, indicators: 0.8, patterns: 1.05, derivatives: 1, flow: 1, news: 1 }, thresholdAdj: 0, stopMult: 1 },
  trend_down: { label: 'нисходящий тренд', w: { trend: 1.35, levels: 0.9, indicators: 0.8, patterns: 1.05, derivatives: 1, flow: 1, news: 1 }, thresholdAdj: 0, stopMult: 1 },
  range: { label: 'боковик', w: { trend: 0.6, levels: 1.35, indicators: 1.2, patterns: 1, derivatives: 1, flow: 1.05, news: 1 }, thresholdAdj: 0, stopMult: 1 },
  squeeze: { label: 'сжатие перед сильным движением', w: { trend: 0.85, levels: 1, indicators: 0.9, patterns: 1.25, derivatives: 1.1, flow: 1.15, news: 1 }, thresholdAdj: 0, stopMult: 1 },
  volatile: { label: 'высокая волатильность', w: { trend: 0.9, levels: 1, indicators: 0.85, patterns: 0.8, derivatives: 1.2, flow: 1.2, news: 1.1 }, thresholdAdj: 0.05, stopMult: 1.3 },
  transition: { label: 'переходный режим', w: { trend: 1, levels: 1, indicators: 1, patterns: 1, derivatives: 1, flow: 1, news: 1 }, thresholdAdj: 0, stopMult: 1 },
};

export function detectRegime(tf) {
  const h1 = tf.h1, h4 = tf.h4 ?? tf.h1;
  const adx4 = lastValid(h4.adx.adx) ?? 20;
  const stack4 = h4.stack ?? 0;
  const atrPctSeries = h1.atr.map((a, i) => (a == null ? null : a / h1.C[i]));
  const atrPct = percentileRank(atrPctSeries.slice(-300), lastValid(atrPctSeries)) ?? 0.5;
  const bbwPct = percentileRank(h1.bb.width.slice(-300), lastValid(h1.bb.width)) ?? 0.5;
  const sqOn = h1.sq.on[h1.sq.on.length - 1] === true;

  let key;
  if (atrPct >= 0.93) key = 'volatile';
  else if (adx4 >= 25 && Math.abs(stack4) >= 0.66) key = stack4 > 0 ? 'trend_up' : 'trend_down';
  else if (sqOn || bbwPct <= 0.12) key = 'squeeze';
  else if (adx4 < 20) key = 'range';
  else key = 'transition';

  return { key, label: REGIMES[key].label, adx4, atrPct, bbwPct, squeeze: sqOn, ...REGIMES[key] };
}
