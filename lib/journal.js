// Журнал сигналов: после каждого сигнала ПОКУПКА/ПРОДАЖА программа сама следит, что было дальше —
// дошла ли цена до цели 1 (половина позиции фиксируется, стоп переносится в безубыток), до цели 2,
// или сработал стоп. По журналу считается статистика: доля успешных сигналов, средний результат в R
// (R — сколько рисков заработано: +2R — прибыль в два раза больше заложенного риска).
import fs from 'node:fs';
import path from 'node:path';

export class Journal {
  constructor(file, cfg) {
    this.file = file;
    this.cfg = cfg.journal;
    this.entries = [];
    this.dirty = false;
    this.lastSave = 0;
    try { this.entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* новый журнал */ }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.entries.slice(-2000)));
      this.dirty = false;
      this.lastSave = Date.now();
    } catch (e) { console.error('Журнал: не удалось сохранить —', e.message); }
  }

  openFor(symbol) { return this.entries.find((e) => e.symbol === symbol && e.status === 'open') ?? null; }

  /** Открыть запись по сигналу. Противоположная открытая сделка закрывается по текущей цене. */
  open(r) {
    const events = [];
    const prev = this.openFor(r.symbol);
    if (prev) {
      if (prev.side === r.plan.dir) return { entry: prev, events };
      events.push(this.close(prev, r.price, 'reversed', Date.now()));
    }
    const p = r.plan;
    const e = {
      id: `${r.symbol}-${Date.now().toString(36)}`,
      symbol: r.symbol, side: p.dir, opened: Date.now(), entry: r.price, zone: p.zone,
      stop: p.stop, initialStop: p.stop, t1: p.t1, t2: p.t2, score: +r.score.toFixed(3), confidence: r.confidence,
      regime: r.regime.key, status: 'open', tp1: false, best: r.price, worst: r.price, result: null, closed: null, why: null,
    };
    this.entries.push(e);
    this.save();
    return { entry: e, events };
  }

  rOf(e, price) {
    const s = e.side === 'BUY' ? 1 : -1;
    const risk = Math.abs(e.entry - e.initialStop) || 1e-12;
    return ((price - e.entry) * s) / risk;
  }

  close(e, price, why, t) {
    const r = this.rOf(e, price);
    e.result = e.tp1 ? +(0.5 * this.rOf(e, e.t1) + 0.5 * r).toFixed(3) : +r.toFixed(3);
    e.status = 'closed'; e.why = why; e.closed = t; e.exit = price;
    return { type: why, entry: e, r: e.result };
  }

  /**
   * Проверить открытые сделки по цене.
   * @param {(symbol:string)=>{hi:number,lo:number,last:number}|null} rangeOf — диапазон цены с прошлой проверки
   */
  update(rangeOf) {
    const out = [];
    const now = Date.now();
    for (const e of this.entries) {
      if (e.status !== 'open') continue;
      const r = rangeOf(e.symbol);
      if (!r) continue;
      const buy = e.side === 'BUY';
      const fav = buy ? r.hi : r.lo, adv = buy ? r.lo : r.hi;
      e.best = buy ? Math.max(e.best, fav) : Math.min(e.best, fav);
      e.worst = buy ? Math.min(e.worst, adv) : Math.max(e.worst, adv);
      this.dirty = true;
      const hitStop = buy ? adv <= e.stop : adv >= e.stop;
      const hitT1 = buy ? fav >= e.t1 : fav <= e.t1;
      const hitT2 = buy ? fav >= e.t2 : fav <= e.t2;
      // если за интервал задеты и стоп, и цель — считаем, что сначала стоп (консервативно)
      if (hitStop) {
        out.push(this.close(e, e.stop, e.trailed ? 'trail' : e.tp1 ? 'breakeven' : 'stop', now));
        continue;
      }
      if (!e.tp1 && hitT1) {
        e.tp1 = true; e.tp1At = now; e.stop = e.entry;
        out.push({ type: 'tp1', entry: e, r: +(0.5 * this.rOf(e, e.t1)).toFixed(3) });
      }
      if (e.tp1 && hitT2) { out.push(this.close(e, e.t2, 'tp2', now)); continue; }
      // цена прошла полпути от цели 1 к цели 2 — подтягиваем стоп к цели 1 (фиксируем прибыль остатка)
      if (e.tp1 && !e.trailed) {
        const mid = e.t1 + (e.t2 - e.t1) / 2;
        if (buy ? fav >= mid : fav <= mid) {
          e.trailed = true; e.stop = e.t1;
          out.push({ type: 'trail', entry: e, r: +this.rOf(e, e.t1).toFixed(3) });
        }
      }
      if (now - e.opened > this.cfg.expireHours * 3600e3) out.push(this.close(e, r.last, 'expired', now));
    }
    // события сохраняем сразу, мелкие изменения (лучшая/худшая цена) — раз в 5 минут
    if (out.length || (this.dirty && now - this.lastSave > 5 * 60e3)) this.save();
    return out;
  }

  stats(days = 30) {
    const since = Date.now() - days * 86400e3;
    const list = this.entries.filter((e) => e.opened >= since);
    const closed = list.filter((e) => e.status === 'closed');
    const wins = closed.filter((e) => e.result > 0.05).length;
    const losses = closed.filter((e) => e.result < -0.05).length;
    const sumR = closed.reduce((s, e) => s + (e.result || 0), 0);
    const gp = closed.filter((e) => e.result > 0).reduce((s, e) => s + e.result, 0);
    const gl = -closed.filter((e) => e.result < 0).reduce((s, e) => s + e.result, 0);
    const bySymbol = {};
    for (const e of closed) {
      const b = (bySymbol[e.symbol] ??= { n: 0, r: 0, wins: 0 });
      b.n++; b.r += e.result || 0; if (e.result > 0.05) b.wins++;
    }
    return {
      days,
      total: list.length,
      open: list.filter((e) => e.status === 'open').length,
      closed: closed.length,
      tp1Rate: list.length ? list.filter((e) => e.tp1).length / list.length : null,
      wins, losses,
      winRate: wins + losses ? wins / (wins + losses) : null,
      avgR: closed.length ? sumR / closed.length : null,
      sumR,
      profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : null,
      bySymbol,
    };
  }

  recent(n = 10) { return this.entries.slice(-n).reverse(); }
}
