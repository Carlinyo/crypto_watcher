// Веб-панель и проверка здоровья:
//   /            — все монеты: оценка, сигнал, режим, уровни, фандинг, киты; рынок; журнал сигналов
//   /coin/BTCUSDT — полный отчёт по монете (как в письме)
//   /api/state   — то же в JSON
//   /health      — для Docker: 200, если анализ идёт, 503 — если завис
// По умолчанию доступна только с самого сервера (через SSH-туннель), можно задать DASHBOARD_TOKEN.
import http from 'node:http';
import crypto from 'node:crypto';
import { signalHtml, ACTION, tradeTitle, TRADE_WHY } from './report.js';
import { fmt, fmtUsd, fmtMoney, trades as nTrades, pct, sgn, coinOf, fmtDate, TF_RU, safeHref, escapeHtml as e } from './format.js';

const STYLE = `body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#f6f8fa;color:#1f2328;font-size:14px}
main{max-width:1280px;margin:0 auto;padding:14px}h1{font-size:20px;margin:4px 0 10px}h2{font-size:16px;margin:18px 0 8px}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #d0d7de}th,td{padding:6px 8px;border-bottom:1px solid #eaeef2;text-align:left;vertical-align:top}
th{background:#f6f8fa;font-weight:600;font-size:12px;color:#57606a}a{color:#0969da;text-decoration:none}.g{color:#1a7f37}.r{color:#cf222e}.m{color:#57606a}
.card{background:#fff;border:1px solid #d0d7de;padding:10px 12px;margin-bottom:10px}.bar{display:inline-block;width:90px;height:8px;background:#eaeef2;position:relative;vertical-align:middle}
.bar i{position:absolute;top:0;height:8px}.wrap{overflow-x:auto}`;

// заголовки безопасности: без скриптов и встраивания в чужие сайты, адрес (с токеном) не уходит по ссылкам
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
};
const send = (res, status, type, body) => { res.writeHead(status, { 'Content-Type': type, ...SECURITY }); res.end(body); };
const sameToken = (given, token) => {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function bar(s) {
  const w = Math.round(Math.min(1, Math.abs(s)) * 45);
  return `<span class="bar"><i style="${s >= 0 ? 'left:45px' : `left:${45 - w}px`};width:${w}px;background:${s >= 0 ? '#1a7f37' : '#cf222e'}"></i></span>`;
}

// 🤖 автоторговля: баланс, открытые позиции, закрытые сделки
function tradingBlock(tr) {
  if (!tr || (!tr.enabled && !tr.open.length && !tr.closed.length)) return '';
  const side = (t) => (t.side === 'Buy' ? '<span class="g">лонг</span>' : '<span class="r">шорт</span>');
  const head = tr.ready
    ? `Баланс <b>${tr.balance ? fmtMoney(tr.balance.equity) : '—'}</b> (свободно ${tr.balance ? fmtMoney(tr.balance.available) : '—'}) · итог за сегодня <b class="${tr.pnlToday >= 0 ? 'g' : 'r'}">${fmtMoney(tr.pnlToday ?? 0, { sign: true })}</b>`
      + `${tr.stats?.n ? ` · за 30 дней ${nTrades(tr.stats.n)}, прибыльных ${(tr.stats.winRate * 100).toFixed(0)}%, итог ${fmtMoney(tr.stats.pnl, { sign: true })} (${sgn(tr.stats.sumR, 1)}R)` : ''}`
      + `<br><span class="m">риск ${tr.settings.riskPct}% на сделку · плечо до ×${tr.settings.leverage} · до ${tr.settings.maxPositions} позиций · дневной лимит убытка ${tr.settings.dailyLossPct}%${tr.enabled ? '' : ' · новые сделки выключены (TRADE=0)'}</span>`
      + `${tr.userPause ? `<br><b class="r">⏸ на паузе с ${fmtDate(tr.userPause.at)} — новые сделки не открываются (снять: --resume-trading)</b>` : ''}`
      + `${tr.paused ? '<br><b class="r">⛔ дневной лимит убытка — новые сделки только завтра</b>' : ''}${tr.warnings?.length ? `<br><span class="r">⚠️ ${tr.warnings.map(e).join('<br>⚠️ ')}</span>` : ''}${tr.lastError ? `<br><span class="m">последняя ошибка: ${e(tr.lastError)}</span>` : ''}`
    : `<b class="r">не работает:</b> ${e(tr.problem ?? 'запуск…')}`;
  return `<h2>${e(tradeTitle(tr))}</h2><div class="card">${head}</div>
${tr.open.length ? `<div class="wrap"><table><tr><th>Монета</th><th>Сторона</th><th>Открыта</th><th>Объём</th><th>Вход</th><th>Стоп</th><th>Цели</th><th>Сейчас</th></tr>${tr.open.map((t) => `<tr><td><b>${e(coinOf(t.symbol))}</b><br><span class="m">${e(t.bySymbol)}</span></td><td>${side(t)}</td><td class="m">${fmtDate(t.openedAt)}</td><td>${fmtMoney(t.notional)}<br><span class="m">риск ${fmtMoney(t.riskUsd)}</span></td><td>${fmt(t.entry)}</td><td>${fmt(t.slNow)}${t.tp1Done ? '<br><span class="m">безубыток</span>' : ''}</td><td>${fmt(t.t1)}${t.single ? '' : ` / ${fmt(t.t2)}`}${t.tp1Done ? '<br><span class="g">цель 1 взята</span>' : ''}</td><td class="${(t.upnl ?? 0) >= 0 ? 'g' : 'r'}">${t.upnl != null ? fmtMoney(t.upnl, { sign: true }) : '—'}<br><span class="m">${t.mark ? fmt(t.mark) : ''}</span></td></tr>`).join('')}</table></div>` : '<div class="card m">открытых сделок нет</div>'}
${tr.closed.length ? `<table><tr><th>Монета</th><th>Сторона</th><th>Открыта</th><th>Вход → выход</th><th>Причина</th><th>Итог</th></tr>${tr.closed.slice(0, 15).map((t) => `<tr><td>${e(coinOf(t.symbol))}</td><td>${side(t)}</td><td class="m">${fmtDate(t.openedAt)}</td><td>${fmt(t.entry)} → ${t.exit ? fmt(t.exit) : '—'}</td><td>${e(TRADE_WHY[t.why] ?? t.why ?? '')}</td><td class="${(t.pnl ?? 0) >= 0 ? 'g' : 'r'}">${t.pnl != null ? fmtMoney(t.pnl, { sign: true }) : '—'}${t.r != null ? ` <span class="m">(${sgn(t.r, 2)}R)</span>` : ''}</td></tr>`).join('')}</table>` : ''}`;
}

function dashboard(app, tok) {
  const s = app.snapshot();
  const q = tok ? `?token=${encodeURIComponent(tok)}` : '';
  const rows = [...s.results].sort((a, b) => b.score - a.score).map((r) => {
    const d = r.blocks.derivatives?.summary, f = r.blocks.flow?.summary;
    const sp = r.levels.supports[0], rs = r.levels.resistances[0];
    return `<tr><td><a href="/coin/${r.symbol}${q}"><b>${e(coinOf(r.symbol))}</b></a><br><span class="m">${e(r.name ?? '')}</span></td>
<td>${fmt(r.price)}<br><span class="${r.stats.change24h >= 0 ? 'g' : 'r'}">${pct(r.stats.change24h, 1)}</span></td>
<td>${bar(r.score)} <b class="${r.score > 0.1 ? 'g' : r.score < -0.1 ? 'r' : 'm'}">${sgn(r.score)}</b><br><span class="m">уверенность ${r.confidence}%</span></td>
<td>${ACTION[r.action].emoji} ${e(ACTION[r.action].text.toLowerCase())}<br><span class="m">${e(r.regime.label)}</span></td>
<td>${sp ? `${fmt(sp.high)} <span class="m">(${pct(sp.high / r.price - 1, 1)}, сила ${sp.strength.toFixed(1)})</span>` : '—'}<br>${rs ? `${fmt(rs.low)} <span class="m">(${pct(rs.low / r.price - 1, 1)}, сила ${rs.strength.toFixed(1)})</span>` : '—'}</td>
<td>${d?.funding != null ? `${(d.funding * 100).toFixed(3)}%` : '—'}<br><span class="m">OI 24ч ${d?.oi24 != null ? pct(d.oi24, 1) : '—'}</span></td>
<td>${(() => { const w = s.whales4h?.[r.symbol]; return w && w.buy + w.sell > 0 ? `${fmtUsd(w.net, { sign: true })}<br><span class="m">${w.buyCount}↑ ${w.sellCount}↓</span>` : '—'; })()}<br><span class="m">${f?.largeDelta != null ? `крупные ${fmtUsd(f.largeDelta, { sign: true })}` : ''}</span></td>
<td>${Object.entries(r.tfs).map(([k, t]) => `${TF_RU[k] ?? k}: ${e(t.trend)}`).join('<br>')}</td>
<td class="m">${fmtDate(r.time, { withDate: false })}</td></tr>`;
  }).join('');
  const m = s.market, g = m.global, f = m.fng;
  const st = s.stats;
  const open = s.journal.filter((x) => x.status === 'open');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><meta name="referrer" content="no-referrer"><title>Crypto Watcher</title><style>${STYLE}</style></head><body><main>
<h1>Crypto Watcher <span class="m" style="font-size:13px">обновлено ${fmtDate(Date.now())} · цикл ${s.health.lastCycleSec ?? '—'} с назад</span></h1>
<div class="card">${g ? `Капитализация ${fmtUsd(g.totalMcap)} (${g.mcapChange24h >= 0 ? '+' : ''}${g.mcapChange24h?.toFixed(1)}% за 24 ч) · доминация BTC ${g.btcDom?.toFixed(1)}% · стейблкоины ${g.stableDom?.toFixed(1)}%` : 'данные о рынке загружаются'}
${f ? ` · страх и жадность <b>${f.value}</b> (${e(f.label)})` : ''}${s.liqMarket ? ` · ликвидации за 24 ч: лонги ${fmtUsd(s.liqMarket.long)}, шорты ${fmtUsd(s.liqMarket.short)}` : ''}</div>
<div class="wrap"><table><tr><th>Монета</th><th>Цена / 24 ч</th><th>Оценка</th><th>Сигнал / режим</th><th>Поддержка / сопротивление</th><th>Фандинг / OI</th><th>Киты 4 ч</th><th>Тренд</th><th>Время</th></tr>${rows || '<tr><td colspan="9">первый цикл анализа ещё идёт…</td></tr>'}</table></div>
${tradingBlock(s.trading)}
<h2>Жду цену в зоне входа</h2>
${s.zones?.length ? `<table><tr><th>Монета</th><th>Сторона</th><th>Зона входа</th><th>Цена сейчас</th><th>Стоп / цель 1</th><th>Ждём до</th></tr>${s.zones.map((z) => {
    const d = z.price ? (z.dir === 'BUY' ? z.price / z.high - 1 : z.price / z.low - 1) : null;
    return `<tr><td><a href="/coin/${z.symbol}${q}"><b>${e(coinOf(z.symbol))}</b></a></td><td class="${z.dir === 'BUY' ? 'g' : 'r'}">${z.dir === 'BUY' ? 'покупка' : 'продажа'}</td><td>${fmt(z.low)} – ${fmt(z.high)}</td><td>${z.price ? fmt(z.price) : '—'}${d != null ? ` <span class="m">(${Math.abs(d) < 0.0005 ? 'у зоны' : `до зоны ${pct(-d, 1)}`})</span>` : ''}</td><td>${z.stop ? fmt(z.stop) : '—'} / ${z.t1 ? fmt(z.t1) : '—'}</td><td class="m">${fmtDate(z.until)}</td></tr>`;
  }).join('')}</table>` : '<div class="card m">сейчас нет — как только анализ найдёт хорошую цену для входа, монета появится здесь; письмо придёт, когда цена войдёт в зону</div>'}
${s.events?.length ? `<h2>Ближайшие события</h2><div class="card">${s.events.map((x) => `📅 <b>${fmtDate(x.t)}</b> — ${e(x.name)}`).join('<br>')}<br><span class="m">за несколько часов до и после события новые входы откладываются</span></div>` : ''}
<h2>Сигналы и результаты (30 дней)</h2>
<div class="card">${st.total ? `Всего ${st.total}, открыто ${st.open}, закрыто ${st.closed}; успешных ${st.winRate != null ? (st.winRate * 100).toFixed(0) : '—'}%; цель 1 достигнута в ${st.tp1Rate != null ? (st.tp1Rate * 100).toFixed(0) : '—'}%; средний результат ${st.avgR != null ? sgn(st.avgR, 2) : '—'}R; итого ${sgn(st.sumR, 1)}R` : 'Сигналов ещё не было.'}</div>
${open.length ? `<table><tr><th>Монета</th><th>Сторона</th><th>Открыт</th><th>Вход</th><th>Стоп</th><th>Цели</th><th>Статус</th></tr>${open.map((x) => `<tr><td>${e(coinOf(x.symbol))}</td><td>${x.side === 'BUY' ? 'покупка' : 'продажа'}</td><td>${fmtDate(x.opened)}</td><td>${fmt(x.entry)}</td><td>${fmt(x.stop)}</td><td>${fmt(x.t1)} / ${fmt(x.t2)}</td><td>${x.tp1 ? 'цель 1 взята' : 'открыт'}</td></tr>`).join('')}</table>` : ''}
<h2>Последние киты</h2>
<table><tr><th>Время</th><th>Монета</th><th>Сделка</th><th>Рынок</th><th>Письмо</th></tr>${(s.whales ?? []).slice(0, 15).map((w) => `<tr><td class="m">${fmtDate(w.time)}</td><td>${e(coinOf(w.symbol))}</td><td class="${w.side === 'buy' ? 'g' : 'r'}">${w.side === 'buy' ? 'покупка' : 'продажа'} ${fmtUsd(w.usd)}${w.type === 'series' ? ` (серия ×${w.count})` : ''}</td><td>${w.market === 'spot' ? 'спот' : 'фьючерсы'}</td><td class="m">${w.alerted ? 'да' : '—'}</td></tr>`).join('') || '<tr><td colspan="5">пока нет</td></tr>'}</table>
<h2>Крупные ликвидации за сутки</h2>
<table><tr><th>Время</th><th>Монета</th><th>Кого ликвидировали</th><th>Сумма</th><th>Цена</th></tr>${(s.liqBig ?? []).map((l) => `<tr><td class="m">${fmtDate(l.t)}</td><td>${e(coinOf(l.symbol))}</td><td class="${l.side === 'long' ? 'r' : 'g'}">${l.side === 'long' ? 'лонги' : 'шорты'}</td><td>${fmtUsd(l.usd)}</td><td>${fmt(l.price)}</td></tr>`).join('') || '<tr><td colspan="5">пока нет</td></tr>'}</table>
<h2>Новости</h2>
<div class="card">${(s.news ?? []).map((n) => `${n.s > 0.05 ? '<span class="g">▲</span>' : n.s < -0.05 ? '<span class="r">▼</span>' : '•'} ${safeHref(n.link) ? `<a href="${e(safeHref(n.link))}" target="_blank" rel="noopener noreferrer">${e(n.title)}</a>` : e(n.title)} <span class="m">${e((n.sources ?? [n.source]).slice(0, 2).join(', '))} · ${fmtDate(n.time)}</span>`).join('<br>') || 'пока нет'}</div>
<h2>Закрытые сигналы</h2>
<table><tr><th>Монета</th><th>Сторона</th><th>Открыт</th><th>Вход → выход</th><th>Итог</th><th>Результат</th></tr>${s.journal.filter((x) => x.status === 'closed').slice(0, 15).map((x) => `<tr><td>${e(coinOf(x.symbol))}</td><td>${x.side === 'BUY' ? 'покупка' : 'продажа'}</td><td class="m">${fmtDate(x.opened)}</td><td>${fmt(x.entry)} → ${fmt(x.exit)}</td><td>${({ tp2: 'цель 2', stop: 'стоп', breakeven: 'безубыток', trail: 'подтянутый стоп', expired: 'истёк', reversed: 'разворот' })[x.why] ?? x.why}</td><td class="${x.result > 0 ? 'g' : x.result < 0 ? 'r' : 'm'}">${sgn(x.result, 2)}R</td></tr>`).join('') || '<tr><td colspan="6">пока нет</td></tr>'}</table>
<h2>Последние события</h2>
<div class="card m">На почту приходят: ${e((s.emailEvents ?? []).join(', '))}. Остальное — только здесь (настройка EMAIL_EVENTS).</div>
<table><tr><th>Время</th><th>Событие</th><th>Письмо</th></tr>${s.alerts.slice(0, 30).map((a) => `<tr><td class="m">${fmtDate(a.t)}</td><td>${e(a.subject)}</td><td class="m">${a.sent === false ? '—' : '✉️'}</td></tr>`).join('') || '<tr><td colspan="3">пока нет</td></tr>'}</table>
<h2>Состояние</h2>
<div class="card">${e(s.health.text)}<br>${s.streams.map((x) => `поток «${e(x.name)}»: ${x.connected ? '<span class="g">подключён</span>' : '<span class="r">нет связи</span>'}, сообщений ${x.messages}, переподключений ${x.reconnects}`).join('<br>')}
<br>новостные ленты: ${s.feeds.map((x) => `${e(x.name)} ${x.ok ? '✓' : '✗'}`).join(', ')}</div>
</main></body></html>`;
}

export function startServer(cfg, app) {
  const { port, host, token } = cfg.server;
  if (!port) return null;
  const srv = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'text/plain; charset=utf-8', 'Только чтение'); return; }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') {
        const h = app.health();
        send(res, h.ok ? 200 : 503, 'application/json', JSON.stringify({ ok: h.ok, lastCycleSec: h.lastCycleSec, cycles: h.cycles, uptimeMin: h.uptimeMin }));
        return;
      }
      const tok = url.searchParams.get('token');
      if (token && !sameToken(tok, token)) { send(res, 401, 'text/plain; charset=utf-8', 'Нужен ?token=...'); return; }
      if (url.pathname === '/api/state') {
        const s = app.snapshot();
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(s, (k, v) => (k === 'blocks' ? Object.fromEntries(Object.entries(v).map(([bk, b]) => [bk, { score: b.score, disabled: !!b.disabled, notes: b.notes, summary: b.summary }])) : v)));
        return;
      }
      const m = url.pathname.match(/^\/coin\/([A-Z0-9]{2,20})$/);
      if (m) {
        const r = app.results.get(m[1]);
        send(res, r ? 200 : 404, 'text/html; charset=utf-8', r ? signalHtml(r, { chartSvg: app.chartSvg?.(m[1]) }) : 'Нет данных по монете');
        return;
      }
      if (url.pathname === '/') { send(res, 200, 'text/html; charset=utf-8', dashboard(app, tok)); return; }
      send(res, 404, 'text/plain; charset=utf-8', 'Не найдено');
    } catch (err) {
      console.error('Веб-панель:', err.message);
      send(res, 500, 'text/plain; charset=utf-8', 'Внутренняя ошибка');
    }
  });
  srv.headersTimeout = 10e3;
  srv.requestTimeout = 15e3;
  srv.on('error', (err) => console.error(`Веб-панель: ${err.message}`));
  srv.listen(port, host, () => console.log(`🌐 Веб-панель: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`));
  return srv;
}
