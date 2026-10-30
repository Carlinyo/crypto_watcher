// Поток данных Binance через WebSocket (combined streams) с автоматическим переподключением.
// Спот:     wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/...
// Фьючерсы: wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/!forceOrder@arr
//           (с апреля 2026 рыночные потоки фьючерсов доступны только по пути /market)

export class BinanceStream {
  constructor({ name, base, fallback = [], onMessage, idleMs = 120e3 }) {
    this.name = name;
    this.bases = [base, ...fallback].map((b) => b.replace(/\/+$/, ''));
    this.baseIdx = 0;
    this.base = this.bases[0];
    this.onMessage = onMessage;
    this.idleMs = idleMs;
    this.streams = [];
    this.ws = null;
    this.stopped = false;
    this.attempt = 0;
    this.reconnects = 0;
    this.connectedAt = 0;
    this.lastMsg = 0;
    this.messages = 0;
    this.lastError = null;
    this.timer = null;
  }

  static supported() { return typeof WebSocket !== 'undefined'; }

  setStreams(list) {
    const next = [...new Set(list)].sort();
    if (next.join('/') === this.streams.join('/') && this.ws) return;
    this.streams = next;
    this.connect();
    if (!this.timer) {
      this.timer = setInterval(() => this.watchdog(), 15e3);
      this.timer.unref?.();
    }
  }

  url() { return `${this.base}/stream?streams=${this.streams.join('/')}`; }

  connect() {
    if (this.stopped) return;
    const old = this.ws;
    this.ws = null;
    try { old?.close(); } catch { /* уже закрыт */ }
    if (!this.streams.length) return;

    let ws;
    try { ws = new WebSocket(this.url()); } catch (e) { this.lastError = e.message; this.scheduleReconnect(); return; }
    this.ws = ws;
    this.lastMsg = Date.now();

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.connectedAt = Date.now();
      console.log(`📡 Поток «${this.name}» подключён (${this.streams.length} каналов)`);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMsg = Date.now();
      this.messages++;
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      try { this.onMessage(msg.data ?? msg, msg.stream); } catch (e) { this.lastError = e.message; }
    };
    ws.onerror = (e) => { if (this.ws === ws) this.lastError = e?.message || 'ошибка соединения'; };
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return; // закрыт намеренно
      this.ws = null;
      this.connectedAt = 0;
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.stopped) return;
    // несколько неудач подряд — пробуем запасной адрес
    if (this.attempt >= 2 && this.bases.length > 1) {
      this.baseIdx = (this.baseIdx + 1) % this.bases.length;
      this.base = this.bases[this.baseIdx];
      console.error(`📡 Поток «${this.name}»: переключаюсь на ${this.base}`);
    }
    const delay = Math.min(60e3, 2000 * 2 ** this.attempt++);
    this.reconnects++;
    console.error(`📡 Поток «${this.name}» оборвался, переподключение через ${Math.round(delay / 1000)} с`);
    setTimeout(() => { if (!this.ws && !this.stopped) this.connect(); }, delay).unref?.();
  }

  // поток «завис» или живёт почти сутки (Binance сам рвёт соединения через 24 ч) — переподключаемся
  watchdog() {
    if (this.stopped || !this.streams.length) return;
    const now = Date.now();
    if (this.ws && (now - this.lastMsg > this.idleMs || (this.connectedAt && now - this.connectedAt > 23 * 3600e3))) {
      console.error(`📡 Поток «${this.name}»: ${now - this.lastMsg > this.idleMs ? 'нет данных' : 'плановое обновление соединения'}, переподключаюсь`);
      this.connect();
    }
  }

  connected() { return !!this.ws && this.connectedAt > 0 && Date.now() - this.lastMsg < this.idleMs; }

  status() {
    return {
      name: this.name,
      connected: this.connected(),
      channels: this.streams.length,
      messages: this.messages,
      lastMessageSec: this.lastMsg ? Math.round((Date.now() - this.lastMsg) / 1000) : null,
      reconnects: this.reconnects,
      lastError: this.lastError,
    };
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
