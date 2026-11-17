const FUNDING_INTERVAL = 8 * 3600e3;

/** Издержки в цене на единицу актива. Половина спреда на рыночную сторону, плюс проскальзывание. */
export function executionCosts(trade, { feePct, spreadBps, slippageBps, fundingBps, funding = null, tp1Share }) {
  const halfSpread = spreadBps / 2 / 1e4;
  const slip = slippageBps / 1e4;
  const remaining = trade.tp1 ? 1 - tp1Share : 1;
  const turnover = trade.entry + remaining * trade.exit + (trade.tp1 ? tp1Share * trade.target1 : 0);
  const market = trade.entry + (trade.why === 'tp2' ? 0 : remaining * trade.exit);
  let fundingCost = 0;
  if (funding) {
    const side = trade.side === 'BUY' ? 1 : -1;
    for (const x of funding) {
      if (x.time <= trade.t0) continue;
      if (x.time > trade.t1) break;
      const share = trade.tp1At != null && x.time > trade.tp1At ? remaining : 1;
      fundingCost += x.rate * (x.price || trade.entry) * side * share;
    }
  } else {
    const times = (a, b) => Math.max(0, Math.floor(b / FUNDING_INTERVAL) - Math.floor(a / FUNDING_INTERVAL));
    const endFull = trade.tp1At ?? trade.t1;
    fundingCost = trade.entry * fundingBps / 1e4 * (times(trade.t0, endFull) + remaining * times(endFull, trade.t1));
  }
  return { fee: turnover * feePct / 200, spread: market * halfSpread, slippage: market * slip, funding: fundingCost };
}

export const tradesIn = (trades, start, end) => trades.filter((t) => t.t0 >= start && t.t1 < end);

export function lastClosedIndex(candles, at) {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles[mid].closeTime <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Сначала обучаемся на прошлом окне, затем оцениваем только выбранный порог на следующем. */
export function walkForward(runs, { start, end, stats }) {
  const boundaries = [0, 0.4, 0.6, 0.8, 1].map((p) => start + Math.floor((end - start) * p));
  const select = (until) => [...runs.entries()].map(([threshold, trades]) => ({
    threshold, train: stats(tradesIn(trades, start, until)),
  })).filter(({ train }) => train.n >= 10 && train.sumR > 0)
    .sort((a, b) => b.train.sumR - a.train.sumR || a.train.maxDD - b.train.maxDD || b.threshold - a.threshold)[0] ?? null;
  const grade = (from, to) => {
    const picked = select(from);
    return { from, to, threshold: picked?.threshold ?? null, train: picked?.train ?? null,
      test: picked ? stats(tradesIn(runs.get(picked.threshold), from, to)) : null };
  };
  const folds = [grade(boundaries[1], boundaries[2]), grade(boundaries[2], boundaries[3])];
  const holdout = grade(boundaries[3], boundaries[4]);
  const passed = (x) => x.test?.n >= 5 && x.test.sumR > 0 && x.test.pf >= 1.1;
  const recommended = [...folds, holdout].every(passed) ? holdout.threshold : null;
  return { folds, holdout, recommended };
}
