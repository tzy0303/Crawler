import * as cheerio from 'cheerio';
import { labelValues, toLines } from '../core/extract.js';

const BASE = 'https://www.beclass.com';
const TAIPEI_OFFSET = 8 * 3600 * 1000;
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export default {
  id: 'beclass',
  name: 'BeClass 線上報名',
  baseUrl: BASE,
  /**
   * 每天都會變的欄位：不算「修改」。
   * 名額上限：2026-11 改版後列表不再顯示，舊資料有、新資料沒有，列為會變的欄位避免全部被當成「修改」
   */
  volatileFields: ['剩餘天數', '尚餘名額', '報名狀態', '名額上限'],

  /** 依最後編修時間排序 → 新增/修改過的活動會排在前面，增量爬取可以提早停 */
  listUrl: (page) => `${BASE}/default.php?name=ShowList&op=ShowRegist&od=lastmod&page=${page}`,

  parseList(html, _url, { now = Date.now() } = {}) {
    const $ = cheerio.load(html);
    const items = [];
    // 2026-11 改版後的列表：<a class="dsl-row"> 裡有 .dsl-md（11/22）、.dsl-wk（週日 · 2027）、.dsl-t（標題）、
    // .dsl-m（報名到 11/16 · 剩 8 位）、.dsl-b（明天截止、還有 3 天、額滿）
    $('a.dsl-row[href*="rid="]').each((_, a) => {
      const $a = $(a);
      const url = new URL($a.attr('href'), BASE).href;
      const name = $a.find('.dsl-t').text().trim();
      if (!name) return;
      const fields = {};
      const thisYear = new Date(now + TAIPEI_OFFSET).getUTCFullYear();
      // 不是今年的日期網站會寫年份（「1/9 週六 · 2027」「報名到 2027/1/4」），沒寫就是今年
      const md = $a.find('.dsl-md').text().match(/(\d{1,2})\/(\d{1,2})/);
      if (md) fields['活動日期'] = ymd(Number($a.find('.dsl-wk').text().match(/(\d{4})/)?.[1] ?? thisYear), md[1], md[2]);
      const meta = $a.find('.dsl-m').text();
      const badge = $a.find('.dsl-b').text();
      const until = meta.match(/報名到\s*(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})/);
      let days = null;
      if (until) {
        const deadline = Date.UTC(Number(until[1] ?? thisYear), Number(until[2]) - 1, Number(until[3]), 23, 59, 59) - TAIPEI_OFFSET;
        days = Math.round(((deadline - now) / 86_400_000) * 10) / 10;
        if (days >= 0) fields['剩餘天數'] = days;
      } else {
        // 沒寫截止日、只有標籤：「還有 3 天」「明天截止」「今天截止」
        const n = badge.match(/還有\s*(\d+)\s*天/)?.[1] ?? (/今天截止/.test(badge) ? 0 : /明天截止/.test(badge) ? 1 : null);
        if (n != null) fields['剩餘天數'] = Number(n);
      }
      const left = meta.match(/剩\s*(\d+)\s*位/);
      if (left) fields['尚餘名額'] = Number(left[1]);
      const text = `${meta} ${badge}`;
      fields['報名狀態'] = /額滿/.test(text) ? '已額滿' : /已截止|停止報名|報名截止/.test(text) || (days != null && days < 0) ? '已截止' : '報名中';
      items.push({ name, url, sourceId: url.match(/rid=([0-9a-z]+)/i)?.[1] ?? null, fields });
    });
    if (items.length) {
      const pages = $('.dsl-pn').text().match(/\d+\s*\/\s*(\d+)/);
      return { items, totalPages: pages ? Number(pages[1]) : null };
    }
    // 改版前的列表
    $('a.listlink[href*="rid="]').each((_, a) => {
      const $a = $(a);
      const url = new URL($a.attr('href'), BASE).href;
      const name = ($a.attr('title') || $a.text()).trim();
      if (!name) return;
      const small = $a.nextAll('.small').first().text();
      const fields = {};
      const date = small.match(/\((\d{4}-\d{2}-\d{2})\)/);
      if (date) fields['活動日期'] = date[1];
      const days = small.match(/報名期限([\d.]+)天/);
      if (days) fields['剩餘天數'] = Number(days[1]);
      const quota = small.match(/限額(\d+)名/);
      if (quota) fields['名額上限'] = Number(quota[1]);
      const left = small.match(/尚餘(\d+)人/);
      if (left) fields['尚餘名額'] = Number(left[1]);
      fields['報名狀態'] = /截止|額滿/.test(small) ? (small.includes('額滿') ? '已額滿' : '已截止') : '報名中';
      items.push({ name, url, sourceId: url.match(/rid=([0-9a-z]+)/i)?.[1] ?? null, fields });
    });
    const total = $('body').text().match(/共\s*(\d+)\s*頁/);
    return { items, totalPages: total ? Number(total[1]) : null };
  },

  /**
   * 列表頁被擋（雲端主機 IP 常被 BeClass 回 403）時改讀官方 RSS（最新 200 筆）。
   * RSS 沒有地點、類別，所以只用來新增，不拿來判斷修改（partial）。
   */
  fallback: {
    url: `${BASE}/backend.php`,
    parse(xml) {
      const $ = cheerio.load(xml, { xml: true });
      return $('item')
        .map((_, el) => {
          const $el = $(el);
          const name = $el.find('title').text().trim();
          const rid = $el.find('link').text().match(/rid=([0-9a-z]+)/i)?.[1];
          if (!name || !rid) return null;
          const date = $el.find('Date').text().trim();
          return { name, url: `${BASE}/rid=${rid}`, sourceId: rid, fields: date ? { 活動日期: date } : {} };
        })
        .get()
        .filter(Boolean);
    },
  },

  parseDetail(html) {
    const $ = cheerio.load(html);
    const fields = {};
    const date = $('h2.content').first().text().match(/活動日期[:：]\s*(\S.*)/);
    if (date) fields['活動日期'] = date[1].trim();
    const cats = $('a[href*="op=catRank"] button')
      .map((_, b) => $(b).text().trim())
      .get()
      .filter(Boolean);
    // 一個活動可有多個類別 → 存成陣列（排序，避免網站順序變動被當成修改）
    if (cats.length) fields['類別'] = [...new Set(cats)].sort();

    let description = null;
    $('h2.txtbox_div').each((_, h) => {
      const title = $(h).text().trim();
      const box = $(h).nextAll('.txtbox_div02').first().find('.BOXContent').first();
      if (!box.length) return;
      const lines = toLines($, box);
      if (title.startsWith('活動說明')) {
        description = lines.join('\n').slice(0, 20000);
        return;
      }
      // 其他區塊（活動地點資訊…）用通用「標籤：值」抽取，網站有什麼欄位就收什麼
      for (const [k, v] of Object.entries(labelValues(lines))) if (!(k in fields)) fields[k] = v;
    });
    // 沒有「活動地點資訊」區塊時，從活動說明裡找「地點/地址：…」補上
    if (!fields['地點'] && description) {
      const fromDesc = Object.entries(labelValues(description.split('\n'))).find(([k]) => /地點|地址/.test(k));
      if (fromDesc) fields['地點'] = fromDesc[1];
    }
    // 承辦人員帳號（「承辦人員其他活動」連結的 v=）：比對同一筆時當作「公司」，避免不同單位的同名活動被併在一起
    const owner = $('a[href*="op=relation"]').attr('href')?.match(/[?&]v=([^&]+)/)?.[1] ?? null;
    return { name: $('h1.title').first().text().trim() || null, fields, description, owner };
  },
};
