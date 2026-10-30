// HTTP-запросы с повторами, тайм-аутами и уважением к лимитам (Retry-After).
// Ключи и токены в адресах скрываются в логах и письмах.

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const UA = 'crypto-signal-watcher/2.0 (+https://github.com)';

export class HttpError extends Error {
  constructor(message, status, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// убираем из адреса всё, что похоже на секреты, и длинные списки параметров
export function safeUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/token|key|secret|auth|signature|password/i.test(k)) u.searchParams.set(k, '***');
    }
    const s = u.toString();
    return s.length > 160 ? `${s.slice(0, 157)}…` : s;
  } catch {
    return String(url).slice(0, 160);
  }
}

export async function request(url, { method = 'GET', headers = {}, body, tries = 3, timeout = 15000, parse = 'json' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: AbortSignal.timeout(timeout),
        headers: {
          'User-Agent': UA,
          Accept: parse === 'json' ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*',
          ...headers,
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const ra = Number(res.headers.get('retry-after'));
        throw new HttpError(
          `HTTP ${res.status} — ${safeUrl(url)}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`,
          res.status,
          Number.isFinite(ra) && ra > 0 ? ra : null,
        );
      }
      const data = parse === 'json' ? await res.json() : await res.text();
      return { data, headers: res.headers, status: res.status };
    } catch (e) {
      lastErr = e;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') lastErr = new Error(`тайм-аут ${timeout / 1000} с — ${safeUrl(url)}`);
      const st = e.status;
      // ошибки клиента повторять бессмысленно (кроме 408 и 429); 418 — бан IP на Binance
      if (st && st >= 400 && st < 500 && st !== 408 && st !== 429) break;
      if (i < tries - 1) {
        const wait = e.retryAfter ? Math.min(e.retryAfter * 1000, 60_000) : 1000 * 2 ** i + Math.random() * 400;
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

export const getJSON = async (url, opts) => (await request(url, { ...opts, parse: 'json' })).data;
export const getText = async (url, opts) => (await request(url, { ...opts, parse: 'text' })).data;
