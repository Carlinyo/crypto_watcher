// Защита от двух одновременно работающих копий программы: две копии открыли бы каждую сделку дважды
// и слали бы письма вдвойне. Копия, которая работает, раз в 30 с отмечается в data/instance.lock.
// Новая копия ждёт, пока отметка не устареет (2 мин) или старый процесс не завершится.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { writeJsonAtomic, readJson } from './storage.js';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export class InstanceLock {
  constructor(file, { staleMs = 120e3, beatMs = 30e3 } = {}) {
    this.file = file;
    this.staleMs = staleMs;
    this.beatMs = beatMs;
    this.me = { id: crypto.randomUUID(), pid: process.pid, host: os.hostname(), startedAt: Date.now() };
    this.timer = null;
  }

  /** Кто держит блокировку (если она чужая и живая) */
  holder() {
    const h = readJson(this.file, null, { log: () => {} });
    if (!h || h.id === this.me.id) return null;
    if (Date.now() - (h.beat ?? 0) > this.staleMs) return null;            // отметка устарела
    if (h.host === this.me.host) {
      if (h.pid === this.me.pid) return null;                             // прошлая жизнь этого же контейнера/процесса
      if (!alive(h.pid)) return null;                                     // процесс на этом же компьютере уже завершён
    }
    return h;
  }

  tryAcquire() {
    const h = this.holder();
    if (h) return { ok: false, holder: h };
    this.beat();
    this.timer = setInterval(() => this.beat(), this.beatMs);
    this.timer.unref?.();
    return { ok: true };
  }

  beat() {
    try { writeJsonAtomic(this.file, { ...this.me, beat: Date.now() }); } catch { /* диск недоступен — попробуем позже */ }
  }

  release() {
    clearInterval(this.timer);
    try {
      const h = readJson(this.file, null, { log: () => {} });
      if (h?.id === this.me.id) { fs.unlinkSync(this.file); try { fs.unlinkSync(`${this.file}.bak`); } catch { /* нет копии */ } }
    } catch { /* уже нет */ }
  }
}
