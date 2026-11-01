// Тексты и HTML-письма: сигналы, киты, новости, события журнала, запуск, ежедневный обзор.
// HTML — только встроенные стили и таблицы, чтобы письма одинаково выглядели в Gmail и на телефоне
// (и размер меньше 100 КБ — иначе Gmail обрезает письмо).
import { fmt, fmtUsd, fmtMoney, fmtAmount, trades as nTrades, plural, pct, sgn, fmtDate, fmtDuration, coinOf, safeHref, escapeHtml as e } from './format.js';
import { BLOCK_NAMES } from './analyzer.js';

export const ACTION = {
  BUY: { emoji: '🟢', text: 'ПОКУПКА', color: '#1a7f37' },
  SELL: { emoji: '🔴', text: 'ПРОДАЖА', color: '#cf222e' },
  WATCH_BUY: { emoji: '🟡', text: 'ГОТОВИТЬСЯ К ПОКУПКЕ', color: '#9a6700' },
  WATCH_SELL: { emoji: '🟡', text: 'ГОТОВИТЬСЯ К ПРОДАЖЕ', color: '#9a6700' },
  NEUTRAL: { emoji: '⚪', text: 'НЕЙТРАЛЬНО', color: '#57606a' },
};
const SMS_ACTION = { BUY: 'BUY', SELL: 'SELL', WATCH_BUY: 'WATCH BUY', WATCH_SELL: 'WATCH SELL', NEUTRAL: '-' };
const MARKET_RU = { spot: 'спот', futures: 'фьючерсы' };
const SESSION_HOURS = { regular: 'в основную сессию США, 9:30–16:00 по Нью-Йорку', extended: 'с 4:00 до 20:00 по Нью-Йорку', any: 'всё время, пока идут торги' };
// 📈 акции помечаются в письмах, чтобы их не путать с монетами
const nameOf = (r) => (r?.kind === 'stock' ? `${coinOf(r.symbol)} (акция)` : coinOf(r.symbol));

const C = { green: '#1a7f37', red: '#cf222e', amber: '#9a6700', gray: '#57606a', light: '#f6f8fa', border: '#d0d7de', text: '#1f2328' };
const FONT = 'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif';

// ── HTML-кирпичики ──────────────────────────────────────────────────────────
const wrap = (inner) => `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">
<div style="${FONT};color:${C.text};font-size:14px;line-height:1.45;max-width:680px;margin:0 auto;padding:12px">${inner}
<p data-cw-footer style="color:${C.gray};font-size:11px;margin-top:18px">Crypto Watcher — автоматический анализ, не финансовая рекомендация. Решение о сделке принимаете вы.</p></div></body></html>`;
const h2 = (t, color = C.text) => `<h2 style="margin:6px 0 4px;font-size:19px;color:${color}">${t}</h2>`;
const h3 = (t) => `<h3 style="margin:16px 0 6px;font-size:15px;border-bottom:1px solid ${C.border};padding-bottom:3px">${t}</h3>`;
const muted = (t) => `<span style="color:${C.gray}">${t}</span>`;
const colorOf = (s) => (s > 0.1 ? C.green : s < -0.1 ? C.red : C.gray);

function bar(s, width = 110) {
  const half = width / 2, w = Math.round(Math.min(1, Math.abs(s)) * half);
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:${width}px;display:inline-table;vertical-align:middle"><tr>
<td style="width:${half}px;background:#eaeef2;text-align:right;padding:0">${s < 0 ? `<div style="display:inline-block;height:9px;width:${w}px;background:${C.red}"></div>` : ''}</td>
<td style="width:1px;background:#8c959f;padding:0"></td>
<td style="width:${half}px;background:#eaeef2;padding:0">${s > 0 ? `<div style="height:9px;width:${w}px;background:${C.green}"></div>` : ''}</td></tr></table>`;
}

const table = (rows, { head = null, widths = [] } = {}) => `<table cellpadding="5" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">
${head ? `<tr>${head.map((x, i) => `<th style="text-align:left;background:${C.light};border-bottom:1px solid ${C.border};${widths[i] ? `width:${widths[i]};` : ''}">${x}</th>`).join('')}</tr>` : ''}
${rows.map((r) => `<tr>${r.map((x) => `<td style="border-bottom:1px solid #eaeef2;vertical-align:top">${x}</td>`).join('')}</tr>`).join('\n')}</table>`;

export const fmtQty = (q) => (q >= 1000 ? Math.round(q).toLocaleString('ru-RU') : q >= 1 ? q.toFixed(q >= 100 ? 1 : 3) : q.toPrecision(3));
const chartBlock = ({ chartCid, chartSvg } = {}) => (chartSvg ? `<div style="margin:8px 0">${chartSvg}</div>`
  : chartCid ? `<img src="cid:${chartCid}" alt="график" width="720" style="width:100%;max-width:720px;height:auto;border:1px solid ${C.border};margin:8px 0">` : '');
const zoneStr = (z) => `${fmt(z.low)}${z.high - z.low > z.price * 1e-4 ? ` – ${fmt(z.high)}` : ''}`;
const dist = (z, price) => {
  const d = (z.side === 'support' ? z.high : z.side === 'resistance' ? z.low : z.price) / price - 1;
  return Math.abs(d) < 0.0005 ? 'у цены' : pct(d, 1);
};

// ── сигнал ──────────────────────────────────────────────────────────────────
export function signalSubject(r, { zone = false } = {}) {
  const a = ACTION[r.action], coin = nameOf(r);
  if (zone) return `🎯 ${coin}: цена в зоне ${r.plan.dir === 'BUY' ? 'покупки' : 'продажи'} ${fmt(r.plan.zone[0])}–${fmt(r.plan.zone[1])} — ${a.text}${r.exec?.status === 'opened' ? ' · 🤖 сделка открыта' : ''}`;
  if (r.action.startsWith('WATCH')) return `${a.emoji} ${coin}: ${r.plan.dir === 'BUY' ? 'готовиться к покупке' : 'готовиться к продаже'}, ждать ${fmt(r.plan.zone[0])}–${fmt(r.plan.zone[1])}`;
  return `${a.emoji} ${a.text} ${coin} по ${fmt(r.price)} · уверенность ${r.confidence}%${r.exec?.status === 'opened' ? ' · 🤖 сделка открыта' : ''}`;
}

export function smsText(r, { zone = false } = {}) {
  const p = r.plan;
  const who = `${coinOf(r.symbol)}${r.kind === 'stock' ? ' stock' : ''}`;
  if (r.exec?.sms) return `${zone ? 'ZONE ' : ''}${SMS_ACTION[r.action]} ${who} ${fmt(r.price)} | ${r.exec.sms} | SL ${fmt(p.stop)} TP ${fmt(p.t1)}/${fmt(p.t2)} conf ${r.confidence}%`.slice(0, 160);
  return `${zone ? 'ZONE ' : ''}${SMS_ACTION[r.action]} ${who} ${fmt(r.price)} | zone ${fmt(p.zone[0])}-${fmt(p.zone[1])} SL ${fmt(p.stop)} TP ${fmt(p.t1)}/${fmt(p.t2)} RR ${p.rrNow.toFixed(1)} conf ${r.confidence}%`.slice(0, 160);
}

// ── автоторговля: блок в письме о сигнале ───────────────────────────────────
const MODE_RU = { demo: 'демо-счёт', live: 'реальный счёт', testnet: 'тестовая сеть' };
const SIDE_RU = { Buy: 'ЛОНГ', Sell: 'ШОРТ' };
export const TRADE_WHY = {
  tp1: 'цель 1 (вся позиция)', tp2: 'цель 2', trail: 'подтянутый стоп на цели 1', breakeven: 'безубыток после цели 1', stop: 'стоп',
  expired: 'истёк срок', reversed: 'обратный сигнал', 'manual-all': 'команда «закрыть всё»', manual: 'вручную или биржей', 'no-stop': 'не удалось поставить стоп', closed: 'позиция закрыта',
};
const contracts = (t) => `${fmtAmount(t.qty)} ${t.mult > 1 ? `контр. ${t.bySymbol} (${fmtAmount(t.qty * t.mult)} ${coinOf(t.symbol)})` : coinOf(t.symbol)}`;

export function tradeTitle(x) { return `🤖 Bybit (${MODE_RU[x.mode] ?? x.mode}${x.mode === 'live' ? ', настоящие деньги' : ''})`; }

export function tradeLines(x) {
  if (!x) return [];
  if (x.status === 'skipped') return [['Сделка не открыта', x.reason]];
  if (x.status === 'error') return [['⚠️ Ошибка', x.reason]];
  const t = x.trade;
  const L = [
    ['Открыто', `${SIDE_RU[t.side]} ${contracts(t)} по ${fmt(t.entry)}, сумма ${fmtMoney(t.notional)}, плечо ×${t.leverage}`],
    ['Риск', `${fmtMoney(t.riskUsd)} (${t.riskPct.toFixed(1)}% баланса, с комиссиями)${t.limitedBy ? ` — позиция уменьшена: ${t.limitedBy}` : ''}`],
    ['Стоп на бирже', fmt(t.stop)],
    ['Цели', t.single ? `${fmt(t.t1)} — вся позиция` : `50% по ${fmt(t.t1)}, 50% по ${fmt(t.t2)} (лимитные ордера «только закрытие»)`],
    ['Дальше', t.single ? 'программа следит за позицией; через 72 ч без результата закроет её' : 'после цели 1 стоп — в безубыток, на полпути к цели 2 — на цель 1; через 72 ч без результата позиция закрывается'],
  ];
  if (x.reversed) L.unshift(['Разворот', `прошлая сделка (${SIDE_RU[x.reversed.side]}) закрыта${x.reversed.pnl != null ? `: ${fmtMoney(x.reversed.pnl, { sign: true })}` : ''}`]);
  for (const w of t.warnings ?? []) L.push(['⚠️', w]);
  return L;
}

function planLines(r) {
  const p = r.plan, buy = p.dir === 'BUY';
  const L = [
    [buy ? 'Зона покупки' : 'Зона продажи', `${fmt(p.zone[0])} – ${fmt(p.zone[1])}${p.anchor ? ` (${p.anchor.sources.slice(0, 3).join(', ')})` : ''}`],
    ['Стоп', `${fmt(p.stop)} (${pct(p.stopPct, 1)})`],
    ['Цель 1', `${fmt(p.t1)} (${pct(p.t1Pct, 1)}) — ${p.t1Why.slice(0, 3).join(', ')}`],
    ['Цель 2', `${fmt(p.t2)} (${pct(p.t2Pct, 1)}) — ${p.t2Why.slice(0, 3).join(', ')}`],
  ];
  if (p.t3) L.push(['Цель 3', `${fmt(p.t3)} (${pct(p.t3 / p.entry - 1, 1)}) — ${(p.t3Why ?? []).join(', ')}`]);
  L.push(['Прибыль/риск', `${p.rrNow.toFixed(2)} от текущей цены, ${p.rr.toFixed(2)} от середины зоны (с комиссией)`]);
  if (p.size) L.push(['Размер позиции', `${fmtQty(p.size.qty)} ${coinOf(r.symbol)} ≈ ${fmtUsd(p.size.notional)} при риске ${fmtUsd(p.size.riskUsd)}${p.size.leverage > 1 ? ` (нужно плечо ×${p.size.leverage.toFixed(1)})` : ''}`]);
  L.push(['Отмена', `${p.invalidation} или через 24 ч`]);
  for (const n of p.notes) L.push(['Примечание', n]);
  return L;
}

/** Опционы одной строкой: путы/коллы, риск-реверсал, IV против фактической, ближайшая крупная экспирация */
export function optionsText(o, rv30 = null) {
  if (!o) return null;
  const t = [];
  if (o.pcr != null) t.push(`путы/коллы ${o.pcr.toFixed(2)}`);
  if (o.rr25 != null) t.push(`риск-реверсал ${sgn(o.rr25, 1)} (${o.rr25 > 1 ? 'коллы дороже — ждут роста' : o.rr25 < -1 ? 'путы дороже — страхуются от падения' : 'без перекоса'})`);
  if (o.atmIv != null) t.push(`IV ${Math.round(o.atmIv * 100)}%${rv30 != null ? ` при фактической ${Math.round(rv30 * 100)}%` : ''}`);
  if (o.nextBig) t.push(`экспирация ${fmtDate(o.nextBig.ts)} на ${fmtUsd(o.nextBig.oiUsd)}, «максимальная боль» ${fmt(o.nextBig.maxPain)}`);
  return t.length ? t.join('; ') : null;
}
const breadthText = (b) => (b?.n ? `растут ${b.up} из ${b.n} ${b.kind === 'stock' ? 'акций' : 'монет'}, падают ${b.down}` : null);

// 🔎 подробности: недельный тренд, обычный ход за сутки, отмена сценария, ликвидации, опционы, рынок, похожие сигналы
export function deepLines(r) {
  const L = [];
  const p = r.plan, buy = p?.dir === 'BUY';
  const w1 = r.tfs?.w1, d1 = r.tfs?.d1;
  if (w1) L.push(['Недельный тренд', `${w1.trend}${w1.rsi != null ? `, RSI недели ${w1.rsi.toFixed(0)}` : ''}`]);
  if (d1?.atr > 0) L.push(['Обычный ход за сутки', `±${((d1.atr / r.price) * 100).toFixed(1)}% — примерно от ${fmt(r.price - d1.atr)} до ${fmt(r.price + d1.atr)}`]);
  if (p && r.action !== 'NEUTRAL') {
    const next = buy ? r.levels?.supports?.find((z) => z.high < p.stop) : r.levels?.resistances?.find((z) => z.low > p.stop);
    L.push(['Если не сработает', next
      ? `за стопом ${fmt(p.stop)} цена может уйти к следующей ${buy ? 'поддержке' : 'зоне сопротивления'} ${zoneStr(next)} (${pct((buy ? next.high : next.low) / r.price - 1, 1)})`
      : `за стопом ${fmt(p.stop)} сильных уровней рядом нет — движение может продолжиться`]);
  }
  const lm = r.liqmap;
  if (lm && (lm.above.length || lm.below.length)) {
    const c = (x) => `${fmtUsd(x.usd)} у ${fmt(x.price)} (${pct(x.price / r.price - 1, 1)})`;
    L.push(['Ликвидации (оценка)', `выше — шорты: ${lm.above.slice(0, 2).map(c).join(', ') || '—'}; ниже — лонги: ${lm.below.slice(0, 2).map(c).join(', ') || '—'}`]);
  }
  const o = optionsText(r.options, r.rv30);
  if (o) L.push(['Опционы Deribit', o]);
  const b = breadthText(r.breadth);
  if (b) L.push(['Рынок в целом', b]);
  const h = r.history;
  if (h && r.action !== 'NEUTRAL') L.push(['Похожие сигналы', h.n >= 5 ? `${h.n} за полгода (${h.regime ? 'та же сторона и режим рынка' : 'та же сторона'}): успешных ${h.winRate != null ? Math.round(h.winRate * 100) : '—'}%, в среднем ${sgn(h.avgR, 2)}R` : `пока ${h.n ? `только ${h.n}` : 'не было'} — статистика накопится`]);
  return L;
}

export function signalText(r, { zone = false } = {}) {
  const a = ACTION[r.action];
  const out = [
    `${zone ? '🎯 ЦЕНА В ЗОНЕ. ' : ''}${a.emoji} ${a.text} ${r.kind === 'stock' ? `акция ${coinOf(r.symbol)}${r.name ? ` (${r.name})` : ''}` : r.symbol} @ ${fmt(r.price)}`,
    ...(r.kind === 'stock' ? ['Данные — бессрочный фьючерс на акцию на Binance: цена следует за акцией.'] : []),
    `Оценка ${sgn(r.score)} (порог ±${r.threshold.toFixed(2)}), уверенность ${r.confidence}% (${r.confidenceLabel}), согласие блоков ${(r.agreement * 100).toFixed(0)}%`,
    `Режим рынка: ${r.regime.label}. 24 ч: ${pct(r.stats.change24h, 1)}, 7 дн: ${pct(r.stats.change7d, 1)}`,
  ];
  if (r.action !== 'NEUTRAL') { out.push(''); for (const [k, v] of planLines(r)) out.push(`${k}: ${v}`); }
  if (r.exec) { out.push('', `${tradeTitle(r.exec)}:`); for (const [k, v] of tradeLines(r.exec)) out.push(`  ${k}: ${v}`); }
  const deep = deepLines(r);
  if (deep.length) { out.push('', 'ПОДРОБНЕЕ:'); for (const [k, v] of deep) out.push(`  ${k}: ${v}`); }
  if (r.reason) out.push(`⚠️ ${r.reason}`);
  for (const w of r.warnings) out.push(`⚠️ ${w}`);
  const ev = nextEventLine(r);
  if (ev) out.push(`📅 ${ev}`);
  if (r.exposure?.length) out.push(`⚠️ ${exposureLine(r)}`);
  if (r.reasons.pro.length) { out.push('', 'ЗА:'); for (const x of r.reasons.pro) out.push(`  + ${x.text}`); }
  if (r.reasons.contra.length) { out.push('', 'ПРОТИВ:'); for (const x of r.reasons.contra) out.push(`  − ${x.text}`); }
  out.push('');
  for (const [k, b] of Object.entries(r.blocks)) {
    out.push(`${BLOCK_NAMES[k]}: ${b.disabled ? 'нет данных' : sgn(b.score)}${r.weights[k] ? ` (вес ${(r.weights[k] * 100).toFixed(0)}%)` : ''}`);
    for (const n of b.notes ?? []) out.push(`   • ${n}`);
  }
  for (const z of r.levels.inside ?? []) out.push('', `Цена внутри зоны: ${zoneStr(z)}, сила ${z.strength.toFixed(1)}: ${z.sources.slice(0, 4).join(', ')}`);
  out.push('', 'Поддержки:');
  for (const z of r.levels.supports.slice(0, 4)) out.push(`   ${zoneStr(z)} (${dist(z, r.price)}), сила ${z.strength.toFixed(1)}: ${z.sources.slice(0, 4).join(', ')}`);
  out.push('Сопротивления:');
  for (const z of r.levels.resistances.slice(0, 4)) out.push(`   ${zoneStr(z)} (${dist(z, r.price)}), сила ${z.strength.toFixed(1)}: ${z.sources.slice(0, 4).join(', ')}`);
  if (r.news?.top?.length) { out.push('', 'Новости:'); for (const n of r.news.top.slice(0, 4)) out.push(`   ${n.s > 0 ? '▲' : n.s < 0 ? '▼' : '•'} ${n.title} (${n.source})`); }
  return out.join('\n');
}

export function signalHtml(r, { zone = false, chartCid = null, chartSvg = null } = {}) {
  const a = ACTION[r.action];
  const coin = coinOf(r.symbol);
  const parts = [];
  parts.push(`<div style="border-left:5px solid ${a.color};padding:4px 0 4px 10px;margin-bottom:8px">
${zone ? `<div style="font-weight:600;color:${a.color}">🎯 Цена вошла в зону ${r.plan.dir === 'BUY' ? 'покупки' : 'продажи'}</div>` : ''}
${h2(`${a.emoji} ${a.text} ${r.kind === 'stock' ? `акция ${e(coin)}` : e(coin)} — ${fmt(r.price)} $`, a.color)}
${r.kind === 'stock' ? `<div style="color:${C.gray};font-size:12px">${e(r.name ?? '')} · бессрочный фьючерс на акцию на Binance, цена следует за акцией</div>` : ''}
<div>${bar(r.score, 160)} &nbsp;<b>${sgn(r.score)}</b> ${muted(`(порог ±${r.threshold.toFixed(2)})`)} · уверенность <b>${r.confidence}%</b> (${r.confidenceLabel}) · согласие блоков ${(r.agreement * 100).toFixed(0)}%</div>
<div style="color:${C.gray};font-size:12px;margin-top:3px">${e(r.regime.label)} · 1 ч ${pct(r.stats.change1h, 1)} · 24 ч ${pct(r.stats.change24h, 1)} · 7 дн ${pct(r.stats.change7d, 1)} · объём 24 ч ${fmtUsd(r.stats.volume24h)} · ${fmtDate(r.time)}</div></div>`);
  parts.push(chartBlock({ chartCid, chartSvg }));

  if (r.exec) {
    const okTrade = r.exec.status === 'opened';
    parts.push(`<div style="border:1px solid ${okTrade ? C.green : C.border};background:${okTrade ? '#f0fff4' : C.light};padding:6px 10px;margin:8px 0"><b>${e(tradeTitle(r.exec))}</b>${table(tradeLines(r.exec).map(([k, v]) => [`<b>${e(k)}</b>`, e(v)]), { widths: ['130px'] })}</div>`);
  }
  if (r.action !== 'NEUTRAL') parts.push(h3('План') + table(planLines(r).map(([k, v]) => [`<b>${e(k)}</b>`, e(v)]), { widths: ['130px'] }));
  const deep = deepLines(r);
  if (deep.length) parts.push(h3('Подробнее') + table(deep.map(([k, v]) => [`<b>${e(k)}</b>`, e(v)]), { widths: ['130px'] }));
  const warn = [r.reason, ...r.warnings].filter(Boolean);
  if (warn.length) parts.push(`<div style="background:#fff8c5;border:1px solid #d4a72c;padding:6px 8px;margin-top:8px">${warn.map((w) => `⚠️ ${e(w)}`).join('<br>')}</div>`);
  const evl = nextEventLine(r);
  if (evl) parts.push(`<div style="margin-top:6px;color:${C.gray}">📅 ${e(evl)}</div>`);
  if (r.exposure?.length) parts.push(`<div style="margin-top:6px;color:${C.amber}">⚠️ ${e(exposureLine(r))}</div>`);

  if (r.reasons.pro.length || r.reasons.contra.length) {
    parts.push(h3('Главные причины'));
    parts.push(table([[
      r.reasons.pro.map((x) => `<div style="color:${C.green}">+ ${e(x.text)}</div>`).join('') || muted('—'),
      r.reasons.contra.map((x) => `<div style="color:${C.red}">− ${e(x.text)}</div>`).join('') || muted('—'),
    ]], { head: ['За', 'Против'], widths: ['50%', '50%'] }));
  }

  parts.push(h3('Все блоки анализа'));
  parts.push(table(Object.entries(r.blocks).map(([k, b]) => [
    `<b>${e(BLOCK_NAMES[k])}</b>${r.weights[k] ? `<br>${muted(`вес ${(r.weights[k] * 100).toFixed(0)}%`)}` : ''}`,
    b.disabled ? muted('нет данных') : `${bar(b.score)}<br><b style="color:${colorOf(b.score)}">${sgn(b.score)}</b>`,
    (b.notes ?? []).map((n) => `• ${e(n)}`).join('<br>') || muted('—'),
  ]), { head: ['Блок', 'Оценка', 'Детали'], widths: ['30%', '120px', ''] }));

  const zr = (z) => [`<b>${zoneStr(z)}</b>`, dist(z, r.price), z.strength.toFixed(1), e(z.sources.slice(0, 5).join(', '))];
  parts.push(h3('Уровни'));
  parts.push(table([
    ...r.levels.resistances.slice(0, 4).reverse().map((z) => [`<span style="color:${C.red}">▲</span>`, ...zr(z)]),
    ...(r.levels.inside ?? []).length
      ? r.levels.inside.map((z) => [`<b>●</b>`, `<b>${fmt(r.price)}</b> ${muted(`внутри ${zoneStr(z)}`)}`, 'цена', z.strength.toFixed(1), e(z.sources.slice(0, 5).join(', '))])
      : [[`<b>●</b>`, `<b>${fmt(r.price)}</b>`, 'цена', '', '']],
    ...r.levels.supports.slice(0, 4).map((z) => [`<span style="color:${C.green}">▼</span>`, ...zr(z)]),
  ], { head: ['', 'Зона', 'До цены', 'Сила', 'Почему здесь уровень'], widths: ['14px', '150px', '60px', '40px', ''] }));

  if (r.news?.top?.length) {
    parts.push(h3('Новости'));
    parts.push(r.news.top.slice(0, 5).map((n) => `<div style="margin:3px 0">${n.s > 0.05 ? `<span style="color:${C.green}">▲</span>` : n.s < -0.05 ? `<span style="color:${C.red}">▼</span>` : '•'} ${safeHref(n.link) ? `<a href="${e(safeHref(n.link))}" style="color:${C.text}">${e(n.title)}</a>` : e(n.title)} ${muted(`${e(n.sources?.slice(0, 2).join(', ') ?? n.source)} · ${fmtDate(n.time)}`)}</div>`).join(''));
  }
  return wrap(parts.join('\n'));
}

function exposureLine(r) {
  return `Уже открыты сигналы в ту же сторону: ${r.exposure.map((x) => coinOf(x.symbol)).join(', ')} — ${r.kind === 'stock' ? 'акции обычно движутся вместе с рынком' : 'крипта обычно движется вместе'}, поэтому общий риск выше. Подумайте об уменьшении размера позиции.`;
}

// ближайшее макрособытие в пределах двух суток
function nextEventLine(r) {
  const n = r.macro?.next;
  if (!n || n.t - (r.time ?? Date.now()) > 48 * 3600e3) return null;
  return `Ближайшее событие: ${n.name} — ${fmtDate(n.t)} (через ${fmtDuration(n.t - (r.time ?? Date.now()))})`;
}

// ── резкое движение ────────────────────────────────────────────────────────
export function moveMessage(mv, r, ctx = {}) {
  const coin = r?.kind === 'stock' ? `${coinOf(mv.symbol)} (акция)` : coinOf(mv.symbol);
  const up = mv.change > 0;
  // объём сравниваем с обычным, только когда накоплено хотя бы 30 мин потока сделок
  const volX = mv.enough && mv.volX ? mv.volX : null;
  const subject = `⚡ ${coin} ${pct(mv.change, 1)} за ${mv.win} мин: ${fmt(mv.from)} → ${fmt(mv.to)}${volX ? ` (объём ×${volX.toFixed(1)})` : ''}`;
  const L = [
    ['Движение', `${up ? 'рост' : 'падение'} ${pct(mv.change, 2)} за ${mv.win} мин (порог ${pct(mv.need * (up ? 1 : -1), 1)}); диапазон ${fmt(mv.lo)} – ${fmt(mv.hi)}`],
  ];
  if (volX) L.push(['Объём', volX >= 1.5 ? `в ${volX.toFixed(1)} раза выше обычного` : `обычный (×${volX.toFixed(1)}) — движение без всплеска объёма`]);
  const l = ctx.liq;
  if (l && l.long + l.short > 0) L.push(['Ликвидации за 15 мин', `лонги ${fmtUsd(l.long)}, шорты ${fmtUsd(l.short)}`]);
  const f = ctx.flow;
  if (f) {
    const large = f.spot.largeDelta + f.futures.largeDelta;
    L.push(['Крупные игроки за 15 мин', `${fmtUsd(large, { sign: true })}${f.whales.buy + f.whales.sell > 0 ? `; киты и крупные ордера: покупки ${fmtUsd(f.whales.buy)}, продажи ${fmtUsd(f.whales.sell)}` : ''}`]);
  }
  if (r) {
    L.push(['Анализ сразу после движения', `${ACTION[r.action].emoji} ${ACTION[r.action].text}, оценка ${sgn(r.score)}, уверенность ${r.confidence}%`]);
    const sup = r.levels.supports[0], res = r.levels.resistances[0];
    if (sup) L.push(['Ближайшая поддержка', `${zoneStr(sup)} (${dist(sup, r.price)}), сила ${sup.strength.toFixed(1)}: ${sup.sources.slice(0, 3).join(', ')}`]);
    if (res) L.push(['Ближайшее сопротивление', `${zoneStr(res)} (${dist(res, r.price)}), сила ${res.strength.toFixed(1)}`]);
    if (r.action !== 'NEUTRAL') L.push([r.plan.dir === 'BUY' ? 'Зона покупки' : 'Зона продажи', `${fmt(r.plan.zone[0])} – ${fmt(r.plan.zone[1])}, стоп ${fmt(r.plan.stop)}, цель ${fmt(r.plan.t1)}`]);
  }
  const hint = up
    ? 'После резкого роста часто бывает откат — не догоняйте цену; выгоднее ждать возврата к поддержке.'
    : 'Резкие падения на ликвидациях часто дают хорошую цену у сильных поддержек — но дождитесь остановки падения (сигнала программы).';
  const text = [subject, '', ...L.map(([k, v]) => `${k}: ${v}`), '', hint].join('\n');
  const html = wrap(`${h2(e(subject), up ? C.green : C.red)}${table(L.map(([k, v]) => [`<b>${e(k)}</b>`, e(v)]), { widths: ['190px'] })}<p style="color:${C.gray}">${e(hint)}</p>${chartBlock(ctx)}`);
  return { subject, text, html };
}

// ── макрособытие ───────────────────────────────────────────────────────────
const MACRO_WHAT = {
  fomc: 'ФРС объявит ставку и даст пресс-конференцию. Крипта обычно резко двигается в первые минуты и часы после решения.',
  cpi: 'Инфляция в США (CPI). Выше прогноза — обычно давление на крипту, ниже — повод для роста. В первые минуты возможны резкие движения в обе стороны.',
  nfp: 'Рынок труда США (Non-Farm Payrolls). Сильные данные укрепляют доллар и обычно давят на крипту, слабые — наоборот. В первые минуты возможны резкие движения.',
  user: 'Событие из вашего списка (data/events.json). Возможны резкие движения в обе стороны.',
};

export function macroMessage(ev, ctx = {}) {
  const left = fmtDuration(ev.t - Date.now());
  const subject = `📅 Через ${left}: ${ev.name} (${fmtDate(ev.t, { withDate: false })})`;
  const L = [
    ['Событие', ev.name],
    ['Время', `${fmtDate(ev.t)} (через ${left})`],
    ['Что это значит', MACRO_WHAT[ev.kind] ?? MACRO_WHAT.user],
    ['Что сделает программа', ctx.filter === false
      ? 'фильтр макрособытий выключен (MACRO_FILTER=false) — сигналы приходят как обычно, это только напоминание'
      : `за ${ev.before} ч до и ${ev.after} ч после события новые сигналы на вход откладываются (придёт «готовиться»), киты и анализ работают как обычно`],
  ];
  if (ctx.btc) L.push(['Биткоин сейчас', `${fmt(ctx.btc.price)} · оценка ${sgn(ctx.btc.score)}${ctx.btc.change24h != null ? ` · 24 ч ${pct(ctx.btc.change24h, 1)}` : ''}`]);
  if (ctx.open?.length) L.push(['Открытые сигналы', ctx.open.map((x) => `${coinOf(x.symbol)} (${x.side === 'BUY' ? 'покупка' : 'продажа'}, стоп ${fmt(x.stop)})`).join(', ')]);
  L.push(['Совет', 'Проверьте стопы по открытым позициям; не входите с плечом перед самой новостью.']);
  const text = [subject, '', ...L.map(([k, v]) => `${k}: ${v}`)].join('\n');
  const html = wrap(`${h2(e(subject))}${table(L.map(([k, v]) => [`<b>${e(k)}</b>`, e(v)]), { widths: ['170px'] })}`);
  return { subject, text, html };
}

// ── киты ───────────────────────────────────────────────────────────────────
export function whaleMessage(ev, decision, ctx) {
  const coin = ctx?.stock ? `${coinOf(ev.symbol)} (акция)` : coinOf(ev.symbol);
  const buy = ev.side === 'buy';
  const where = ev.market === 'spot' ? 'спот Binance' : 'фьючерсы Binance (USDT-M)';
  const subject = ev.type === 'series'
    ? `🐋 Кит ${buy ? 'скупает' : 'распродаёт'} ${coin}: ${fmtUsd(ev.usd)} за ${ev.minutes} мин (${MARKET_RU[ev.market]})`
    : `🐋 Кит ${buy ? 'купил' : 'продал'} ${coin} на ${fmtUsd(ev.usd)} (${MARKET_RU[ev.market]})`;
  const L = [];
  L.push(['Рынок', where]);
  if (ev.type === 'series') L.push(['Что произошло', `${ev.count} крупных ${buy ? 'покупок' : 'продаж'} за ${ev.minutes} мин на ${fmtUsd(ev.usd)} — похоже на набор позиции частями`]);
  else {
    L.push(['Сумма', `${fmtUsd(ev.usd)} — ${fmtQty(ev.qty)} ${ctx?.stock ? 'акц.' : coinOf(ev.symbol)} по средней цене ${fmt(ev.price)}`]);
    if (ev.trades > 1 && fmt(ev.from) !== fmt(ev.to)) L.push(['Как исполнен', `рыночный ордер прошёл по стакану от ${fmt(ev.from)} до ${fmt(ev.to)} (${nTrades(ev.trades)})`]);
  }
  L.push(['Время', fmtDate(ev.time)]);
  if (ev.rank) L.push(['Необычность', `поток крупных ${buy ? 'покупок' : 'продаж'} за ${ev.minutes} мин больше, чем в ${Math.floor(ev.rank.pct)}% таких отрезков за последние ${ev.rank.hours} ч`]);
  L.push(['Насколько крупно', `порог кита для ${coinOf(ev.symbol)}: ${fmtUsd(ev.threshold)} — эта ${ev.type === 'series' ? 'серия' : 'сделка'} больше в ${(ev.usd / ev.threshold).toFixed(1)} раза${decision?.rule ? `; уведомление: ${decision.rule}` : ''}`]);
  const s = ctx.summary;
  if (s) {
    const w = s.whales, cnt = (n, k) => `${n} шт.${k ? `, из них китов ${k}` : ''}`;
    L.push(['Крупные ордера за час', `покупки ${fmtUsd(w.buy)} (${cnt(w.buyCount, w.buyWhales)}), продажи ${fmtUsd(w.sell)} (${cnt(w.sellCount, w.sellWhales)}), итог ${fmtUsd(w.net, { sign: true })}`]);
    const large = s.spot.largeDelta + s.futures.largeDelta, small = s.spot.smallDelta + s.futures.smallDelta;
    L.push(['Крупные / розница за час', `${fmtUsd(large, { sign: true })} / ${fmtUsd(small, { sign: true })}`]);
  }
  const r = ctx.result;
  let verdict = null;
  if (r) {
    L.push(['Анализ монеты', `${ACTION[r.action].emoji} ${ACTION[r.action].text}, оценка ${sgn(r.score)}, уверенность ${r.confidence}%, цена ${fmt(r.price)}`]);
    const near = buy ? r.levels.supports[0] : r.levels.resistances[0];
    if (near) L.push([buy ? 'Ближайшая поддержка' : 'Ближайшее сопротивление', `${zoneStr(near)} (${dist(near, r.price)}), сила ${near.strength.toFixed(1)}`]);
    const agree = (buy && r.score > 0.15) || (!buy && r.score < -0.15);
    verdict = agree ? '✅ Действие кита совпадает с направлением анализа — сигнал сильнее.' : '⚠️ Анализ это действие кита пока не подтверждает — будьте осторожны.';
  }
  if (ctx.zone && !ctx.trade) L.push(['Ждём вход', `${ctx.zone.dir === 'BUY' ? 'покупка' : 'продажа'} в зоне ${fmt(ctx.zone.low)} – ${fmt(ctx.zone.high)} — письмо придёт, когда цена в неё войдёт`]);
  const tr = ctx.trade;
  if (tr) {
    L.push(['Ваша сделка на Bybit', `${SIDE_RU[tr.side]} по ${fmt(tr.entry)}, стоп ${fmt(tr.slNow)}${tr.upnl != null ? `, сейчас ${fmtMoney(tr.upnl, { sign: true })}` : ''}`]);
    const against = (tr.side === 'Buy') !== buy;
    verdict = `${verdict ? `${verdict}\n` : ''}${against ? '⚠️ Кит действует против вашей позиции — проверьте стоп.' : '🤖 Кит действует в сторону вашей позиции.'}`;
  }
  const caution = ev.market === 'futures'
    ? 'На фьючерсах крупная покупка может быть закрытием шорта, а не новой ставкой на рост.'
    : 'Один крупный ордер — не гарантия роста. Сильнее, когда покупки идут сериями и совпадают с анализом.';
  const text = [subject, '', ...L.map(([k, v]) => `${k}: ${v}`), '', verdict, caution].filter((x) => x !== null).join('\n');
  const html = wrap(`${h2(e(subject), buy ? C.green : C.red)}${table(L.map(([k, v]) => [`<b>${e(k)}</b>`, e(v)]), { widths: ['170px'] })}
${verdict ? `<p style="margin:10px 0 4px"><b>${e(verdict).replace(/\n/g, '<br>')}</b></p>` : ''}<p style="color:${C.gray};margin:4px 0">${e(caution)}</p>${chartBlock(ctx)}`);
  return { subject, text, html, sms: `WHALE ${buy ? 'BUY' : 'SELL'} ${coin} ${fmtUsd(ev.usd)} ${ev.market}${ev.type === 'series' ? ` series x${ev.count}` : ` @${fmt(ev.price)}`}` };
}

// ── важная новость ─────────────────────────────────────────────────────────
export function newsMessage(symbol, a, r) {
  const coin = coinOf(symbol);
  const subject = `📰 ${coin}: ${a.event} — «${a.title.slice(0, 90)}»`;
  const L = [['Событие', a.event], ['Заголовок', a.title], ['Источники', a.sources.join(', ')], ['Опубликовано', fmtDate(a.time)], ['Тон', a.s > 0 ? 'позитивный' : 'негативный']];
  if (r) L.push(['Анализ монеты', `${ACTION[r.action].text}, оценка ${sgn(r.score)}, цена ${fmt(r.price)}`]);
  const text = [subject, '', ...L.map(([k, v]) => `${k}: ${v}`), safeHref(a.link) ? `\n${safeHref(a.link)}` : ''].join('\n');
  const html = wrap(`${h2(e(subject), a.impact < 0 ? C.red : C.green)}${table(L.map(([k, v]) => [`<b>${e(k)}</b>`, e(v)]), { widths: ['130px'] })}
${safeHref(a.link) ? `<p><a href="${e(safeHref(a.link))}">Открыть новость</a></p>` : ''}<p style="color:${C.gray}">Важные новости часто вызывают резкие движения — проверьте открытые позиции.</p>`);
  return { subject, text, html };
}

// ── события журнала ────────────────────────────────────────────────────────
const JEV = {
  tp1: (c, r) => [`🎯 ${c}: цель 1 достигнута (${sgn(r, 2)}R)`, 'Половину позиции можно зафиксировать, стоп перенести в безубыток (на цену входа).'],
  tp2: (c, r) => [`✅ ${c}: цель 2 достигнута (итог ${sgn(r, 2)}R)`, 'Сделка по сигналу завершена с прибылью.'],
  stop: (c, r) => [`🛑 ${c}: сработал стоп (${sgn(r, 2)}R)`, 'Цена ушла против сигнала — сделка закрыта по стопу.'],
  breakeven: (c, r) => [`⚪ ${c}: остаток закрыт в безубыток (итог ${sgn(r, 2)}R)`, 'После цели 1 цена вернулась к цене входа.'],
  expired: (c, r) => [`⌛ ${c}: сигнал истёк (итог ${sgn(r, 2)}R)`, 'За отведённое время цена не дошла ни до цели 2, ни до стопа — сделка закрыта по текущей цене.'],
  reversed: (c, r) => [`🔁 ${c}: противоположный сигнал (итог ${sgn(r, 2)}R)`, 'Появился сигнал в обратную сторону — прошлая сделка закрыта по текущей цене.'],
  trail: (c, r, en) => (en.status === 'closed'
    ? [`✅ ${c}: остаток закрыт по подтянутому стопу (итог ${sgn(r, 2)}R)`, 'Цена развернулась после половины пути ко второй цели — прибыль зафиксирована на уровне цели 1.']
    : [`🔒 ${c}: стоп подтянут к цели 1 (зафиксировано ${sgn(r, 2)}R)`, `Цена прошла полпути ко второй цели — стоп остатка перенесён на ${fmt(en.stop)}.`]),
};

export function journalMessage(ev, stats) {
  const en = ev.entry, coin = coinOf(en.symbol);
  const [subject, what] = JEV[ev.type](coin, ev.r, en);
  const L = [
    ['Сигнал', `${en.side === 'BUY' ? 'ПОКУПКА' : 'ПРОДАЖА'} от ${fmtDate(en.opened)} по ${fmt(en.entry)}`],
    ['Стоп / цели', `${fmt(en.initialStop)} / ${fmt(en.t1)} / ${fmt(en.t2)}`],
    ['Прошло', fmtDuration(Date.now() - en.opened)],
  ];
  if (stats?.closed) L.push(['Статистика за 30 дней', `${stats.closed} закрытых, успешных ${stats.winRate != null ? (stats.winRate * 100).toFixed(0) : '—'}%, средний результат ${stats.avgR != null ? sgn(stats.avgR, 2) : '—'}R`]);
  const text = [subject, what, '', ...L.map(([k, v]) => `${k}: ${v}`)].join('\n');
  const html = wrap(`${h2(e(subject))}<p>${e(what)}</p>${table(L.map(([k, v]) => [`<b>${e(k)}</b>`, e(v)]), { widths: ['170px'] })}`);
  return { subject, text, html };
}

// ── автоторговля: события сделок ────────────────────────────────────────────
export function tradeEventMessage(ev, ctx = {}) {
  const t = ev.trade, coin = t ? coinOf(t.symbol) : '';
  const head = tradeTitle(ev);
  let subject, what;
  const L = [];
  if (t) {
    L.push(['Сделка', `${SIDE_RU[t.side]} ${contracts(t)} от ${fmtDate(t.openedAt)} по ${fmt(t.entry)}`]);
    L.push(['Стоп / цели', `${fmt(t.slNow)}${t.slNow !== t.stop ? ` (был ${fmt(t.stop)})` : ''} / ${fmt(t.t1)}${t.single ? '' : ` / ${fmt(t.t2)}`}`]);
  }
  switch (ev.type) {
    case 'tp1':
      subject = `🎯 Bybit: ${coin} — цель 1 взята, стоп в безубытке`;
      what = `Половина позиции закрыта по ${fmt(t.t1)}. Стоп остатка перенесён на ${fmt(t.slNow)} — дальше сделка в худшем случае закроется без убытка.`;
      break;
    case 'trail':
      subject = `🔒 Bybit: ${coin} — стоп подтянут к цели 1`;
      what = `Цена прошла полпути ко второй цели — стоп остатка перенесён на ${fmt(t.slNow)}, прибыль по нему зафиксирована.`;
      break;
    case 'closed': {
      const win = (t.pnl ?? 0) >= 0;
      subject = `${win ? '✅' : '🛑'} Bybit: ${coin} ${SIDE_RU[t.side]} закрыт — ${t.pnl != null ? fmtMoney(t.pnl, { sign: true }) : 'итог уточняется'}${t.r != null ? ` (${sgn(t.r, 2)}R)` : ''}`;
      what = `Причина: ${TRADE_WHY[t.why] ?? t.why}.${t.exit ? ` Средняя цена выхода ${fmt(t.exit)}.` : ''}`;
      const path = [`открыта ${fmtDate(t.openedAt)} по ${fmt(t.entry)}`];
      if (t.tp1At) path.push(`${fmtDate(t.tp1At)} цель 1: половина закрыта по ${fmt(t.t1)}, стоп в безубыток`);
      if (t.trailedAt) path.push(`${fmtDate(t.trailedAt)} стоп подтянут к цели 1`);
      path.push(`${fmtDate(t.closedAt ?? Date.now())} закрыта — ${TRADE_WHY[t.why] ?? t.why}${t.exit ? `, средний выход ${fmt(t.exit)}` : ''}`);
      L.push(['Ход сделки', path.join(' → ')]);
      L.push(['Держали', fmtDuration((t.closedAt ?? Date.now()) - t.openedAt)]);
      L.push(['Результат', `${t.pnl != null ? fmtMoney(t.pnl, { sign: true }) : '—'} при заложенном риске ${fmtMoney(t.riskUsd)} (по данным Bybit)`]);
      break;
    }
    case 'sl-restored':
      subject = `⚠️ Bybit: ${coin} — стоп был снят, программа поставила его снова`;
      what = `На позиции не оказалось стопа. Программа снова поставила его на ${fmt(t.slNow)}. Если вы снимали его специально — закройте сделку вручную или командой --close-all.`;
      break;
    case 'tp-restored':
      subject = `⚠️ Bybit: ${coin} — цель ${ev.tag === 't2' ? '2' : '1'} была снята, программа выставила её снова`;
      what = `Лимитного ордера на цель ${fmt(ev.price)} не оказалось на бирже (отменён вручную или не встал). Он выставлен снова на оставшийся объём.`;
      break;
    case 'orphans':
      subject = '⚠️ Bybit: найдены ордера программы без записи о сделке';
      what = `Программа не знает об этих ордерах: файл сделок потерян или их открыла другая копия программы. Проверьте позиции по этим монетам на Bybit вручную: ${[...new Set((ev.orders ?? []).map((o) => o.symbol))].join(', ')}.`;
      break;
    case 'paused':
      subject = '⛔ Bybit: дневной лимит убытка — новые сделки только завтра';
      what = `Убыток за день ${fmtMoney(ev.pnl ?? ctx.pnlToday ?? 0)} достиг лимита ${ev.limitPct}% баланса. Открытые сделки сопровождаются как обычно, новые откроются завтра.`;
      break;
    case 'resumed':
      subject = '▶️ Bybit: новый день — автоторговля снова работает';
      what = 'Дневной лимит убытка обнулился.';
      break;
    case 'offline':
      subject = '⚠️ Bybit: нет связи больше 5 минут';
      what = `Ошибка: ${ev.error}. Открытые сделки защищены стопом на бирже; перенос стопов возобновится, когда связь вернётся.`;
      break;
    case 'online':
      subject = '✅ Bybit: связь восстановлена';
      what = 'Программа снова сопровождает открытые сделки.';
      break;
    default:
      subject = `🤖 Bybit: ${ev.type}`;
      what = '';
  }
  if (ctx.pnlToday != null) L.push(['Итог за сегодня', fmtMoney(ctx.pnlToday, { sign: true })]);
  if (ctx.stats?.n) L.push(['За 30 дней', `${nTrades(ctx.stats.n)}, прибыльных ${(ctx.stats.winRate * 100).toFixed(0)}%, итог ${fmtMoney(ctx.stats.pnl, { sign: true })} (${sgn(ctx.stats.sumR, 1)}R)`]);
  if (ctx.balance?.equity) L.push(['Баланс', fmtMoney(ctx.balance.equity)]);
  const text = [subject, `${head}. ${what}`, '', ...L.map(([k, v]) => `${k}: ${v}`)].join('\n');
  const html = wrap(`${h2(e(subject))}<p>${muted(e(head))}<br>${e(what)}</p>${L.length ? table(L.map(([k, v]) => [`<b>${e(k)}</b>`, e(v)]), { widths: ['150px'] }) : ''}`);
  return { subject, text, html };
}

// ── анализ развернулся против открытого сигнала ────────────────────────────
export function reversalMessage(en, r, ctx = {}) {
  const coin = coinOf(en.symbol);
  const buy = en.side === 'BUY';
  const subject = `⚠️ ${coin}: анализ развернулся против открытой ${buy ? 'покупки' : 'продажи'} (оценка ${sgn(r.score)})`;
  const near = buy ? r.levels.supports[0] : r.levels.resistances[0];
  const L = [
    ['Открыт сигнал', `${buy ? 'покупка' : 'продажа'} от ${fmtDate(en.opened)} по ${fmt(en.entry)}, стоп ${fmt(en.stop)}, цели ${fmt(en.t1)} / ${fmt(en.t2)}${en.tp1 ? ' (цель 1 уже взята)' : ''}`],
    ['Сейчас', `цена ${fmt(r.price)} (${pct(r.price / en.entry - 1, 1)} от входа), оценка ${sgn(r.score)}, режим: ${r.regime.label}`],
    ['Главные причины против', r.reasons[buy ? 'contra' : 'pro'].slice(0, 4).map((x) => x.text).join('; ') || '—'],
  ];
  if (near) L.push([buy ? 'Ближайшая поддержка' : 'Ближайшее сопротивление', `${zoneStr(near)} (${dist(near, r.price)})`]);
  L.push(['Что можно сделать', `${en.tp1 ? 'зафиксировать остаток' : 'закрыть позицию или уменьшить её'}, либо подтянуть стоп ${near ? `за ${buy ? 'поддержку' : 'сопротивление'} ${fmt(buy ? near.low : near.high)}` : 'ближе к цене'}`]);
  const text = [subject, '', ...L.map(([k, v]) => `${k}: ${v}`)].join('\n');
  const html = wrap(`${h2(e(subject), C.amber)}${table(L.map(([k, v]) => [`<b>${e(k)}</b>`, e(v)]), { widths: ['190px'] })}${chartBlock(ctx)}`);
  return { subject, text, html };
}

// ── запуск и смена списка ──────────────────────────────────────────────────
export function coinsTable(coins) {
  return coins.map((c, i) => `${String(i + 1).padStart(2)}. ${c.symbol.padEnd(10)}${c.name ? ` ${c.name}` : ''}`
    + (c.mcap ? ` — №${c.mcapRank} по капитализации, №${c.volRank} по объёму` : c.volRank ? ` — №${c.volRank} по объёму на Binance` : '')).join('\n');
}

export function stocksTable(stocks) {
  return stocks.map((c, i) => `${String(i + 1).padStart(2)}. ${String(c.ticker ?? coinOf(c.symbol)).padEnd(6)} ${c.name ?? ''}${c.symbol !== `${String(c.ticker).replace(/[^A-Z0-9]/g, '')}USDT` ? ` (${c.symbol})` : ''}`).join('\n');
}

export function startMessage({ coins, stocks = [], source, cfg, channels, changed, trading = null, events = null }) {
  const subject = changed ? '🔄 Crypto Watcher: обновлён список монет и акций' : `✅ Crypto Watcher запущен: ${plural(coins.length, ['монета', 'монеты', 'монет'])}${stocks.length ? ` и ${plural(stocks.length, ['акция', 'акции', 'акций'])}` : ''}`;
  const head = changed
    ? `Список монет обновлён (${source}).\nДобавлены: ${changed.added.join(', ') || '—'}\nУбраны: ${changed.removed.join(', ') || '—'}`
    : `Анализ: 15m/1h/4h/1d и неделя${cfg.options?.enabled ? ', опционы BTC и ETH (Deribit)' : ''}, проверка каждые ${cfg.pollSeconds} с. Порог сигнала ±${cfg.signal.threshold}.\nИсточник рейтинга: ${source}.\nУведомления: ${channels.join(', ')}.${events ? `\nНа почту приходят: ${events.join(', ')}.` : ''}${trading ? `\n${trading}` : ''}`;
  const st = stocks.length ? `\n\nАкции (фьючерсы на акции Binance; сигналы — ${SESSION_HOURS[cfg.stocks?.hours] ?? 'в часы торгов'}):\n${stocksTable(stocks)}` : '';
  const text = `${subject}\n\n${head}\n\nОтслеживаю:\n${coinsTable(coins)}${st}`;
  const html = wrap(`${h2(e(subject))}<p>${e(head).replace(/\n/g, '<br>')}</p>${table(coins.map((c, i) => [String(i + 1), `<b>${e(coinOf(c.symbol))}</b> ${muted(e(c.name ?? ''))}`, c.mcap ? `№${c.mcapRank}` : '—', c.volRank ? `№${c.volRank}` : '—']), { head: ['#', 'Монета', 'Капитализация', 'Объём'] })}`
    + (stocks.length ? h3('Акции') + table(stocks.map((c, i) => [String(i + 1), `<b>${e(c.ticker ?? coinOf(c.symbol))}</b> ${muted(e(c.name ?? ''))}`])) : ''));
  return { subject, text, html };
}

// ── ежедневный обзор ───────────────────────────────────────────────────────
export function digestMessage({ results, market, journal, stats, liqMarket, whalesDay, newsTop, health, events = [], trading = null }) {
  const btc = results.find((r) => r.symbol.startsWith('BTC'));
  const f = market?.fng, g = market?.global;
  const date = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const subject = `📊 Обзор рынка ${date}: ${btc ? `BTC ${fmt(btc.price)} (${pct(btc.stats.change24h, 1)})` : ''}${f ? `, страх/жадность ${f.value}` : ''}`;
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const ov = [];
  if (g) ov.push(`Капитализация рынка ${fmtUsd(g.totalMcap)} (${g.mcapChange24h >= 0 ? '+' : ''}${g.mcapChange24h?.toFixed(1)}% за 24 ч), доминация BTC ${g.btcDom?.toFixed(1)}%${g.btcDomChange24h != null ? ` (${g.btcDomChange24h >= 0 ? '+' : ''}${g.btcDomChange24h.toFixed(2)})` : ''}, стейблкоины ${g.stableDom?.toFixed(1)}%${g.stable7d ? ` (за неделю ${fmtUsd(g.stable7d.abs, { sign: true })})` : ''}`);
  if (f) ov.push(`Индекс страха и жадности: ${f.value} (${f.label}), за неделю ${f.change7d >= 0 ? '+' : ''}${f.change7d}`);
  if (liqMarket) ov.push(`Ликвидации за сутки (все монеты Binance): лонги ${fmtUsd(liqMarket.long)}, шорты ${fmtUsd(liqMarket.short)}`);
  const br = ['crypto', 'stock'].map((k) => breadthText(results.find((r) => (r.kind ?? 'crypto') === k && r.breadth?.n)?.breadth)).filter(Boolean);
  if (br.length) ov.push(`Рынок в целом: ${br.join('; ')}`);
  for (const r of results.filter((x) => x.options)) ov.push(`Опционы ${coinOf(r.symbol)} (Deribit): ${optionsText(r.options, r.rv30)}`);
  const best = sorted.slice(0, 3).filter((r) => r.score > 0.15), worst = sorted.slice(-3).reverse().filter((r) => r.score < -0.15);
  if (best.length) ov.push(`Сильнее всего выглядят: ${best.map((r) => `${coinOf(r.symbol)} (${sgn(r.score)})`).join(', ')}`);
  if (worst.length) ov.push(`Слабее всего: ${worst.map((r) => `${coinOf(r.symbol)} (${sgn(r.score)})`).join(', ')}`);

  const row = (r) => {
    const d = r.blocks.derivatives?.summary;
    const s = r.levels.supports[0], rs = r.levels.resistances[0];
    return {
      coin: coinOf(r.symbol), price: fmt(r.price), ch: pct(r.stats.change24h, 1), score: r.score, action: r.action, regime: r.regime.label,
      sup: s ? `${fmt(s.high)} (${dist(s, r.price)})` : '—', res: rs ? `${fmt(rs.low)} (${dist(rs, r.price)})` : '—',
      funding: d?.funding != null ? `${(d.funding * 100).toFixed(3)}%` : '—', oi: d?.oi24 != null ? pct(d.oi24, 1) : '—',
      whales: whalesDay?.[r.symbol] ? fmtUsd(whalesDay[r.symbol], { sign: true }) : '—',
    };
  };
  const rows = sorted.map(row);
  const textRows = rows.map((x) => `${x.coin.padEnd(6)} ${x.price.padStart(12)} ${x.ch.padStart(7)}  ${sgn(x.score).padStart(5)}  ${ACTION[x.action].emoji} ${x.regime}; S ${x.sup}; R ${x.res}; фандинг ${x.funding}; OI 24ч ${x.oi}; киты ${x.whales}`);
  const st = stats;
  const jl = st?.total ? `Сигналы за 30 дней: ${st.total} (открыто ${st.open}), закрыто ${st.closed}, успешных ${st.winRate != null ? (st.winRate * 100).toFixed(0) : '—'}%, цель 1 достигнута в ${st.tp1Rate != null ? (st.tp1Rate * 100).toFixed(0) : '—'}%, средний результат ${st.avgR != null ? sgn(st.avgR, 2) : '—'}R, сумма ${sgn(st.sumR, 1)}R` : 'Сигналов за 30 дней ещё не было.';
  const openList = (journal ?? []).filter((x) => x.status === 'open');
  const tr = trading;
  const tradeLine = tr && (tr.enabled || tr.open.length)
    ? `${tradeTitle(tr)}: ${tr.ready ? `баланс ${tr.balance ? fmtMoney(tr.balance.equity) : '—'}, открыто ${tr.open.length}, итог за сегодня ${fmtMoney(tr.pnlToday ?? 0, { sign: true })}${tr.stats?.n ? `; за 30 дней ${nTrades(tr.stats.n)}, прибыльных ${(tr.stats.winRate * 100).toFixed(0)}%, итог ${fmtMoney(tr.stats.pnl, { sign: true })}` : ''}${tr.paused ? '; ⛔ дневной лимит убытка' : ''}` : `не работает — ${tr.problem}`}`
    : null;
  const text = [subject, '', ...ov, '', 'Монеты (от сильных к слабым):', ...textRows, '', jl, ...(tradeLine ? [tradeLine, ...tr.open.map((t) => `  ${SIDE_RU[t.side]} ${coinOf(t.symbol)} по ${fmt(t.entry)}, стоп ${fmt(t.slNow)}, сейчас ${t.upnl != null ? fmtMoney(t.upnl, { sign: true }) : '—'}`)] : []),
    ...openList.map((x) => `  открыт: ${x.side === 'BUY' ? 'покупка' : 'продажа'} ${coinOf(x.symbol)} от ${fmtDate(x.opened)} по ${fmt(x.entry)}, стоп ${fmt(x.stop)}, цели ${fmt(x.t1)}/${fmt(x.t2)}${x.tp1 ? ' (цель 1 взята)' : ''}`),
    '', ...(events.length ? ['События на неделю:', ...events.map((x) => `  📅 ${fmtDate(x.t)} — ${x.name}`)] : []),
    '', ...(newsTop?.length ? ['Главные новости:', ...newsTop.map((n) => `  ${n.s > 0 ? '▲' : '▼'} ${n.title} (${n.source})`)] : []),
    '', health ? `Состояние: ${health}` : ''].join('\n');

  const html = wrap(`${h2(e(subject))}
<div style="background:${C.light};padding:8px 10px">${ov.map((x) => e(x)).join('<br>')}</div>
${h3('Монеты — от сильных к слабым')}
${table(rows.map((x) => [`<b>${e(x.coin)}</b>`, `${x.price}<br>${muted(x.ch)}`, `${bar(x.score, 70)}<br><b style="color:${colorOf(x.score)}">${sgn(x.score)}</b>`, `${ACTION[x.action].emoji} ${muted(e(x.regime))}`, `${x.sup}<br>${x.res}`, `${x.funding}<br>${x.oi}`, x.whales]),
    { head: ['Монета', 'Цена / 24 ч', 'Оценка', 'Сигнал / режим', 'Поддержка / сопротивление', 'Фандинг / OI 24 ч', 'Киты'] })}
${h3('Сигналы и результаты')}<p>${e(jl)}</p>
${tradeLine ? `<p><b>${e(tradeLine)}</b></p>${tr.open.length ? table(tr.open.map((t) => [`<b>${e(coinOf(t.symbol))}</b>`, SIDE_RU[t.side], fmtDate(t.openedAt), fmt(t.entry), fmt(t.slNow), `${fmt(t.t1)}${t.single ? '' : ` / ${fmt(t.t2)}`}`, t.upnl != null ? fmtMoney(t.upnl, { sign: true }) : '—']), { head: ['Монета', 'Сторона', 'Открыта', 'Вход', 'Стоп', 'Цели', 'Сейчас'] }) : ''}` : ''}
${openList.length ? table(openList.map((x) => [`<b>${e(coinOf(x.symbol))}</b>`, x.side === 'BUY' ? 'покупка' : 'продажа', fmtDate(x.opened), fmt(x.entry), fmt(x.stop), `${fmt(x.t1)} / ${fmt(x.t2)}`, x.tp1 ? 'цель 1 взята' : '']), { head: ['Монета', 'Сторона', 'Открыт', 'Вход', 'Стоп', 'Цели', ''] }) : ''}
${events.length ? h3('📅 События на неделю') + events.map((x) => `<div style="margin:3px 0"><b>${fmtDate(x.t)}</b> — ${e(x.name)}</div>`).join('') : ''}
${newsTop?.length ? h3('Главные новости') + newsTop.map((n) => `<div style="margin:3px 0">${n.s > 0 ? `<span style="color:${C.green}">▲</span>` : `<span style="color:${C.red}">▼</span>`} ${safeHref(n.link) ? `<a href="${e(safeHref(n.link))}" style="color:${C.text}">${e(n.title)}</a>` : e(n.title)} ${muted(e(n.source))}</div>`).join('') : ''}
${health ? `<p style="color:${C.gray};font-size:12px">Состояние: ${e(health)}</p>` : ''}`);
  return { subject, text, html };
}

// ── строка состояния в консоли ─────────────────────────────────────────────
export function statusLine(r) {
  const col = r.score >= 0.2 ? '\x1b[32m' : r.score <= -0.2 ? '\x1b[31m' : '\x1b[2m';
  const n = Math.round(Math.min(1, Math.abs(r.score)) * 10);
  const b = (r.score >= 0 ? '+' : '-') + '█'.repeat(n) + '·'.repeat(10 - n);
  const parts = Object.entries(r.blocks).map(([k, x]) => `${k.slice(0, 4)} ${x.disabled ? ' -- ' : sgn(x.score)}`);
  const why = r.action.startsWith('WATCH') ? (r.reason ? ` · ждём зону ${fmt(r.plan.zone[0])}–${fmt(r.plan.zone[1])}` : r.warnings[0] ? ` · ${r.warnings[0].split(' — ')[0]}` : '') : '';
  return `\x1b[2m${fmtDate(r.time, { withDate: false })}\x1b[0m ${coinOf(r.symbol).padEnd(6)} ${fmt(r.price).padStart(12)}  ${col}${b} ${sgn(r.score)}\x1b[0m ${ACTION[r.action].emoji} \x1b[2m${parts.join(' | ')} · ${r.regime.label}${why}\x1b[0m`;
}
