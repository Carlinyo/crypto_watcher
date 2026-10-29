export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, parse, { tries = 3, timeout = 15000, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': 'crypto-signal-watcher/1.0', Accept: 'application/json', ...headers },
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} — ${url}`);
        err.status = res.status;
        throw err;
      }
      return await parse(res);
    } catch (e) {
      lastErr = e;
      // ошибки клиента (кроме лимита 429) повторять бессмысленно
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) break;
      if (i < tries - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

export const getJSON = (url, opts) => request(url, (r) => r.json(), opts);
export const getText = (url, opts) => request(url, (r) => r.text(), opts);
