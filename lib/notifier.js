// Уведомления: почта (все) и SMS (только сигналы ПОКУПКА/ПРОДАЖА).
// • срочные (сигналы) уходят сразу; остальные копятся несколько секунд и приходят одним письмом;
// • ограничение числа писем в час, чтобы не утонуть в почте (срочные проходят всегда);
// • при сбое отправки — одна повторная попытка.
import { sleep } from './http.js';

export class Notifier {
  constructor(cfg) {
    this.cfg = cfg.notify;
    this.mailer = null;
    this.queue = [];
    this.timer = null;
    this.sent = [];   // время отправленных писем (для лимита в час)
    this.stats = { emails: 0, sms: 0, errors: 0, lastError: null };
  }

  emailReady() { const e = this.cfg.email; return !!(e.to && e.user && e.pass); }
  smsReady() { const s = this.cfg.sms; return !!(s.to && s.from && s.accountSid && s.authToken); }

  channels() {
    const list = ['консоль'];
    if (this.emailReady()) list.push(`почта ${this.cfg.email.to} (все уведомления)`);
    if (this.smsReady()) list.push(`SMS ${this.cfg.sms.to} (только покупка/продажа)`);
    return list;
  }

  async getMailer() {
    if (this.mailer) return this.mailer;
    const { default: nodemailer } = await import('nodemailer');
    const e = this.cfg.email;
    this.mailer = nodemailer.createTransport({ host: e.host, port: e.port, secure: e.port === 465, auth: { user: e.user, pass: e.pass } });
    return this.mailer;
  }

  async email(subject, text, html, attachments = []) {
    if (!this.emailReady()) return false;
    const e = this.cfg.email;
    for (let i = 0; i < 2; i++) {
      try {
        const mailer = await this.getMailer();
        await mailer.sendMail({ from: e.from || e.user, to: e.to, subject, text, html, attachments });
        this.sent.push(Date.now());
        this.stats.emails++;
        return true;
      } catch (err) {
        this.stats.errors++;
        this.stats.lastError = `почта: ${err.message}`;
        console.error(`[уведомление] почта: ${err.message}${i === 0 ? ' — повтор через 30 с' : ''}`);
        if (i === 0) await sleep(30e3);
      }
    }
    return false;
  }

  async sms(text) {
    if (!this.smsReady()) return false;
    const s = this.cfg.sms;
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${s.accountSid}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${s.accountSid}:${s.authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: s.to, From: s.from, Body: text.slice(0, 160) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        this.stats.sms++;
        return true;
      } catch (err) {
        this.stats.errors++;
        this.stats.lastError = `SMS: ${err.message}`;
        console.error(`[уведомление] SMS: ${err.message}${i === 0 ? ' — повтор через 20 с' : ''}`);
        if (i === 0) await sleep(20e3);
      }
    }
    return false;
  }

  log(subject, text) {
    if (!this.cfg.console) return;
    const body = text.startsWith(subject) ? text.slice(subject.length).replace(/^\n+/, '') : text;
    console.log(`\n\x1b[1m${'═'.repeat(64)}\n${subject}\x1b[0m\n${body}\n${'═'.repeat(64)}\n`);
  }

  /** Срочно: письмо (и SMS, если передан smsText) сразу */
  async urgent({ subject, text, html, smsText, attachments }) {
    this.log(subject, text);
    await Promise.allSettled([this.email(subject, text, html, attachments), smsText ? this.sms(smsText) : Promise.resolve(false)]);
  }

  /** Обычное уведомление: объединяется с соседними в одно письмо. key — чтобы потом можно было отменить */
  enqueue({ subject, text, html, tag, attachments, key }) {
    this.log(subject, text);
    this.queue.push({ subject, text, html, attachments, key, tag: tag ?? subject.split(' ')[0] });
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush().catch((e) => console.error('[уведомление]', e.message)); }, this.cfg.batchSeconds * 1000);
      this.timer.unref?.();
    }
  }

  /** Убрать из очереди ещё не отправленные уведомления с этим ключом (например, «готовиться» после сигнала) */
  drop(key) {
    const before = this.queue.length;
    this.queue = this.queue.filter((m) => m.key !== key);
    return before - this.queue.length;
  }

  async flush() {
    if (!this.queue.length) return;
    this.sent = this.sent.filter((t) => Date.now() - t < 3600e3);
    if (this.sent.length >= this.cfg.maxEmailsPerHour) {
      // лимит исчерпан — отложим до освобождения
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 5 * 60e3);
      this.timer.unref?.();
      return;
    }
    const batch = this.queue.splice(0, 12);
    if (batch.length === 1) {
      const m = batch[0];
      await this.email(m.subject, m.text, m.html, m.attachments);
    } else {
      const tags = [...new Set(batch.map((m) => m.tag))];
      const n = batch.length;
      const word = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'уведомления' : 'уведомлений';
      const subject = `${n} ${word}: ${batch.map((m) => m.subject.replace(/^\S+\s/, '').slice(0, 42)).slice(0, 3).join(' · ')}${n > 3 ? ' …' : ''}`;
      const text = batch.map((m) => `${m.subject}\n${m.text}`).join(`\n\n${'─'.repeat(40)}\n\n`);
      const inner = (h) => (h ? (h.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? h) : '');
      // подпись «автоматический анализ…» — только под последним уведомлением
      const noFooter = (h) => h.replace(/<p data-cw-footer[^>]*>[\s\S]*?<\/p>/g, '');
      const html = `<!doctype html><html><body style="margin:0;padding:0">${batch.map((m, i) => (i < batch.length - 1 ? noFooter(inner(m.html)) : inner(m.html))).join('<hr style="border:0;border-top:2px solid #d0d7de;margin:18px 0">')}</body></html>`;
      await this.email(`${tags.slice(0, 5).join('')} ${subject}`, text, html, batch.flatMap((m) => m.attachments ?? []));
    }
    if (this.queue.length && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 2000);
      this.timer.unref?.();
    }
  }

  /** Служебное: сразу во все каналы (тест, запуск) */
  async broadcast({ subject, text, html, smsText }) {
    this.log(subject, text);
    await Promise.allSettled([this.email(subject, text, html), smsText ? this.sms(smsText) : Promise.resolve(false)]);
  }

  status() {
    return { ...this.stats, queued: this.queue.length, lastHour: this.sent.filter((t) => Date.now() - t < 3600e3).length };
  }
}
