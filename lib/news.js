// 5. Новости и настроение рынка: RSS крупных крипто-изданий, CryptoPanic (по желанию),
// индекс страха и жадности. Тональность считается по словарю ключевых слов.
import { getJSON, getText } from './http.js';
import { clamp } from './indicators.js';

const ALIASES = {
  BTC: ['bitcoin', 'btc'], ETH: ['ethereum', 'ether', 'eth'], SOL: ['solana'],
  BNB: ['bnb', 'bnb chain', 'binance coin'], XRP: ['xrp', 'ripple'], ADA: ['cardano', 'ada'],
  DOGE: ['dogecoin', 'doge'], TON: ['toncoin', 'ton blockchain'], AVAX: ['avalanche', 'avax'],
  LINK: ['chainlink'], DOT: ['polkadot'], LTC: ['litecoin', 'ltc'],
  TRX: ['tron', 'trx'], SUI: ['sui'], PEPE: ['pepe'], SHIB: ['shiba inu', 'shib'],
  XLM: ['stellar', 'xlm'], HBAR: ['hedera', 'hbar'], BCH: ['bitcoin cash', 'bch'],
  NEAR: ['near protocol'], APT: ['aptos'], UNI: ['uniswap'], AAVE: ['aave'], ENA: ['ethena'],
};
// тикеры, совпадающие с обычными английскими словами — по ним новости не ищем
const COMMON_WORDS = new Set(['link', 'dot', 'ton', 'sol', 'near', 'uni', 'one', 'op', 'arb', 'sei', 'ena', 'pol', 'ondo', 'trump', 's', 'ip', 'apt']);

function aliasesFor(base, name) {
  if (ALIASES[base]) return ALIASES[base];
  const out = [];
  if (name) out.push(name.toLowerCase());
  const t = base.toLowerCase();
  if (t.length >= 3 && !COMMON_WORDS.has(t)) out.push(t);
  return out.length ? out : [t];
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARKET_WORDS = ['crypto market', 'cryptocurrenc', 'fed ', 'federal reserve', 'interest rate', 'sec ', 'etf', 'stablecoin', 'regulat'];

const POSITIVE = ['surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'bullish', 'gain', 'gains', 'jump', 'jumps', 'rise', 'rises',
  'rebound', 'record high', 'all-time high', 'ath', 'approve', 'approves', 'approved', 'approval', 'adoption', 'inflow', 'inflows',
  'partnership', 'upgrade', 'breakout', 'accumulat', 'buying', 'institutional', 'launch', 'launches', 'recover', 'outperform', 'rate cut'];
const NEGATIVE = ['crash', 'crashes', 'plunge', 'plunges', 'drop', 'drops', 'fall', 'falls', 'slump', 'tumble', 'tumbles', 'bearish',
  'sell-off', 'selloff', 'dump', 'hack', 'hacked', 'exploit', 'stolen', 'ban', 'bans', 'lawsuit', 'sues', 'sued', 'fraud', 'scam',
  'liquidat', 'outflow', 'outflows', 'delist', 'investigation', 'probe', 'charges', 'bankrupt', 'insolven', 'warning', 'fears',
  'decline', 'declines', 'rate hike', 'reject', 'rejects', 'collapse'];

const countHits = (text, words) => words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);

export function headlineSentiment(text) {
  const t = ` ${text.toLowerCase()} `;
  const p = countHits(t, POSITIVE), n = countHits(t, NEGATIVE);
  return p + n === 0 ? 0 : (p - n) / (p + n);
}

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : ''; };

export function parseRss(xml, source) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return items.map((it) => ({
    source,
    title: tag(it, 'title'),
    summary: tag(it, 'description').slice(0, 400),
    time: Date.parse(tag(it, 'pubDate')) || Date.now(),
  })).filter((x) => x.title);
}

export class NewsService {
  constructor(cfg) {
    this.cfg = cfg.news;
    this.cache = { at: 0, items: [], fng: null };
  }

  async refresh() {
    const c = this.cfg;
    if (Date.now() - this.cache.at < c.refreshMinutes * 60e3) return;
    const feeds = await Promise.allSettled(c.rss.map(async (url) => parseRss(await getText(url, { tries: 2 }), new URL(url).hostname)));
    const items = feeds.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

    let fng = null;
    try {
      const j = await getJSON(c.fearGreedUrl, { tries: 2 });
      fng = { value: +j.data[0].value, label: j.data[0].value_classification };
    } catch { /* недоступно — не страшно */ }

    this.cache = { at: Date.now(), items, fng };
  }

  // CryptoPanic кэшируется по каждой монете, чтобы не упереться в лимиты при 15 монетах
  async cryptoPanic(base) {
    if (!this.cfg.cryptopanicToken) return [];
    this.cpCache ??= new Map();
    const hit = this.cpCache.get(base);
    if (hit && Date.now() - hit.at < this.cfg.refreshMinutes * 60e3) return hit.items;
    const items = await this.fetchCryptoPanic(base);
    this.cpCache.set(base, { at: Date.now(), items });
    return items;
  }

  async fetchCryptoPanic(base) {
    try {
      const j = await getJSON(`${this.cfg.cryptopanicUrl}?auth_token=${this.cfg.cryptopanicToken}&currencies=${base}&public=true`, { tries: 1 });
      return (j.results || []).map((r) => {
        const v = r.votes || {};
        const pos = (v.positive || 0) + (v.liked || 0), neg = (v.negative || 0) + (v.disliked || 0);
        return {
          source: 'cryptopanic', title: r.title, time: Date.parse(r.published_at) || Date.now(),
          votes: pos + neg > 2 ? (pos - neg) / (pos + neg) : null, direct: true,
        };
      });
    } catch { return []; }
  }

  async analyze(symbol, name) {
    if (!this.cfg.enabled) return { score: 0, notes: ['новости отключены'], disabled: true };
    await this.refresh();
    const base = symbol.replace(/(USDT|USDC|FDUSD|BUSD|USD|BTC|ETH)$/, '') || symbol;
    const aliases = aliasesFor(base, name);
    const re = new RegExp(`\\b(${aliases.map(escapeRe).join('|')})\\b`, 'i');
    const cutoff = Date.now() - this.cfg.lookbackHours * 3600e3;

    const pool = [...this.cache.items, ...(await this.cryptoPanic(base))].filter((x) => x.time >= cutoff);
    const seen = new Set();
    let wSum = 0, sSum = 0;
    const scored = [];
    for (const it of pool) {
      const key = it.title.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      const text = `${it.title} ${it.summary || ''}`;
      const direct = it.direct || re.test(text);
      const general = !direct && MARKET_WORDS.some((w) => text.toLowerCase().includes(w));
      if (!direct && !general) continue;
      const s = it.votes ?? headlineSentiment(text);
      const ageH = (Date.now() - it.time) / 3600e3;
      const w = (direct ? 1 : 0.4) * Math.exp(-ageH / 12); // свежие и прямые новости важнее
      wSum += w; sSum += w * s;
      if (s !== 0) scored.push({ ...it, s, w });
    }

    const headlines = wSum ? sSum / wSum : 0;
    const notes = [];
    let score = headlines * Math.min(1, wSum / 2); // мало новостей → меньше уверенности
    notes.push(`новостей по теме за ${this.cfg.lookbackHours}ч: ${seen.size ? scored.length : 0} с окраской, тональность ${headlines >= 0 ? '+' : ''}${headlines.toFixed(2)}`);

    const fng = this.cache.fng;
    if (fng) {
      // контртренд: экстремальный страх — возможность купить, экстремальная жадность — повод фиксировать
      const f = fng.value <= 20 ? 0.6 : fng.value <= 35 ? 0.25 : fng.value >= 80 ? -0.6 : fng.value >= 65 ? -0.25 : 0;
      score = 0.7 * score + 0.3 * f;
      notes.push(`индекс страха и жадности: ${fng.value} (${fng.label})`);
    }

    const top = scored.sort((a, b) => Math.abs(b.s) * b.w - Math.abs(a.s) * a.w).slice(0, 3);
    return { score: clamp(score), notes, top, fng };
  }
}
