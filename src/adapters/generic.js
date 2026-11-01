import * as cheerio from 'cheerio';
import { labelValues, toLines } from '../core/extract.js';

/**
 * 通用 adapter：在網頁上新增網站時用，不用寫程式。
 * cfg = {
 *   id, name,
 *   listUrl: 'https://x.com/list?page={page}'  // 沒有 {page} 就只抓這一頁
 *   linkPattern: 'x.com/event?id=#'             // 活動連結規則：# = 數字、* = 任意一段
 *   fetchDetail: true,                          // 進詳細頁抓欄位
 *   titleSelector, contentSelector,             // 選填 CSS 選擇器
 *   trackDescription: false,                    // 內文變動也算修改
 *   volatileFields: [], maxPages, initialPages, encoding
 * }
 */

const PAGER_TEXT =
  /^[\s[\]«»‹›<>|]*(\d{1,3}|上一頁|下一頁|上頁|下頁|第一頁|最後頁|首頁|末頁|前往.*|next|prev|previous|first|last|more|更多.*|看更多)[\s[\]«»‹›<>|]*$/i;
const NEXT_TEXT = /^[\s[\]«»‹›<>]*(2|下一頁|下頁|next|›|»|>)[\s[\]«»‹›<>]*$/i;
// 西元 2026-11-05 / 2026.11.05 / 2026年11月5日，民國 115/11/05 / 115年11月5日
const DATE_RE = /(?<!\d)(\d{4}|\d{3}|\d{2}(?=\s*年))\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/;

const hexToken = (s) => s.replace(/(?=[0-9a-f]*\d)[0-9a-f]{8,}/gi, '*');
const generalize = (s) => hexToken(s).replace(/\d+/g, '#');

function sortedQuery(u, mapValue = (v) => v) {
  const q = [...u.searchParams].map(([k, v]) => `${k}=${mapValue(v)}`).sort().join('&');
  return q ? `?${q}` : '';
}

/** 連結 → 比對用字串：host + path + 排序後 query */
export const canonical = (href) => {
  const u = new URL(href);
  return u.host + u.pathname + sortedQuery(u);
};

/** 細規則：數字/hex 一般化，例如 www.beclass.com/rid=* 、x.com/event?id=# */
export const linkSignature = (href) => {
  const u = new URL(href);
  return u.host + u.pathname.split('/').map(generalize).join('/') + sortedQuery(u, (v) => (/\d/.test(v) ? generalize(v) : v));
};

/** 粗規則：同一層目錄，例如 x.com/events/*（網址是英文 slug 時用） */
const coarseSignature = (href) => {
  const u = new URL(href);
  const parts = u.pathname.replace(/\/$/, '').split('/');
  if (parts.length < 3) return null;
  return `${u.host}${parts.slice(0, -1).join('/')}/*`;
};

export const patternToRegex = (p) =>
  new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/?&=]+').replace(/#/g, '\\d+')}$`);

export function normalizeDate(s) {
  const m = String(s).match(DATE_RE);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1000) y += 1911; // 民國年
  return `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

const LEADING_DATE_RE =
  /^\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(\s*\([^)]{1,3}\))?(\s*[-~～至]\s*(\d{4}[-/.])?\d{1,2}[-/.]\d{1,2}(\s*\([^)]{1,3}\))?)?\s*/;

/** 連結的活動名稱（去掉開頭黏著的日期區間） */
function anchorTitle($, a) {
  const raw = rawAnchorTitle($, a);
  const stripped = raw.replace(LEADING_DATE_RE, '');
  return stripped.length >= 4 ? stripped : raw;
}

/** title 屬性 → 卡片內的標題元素 → 多行時取最長一行 */
function rawAnchorTitle($, a) {
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const attr = clean($(a).attr('title'));
  if (attr.length >= 4) return attr;
  const heading = clean($(a).find('h1,h2,h3,h4,h5,h6,[class*=title],[class*=name],strong').first().text());
  if (heading.length >= 4) return heading;
  const lines = toLines($, a);
  if (lines.length <= 1) return clean(lines[0]);
  return lines.filter((l) => !DATE_RE.test(l) || l.length > 25).sort((x, y) => y.length - x.length)[0] ?? clean(lines[0]);
}

function collectAnchors($, pageUrl) {
  const out = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href').trim();
    if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) return;
    let url;
    try {
      url = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol)) return;
    url.hash = '';
    const text = anchorTitle($, a);
    if (text.length < 4 || PAGER_TEXT.test(text)) return;
    out.push({ el: a, url: url.href, text });
  });
  return out;
}

/** 分析列表頁：回傳可能的活動連結規則（依可能性排序）與分頁網址樣板 */
export function analyzeListPage(html, pageUrl) {
  const $ = cheerio.load(html);
  const anchors = collectAnchors($, pageUrl);
  const self = linkSignature(pageUrl);
  const groups = new Map();
  for (const a of anchors) {
    for (const sig of [linkSignature(a.url), coarseSignature(a.url)]) {
      if (!sig || sig === self || !/[#*]/.test(sig)) continue;
      if (!groups.has(sig)) groups.set(sig, new Map());
      groups.get(sig).set(a.url, a.text);
    }
  }
  const candidates = [...groups]
    .map(([pattern, urls]) => {
      const texts = [...urls.values()];
      const avgLen = texts.reduce((n, t) => n + t.length, 0) / texts.length;
      return { pattern, count: urls.size, score: urls.size * Math.min(avgLen, 30), samples: texts.slice(0, 5) };
    })
    .filter((c) => c.count >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return { candidates, pageTemplate: suggestPageTemplate($, pageUrl) };
}

/** 找「下一頁 / 2」連結，把頁碼換成 {page} */
function suggestPageTemplate($, pageUrl) {
  let template = null;
  $('a[href]').each((_, a) => {
    if (template || !NEXT_TEXT.test($(a).text())) return;
    let u;
    try {
      u = new URL($(a).attr('href'), pageUrl);
    } catch {
      return;
    }
    for (const [k, v] of u.searchParams) {
      if (v === '2') {
        u.searchParams.set(k, '__PAGE__');
        template = u.href.replace('__PAGE__', '{page}');
        return;
      }
    }
    const parts = u.pathname.split('/');
    const i = parts.lastIndexOf('2');
    if (i > 0) {
      parts[i] = '__PAGE__';
      u.pathname = parts.join('/');
      template = u.href.replace('__PAGE__', '{page}');
    }
  });
  return template;
}

/** 從一段文字行抽欄位，沒有日期欄位就找第一個日期 */
function extractFields(lines) {
  const fields = labelValues(lines);
  for (const [k, v] of Object.entries(fields)) {
    if (/日期|時間/.test(k)) {
      const d = normalizeDate(v);
      if (d) fields[k] = d;
    }
  }
  if (!Object.keys(fields).some((k) => /日期/.test(k))) {
    const d = lines.map(normalizeDate).find(Boolean);
    if (d) fields['日期'] = d;
  }
  return fields;
}

function guessMain($) {
  for (const sel of ['main', 'article', '[role=main]', '#content', '.content', '#main', '.main']) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 50) return el;
  }
  return $('body');
}

export function createGenericAdapter(cfg) {
  const paged = cfg.listUrl.includes('{page}');
  // 沒設定連結規則 / 分頁網址時（例如從雲端網頁只填了網址），抓第 1 頁時自動判斷
  let linkRe = cfg.linkPattern ? patternToRegex(cfg.linkPattern) : null;
  let detectedTemplate = null;
  return {
    id: cfg.id,
    name: cfg.name,
    baseUrl: new URL(cfg.listUrl.replaceAll('{page}', '1')).origin,
    custom: true,
    volatileFields: cfg.volatileFields ?? [],
    encoding: cfg.encoding || 'auto',

    listUrl(page) {
      if (paged) return cfg.listUrl.replaceAll('{page}', String(page));
      if (page === 1) return cfg.listUrl;
      return detectedTemplate ? detectedTemplate.replaceAll('{page}', String(page)) : null;
    },

    /** 自動判斷的結果（給 log 用） */
    detected: () => ({ linkPattern: linkRe?.source ?? null, pageTemplate: detectedTemplate }),

    parseList(html, pageUrl) {
      const $ = cheerio.load(html);
      if (!linkRe || (!paged && !detectedTemplate && pageUrl === cfg.listUrl && cfg.autoPaging !== false)) {
        const analysis = analyzeListPage(html, pageUrl);
        if (!linkRe) {
          const pattern = analysis.candidates[0]?.pattern;
          if (!pattern) return { items: [], totalPages: 1 };
          linkRe = patternToRegex(pattern);
        }
        if (!paged && cfg.autoPaging !== false) detectedTemplate = analysis.pageTemplate;
      }
      const seen = new Set();
      const items = [];
      for (const a of collectAnchors($, pageUrl)) {
        if (seen.has(a.url) || (linkRe && !linkRe.test(canonical(a.url)))) continue;
        seen.add(a.url);
        const box = $(a.el).closest('li,tr,article,.item,.card,.list-item');
        const fields = box.length ? extractFields(toLines($, box).filter((l) => l !== a.text)) : {};
        items.push({ name: a.text, url: a.url, sourceId: null, fields });
      }
      return { items, totalPages: paged || detectedTemplate ? null : 1 };
    },

    parseDetail:
      cfg.fetchDetail === false
        ? null
        : (html) => {
            const $ = cheerio.load(html);
            const main = cfg.contentSelector ? $(cfg.contentSelector).first() : guessMain($);
            const lines = toLines($, main.length ? main : $('body'));
            const fields = extractFields(lines);
            const name = cfg.titleSelector ? $(cfg.titleSelector).first().text().trim() : null;
            return { name, fields, description: cfg.trackDescription ? lines.join('\n').slice(0, 20000) : null };
          },
  };
}
