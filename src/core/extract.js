const BLOCK_TAGS = 'p,div,li,tr,td,th,h1,h2,h3,h4,h5,h6,ul,ol,table,section,article,dd,dt,blockquote';

/** 名稱正規化：全形英數/空白轉半形、壓縮空白。用來判斷「同一個活動」 */
export function normalizeName(s) {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** cheerio 元素 → 文字行（依區塊元素斷行） */
export function toLines($, el) {
  const c = $(el).clone();
  c.find('script,style,iframe,noscript').remove();
  c.find('br').replaceWith('\n');
  c.find(BLOCK_TAGS).each((_, n) => {
    $(n).append('\n');
  });
  return c
    .text()
    .split('\n')
    .map((t) => t.replace(/[\s ﻿]+/g, ' ').trim())
    .filter(Boolean);
}

const LABEL_RE = /^([^\s:：，,。、()（）[\]【】"'<>]{1,10})\s*[:：]\s*(.+)$/;

/** 通用「標籤：值」抽取，同一標籤取第一次出現 */
export function labelValues(lines) {
  const out = {};
  for (const line of lines) {
    const m = line.match(LABEL_RE);
    if (!m) continue;
    const label = m[1].replace(/^[^\p{L}\p{N}]+/u, ''); // 去掉「┃活動日期」「■地點」前面的符號
    const value = m[2].trim();
    // 純數字是時間（09:00），不是標籤
    if (!label || /^\d+$/.test(label) || !value || value.startsWith('//') || value.length > 200 || label in out) continue;
    out[label] = value;
  }
  return out;
}

const CITIES = [
  '臺北市', '新北市', '桃園市', '臺中市', '臺南市', '高雄市', '基隆市', '新竹市', '嘉義市',
  '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣',
  '臺東縣', '澎湖縣', '金門縣', '連江縣',
];
const SHORT_CITY = new Map();
for (const c of CITIES) if (!SHORT_CITY.has(c.slice(0, 2))) SHORT_CITY.set(c.slice(0, 2), c);
SHORT_CITY.set('馬祖', '連江縣');

/** 從地點文字推出縣市；線上活動回傳「線上」 */
export function deriveCity(text) {
  if (!text) return null;
  const t = String(text).replace(/台/g, '臺');
  let best = null;
  let bestIdx = Infinity;
  for (const c of CITIES) {
    const i = t.indexOf(c);
    if (i >= 0 && i < bestIdx) [best, bestIdx] = [c, i];
  }
  if (best) return best;
  for (const [short, city] of SHORT_CITY) {
    const i = t.indexOf(short);
    if (i >= 0 && i < bestIdx) [best, bestIdx] = [city, i];
  }
  if (best) return best;
  if (/線上|網路|視訊|直播|online|zoom|google meet|teams|webex/i.test(text)) return '線上';
  return null;
}

/** 衍生欄位由其他欄位推出，不另外算「修改」 */
export const DERIVED_FIELDS = ['縣市'];

/** 加上衍生欄位（目前：從地點/地址推縣市，依序試到推得出來為止） */
export function addDerivedFields(fields) {
  if ('縣市' in fields) return fields;
  const keys = Object.keys(fields);
  const locKeys = [...keys.filter((k) => /地點|場地|地區|工作地/.test(k)), ...keys.filter((k) => /地址/.test(k))];
  for (const k of locKeys) {
    const city = deriveCity(fields[k]);
    if (city) {
      fields['縣市'] = city;
      break;
    }
  }
  return fields;
}
