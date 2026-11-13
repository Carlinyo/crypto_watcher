// 📣 Посты для Telegram-каналов: платного (все сигналы с полным разбором, сопровождение, киты, резкие движения,
// обзор рынка) и бесплатного (часть сигналов кратко, их итоги и честная статистика за неделю).
//
// В посты НЕ попадает ничего о вашем счёте: ни баланс, ни размер позиции, ни сделки на Bybit, ни самопроверка.
// Разметка — HTML Telegram (b, i, a, code, blockquote); всё, что пришло извне (названия, новости), экранируется.
import { fmt, fmtUsd, pct, sgn, plural, fmtDate, fmtDuration, coinOf, escapeHtml as e } from './format.js';
import { ACTION, entryLine, deepLines } from './report.js';
import { levelStr } from './entry.js';

const DISCLAIMER = 'Не является инвестиционной рекомендацией. Торговля с плечом может привести к потере всех вложенных средств.';
const tagOf = (symbol) => `#${coinOf(symbol).replace(/[^\p{L}\p{N}_]/gu, '')}`;
const nameOf = (r) => (r.kind === 'stock' ? `акция ${e(coinOf(r.symbol))}${r.name ? ` (${e(r.name)})` : ''}` : e(coinOf(r.symbol)));
const zoneTxt = (z) => `${fmt(z.low)}${z.high - z.low > Math.abs(z.high) * 1e-4 ? `–${fmt(z.high)}` : ''}`;
const pctTo = (x, price) => pct(x / price - 1, 1);
const rate = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

/** Статистика сигналов одной строкой: «за 30 дней: 24 закрытых, успешных 58%, в среднем +0.41R, итого +9.8R» */
export function statsLine(st, label = 'за 30 дней') {
  if (!st?.closed) return null;
  return `${label}: ${plural(st.closed, ['закрытый сигнал', 'закрытых сигнала', 'закрытых сигналов'])}, успешных ${rate(st.winRate)}, в среднем ${sgn(st.avgR ?? 0, 2)}R, итого ${sgn(st.sumR ?? 0, 1)}R`;
}

/** Строки плана сделки без размера позиции (он — только для владельца) */
function planRows(r) {
  const p = r.plan, buy = p.dir === 'BUY';
  const rows = [
    [`${buy ? '🟢 Вход' : '🔴 Вход'}`, `${fmt(r.price)}${p.zone ? ` (зона ${fmt(p.zone[0])}–${fmt(p.zone[1])})` : ''}`],
    ['🛑 Стоп', `${fmt(p.stop)} (${pct(p.stopPct, 1)})`],
    ['🎯 Цель 1', `${fmt(p.t1)} (${pct(p.t1Pct, 1)})`],
    ['🎯 Цель 2', `${fmt(p.t2)} (${pct(p.t2Pct, 1)})`],
  ];
  if (p.t3) rows.push(['🎯 Цель 3', `${fmt(p.t3)} (${pctTo(p.t3, p.entry ?? r.price)})`]);
  rows.push(['⚖️ Прибыль/риск', `${p.rrNow.toFixed(2)}`]);
  return rows;
}
const rowsText = (rows) => rows.map(([k, v]) => `${k}: <b>${e(v)}</b>`).join('\n');

/**
 * Сигнал на вход.
 * @param {'paid'|'free'} tier
 * @param {{ zone?: boolean, stats?: object, paidLink?: string }} ctx
 */
export function signalPost(r, tier, { zone = false, stats = null, paidLink = '' } = {}) {
  const a = ACTION[r.action], p = r.plan, buy = p.dir === 'BUY';
  const head = `${a.emoji} <b>${a.text}</b> ${nameOf(r)} ${tagOf(r.symbol)}`;
  const why = r.retest
    ? `🎯 Ретест уровня ${e(levelStr(r.retest.level))} подтверждён — уровень удержался`
    : zone ? `🎯 Цена в зоне ${buy ? 'покупки' : 'продажи'}` : null;
  if (tier === 'free') {
    const L = [head, ...(why ? [why] : []), '', rowsText(planRows(r)), '', 'Сопровождение: на цели 1 — зафиксировать половину и перенести стоп в безубыток.'];
    const sl = statsLine(stats);
    if (sl) L.push('', `📊 Все сигналы ${e(sl)}`);
    L.push('', paidLink ? `🔒 Полный разбор, уровни, сопровождение и все сигналы — <a href="${e(paidLink)}">в платном канале</a>` : '🔒 Полный разбор и все сигналы — в платном канале');
    L.push(`<i>${DISCLAIMER}</i>`);
    return L.join('\n');
  }
  const L = [head, ...(why ? [why] : [])];
  L.push(`Оценка ${sgn(r.score)} (порог ±${r.threshold.toFixed(2)}), уверенность ${r.confidence}% (${e(r.confidenceLabel ?? '')}), режим: ${e(r.regime?.label ?? '—')}`);
  L.push(`24 ч ${pct(r.stats?.change24h, 1)} · 7 дн ${pct(r.stats?.change7d, 1)}`);
  L.push('', rowsText(planRows(r)));
  const ent = entryLine(r);
  if (ent) L.push('', `<b>Точка входа:</b> ${e(ent[1])}`);
  if (p.t1Why?.length) L.push(`<b>Цель 1:</b> ${e(p.t1Why.slice(0, 3).join(', '))}`);
  if (p.t2Why?.length) L.push(`<b>Цель 2:</b> ${e(p.t2Why.slice(0, 3).join(', '))}`);
  L.push(`<b>Отмена сценария:</b> ${e(p.invalidation ?? '—')} или через 24 ч`);
  L.push('<b>Сопровождение:</b> на цели 1 фиксируем половину, стоп — в безубыток; на полпути к цели 2 стоп подтягиваем к цели 1. Итоги — в этом канале.');
  const pro = (r.reasons?.pro ?? []).slice(0, 5), con = (r.reasons?.contra ?? []).slice(0, 4);
  if (pro.length) L.push('', '<b>За:</b>', ...pro.map((x) => `➕ ${e(x.text)}`));
  if (con.length) L.push('', '<b>Против:</b>', ...con.map((x) => `➖ ${e(x.text)}`));
  const warn = [r.reason, ...(r.warnings ?? [])].filter(Boolean).slice(0, 3);
  if (warn.length) L.push('', ...warn.map((w) => `⚠️ ${e(w)}`));
  const deep = deepLines(r);
  if (deep.length) L.push('', '<b>Подробнее:</b>', ...deep.map(([k, v]) => `• ${e(k)}: ${e(v)}`));
  const sup = (r.levels?.supports ?? []).slice(0, 3), res = (r.levels?.resistances ?? []).slice(0, 3);
  if (sup.length || res.length) {
    L.push('', '<b>Уровни:</b>');
    for (const z of [...res].reverse()) L.push(`▲ ${zoneTxt(z)} (${pctTo(z.low, r.price)}), сила ${z.strength.toFixed(1)}`);
    L.push(`● цена ${fmt(r.price)}`);
    for (const z of sup) L.push(`▼ ${zoneTxt(z)} (${pctTo(z.high, r.price)}), сила ${z.strength.toFixed(1)}`);
  }
  const news = (r.news?.top ?? []).slice(0, 3);
  if (news.length) L.push('', '<b>Новости:</b>', ...news.map((n) => `${n.s > 0 ? '▲' : n.s < 0 ? '▼' : '•'} ${e(n.title)}`));
  const sl = statsLine(stats);
  if (sl) L.push('', `📊 Сигналы ${e(sl)}`);
  L.push('', `<i>${DISCLAIMER}</i>`);
  return L.join('\n');
}

/** Сильный сигнал есть, но вход только на ретесте уровня — подписчики платного канала готовятся заранее */
export function setupPost(r) {
  const p = r.plan, base = p.dir;
  const a = ACTION[base];
  const L = [`🟡 <b>Готовимся: ${a.text.toLowerCase()}</b> ${nameOf(r)} ${tagOf(r.symbol)}`];
  L.push(`Сигнал подтверждён (оценка ${sgn(r.score)}), но от текущей цены ${fmt(r.price)} вход невыгоден — вдогонку не входим.`);
  const ent = entryLine(r);
  if (ent) L.push(`<b>Ждём:</b> ${e(ent[1])}`);
  else L.push(`<b>Ждём:</b> цену в зоне ${fmt(p.zone[0])}–${fmt(p.zone[1])}`);
  L.push(`Ориентиры: стоп ${fmt(p.stop)}, цели ${fmt(p.t1)} / ${fmt(p.t2)}. Когда вход подтвердится — придёт отдельный сигнал.`);
  return L.join('\n');
}

// итоги сигналов (из журнала): что делать подписчику
const RESULT = {
  tp1: (c, r) => [`🎯 ${c}: цель 1 достигнута (+${Math.abs(r).toFixed(2)}R)`, 'Фиксируем половину позиции, стоп переносим в безубыток (на цену входа).'],
  tp2: (c, r) => [`✅ ${c}: цель 2 достигнута — итог ${sgn(r, 2)}R`, 'Сигнал завершён с прибылью.'],
  stop: (c, r) => [`🛑 ${c}: стоп — итог ${sgn(r, 2)}R`, 'Цена ушла против сигнала, сделка закрыта по стопу.'],
  breakeven: (c, r) => [`⚪ ${c}: остаток закрыт в безубыток — итог ${sgn(r, 2)}R`, 'После цели 1 цена вернулась к цене входа.'],
  expired: (c, r) => [`⌛ ${c}: сигнал закрыт по времени — итог ${sgn(r, 2)}R`, 'За отведённое время цена не дошла ни до цели 2, ни до стопа — закрываем по текущей цене.'],
  reversed: (c, r) => [`🔁 ${c}: сигнал в обратную сторону — итог ${sgn(r, 2)}R`, 'Анализ развернулся — закрываем сделку по текущей цене.'],
  trail: (c, r, en) => (en.status === 'closed'
    ? [`✅ ${c}: остаток закрыт по подтянутому стопу — итог ${sgn(r, 2)}R`, 'Прибыль зафиксирована.']
    : [`🔒 ${c}: стоп подтягиваем к цели 1 (${fmt(en.stop)})`, `Цена прошла полпути ко второй цели — зафиксировано ${sgn(r, 2)}R.`]),
};

/** Итог сигнала (цель, стоп, безубыток…) — в тот канал, где был сам сигнал */
export function resultPost(ev, { stats = null } = {}) {
  const en = ev.entry;
  const f = RESULT[ev.type];
  if (!f) return null;
  const [title, what] = f(e(coinOf(en.symbol)), ev.r ?? 0, en);
  const L = [`<b>${title}</b> ${tagOf(en.symbol)}`, what, '',
    `Сигнал: ${en.side === 'BUY' ? 'покупка' : 'продажа'} от ${fmtDate(en.opened)} по ${fmt(en.entry)}; стоп ${fmt(en.initialStop)}, цели ${fmt(en.t1)} / ${fmt(en.t2)}`,
    `Прошло: ${fmtDuration(Date.now() - en.opened)}`];
  const sl = statsLine(stats);
  if (sl && en.status === 'closed') L.push(`📊 Сигналы ${e(sl)}`);
  return L.join('\n');
}

/** Анализ развернулся против открытого сигнала — предупреждение подписчикам */
export function reversalPost(en, r) {
  const coin = e(coinOf(en.symbol));
  return [`⚠️ <b>${coin}: анализ развернулся против сигнала</b> ${tagOf(en.symbol)}`,
    `Сигнал ${en.side === 'BUY' ? 'покупки' : 'продажи'} от ${fmtDate(en.opened)} по ${fmt(en.entry)}, сейчас цена ${fmt(r.price)}, оценка ${sgn(r.score)}.`,
    'Будьте осторожны: проверьте стоп, при прибыли можно зафиксировать часть. Если обратный сигнал подтвердится — сигнал будет закрыт.'].join('\n');
}

/** Крупный кит (те же правила, что и для письма: по умолчанию от $30 млн) */
export function whalePost(ev) {
  const coin = e(coinOf(ev.symbol)), buy = ev.side === 'buy';
  const mk = ev.market === 'spot' ? 'спот' : 'фьючерсы';
  const head = ev.type === 'series'
    ? `🐋 <b>Кит ${buy ? 'скупает' : 'продаёт'} ${coin}: ${fmtUsd(ev.usd)} за ${ev.minutes} мин</b> (${mk})`
    : `🐋 <b>Кит ${buy ? 'купил' : 'продал'} ${coin} на ${fmtUsd(ev.usd)}</b> (${mk})`;
  const L = [`${head} ${tagOf(ev.symbol)}`];
  if (ev.type === 'series') L.push(`${plural(ev.count, ['крупный ордер', 'крупных ордера', 'крупных ордеров'])} в одну сторону — похоже на набор позиции частями.`);
  else if (ev.price) L.push(`Средняя цена ${fmt(ev.price)}.`);
  L.push('Один кит — не сигнал сам по себе; сильнее, когда совпадает с анализом.');
  return L.join('\n');
}

/** Резкое движение с анализом сразу после него */
export function movePost(mv, r) {
  const coin = e(coinOf(mv.symbol)), up = mv.change > 0;
  const volX = mv.enough && mv.volX ? mv.volX : null;
  const L = [`⚡ <b>${coin} ${pct(mv.change, 1)} за ${mv.win} мин</b> ${tagOf(mv.symbol)}`, `${fmt(mv.from)} → ${fmt(mv.to)}${volX ? `, объём ×${volX.toFixed(1)} к обычному` : ''}`];
  if (r) {
    const sup = r.levels?.supports?.[0], res = r.levels?.resistances?.[0];
    L.push(`Анализ: ${ACTION[r.action].emoji} ${ACTION[r.action].text.toLowerCase()}, оценка ${sgn(r.score)}`);
    if (sup) L.push(`Ближайшая поддержка ${zoneTxt(sup)} (${pctTo(sup.high, r.price)})`);
    if (res) L.push(`Ближайшее сопротивление ${zoneTxt(res)} (${pctTo(res.low, r.price)})`);
  }
  L.push(up ? 'После резкого роста часто бывает откат — не догоняйте цену.' : 'На резких падениях не ловим нож — ждём остановки и сигнала.');
  return L.join('\n');
}

/** Утренний обзор рынка для платного канала */
export function dailyPost({ results, market, stats, openSignals = [], date = new Date() }) {
  const day = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const L = [`📊 <b>Обзор рынка ${day}</b>`];
  const f = market?.fng, g = market?.global;
  if (g?.totalMcap) L.push(`Капитализация ${fmtUsd(g.totalMcap)} (${pct((g.mcapChange24h ?? 0) / 100, 1)} за 24 ч), доминация BTC ${g.btcDom?.toFixed(1)}%`);
  if (f) L.push(`Страх и жадность: ${f.value} (${e(f.label)})`);
  const list = [...results].filter((r) => r.kind !== 'stock').sort((a, b) => b.score - a.score);
  if (list.length) {
    L.push('', '<b>Монеты</b> (цена · 24 ч · оценка):');
    for (const r of list) L.push(`${ACTION[r.action].emoji} ${e(coinOf(r.symbol))} ${fmt(r.price)} · ${pct(r.stats?.change24h, 1)} · ${sgn(r.score)}`);
  }
  const stocks = [...results].filter((r) => r.kind === 'stock').sort((a, b) => b.score - a.score);
  if (stocks.length) {
    L.push('', '<b>Акции</b> (цена · 24 ч · оценка):');
    for (const r of stocks) L.push(`${ACTION[r.action].emoji} ${e(coinOf(r.symbol))} ${fmt(r.price)} · ${pct(r.stats?.change24h, 1)} · ${sgn(r.score)}`);
  }
  const best = list.slice(0, 3).filter((r) => r.score > 0.15), worst = list.slice(-3).reverse().filter((r) => r.score < -0.15);
  if (best.length || worst.length) L.push('');
  if (best.length) L.push(`Сильнее всего: ${best.map((r) => e(coinOf(r.symbol))).join(', ')}`);
  if (worst.length) L.push(`Слабее всего: ${worst.map((r) => e(coinOf(r.symbol))).join(', ')}`);
  if (openSignals.length) {
    L.push('', '<b>Открытые сигналы:</b>');
    for (const x of openSignals) L.push(`${x.side === 'BUY' ? '🟢' : '🔴'} ${e(coinOf(x.symbol))} от ${fmt(x.entry)}${x.tp1 ? ' · цель 1 взята, стоп в безубытке' : ''}`);
  }
  const sl = statsLine(stats);
  if (sl) L.push('', `📊 Сигналы ${e(sl)}`);
  return L.join('\n');
}

/**
 * Итоги недели — в оба канала: все закрытые за неделю сигналы, включая убыточные.
 * entries — записи журнала, закрытые за неделю.
 */
export function weeklyPost(entries, { stats30 = null, tier = 'paid', paidLink = '' } = {}) {
  const closed = entries.filter((x) => x.status === 'closed' && x.result != null);
  const L = ['🗓 <b>Итоги недели по сигналам</b>'];
  if (!closed.length) L.push('За неделю закрытых сигналов не было.');
  else {
    const wins = closed.filter((x) => x.result > 0.05).length, losses = closed.filter((x) => x.result < -0.05).length;
    const sum = closed.reduce((s, x) => s + x.result, 0);
    L.push(`${plural(closed.length, ['сигнал закрыт', 'сигнала закрыто', 'сигналов закрыто'])}: в плюс ${wins}, в минус ${losses}, в ноль ${closed.length - wins - losses}; итого <b>${sgn(sum, 1)}R</b>`);
    L.push('');
    for (const x of [...closed].sort((a, b) => a.closed - b.closed)) L.push(`${x.result > 0.05 ? '✅' : x.result < -0.05 ? '🛑' : '⚪'} ${e(coinOf(x.symbol))} ${x.side === 'BUY' ? 'покупка' : 'продажа'}: ${sgn(x.result, 2)}R`);
  }
  const sl = statsLine(stats30);
  if (sl) L.push('', `📊 ${e(sl)}`);
  L.push('', '<i>R — результат в рисках: +2R — прибыль вдвое больше риска до стопа, −1R — потеря риска. Учитываются все сигналы, включая убыточные.</i>');
  if (tier === 'free') L.push('', paidLink ? `🔒 Все сигналы с разбором — <a href="${e(paidLink)}">в платном канале</a>` : '🔒 Все сигналы с разбором — в платном канале');
  return L.join('\n');
}
