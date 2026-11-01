import * as cheerio from 'cheerio';
import { labelValues, toLines } from '../core/extract.js';

const BASE = 'https://www.beclass.com';

export default {
  id: 'beclass',
  name: 'BeClass 線上報名',
  baseUrl: BASE,
  /** 每天都會變的欄位：不算「修改」 */
  volatileFields: ['剩餘天數', '尚餘名額', '報名狀態'],

  /** 依最後編修時間排序 → 新增/修改過的活動會排在前面，增量爬取可以提早停 */
  listUrl: (page) => `${BASE}/default.php?name=ShowList&op=ShowRegist&od=lastmod&page=${page}`,

  parseList(html) {
    const $ = cheerio.load(html);
    const items = [];
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
    return { name: $('h1.title').first().text().trim() || null, fields, description };
  },
};
