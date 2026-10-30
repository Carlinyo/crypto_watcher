// Кэш с временем жизни: не дёргаем API чаще, чем нужно, параллельные запросы одного ключа
// объединяются, а при ошибке сети возвращается последнее удачное значение (помечается как устаревшее).

export class TTLCache {
  constructor() {
    this.map = new Map();
  }

  /**
   * @param {string} key
   * @param {number} ttlMs   сколько значение считается свежим
   * @param {(prev:any)=>Promise<any>} fn  загрузчик; получает предыдущее значение (для догрузки)
   * @param {{staleMs?:number}} opts  сколько можно отдавать старое значение при ошибке
   */
  async get(key, ttlMs, fn, { staleMs = 6 * 3600e3 } = {}) {
    const now = Date.now();
    let e = this.map.get(key);
    if (e && e.value !== undefined && now - e.at < ttlMs) return e.value;
    if (e?.pending) return e.pending;
    if (!e) { e = { value: undefined, at: 0, error: null, pending: null, stale: false }; this.map.set(key, e); }
    const entry = e;
    entry.pending = (async () => {
      try {
        const v = await fn(entry.value);
        entry.value = v;
        entry.at = Date.now();
        entry.error = null;
        entry.stale = false;
        return v;
      } catch (err) {
        entry.error = err;
        if (entry.value !== undefined && Date.now() - entry.at < staleMs) { entry.stale = true; return entry.value; }
        throw err;
      } finally {
        entry.pending = null;
      }
    })();
    return entry.pending;
  }

  peek(key) { return this.map.get(key)?.value; }
  isStale(key) { return !!this.map.get(key)?.stale; }
  age(key) { const e = this.map.get(key); return e?.at ? Date.now() - e.at : Infinity; }
  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
