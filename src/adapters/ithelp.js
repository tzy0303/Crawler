import * as cheerio from 'cheerio';
import { fetchHtml } from '../core/fetcher.js';

/**
 * IT 邦幫忙：以「主題」為一筆，不是一篇文章一筆。
 * 主題 = 文章的第一個標籤（鐵人賽系列的標籤就是系列名稱），同作者同主題合成一筆；
 * 主題有新文章（最新一篇換了）就算一次「更新」，歷史時間點記下每次有新文章的時間。
 */
const BASE = 'https://ithelp.ithome.com.tw';

function articleLinks(html) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $('a[href*="/articles/"]').each((_, a) => {
    const href = new URL($(a).attr('href'), BASE).href.split('?')[0];
    if (/\/articles\/\d+$/.test(href)) urls.add(href);
  });
  return [...urls];
}

export function parseArticle(html, url) {
  const $ = cheerio.load(html);
  const title = $('.qa-header__title').first().text().trim();
  const tag = $('.qa-header__tagList').first();
  const author = $('.qa-header__info-person').first().text().trim();
  const time = $('.qa-header__info-time').first().attr('title') || $('.qa-header__info-time').first().text().trim();
  return {
    url,
    title,
    topic: tag.text().trim() || null,
    topicUrl: tag.attr('href') ? new URL(tag.attr('href'), BASE).href : null,
    author,
    time,
  };
}

/** 一群文章 → 每個「主題＋作者」一筆 */
export function groupByTopic(articles) {
  const groups = new Map();
  for (const a of articles) {
    const topic = a.topic || a.title; // 沒有標籤的單篇文章自己一筆
    const key = `${topic}｜${a.author}`;
    if (!groups.has(key)) groups.set(key, { topic, topicUrl: a.topicUrl, author: a.author, list: [] });
    groups.get(key).list.push(a);
  }
  return [...groups.values()].map((g) => {
    g.list.sort((x, y) => String(y.time).localeCompare(String(x.time)));
    const latest = g.list[0];
    const day = latest.title.match(/Day\s*0*(\d+)/i)?.[1];
    return {
      name: `${g.topic}（${g.author}）`,
      url: g.topicUrl || latest.url,
      sourceId: null,
      fields: {
        作者: g.author,
        ...(day ? { 進度: `Day ${day}` } : {}),
        最新一篇: latest.title,
        最新文章日期: String(latest.time).slice(0, 10),
        最新文章連結: latest.url,
        本次看到篇數: g.list.length,
      },
    };
  });
}

export default {
  id: 'ithelp',
  name: 'IT 邦幫忙（依主題）',
  baseUrl: BASE,
  // 本次看到篇數每次不同，不算更新；最新一篇換了才算
  volatileFields: ['本次看到篇數'],

  async collect({ isFirstRun, maxPages = 2, initialPages = 2, log }) {
    const pages = isFirstRun ? initialPages : maxPages;
    const urls = new Set();
    for (let page = 1; page <= pages; page++) {
      for (const u of articleLinks(await fetchHtml(`${BASE}/articles?tab=tech&page=${page}`))) urls.add(u);
    }
    const articles = [];
    for (const url of urls) {
      try {
        articles.push(parseArticle(await fetchHtml(url), url));
      } catch (err) {
        log?.(`[ithelp] 文章讀取失敗：${err.message}`);
      }
    }
    const items = groupByTopic(articles.filter((a) => a.title));
    log?.(`[ithelp] ${articles.length} 篇文章 → ${items.length} 個主題`);
    return items;
  },
};
