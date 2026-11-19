// 🛡 Надёжный стоп для сильного сигнала.
//
// Обычный стоп при входе на ретесте — сразу за уровнем и за минимумом касания (0.2–0.3 ATR). Он короткий, и
// повторный прокол уровня фитилём (частый на крипте и акциях 24/7) выбивает сделку, после чего цена идёт туда,
// куда и показывал анализ. Для сильного сигнала программа выносит стоп за следующую опору:
//   • за следующую поддержку ниже уровня входа (основание, от которого начался пробой), или
//   • за ближайший значимый минимум последних суток (место, где уже сняли стопы),
// выбирая самый дальний вариант, который ещё укладывается в пределы:
//   — не дальше 4 часовых ATR от входа;
//   — прибыль/риск до цели 1 не меньше 1, до цели 2 — не меньше MIN_RR.
// Риск сделки в долларах НЕ растёт: размер позиции считается от стопа, поэтому при более дальнем стопе позиция меньше.
import { fmt } from './format.js';

/** Сильный ли сигнал для надёжного стопа: оценка от «сильной» (0.55) или уверенность от 70% */
export function isStrongSignal(r, { strong = 0.55 } = {}) {
  return Math.abs(r?.score ?? 0) >= strong || (r?.confidence ?? 0) >= 70;
}

/**
 * Вынести стоп за следующую опору.
 * @param {object} plan — план (entry, stop, t1, t2, size…)
 * @param {{ atr: number, stopMult?: number, supports?: object[], resistances?: object[], h1?: object[], minRR?: number,
 *   risk?: object, maxAtr?: number, lookback?: number, price?: number }} o
 * @returns {{ plan: object, moved: boolean, kind?: 'support'|'swing', why?: string }}
 */
export function widenStop(plan, { atr, stopMult = 1, supports = [], resistances = [], h1 = null, minRR = 1.5, risk = {}, maxAtr = 4, lookback = 24, price = plan.entry }) {
  if (!plan || !(atr > 0)) return { plan, moved: false };
  const buy = plan.dir === 'BUY', s = buy ? 1 : -1, feePct = (risk.feePct ?? 0.2) / 100;
  const entry = plan.entry, fee = entry * feePct;
  const beyond = (x) => (x - plan.stop) * s < -1e-12; // дальше нынешнего стопа (ниже для покупки)
  const cands = [];
  // следующие опоры за уровнем входа (поддержки для покупки, сопротивления для продажи)
  for (const z of buy ? supports : resistances) {
    if (!z || !((z.strength ?? 0) >= 0.8)) continue;
    const st = buy ? z.low - 0.25 * atr * stopMult : z.high + 0.25 * atr * stopMult;
    if (beyond(st) && (buy ? z.high < plan.stop + 0.5 * atr : z.low > plan.stop - 0.5 * atr)) {
      cands.push({ stop: st, kind: 'support', why: `за ${buy ? 'поддержкой' : 'сопротивлением'} ${fmt(z.low)}–${fmt(z.high)}` });
    }
  }
  // значимый экстремум последних суток (там уже сняли стопы — второй раз туда реже возвращаются)
  if (h1?.length) {
    const last = h1.slice(-lookback);
    const ext = buy ? Math.min(...last.map((c) => c.low)) : Math.max(...last.map((c) => c.high));
    const st = buy ? ext - 0.2 * atr * stopMult : ext + 0.2 * atr * stopMult;
    if (Number.isFinite(ext) && beyond(st)) cands.push({ stop: st, kind: 'swing', why: `за ${buy ? 'минимумом' : 'максимумом'} суток ${fmt(ext)}` });
  }
  const rrTo = (t, st) => ((t - entry) * s - fee) / ((entry - st) * s + fee);
  const ok = cands.filter((c) => (entry - c.stop) * s <= maxAtr * atr * stopMult && rrTo(plan.t1, c.stop) >= 1 && rrTo(plan.t2, c.stop) >= minRR);
  if (!ok.length) return { plan, moved: false };
  // самый дальний подходящий
  const pick = ok.sort((a, b) => (a.stop - b.stop) * s)[0];
  const stop = pick.stop, feeNow = price * feePct;
  let size = plan.size;
  if (size && risk.deposit > 0 && risk.riskPct > 0) {
    const riskUsd = (risk.deposit * risk.riskPct) / 100, qty = riskUsd / ((entry - stop) * s + fee);
    size = { riskUsd, qty, notional: qty * entry, leverage: (qty * entry) / risk.deposit };
  }
  return {
    moved: true, kind: pick.kind, why: pick.why,
    plan: {
      ...plan, stop, size, stopTight: plan.stop, stopKind: pick.kind,
      rr: rrTo(plan.t1, stop),
      rrNow: (price - stop) * s > 0 ? ((plan.t1 - price) * s - feeNow) / ((price - stop) * s + feeNow) : 0,
      notes: [...(plan.notes ?? []), `сильный сигнал — стоп вынесен ${pick.why} (был ${fmt(plan.stop)}); позиция меньше, риск в $ тот же`],
      invalidation: `закрытие часовой свечи ${buy ? 'ниже' : 'выше'} ${fmt(stop)}`,
      stopPct: stop / entry - 1,
    },
  };
}
