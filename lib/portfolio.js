// 💼 Счёт целиком: что сделки бэктеста сделали бы с балансом — с теми же правилами, что у автоторговли (trader.js):
// риск на сделку в % баланса, потолок позиции плечом, не больше N позиций, не больше M в одну сторону,
// суммарный риск открытых сделок, серия убытков (после двух — риск вдвое меньше, после трёх — пауза),
// пауза по монете после убытка, дневной и недельный лимиты убытка, остановка по просадке от максимума.
//
// Упрощения: сделки по разным монетам независимы (пропуск сделки не меняет следующих по этой монете),
// баланс меняется в момент закрытия сделки, результат сделки — её R из бэктеста × риск в долларах.
const H = 3600e3, DAY = 86400e3;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

export const SKIP_RU = {
  'max positions': 'все места заняты', 'same side': 'уже есть сделки в ту же сторону', 'open risk': 'суммарный риск открытых сделок',
  'loss streak': 'пауза после серии убытков', cooldown: 'пауза по монете после убытка', 'daily loss': 'дневной лимит убытка',
  'weekly loss': 'недельный лимит убытка', 'daily trades': 'дневной максимум сделок', drawdown: 'остановка по просадке',
};

/**
 * @param {Array<{ sym: string, side: 'BUY'|'SELL', t0: number, t1: number, r: number, stopPct: number, safeAt?: number|null, regime?: string }>} trades
 *   t0/t1 — вход и выход (мс), r — итог в рисках (с комиссией), stopPct — расстояние до стопа в долях цены,
 *   safeAt — когда стоп перенесён в безубыток (с этого момента сделка не несёт риска)
 * @param {object} rules — настройки как cfg.trade (riskPct, leverage, maxPositions, …)
 * @param {{ start?: number, protect?: boolean }} [opts] — protect: false — без правил защиты 2.9 (только риск на сделку,
 *   плечо, число позиций, дневной лимит убытка и сделок)
 * @returns {{ start, equity, returnPct, maxDdPct, taken, skipped: Record<string, number>, halted: number|null,
 *   wins, losses, worstDayPct, days, curve: Array<[number, number]> }}
 */
export function simulateAccount(trades, rules, { start = 10000, protect = true } = {}) {
  const c = rules, fee = (c.feePct ?? 0.055) / 100;
  const list = [...trades].filter((t) => Number.isFinite(t.r) && t.t1 >= t.t0).sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  let equity = start, peak = start, top = start, maxDd = 0, halted = null;
  let day = null, dayStart = start, pnlToday = 0, pausedDay = null, openedToday = 0, worstDay = 0;
  let open = [];
  const closed = []; // { sym, t, r, pnl } по времени закрытия
  const skipped = {};
  const curve = [[list[0]?.t0 ?? 0, start]];
  let taken = 0, wins = 0, losses = 0;
  const skip = (code) => { skipped[code] = (skipped[code] ?? 0) + 1; };
  const roll = (t) => {
    const d = dayOf(t);
    if (d === day) return;
    worstDay = Math.min(worstDay, dayStart > 0 ? pnlToday / dayStart : 0);
    day = d; dayStart = equity; pnlToday = 0; pausedDay = null; openedToday = 0;
  };
  const settle = (until) => {
    open.sort((a, b) => a.t1 - b.t1);
    while (open.length && open[0].t1 <= until) {
      const p = open.shift();
      roll(p.t1);
      const pnl = p.r * p.riskUsd;
      equity += pnl;
      pnlToday += pnl;
      closed.push({ sym: p.sym, t: p.t1, r: p.r, pnl });
      if (p.r > 0.05) wins++; else if (p.r < -0.05) losses++;
      curve.push([p.t1, equity]);
      top = Math.max(top, equity);
      maxDd = Math.max(maxDd, top > 0 ? 1 - equity / top : 0);
      if (c.dailyLossPct > 0 && pnlToday <= (-dayStart * c.dailyLossPct) / 100) pausedDay = day;
      if (protect && c.maxDrawdownPct > 0 && halted == null) {
        if (equity > peak) peak = equity;
        else if (equity <= peak * (1 - c.maxDrawdownPct / 100)) halted = p.t1;
      }
    }
  };
  const streak = () => {
    let n = 0, at = null;
    for (let i = closed.length - 1; i >= 0; i--) {
      const x = closed[i];
      if (x.r >= 0.3) break;
      if (x.r <= -0.3) { n++; at ??= x.t; }
    }
    return { n, at };
  };

  for (const t of list) {
    settle(t.t0);
    roll(t.t0);
    if (halted != null) { skip('drawdown'); continue; }
    if (c.maxPerDay > 0 && openedToday >= c.maxPerDay) { skip('daily trades'); continue; }
    if (pausedDay === day) { skip('daily loss'); continue; }
    let mult = 1;
    if (protect) {
      if (c.weeklyLossPct > 0) {
        const w = closed.filter((x) => x.t >= t.t0 - 7 * DAY).reduce((s, x) => s + x.pnl, 0);
        if (w <= (-equity * c.weeklyLossPct) / 100) { skip('weekly loss'); continue; }
      }
      const st = streak();
      if (c.lossStreakPause > 0 && st.n >= c.lossStreakPause && t.t0 - st.at < c.lossPauseHours * H) { skip('loss streak'); continue; }
      if (c.cooldownHours > 0) {
        let last = null;
        for (let i = closed.length - 1; i >= 0 && !last; i--) if (closed[i].sym === t.sym) last = closed[i];
        if (last && last.r <= -0.3 && t.t0 - last.t < c.cooldownHours * H) { skip('cooldown'); continue; }
      }
      if (st.n >= 2) mult *= 0.5;
      if (t.regime === 'volatile' && c.volRiskMult > 0 && c.volRiskMult < 1) mult *= c.volRiskMult;
    }
    if (open.length >= c.maxPositions) { skip('max positions'); continue; }
    if (protect && c.maxSameSide > 0 && open.filter((p) => p.side === t.side).length >= c.maxSameSide) { skip('same side'); continue; }
    let want = (equity * c.riskPct * mult) / 100;
    if (protect && c.maxOpenRiskPct > 0) {
      const used = open.reduce((s, p) => s + (p.safeAt != null && p.safeAt <= t.t0 ? 0 : p.riskUsd), 0);
      const room = (equity * c.maxOpenRiskPct) / 100 - used;
      if (room < want * 0.25) { skip('open risk'); continue; }
      want = Math.min(want, room);
    }
    // потолок позиции: доля покупательной способности (баланс × плечо / число позиций), как в sizePosition
    const stopPct = Math.max(t.stopPct || 0, 1e-4);
    const notional = Math.min(want / (stopPct + 2 * fee), (equity * c.leverage) / Math.max(1, c.maxPositions));
    const riskUsd = notional * stopPct;
    if (!(riskUsd > 0)) { skip('open risk'); continue; }
    open.push({ sym: t.sym, side: t.side, t1: t.t1, r: t.r, riskUsd, safeAt: t.safeAt ?? null });
    openedToday++;
    taken++;
  }
  settle(Infinity);
  worstDay = Math.min(worstDay, dayStart > 0 ? pnlToday / dayStart : 0);
  const span = list.length ? (Math.max(...list.map((t) => t.t1)) - list[0].t0) / DAY : 0;
  return {
    start, equity, returnPct: (equity / start - 1) * 100, maxDdPct: maxDd * 100, taken, total: list.length, skipped, halted,
    wins, losses, worstDayPct: worstDay * 100, days: span, curve: thin(curve, 120),
  };
}

// не больше n точек кривой (для графика в панели)
function thin(curve, n) {
  if (curve.length <= n) return curve;
  const out = [], k = (curve.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(curve[Math.round(i * k)]);
  return out;
}

/** «+12.4% ($11 240), просадка до 6.8%, сделок 61 из 84» */
export function accountText(a, { money = (x) => `$${Math.round(x).toLocaleString('ru-RU')}` } = {}) {
  const sk = Object.entries(a.skipped).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} — ${SKIP_RU[k] ?? k}`);
  return `${a.returnPct >= 0 ? '+' : '−'}${Math.abs(a.returnPct).toFixed(1)}% (${money(a.start)} → ${money(a.equity)}), просадка до ${a.maxDdPct.toFixed(1)}%, худший день ${a.worstDayPct <= -0.05 ? `−${Math.abs(a.worstDayPct).toFixed(1)}%` : '0%'}; сделок ${a.taken} из ${a.total}${sk.length ? ` (пропущено: ${sk.join('; ')})` : ''}${a.halted != null ? `; ⛔ торговля остановлена по просадке ${new Date(a.halted).toISOString().slice(0, 10)}` : ''}`;
}
