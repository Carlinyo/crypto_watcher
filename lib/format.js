// Форматирование чисел, сумм, дат для отчётов и писем

function group(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Цена: точность зависит от величины; тысячи разделяются пробелом
export function fmt(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  let s;
  if (a >= 100) s = p.toFixed(2);
  else if (a >= 1) s = p.toFixed(4);
  else if (a >= 0.01) s = p.toFixed(5);
  else if (a === 0) s = '0';
  else s = p.toFixed(Math.min(14, -Math.floor(Math.log10(a)) + 3)); // 0.0000008911, без «e-7»
  if (a >= 10000) {
    const [i, d] = s.split('.');
    s = group(i) + (d ? `.${d}` : '');
  }
  return s;
}

// 1 сделка, 2 сделки, 5 сделок
export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100, b = a % 10;
  return `${n} ${a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many}`;
}
export const trades = (n) => plural(n, ['сделка', 'сделки', 'сделок']);

// деньги на счёте и итоги сделок — точно: $6 246, $9 992, +$31.27
export function fmtMoney(x, { sign = false } = {}) {
  if (x == null || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  const sg = x < 0 ? '−' : sign && x > 0 ? '+' : '';
  const body = a >= 1000 ? Math.round(a).toLocaleString('ru-RU').replace(/\u00a0|\u202f/g, ' ') : a.toFixed(2);
  return `${sg}$${body}`;
}

// количество монет/контрактов: 293.95, 1 989 000
export function fmtAmount(q) {
  if (!Number.isFinite(q)) return '—';
  return Math.abs(q) >= 1000 ? Math.round(q).toLocaleString('ru-RU').replace(/\u00a0|\u202f/g, ' ') : String(+q.toPrecision(8));
}

export function fmtUsd(x, { sign = false } = {}) {
  if (x == null || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  const sg = x < 0 ? '−' : sign && x > 0 ? '+' : '';
  if (a >= 1e12) return `${sg}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sg}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sg}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sg}$${Math.round(a / 1e3)}K`;
  return `${sg}$${Math.round(a)}`;
}

export function pct(x, digits = 2) {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(digits)}%`;
}

export const sgn = (x, digits = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(digits)}`);

export function fmtDate(ts, { withDate = true } = {}) {
  const d = new Date(ts);
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (!withDate) return t;
  const dd = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return `${dd} ${t}`;
}

export function fmtDuration(ms) {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return r ? `${h} ч ${r} мин` : `${h} ч`;
  return `${Math.round(h / 24)} дн`;
}

export const TF_RU = { m15: '15m', h1: '1h', h4: '4h', d1: '1d' };
export const coinOf = (symbol) => symbol.replace(/(USDT|USDC|FDUSD)$/, '');

// ссылка из внешнего источника (RSS, API) — только http(s); javascript:, data: и прочее отбрасываются
export function safeHref(url) {
  if (!url || typeof url !== 'string' || url.length > 2000) return '';
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch { return ''; }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
