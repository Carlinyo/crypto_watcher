// 5. Новости: RSS крупных крипто-изданий + Google News по каждой монете (+ CryptoPanic по ключу).
// • одинаковые новости из разных источников склеиваются (чем больше изданий — тем важнее);
// • тональность — словарь фраз с весами, учёт отрицаний («not approved»), домыслов («could», «?»);
// • события: взлом, делистинг, иск регулятора, ETF, листинг, банкротство… — важные приходят отдельным письмом.
import { getText, getJSON, safeUrl } from './http.js';
import { safeHref } from './format.js';
import { clamp } from './indicators.js';

// ── словари ─────────────────────────────────────────────────────────────────
const ALIASES = {
  BTC: ['bitcoin', 'btc'], ETH: ['ethereum', 'ether', 'eth'], SOL: ['solana'], BNB: ['bnb', 'bnb chain', 'binance coin'],
  XRP: ['xrp', 'ripple'], ADA: ['cardano', 'ada'], DOGE: ['dogecoin', 'doge'], TON: ['toncoin', 'ton network', 'the open network'],
  AVAX: ['avalanche', 'avax'], LINK: ['chainlink'], DOT: ['polkadot'], LTC: ['litecoin', 'ltc'], TRX: ['tron', 'trx'],
  SUI: ['sui'], PEPE: ['pepe'], SHIB: ['shiba inu', 'shib'], XLM: ['stellar', 'xlm'], HBAR: ['hedera', 'hbar'],
  BCH: ['bitcoin cash', 'bch'], NEAR: ['near protocol'], APT: ['aptos'], UNI: ['uniswap'], AAVE: ['aave'], ENA: ['ethena'],
  HYPE: ['hyperliquid'], ZEC: ['zcash'], XMR: ['monero', 'xmr'], ETC: ['ethereum classic'], ICP: ['internet computer'],
  ARB: ['arbitrum'], OP: ['optimism'], POL: ['polygon'], ATOM: ['cosmos'], FIL: ['filecoin'], TAO: ['bittensor'],
  WLD: ['worldcoin'], ONDO: ['ondo finance'], RENDER: ['render network'], INJ: ['injective'], SEI: ['sei network'], TIA: ['celestia'],
};
const COMMON = new Set(['link', 'dot', 'ton', 'sol', 'near', 'uni', 'one', 'op', 'arb', 'sei', 'ena', 'pol', 'ondo', 'trump', 's',
  'ip', 'apt', 'gas', 'ai', 'vet', 'hot', 'id', 'cake', 'sun', 'win', 'key', 'pay', 'beam', 'flow', 'mask', 'rune']);

const LEX = [
  [/\b(all-time high|record high|new (all-time |record )?high|\bath\b)/, 1.5],
  [/\b(surg(e|es|ed|ing)|soar(s|ed|ing)?|skyrocket(s|ed|ing)?|rocket(s|ed)?|moon(s|ed|ing)?)\b/, 1.2],
  [/\b(rall(y|ies|ied|ying)|jump(s|ed)?|climb(s|ed)?|gain(s|ed)?|rise(s)?|rose|rising|rebound(s|ed)?|recover(s|ed|y)?|bounce(s|d)?|up \d+%)\b/, 0.8],
  [/\b(bullish|breakout|breaks out|uptrend|outperform(s|ed)?|golden cross)\b/, 1.0],
  [/\b(approv(e|es|ed|al)|green ?light(s|ed)?)\b/, 1.2],
  [/\b(adoption|adopt(s|ed)?|integrat(es|ed|ion)|partnership|partners with)\b/, 0.7],
  [/\b(inflow(s)?|record (volume|inflows|demand)|strong(er)? demand|institutional (demand|interest|buying))\b/, 1.0],
  [/\b(accumulat(e|es|ed|ing|ion)|buy(s|ing)? the dip|whales? (buy|accumulat|scoop))/, 0.9],
  [/\b(upgrade(s|d)?|mainnet|launch(es|ed)?)\b/, 0.5],
  [/\b(lists|listing|to list|will list|adds support)\b/, 0.8],
  [/\b(rate cuts?|cuts? rates|dovish|stimulus|easing)\b/, 1.0],
  [/\bshort squeeze\b/, 0.8],
  [/\b(wins?|victory|dismiss(es|ed)? (the )?(lawsuit|case|charges)|settle(s|d|ment))\b/, 0.8],
  [/\b(beats? expectations|reserve|treasury (buys|adds|acquires))\b/, 0.6],
  [/\b(crash(es|ed|ing)?|plung(e|es|ed|ing)|plummet(s|ed|ing)?|tank(s|ed)?|nosedive(s|d)?|bloodbath)\b/, -1.3],
  [/\b(drop(s|ped)?|fall(s|en|ing)?|fell|slump(s|ed)?|slid(e|es)?|tumbl(e|es|ed)|sink(s)?|sank|declin(e|es|ed)|dip(s|ped)?|down \d+%|loses|lost)\b/, -0.8],
  [/\b(sell-?off|dump(s|ed|ing)?|capitulat(e|es|ion)|panic sell)/, -1.1],
  [/\b(bearish|downtrend|breakdown|death cross)\b/, -1.0],
  [/\b(hack(s|ed|er|ers)?|exploit(s|ed)?|drain(s|ed)?|stolen|breach(ed)?|attack(s|ed)?|compromised)\b/, -2.0],
  [/\b(scam|fraud|ponzi|rug ?pull)\b/, -1.8],
  [/\b(lawsuit|sues|sued|indict(s|ed|ment)?|subpoena|probe|investigat(e|es|ion)|charged|charges)\b/, -1.3],
  [/\b(ban(s|ned)?|crackdown|restrict(s|ion|ions)?)\b/, -1.2],
  [/\b(delist(s|ed|ing)?)\b/, -2.0],
  [/\b(outflow(s)?)\b/, -1.0],
  [/\b(liquidat(ed|ion|ions))\b/, -0.7],
  [/\b(bankrupt(cy)?|insolven(t|cy)|collapse(s|d)?|halt(s|ed)? withdrawals|suspend(s|ed)? withdrawals)\b/, -2.2],
  [/\b(reject(s|ed|ion)?|den(y|ies|ied)|delay(s|ed)?|postpone(s|d)?)\b/, -0.9],
  [/\b(rate hikes?|hikes? rates|hawkish|recession|tariffs?)\b/, -0.8],
  [/\b(fears?|panic|uncertainty|concerns?|worr(y|ies|ied)|warn(s|ing|ed)?)\b/, -0.6],
  [/\b(token unlock(s)?|unlocks?)\b/, -0.6],
  [/\b(depeg(s|ged)?)\b/, -1.8],
  [/\b(fined|fines|penalt(y|ies))\b/, -0.8],
  [/\b(underperform(s|ed)?)\b/, -0.6],
];
const NEGATORS = /\b(not|no|never|without|denies|denied|despite|fails? to|unlikely|won't|isn't|aren't|wasn't|doesn't|didn't|rules out)\s+(\w+\s+){0,2}$/;
const SPECULATIVE = /\b(price prediction|predicts?|could|might|may|forecast|analysts? (say|says|predict)|expects?|eyes|targets?|if)\b|\?/;
const INTENSIFIER = /\b(massive|record|biggest|huge|historic|largest|unprecedented)\b/;

const EVENTS = [
  { type: 'hack', re: /\b(hack(ed|er|ers)?|exploit(ed)?|drain(ed)?|stolen|breach(ed)?|compromised)\b/, impact: -3, alert: true, label: 'Взлом / эксплойт' },
  { type: 'delist', re: /\bdelist(s|ed|ing)?\b/, impact: -3, alert: true, label: 'Делистинг' },
  { type: 'bankruptcy', re: /\b(bankrupt(cy)?|insolven|halt(s|ed)? withdrawals|suspend(s|ed)? withdrawals)\b/, impact: -3, alert: true, label: 'Банкротство / остановка вывода' },
  { type: 'depeg', re: /\bdepeg/, impact: -2.5, alert: true, label: 'Потеря привязки стейблкоина', market: true },
  { type: 'regulatory', re: /\b(sec|cftc|doj|regulators?|authorities|government)\b[^.]{0,60}\b(sue|sues|sued|charges?|lawsuit|subpoena|ban(s|ned)?|crackdown)\b|\b(indicted|arrested)\b/, impact: -2.5, alert: true, label: 'Действия регуляторов' },
  { type: 'etf_pos', re: /\betfs?\b[^.]{0,60}\b(approv|green ?light|launch|record inflows?|debut)/, impact: 2.5, alert: true, label: 'ETF: одобрение / приток' },
  { type: 'etf_neg', re: /\betfs?\b[^.]{0,60}\b(reject|den(y|ies|ied)|delay|outflows?)/, impact: -2, alert: true, label: 'ETF: отказ / отток' },
  { type: 'listing', re: /\b(binance|coinbase|upbit|robinhood|okx|bybit|kraken)\b[^.]{0,50}\b(will list|lists|to list|adds|listing)\b|\b(will list|listing on)\b[^.]{0,40}\b(binance|coinbase|upbit|robinhood|okx|kraken)\b/, impact: 2, alert: true, label: 'Листинг на крупной бирже' },
  { type: 'unlock', re: /\b(token unlock|unlocks? \$?\d|vesting)\b/, impact: -1.2, alert: false, label: 'Разблокировка токенов' },
  { type: 'upgrade', re: /\b(mainnet|hard ?fork|network upgrade|upgrade goes live)\b/, impact: 1, alert: false, label: 'Обновление сети' },
  { type: 'adoption', re: /\b(partnership|partners with|treasury|buys? (more )?(bitcoin|btc|eth|ether|sol)|adds .* to (its )?balance sheet)\b/, impact: 1.2, alert: false, label: 'Принятие / покупки компаний' },
  { type: 'macro_dovish', re: /\b(rate cuts?|cuts? rates|dovish|inflation (cools|eases|falls|slows))\b/, impact: 1.5, alert: false, label: 'Макро: смягчение', market: true },
  { type: 'macro_hawkish', re: /\b(rate hikes?|hikes? rates|hawkish|inflation (rises|jumps|hot|accelerat))\b/, impact: -1.5, alert: false, label: 'Макро: ужесточение', market: true },
];
const MARKET_WORDS = /\b(crypto market|cryptocurrenc|crypto stocks|digital assets|fed|federal reserve|fomc|powell|interest rates?|cpi|inflation|sec|stablecoin|etf|risk assets|liquidations)\b/;

// ── разбор RSS/Atom ────────────────────────────────────────────────────────
const ENT = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
export function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/<[^>]+>/g, ' ') // теги, закодированные как &lt;p&gt;
    .replace(/\s+/g, ' ')
    .trim();
}
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};
const linkOf = (xml) => {
  const t = xml.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (t && decode(t[1]).startsWith('http')) return decode(t[1]);
  const a = xml.match(/<link[^>]*href="([^"]+)"/i);
  return a ? a[1].replace(/&amp;/g, '&') : '';
};

export function parseFeed(xml, source) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((it) => {
    const date = tag(it, 'pubDate') || tag(it, 'dc:date') || tag(it, 'published') || tag(it, 'updated');
    let title = tag(it, 'title');
    let src = source.name;
    const gsrc = tag(it, 'source');
    if (gsrc) { src = gsrc; title = title.replace(new RegExp(`\\s+-\\s+${gsrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''); }
    return {
      source: src,
      sourceWeight: source.w ?? 0.7,
      title,
      summary: (tag(it, 'description') || tag(it, 'summary') || tag(it, 'content:encoded')).slice(0, 500),
      link: safeHref(linkOf(it)),
      time: Date.parse(date) || Date.now(),
    };
  }).filter((x) => x.title && x.title.length > 8);
}

// ── тональность ────────────────────────────────────────────────────────────
export function sentiment(text) {
  const t = ` ${String(text).toLowerCase()} `;
  let raw = 0;
  const hits = [];
  for (const [re, w] of LEX) {
    const g = new RegExp(re.source, 'g');
    let m;
    while ((m = g.exec(t))) {
      const before = t.slice(Math.max(0, m.index - 40), m.index);
      const neg = NEGATORS.test(before);
      raw += neg ? -0.5 * w : w;
      hits.push(neg ? `не ${m[0]}` : m[0]);
      if (g.lastIndex === m.index) g.lastIndex++;
    }
  }
  if (INTENSIFIER.test(t)) raw *= 1.25;
  if (SPECULATIVE.test(t)) raw *= 0.6;
  return { s: Math.tanh(raw / 1.5), raw, hits };
}

export function classify(text) {
  const t = String(text).toLowerCase();
  return EVENTS.filter((e) => e.re.test(t));
}

// ── склейка дублей ─────────────────────────────────────────────────────────
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'as', 'is', 'at', 'by', 'with', 'from', 'its', 'after', 'over', 'amid', 'this', 'that', 'be', 'are', 'it']);
const tokens = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9$%. ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };

function clusterItems(items) {
  const clusters = [];
  for (const it of items.sort((a, b) => a.time - b.time)) {
    const tk = tokens(it.title);
    let best = null, bestJ = 0;
    for (const c of clusters) {
      if (Math.abs(c.time - it.time) > 36 * 3600e3) continue;
      const j = jaccard(tk, c.tk);
      if (j > bestJ) { bestJ = j; best = c; }
    }
    if (best && bestJ >= 0.5) {
      best.items.push(it);
      best.sources.add(it.source);
      if (it.sourceWeight > best.lead.sourceWeight) best.lead = it;
    } else clusters.push({ tk, time: it.time, items: [it], sources: new Set([it.source]), lead: it });
  }
  return clusters;
}

const hashOf = (s) => { let h = 0; for (const ch of s.toLowerCase().replace(/[^a-z0-9]/g, '')) h = (h * 31 + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };

// ── сервис ─────────────────────────────────────────────────────────────────
export class NewsService {
  constructor(cfg) {
    this.cfg = cfg.news;
    this.items = [];            // общие ленты
    this.byCoin = new Map();    // base → { at, items } (Google News, CryptoPanic)
    this.feedHealth = new Map(); // url → { ok, fails, lastOk, lastError, nextTry, count }
    this.lastRefresh = 0;
    this.refreshing = null;
  }

  async fetchFeed(src) {
    const h = this.feedHealth.get(src.url) ?? { fails: 0, nextTry: 0 };
    if (Date.now() < h.nextTry) return [];
    try {
      const xml = await getText(src.url, { tries: 2, timeout: 15000, maxBytes: 4e6 });
      const items = parseFeed(xml, src);
      if (!items.length && !/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new Error('ответ не похож на RSS-ленту');
      this.feedHealth.set(src.url, { name: src.name, ok: true, fails: 0, lastOk: Date.now(), count: items.length, nextTry: 0 });
      return items;
    } catch (e) {
      const fails = (h.fails || 0) + 1;
      this.feedHealth.set(src.url, { name: src.name, ok: false, fails, lastOk: h.lastOk, lastError: e.message, nextTry: Date.now() + Math.min(6 * 3600e3, 2 ** fails * 60e3) });
      return [];
    }
  }

  async refresh() {
    if (Date.now() - this.lastRefresh < this.cfg.refreshMinutes * 60e3) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const res = await Promise.all(this.cfg.rss.map((s) => this.fetchFeed(s)));
      const cutoff = Date.now() - 48 * 3600e3;
      this.items = res.flat().filter((x) => x.time >= cutoff);
      this.lastRefresh = Date.now();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async coinNews(base, name) {
    const c = this.cfg;
    const cached = this.byCoin.get(base);
    if (cached && Date.now() - cached.at < c.perCoinMinutes * 60e3) return cached.items;
    const out = [];
    if (c.googleNews) {
      const q = `${name && name.toLowerCase() !== base.toLowerCase() ? `"${name}"` : base} crypto when:1d`;
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      out.push(...(await this.fetchFeed({ url, name: 'Google News', w: 0.75 })).map((x) => ({ ...x, viaSearch: true })));
    }
    if (c.cryptopanicToken) {
      try {
        const j = await getJSON(`${c.cryptopanicUrl}?auth_token=${c.cryptopanicToken}&currencies=${base}&public=true`, { tries: 1 });
        for (const r of j.results || []) {
          const v = r.votes || {};
          const pos = (v.positive || 0) + (v.liked || 0), neg = (v.negative || 0) + (v.disliked || 0);
          out.push({ source: r.source?.title || 'CryptoPanic', sourceWeight: 0.8, title: r.title, summary: r.description || '', link: safeHref(r.original_url || r.url || ''),
            time: Date.parse(r.published_at) || Date.now(), votes: pos + neg > 2 ? (pos - neg) / (pos + neg) : null, viaSearch: true });
        }
      } catch (e) { this.feedHealth.set('cryptopanic', { name: 'CryptoPanic', ok: false, lastError: safeUrl(e.message) }); }
    }
    this.byCoin.set(base, { at: Date.now(), items: out });
    return out;
  }

  aliasesFor(base, name) {
    if (ALIASES[base]) return ALIASES[base];
    const out = [];
    if (name) out.push(name.toLowerCase());
    const t = base.toLowerCase();
    if (t.length >= 3 && !COMMON.has(t)) out.push(t);
    return out.length ? out : [t];
  }

  /**
   * Анализ новостей по монете.
   * @returns {{score:number, items:Array, notes:string[], top:Array, alerts:Array, count:number}}
   */
  async analyze(symbol, name) {
    if (!this.cfg.enabled) return { score: 0, items: [], notes: ['новости отключены'], top: [], alerts: [], disabled: true };
    await this.refresh();
    const base = symbol.replace(/(USDT|USDC|FDUSD)$/, '');
    let coinItems = [];
    try { coinItems = await this.coinNews(base, name); } catch { /* не критично */ }
    const aliases = this.aliasesFor(base, name);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9])(\\$?(${aliases.map(esc).join('|')}))([^a-z0-9]|$)`, 'i');
    const now = Date.now();
    const cutoff = now - this.cfg.lookbackHours * 3600e3;

    const pool = [];
    for (const it of [...this.items, ...coinItems]) {
      if (it.time < cutoff || it.time > now + 3600e3) continue;
      const inTitle = re.test(it.title);
      const inBody = !inTitle && re.test(it.summary || '');
      const direct = inTitle || inBody || it.viaSearch;
      const market = !direct && MARKET_WORDS.test(`${it.title} ${it.summary}`.toLowerCase());
      if (!direct && !market) continue;
      pool.push({ ...it, rel: inTitle ? 1 : it.viaSearch ? 0.8 : inBody ? 0.6 : base === 'BTC' ? 0.6 : 0.35, direct });
    }
    const clusters = clusterItems(pool);

    let wSum = 0, sSum = 0;
    const scored = [];
    const alerts = [];
    for (const cl of clusters) {
      const lead = cl.lead;
      const text = `${lead.title}. ${lead.summary || ''}`;
      const sTitle = sentiment(lead.title), sBody = sentiment(lead.summary || '');
      let s = lead.votes ?? clamp(0.75 * sTitle.s + 0.25 * sBody.s);
      const events = classify(lead.title).length ? classify(lead.title) : classify(text);
      for (const e of events) s = clamp(s + (e.impact / 3) * 0.5);
      const ageH = Math.max(0, (now - cl.time) / 3600e3);
      const decay = 0.5 ** (ageH / this.cfg.halfLifeHours);
      const coverage = Math.min(2, 1 + 0.25 * (cl.sources.size - 1));
      const rel = Math.max(...cl.items.map((x) => x.rel));
      const w = rel * decay * coverage * lead.sourceWeight;
      wSum += w; sSum += w * s;
      const entry = { title: lead.title, link: lead.link, source: lead.source, sources: [...cl.sources], time: cl.time, s, w, events: events.map((e) => e.label), direct: cl.items.some((x) => x.direct) };
      if (Math.abs(s) > 0.05 || events.length) scored.push(entry);
      const alertEv = events.find((e) => e.alert && (entry.direct || e.market));
      if (alertEv && ageH <= 3 && rel >= 0.6) alerts.push({ ...entry, id: hashOf(lead.title), event: alertEv.label, impact: alertEv.impact });
    }

    const tone = wSum ? sSum / wSum : 0;
    const confidence = wSum / (wSum + 1.5);
    const score = clamp(tone * confidence * 1.2);
    const top = scored.sort((a, b) => Math.abs(b.s) * b.w - Math.abs(a.s) * a.w).slice(0, 5);
    const items = top.slice(0, 3).map((t) => ({ text: `${t.direct ? 'Новость' : 'Новость рынка'}: «${t.title}» (${t.sources.slice(0, 2).join(', ')}${t.sources.length > 2 ? ` +${t.sources.length - 2}` : ''})`, s: t.s * Math.min(1, t.w) * 0.3 }));
    const notes = [`новостей по теме за ${this.cfg.lookbackHours} ч: ${clusters.length} (с окраской ${scored.length}), общий тон ${tone >= 0 ? '+' : ''}${tone.toFixed(2)}`];
    return { score, tone, confidence, items, notes, top, alerts, count: clusters.length };
  }

  status() {
    return [...this.feedHealth.values()].map((h) => ({ name: h.name, ok: h.ok, items: h.count ?? 0, fails: h.fails ?? 0, lastError: h.lastError ?? null }));
  }
}
