// Уведомления: почта и SMS (только сигналы ПОКУПКА/ПРОДАЖА).
// • срочные (сигналы) уходят сразу; остальные копятся несколько секунд и приходят одним письмом;
// • ограничение числа писем в час, чтобы не утонуть в почте (срочные проходят всегда);
// • не ушло (почта или Twilio недоступны) — повтор каждые 2 минуты: письма ещё 20 минут, SMS — 10;
// • почта только с шифрованием (STARTTLS обязателен), тема письма очищается от переводов строк.
const RETRY_EVERY = 120e3;
const RETRY_TRIES = { email: 10, sms: 5 };

// в журнале и консоли контакты частично скрыты
export const maskEmail = (s) => String(s).replace(/^(.)([^@]*)(@.*)$/, (m, a, b, c) => `${a}${'*'.repeat(Math.min(Math.max(b.length, 1), 6))}${c}`);
export const maskPhone = (s) => String(s).replace(/^(\+?\d{3})(\d+)(\d{3})$/, (m, a, b, c) => `${a}${'*'.repeat(b.length)}${c}`);
// тема письма — одна строка без управляющих символов (нельзя подставить свои заголовки)
export const cleanSubject = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 200);

export class Notifier {
  constructor(cfg) {
    this.cfg = cfg.notify;
    this.mailer = null;
    this.queue = [];
    this.timer = null;
    this.sent = [];   // время отправленных писем (для лимита в час)
    this.retryQ = []; // не отправленные с первого раза
    this.stats = { emails: 0, sms: 0, errors: 0, lastError: null, lost: 0 };
    this.retryTimer = setInterval(() => { this.runRetries().catch(() => {}); }, 30e3);
    this.retryTimer.unref?.();
  }

  emailReady() { const e = this.cfg.email; return !!(e.to && e.user && e.pass); }
  smsReady() { const s = this.cfg.sms; return !!(s.to && s.from && s.accountSid && s.authToken); }

  channels({ masked = false } = {}) {
    const list = ['консоль'];
    if (this.emailReady()) list.push(`почта ${masked ? maskEmail(this.cfg.email.to) : this.cfg.email.to}`);
    if (this.smsReady()) list.push(`SMS ${masked ? maskPhone(this.cfg.sms.to) : this.cfg.sms.to} (только покупка/продажа)`);
    return list;
  }

  async getMailer() {
    if (this.mailer) return this.mailer;
    const mod = await import('nodemailer');
    const createTransport = mod.createTransport ?? mod.default?.createTransport;
    const e = this.cfg.email;
    const secure = e.port === 465;
    // 465 — сразу TLS; 587 — STARTTLS обязателен (без шифрования письмо и пароль не уйдут)
    // тайм-ауты: зависший почтовый сервер не должен останавливать программу на минуты
    this.mailer = createTransport({ host: e.host, port: e.port, secure, requireTLS: !secure, tls: { minVersion: 'TLSv1.2' }, auth: { user: e.user, pass: e.pass }, connectionTimeout: 20e3, greetingTimeout: 20e3, socketTimeout: 60e3 });
    return this.mailer;
  }

  async sendEmail({ subject, text, html, attachments = [] }) {
    const e = this.cfg.email;
    const mailer = await this.getMailer();
    await mailer.sendMail({ from: e.from || e.user, to: e.to, subject: cleanSubject(subject), text, html, attachments });
    this.sent.push(Date.now());
    this.stats.emails++;
  }

  async email(subject, text, html, attachments = []) {
    if (!this.emailReady()) return false;
    try {
      await this.sendEmail({ subject, text, html, attachments });
      return true;
    } catch (err) {
      this.fail('почта', err);
      this.queueRetry('email', { subject, text, html, attachments });
      return false;
    }
  }

  fail(kind, err) {
    this.stats.errors++;
    this.stats.lastError = `${kind}: ${err.message}`;
    console.error(`[уведомление] ${kind}: ${err.message} — повторю через 2 мин`);
  }

  queueRetry(kind, payload) {
    if (this.retryQ.length >= 50) { this.retryQ.shift(); this.stats.lost++; }
    this.retryQ.push({ kind, payload, tries: 1, next: Date.now() + RETRY_EVERY });
  }

  async runRetries(now = Date.now()) {
    for (const it of [...this.retryQ]) {
      if (it.next > now) continue;
      try {
        if (it.kind === 'email') await this.sendEmail(it.payload); else await this.sendSms(it.payload.text);
        this.retryQ.splice(this.retryQ.indexOf(it), 1);
        console.log(`[уведомление] ${it.kind === 'email' ? 'письмо' : 'SMS'} отправлено с ${it.tries + 1}-й попытки`);
      } catch (err) {
        it.tries++;
        it.next = now + RETRY_EVERY;
        this.stats.lastError = `${it.kind}: ${err.message}`;
        if (it.tries >= RETRY_TRIES[it.kind]) {
          this.retryQ.splice(this.retryQ.indexOf(it), 1);
          this.stats.lost++;
          console.error(`[уведомление] ${it.kind === 'email' ? `письмо «${cleanSubject(it.payload.subject)}»` : 'SMS'} так и не ушло — пропускаю`);
        }
      }
    }
  }

  async sendSms(text) {
    const s = this.cfg.sms;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${s.accountSid}:${s.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: s.to, From: s.from, Body: String(text).slice(0, 160) }),
      signal: AbortSignal.timeout(15e3),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    this.stats.sms++;
  }

  async sms(text) {
    if (!this.smsReady()) return false;
    // дневной лимит SMS: сбой в программе не должен разорить на сообщениях
    const day = new Date().toLocaleDateString('sv-SE');
    if (this.smsDay?.day !== day) this.smsDay = { day, count: 0, warned: false };
    const lim = this.cfg.sms.maxPerDay ?? 20;
    if (lim > 0 && this.smsDay.count >= lim) {
      if (!this.smsDay.warned) { this.smsDay.warned = true; console.error(`[уведомление] SMS: дневной лимит ${lim} исчерпан — до завтра только письма (SMS_MAX_PER_DAY)`); }
      return false;
    }
    this.smsDay.count++;
    try {
      await this.sendSms(text);
      return true;
    } catch (err) {
      this.fail('SMS', err);
      this.queueRetry('sms', { text });
      return false;
    }
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
    return { ...this.stats, queued: this.queue.length, retrying: this.retryQ.length, lastHour: this.sent.filter((t) => Date.now() - t < 3600e3).length };
  }
}
