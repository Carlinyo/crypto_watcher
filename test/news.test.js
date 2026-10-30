import test from 'node:test';
import assert from 'node:assert/strict';
import { sentiment, classify, parseFeed, decode, NewsService } from '../lib/news.js';
import cfg from '../config.js';

test('Тональность: позитив, негатив, отрицание, домыслы', () => {
  assert.ok(sentiment('Bitcoin surges to record high as ETF inflows jump').s > 0.5);
  assert.ok(sentiment('Exchange hacked, $100M stolen').s < -0.5);
  assert.ok(sentiment('SEC approves spot ETF').s > 0);
  assert.ok(sentiment('SEC has not approved the ETF').s < 0, 'отрицание разворачивает смысл');
  const sure = sentiment('XRP rallies 10%').s, guess = sentiment('Could XRP rally 10%?').s;
  assert.ok(guess < sure, 'домыслы весят меньше фактов');
});

test('События: взлом, делистинг, ETF, листинг', () => {
  assert.ok(classify('Solana DeFi protocol exploited for $12M').some((e) => e.type === 'hack'));
  assert.ok(classify('Binance will delist three tokens').some((e) => e.type === 'delist'));
  assert.ok(classify('SEC sues exchange over unregistered securities').some((e) => e.type === 'regulatory'));
  assert.ok(classify('Spot ETF approved, sees record inflows on debut').some((e) => e.type === 'etf_pos'));
  assert.ok(classify('Coinbase will list ABC token next week').some((e) => e.type === 'listing'));
});

test('Разбор RSS, Atom и Google News (суффикс источника убирается)', () => {
  const rss = '<rss><channel><item><title><![CDATA[Ether &amp; Bitcoin rise]]></title><link>https://a.com/1</link><pubDate>Wed, 29 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Text &#8217;quoted&#x2019;&lt;/p&gt;</description></item></channel></rss>';
  const [r] = parseFeed(rss, { name: 'A', w: 1 });
  assert.equal(r.title, 'Ether & Bitcoin rise');
  assert.equal(r.summary, 'Text ’quoted’');
  assert.equal(r.link, 'https://a.com/1');
  const atom = '<feed><entry><title>Solana upgrade</title><link href="https://b.com/2"/><updated>2026-10-29T10:00:00Z</updated><summary>x</summary></entry></feed>';
  assert.equal(parseFeed(atom, { name: 'B' })[0].link, 'https://b.com/2');
  const g = '<rss><channel><item><title>Dogecoin jumps 12% - CoinDesk</title><link>https://n.g/3</link><pubDate>Wed, 29 Oct 2026 10:00:00 GMT</pubDate><source url="x">CoinDesk</source></item></channel></rss>';
  const gi = parseFeed(g, { name: 'Google News' })[0];
  assert.equal(gi.title, 'Dogecoin jumps 12%');
  assert.equal(gi.source, 'CoinDesk');
  assert.equal(decode('&lt;b&gt;x&lt;/b&gt; &hellip;'), 'x …');
});

test('Анализ по монете: склейка дублей, тикеры-слова не путаются, тревога по взлому', async () => {
  const c = structuredClone(cfg);
  c.news.googleNews = false;
  const ns = new NewsService(c);
  const now = Date.now();
  ns.lastRefresh = now;
  ns.items = [
    { source: 'CoinDesk', sourceWeight: 1, title: 'Solana DeFi protocol drained of $12 million in exploit', summary: '', link: 'l1', time: now - 3600e3 },
    { source: 'The Block', sourceWeight: 1, title: 'Solana DeFi protocol drained of $12 million in an exploit', summary: '', link: 'l2', time: now - 3500e3 },
    { source: 'Decrypt', sourceWeight: 0.9, title: 'Chainlink is the missing link for banks', summary: '', link: 'l3', time: now - 3600e3 },
  ];
  const sol = await ns.analyze('SOLUSDT', 'Solana');
  assert.equal(sol.count, 1, 'две версии одной новости — один сюжет');
  assert.ok(sol.score < 0);
  assert.equal(sol.alerts.length, 1);
  assert.equal(sol.top[0].sources.length, 2);
  const link = await ns.analyze('LINKUSDT', 'Chainlink');
  assert.equal(link.count, 1, 'по LINK находится только новость про Chainlink');
});
