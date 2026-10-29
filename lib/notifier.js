// Уведомления: консоль, почта, SMS (Twilio)
import { fmt, BLOCK_NAMES } from './analyzer.js';

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' };
const bar = (s) => {
  const n = Math.round(Math.abs(s) * 10);
  return (s >= 0 ? '+' : '-') + '█'.repeat(n) + '·'.repeat(10 - n);
};

export const ACTION_TEXT = {
  BUY: '🟢 ПОКУПКА', SELL: '🔴 ПРОДАЖА',
  WATCH_BUY: '🟡 ГОТОВИТЬСЯ К ПОКУПКЕ', WATCH_SELL: '🟡 ГОТОВИТЬСЯ К ПРОДАЖЕ', NEUTRAL: '⚪ НЕЙТРАЛЬНО',
};
const ACTION_SHORT = { BUY: 'BUY', SELL: 'SELL', WATCH_BUY: 'GET READY BUY', WATCH_SELL: 'GET READY SELL', NEUTRAL: 'NEUTRAL' };

export function formatReport(r, { full = true } = {}) {
  const p = r.plan;
  const lines = [
    `${ACTION_TEXT[r.action]} ${r.symbol} @ ${fmt(r.price)}`,
    `Оценка ${r.score >= 0 ? '+' : ''}${r.score.toFixed(2)} (${r.strength}), согласие блоков ${(r.agreement * 100).toFixed(0)}%`,
  ];
  if (r.action !== 'NEUTRAL') {
    const buy = r.action.endsWith('BUY');
    lines.push('',
      buy ? `Зона покупки: ${fmt(p.zone[0])} – ${fmt(p.zone[1])}` : `Зона продажи: ${fmt(p.zone[0])} – ${fmt(p.zone[1])}`,
      `Стоп: ${fmt(p.stop)} | Цель 1: ${fmt(p.t1)} | Цель 2: ${fmt(p.t2)}`,
      `Прибыль/риск от текущей цены: ${p.rr.toFixed(2)}`);
    if (r.reason) lines.push(`⚠️ ${r.reason}`);
  }
  if (full) {
    lines.push('');
    for (const [k, b] of Object.entries(r.blocks)) {
      lines.push(`${BLOCK_NAMES[k]}: ${b.disabled ? 'выкл' : `${b.score >= 0 ? '+' : ''}${b.score.toFixed(2)}`}`);
      for (const n of b.notes) lines.push(`   • ${n}`);
    }
    if (r.newsTop?.length) {
      lines.push('', 'Главные новости:');
      for (const n of r.newsTop) lines.push(`   ${n.s > 0 ? '▲' : '▼'} ${n.title}`);
    }
  }
  return lines.join('\n');
}

// Короткий текст для SMS: латиница, чтобы влезть в одно сообщение (160 символов)
export function formatSms(r) {
  const p = r.plan;
  return `${ACTION_SHORT[r.action]} ${r.symbol} ${fmt(r.price)} | zone ${fmt(p.zone[0])}-${fmt(p.zone[1])} SL ${fmt(p.stop)} TP ${fmt(p.t1)}/${fmt(p.t2)} RR ${p.rr.toFixed(1)} score ${r.score.toFixed(2)}`;
}

// 🐋 Письмо о ките
const usd = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}K` : `$${Math.round(x)}`);

export function formatWhale(ev, sum, last, name) {
  const coin = ev.symbol.replace(/USDT$/, '');
  const buy = ev.side === 'buy';
  const where = ev.market === 'spot' ? 'спот Binance' : 'фьючерсы Binance (USDT-M)';
  const verb = buy ? 'КУПИЛ' : 'ПРОДАЛ';
  const subject = ev.type === 'series'
    ? `🐋 Кит ${buy ? 'скупает' : 'распродаёт'} ${coin}: ${usd(ev.usd)} за ${ev.minutes} мин`
    : `🐋 Кит ${verb} ${coin} на ${usd(ev.usd)}`;

  const lines = [subject.replace('🐋 ', '🐋 '), ''];
  lines.push(`Монета: ${coin}${name ? ` (${name})` : ''}`, `Рынок: ${where}`);
  if (ev.type === 'series') {
    lines.push(`Что произошло: ${ev.count} крупных ${buy ? 'покупок' : 'продаж'} подряд за ${ev.minutes} мин на сумму ${usd(ev.usd)} — похоже на набор позиции частями.`);
  } else {
    lines.push(`Сумма: ${usd(ev.usd)} — ${fmt(ev.qty)} ${coin} по средней цене ${fmt(ev.price)}`);
    if (ev.trades > 1 && ev.from !== ev.to) lines.push(`Ордер прошёл по стакану от ${fmt(ev.from)} до ${fmt(ev.to)} (${ev.trades} сделок)`);
  }
  lines.push(`Время: ${new Date(ev.time).toLocaleString('ru-RU')}`,
    `Порог крупной сделки для ${coin}: ${usd(ev.threshold)} — эта ${ev.type === 'series' ? 'серия' : 'сделка'} больше в ${(ev.usd / ev.threshold).toFixed(1)} раза`);

  lines.push('', `Китовые деньги по ${coin} за последний час:`,
    `   покупки ${usd(sum.buy)} (крупных: ${sum.buyCount}), продажи ${usd(sum.sell)} (крупных: ${sum.sellCount})`,
    `   чистый ${sum.net >= 0 ? 'приток' : 'отток'}: ${sum.net >= 0 ? '+' : '−'}${usd(Math.abs(sum.net))}`);

  if (last) {
    lines.push('', `Анализ ${coin} на последней проверке: ${ACTION_TEXT[last.action]}, оценка ${last.score >= 0 ? '+' : ''}${last.score.toFixed(2)}, цена ${fmt(last.price)}`);
    const agree = (buy && last.score > 0.15) || (!buy && last.score < -0.15);
    lines.push(agree ? '✅ Действие кита совпадает с направлением анализа — сигнал сильнее.'
      : '⚠️ Анализ это действие кита пока не подтверждает — будьте осторожны.');
  }
  lines.push('', ev.market === 'futures'
    ? 'Важно: на фьючерсах крупная покупка может быть закрытием шорта, а не новой ставкой на рост.'
    : 'Важно: один крупный ордер — не гарантия роста. Сильнее, когда покупки идут сериями и совпадают с анализом.');
  return { subject, text: lines.join('\n') };
}

export function formatWhaleSms(ev) {
  const coin = ev.symbol.replace(/USDT$/, '');
  return `WHALE ${ev.side === 'buy' ? 'BUY' : 'SELL'} ${coin} ${usd(ev.usd)} ${ev.market}${ev.type === 'series' ? ` series x${ev.count}` : ` @${fmt(ev.price)}`}`;
}

export function statusLine(r) {
  const col = r.score >= 0.2 ? C.green : r.score <= -0.2 ? C.red : C.dim;
  const t = new Date(r.time).toLocaleTimeString('ru-RU');
  const parts = Object.entries(r.blocks).map(([k, b]) => `${k.slice(0, 4)} ${b.disabled ? ' off ' : (b.score >= 0 ? '+' : '') + b.score.toFixed(2)}`);
  return `${C.dim}${t}${C.reset} ${r.symbol.padEnd(9)} ${fmt(r.price).padStart(11)}  ${col}${bar(r.score)} ${r.score.toFixed(2)}${C.reset}  ${C.dim}${parts.join(' | ')}${C.reset}`;
}

async function check(res, name) {
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

// Каналы: консоль, почта (всё) и SMS (по умолчанию выключены, включаются через SMS=1)
export class Notifier {
  constructor(cfg) {
    this.cfg = cfg.notify;
    this.mailer = null;
  }

  // какие каналы настроены — для сообщения при старте
  channels() {
    const c = this.cfg, list = ['консоль'];
    if (c.email.to && c.email.user && c.email.pass) list.push(`почта ${c.email.to} (все уведомления)`);
    if (c.sms.enabled && c.sms.to && c.sms.accountSid && c.sms.authToken && c.sms.from) list.push(`SMS ${c.sms.to} (сигналы ${c.actions.filter((a) => a === 'BUY' || a === 'SELL').join('/') || '—'} и крупные киты)`);
    return list;
  }

  async getMailer() {
    if (this.mailer) return this.mailer;
    const { default: nodemailer } = await import('nodemailer');
    const e = this.cfg.email;
    this.mailer = nodemailer.createTransport({
      host: e.host, port: e.port, secure: e.port === 465, auth: { user: e.user, pass: e.pass },
    });
    return this.mailer;
  }

  async email(subject, text) {
    const e = this.cfg.email;
    if (!e.to || !e.user || !e.pass) return;
    const mailer = await this.getMailer();
    await mailer.sendMail({ from: e.from || e.user, to: e.to, subject, text });
  }

  async sms(text) {
    const s = this.cfg.sms;
    if (!s.enabled || !s.to || !s.from || !s.accountSid || !s.authToken) return;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${s.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${s.accountSid}:${s.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: s.to, From: s.from, Body: text.slice(0, 160) }),
    });
    await check(res, 'SMS');
  }

  // Почта получает всё; SMS — только если передан smsText. Ошибка одного канала не мешает другому
  async broadcast({ subject, text, smsText }) {
    const jobs = [['почта', () => this.email(subject, text)]];
    if (smsText) jobs.push(['SMS', () => this.sms(smsText)]);
    const results = await Promise.allSettled(jobs.map(([, fn]) => fn()));
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`[уведомление] ${jobs[i][0]}: ${r.reason?.message || r.reason}`);
    });
  }

  async send(r) {
    const text = formatReport(r);
    if (this.cfg.console) {
      const col = r.action.endsWith('BUY') ? C.green : r.action.endsWith('SELL') ? C.red : C.yellow;
      console.log(`\n${col}${C.bold}${'═'.repeat(60)}${C.reset}\n${text}\n${col}${'═'.repeat(60)}${C.reset}\n`);
    }
    const signal = r.action === 'BUY' || r.action === 'SELL';
    await this.broadcast({
      subject: `${ACTION_TEXT[r.action]} ${r.symbol} @ ${fmt(r.price)}`,
      text,
      smsText: signal ? formatSms(r) : null, // «готовиться» — только на почту
    });
  }
}
