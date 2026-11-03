import * as cheerio from 'cheerio';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { toLines } from '../core/extract.js';

/**
 * 104 職缺通知信：不爬 104 網站，只讀使用者信箱裡 104 寄來的「職缺通知」信，
 * 從信件內容解析職缺。帳號密碼放環境變數（本機 .env / GitHub Secrets）：
 *   IMAP_USER、IMAP_PASSWORD（Gmail 要用「應用程式密碼」）
 *   IMAP_HOST（預設 imap.gmail.com）、IMAP_PORT（993）、IMAP_MAILBOX（INBOX；all = 所有郵件）
 *   MAIL_FROM（寄件者篩選，預設 104.com.tw）
 */

const JOB_RE = /104\.com\.tw\/job\/([0-9a-z]+)/i;
const COMPANY_LINK_RE = /104\.com\.tw\/company\/([0-9a-z]+)/i;
const BUTTON_RE = /^(立即)?應徵|查看|詳情|更多|看更多|職缺內容|儲存|收藏|不感興趣|取消訂閱|more/i;

const SALARY_RE = /月薪|年薪|時薪|日薪|論件|面議|\d[\d,]*\s*(元|萬)/;
const EXP_RE = /經歷|工作經驗|年以上|經驗不拘/;
const EDU_RE = /學歷|大學|專科|高中|碩士|博士|國中/;
const COMPANY_RE = /公司|企業|集團|銀行|醫院|學校|協會|基金會|事務所|工作室|診所|商行|股份|有限/;

const clean = (s) => String(s ?? '').replace(/[\s͏‌]+/g, ' ').trim();

/** 104 信裡的固定欄位 → 我們的欄位名稱 */
const STRUCTURED = {
  職務類別: '職務類別', 工作待遇: '薪資', 工作性質: '工作性質', 上班地點: '工作地點',
  管理責任: '管理責任', 出差外派: '出差外派', 上班時段: '上班時段', 休假制度: '休假制度',
  可上班日: '可上班日', 需求人數: '需求人數', 工作經歷: '經歷', 學歷要求: '學歷', 科系要求: '科系',
};
/** 像地址的短字串：開頭就是縣市＋鄉鎮市區（「台北市中正區」），或只有縣市（「新竹市」） */
const LOOKS_LIKE_PLACE = /^(臺北|新北|桃園|臺中|臺南|高雄|基隆|新竹|嘉義|苗栗|彰化|南投|雲林|屏東|宜蘭|花蓮|臺東|澎湖|金門|連江)[市縣]([^\s]{1,4}[區鄉鎮市]|$)/;

function hrefJobId(href, re = JOB_RE) {
  let h = String(href ?? '');
  for (let i = 0; i < 3; i++) {
    const m = h.match(re);
    if (m) return m[1];
    try {
      const d = decodeURIComponent(h);
      if (d === h) break;
      h = d;
    } catch {
      break;
    }
  }
  return null;
}

const isTitleAnchor = ($, a) => {
  const t = clean($(a).text());
  return t.length >= 2 && !BUTTON_RE.test(t);
};
const JOB_MARK = '\u0001', COMPANY_MARK = '\u0002';
const APPLY_RE = /^(我要|立即)應徵/;

/**
 * 依信件順序切段：每個職缺 = 從它的標題到下一個職缺標題（或「我要應徵」）之間的行。
 * 「配對日報」把所有職缺放在同一個表格、一個欄位一列，往上找不到只含單一職缺的區塊時用這個。
 * @returns {Map<id, { company, lines }>}
 */
function mailSegments(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    const id = hrefJobId(href);
    if (id && !seen.has(id) && isTitleAnchor($, a)) {
      seen.add(id);
      $(a).prepend(`${JOB_MARK}${id}${JOB_MARK}`);
    } else if (!id && hrefJobId(href, COMPANY_LINK_RE)) {
      $(a).prepend(COMPANY_MARK);
    }
  });
  const segments = new Map();
  let cur = null;
  for (const raw of toLines($, $.root())) {
    const job = raw.match(new RegExp(`${JOB_MARK}(\\w+)${JOB_MARK}`));
    if (job) {
      cur = { company: null, lines: [] };
      segments.set(job[1], cur);
      continue;
    }
    if (!cur) continue;
    const line = clean(raw);
    if (APPLY_RE.test(line)) {
      cur = null;
      continue;
    }
    if (raw.includes(COMPANY_MARK)) cur.company ??= clean(raw.replaceAll(COMPANY_MARK, ''));
    else cur.lines.push(line);
  }
  return segments;
}

/** 解析一封通知信 → 職缺清單 */
export function parseJobMail(html, { date = null, subject = '' } = {}) {
  let segments = null; // 需要時才算
  const $ = cheerio.load(html);
  const jobs = new Map();
  $('a[href]').each((_, a) => {
    const id = hrefJobId($(a).attr('href'));
    if (!id) return;
    if (!jobs.has(id)) jobs.set(id, []);
    jobs.get(id).push(a);
  });

  const mailDate = date ? new Date(date).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 10) : null;
  const items = [];
  for (const [id, anchors] of jobs) {
    const titleA = anchors.find((a) => isTitleAnchor($, a));
    if (!titleA) continue;
    const title = clean($(titleA).text());

    // 往上找：只包含這一個職缺的最大區塊
    let box = $(titleA);
    for (;;) {
      const parent = box.parent();
      if (!parent.length || parent.is('body') || parent.is('html')) break;
      const ids = new Set(parent.find('a[href]').map((_, x) => hrefJobId($(x).attr('href'))).get().filter(Boolean));
      if (ids.size > 1) break;
      box = parent;
    }

    const fields = {};
    const companyA = box.find('a[href]').filter((_, x) => !!hrefJobId($(x).attr('href'), COMPANY_LINK_RE)).first();
    if (companyA.length && clean(companyA.text())) fields['公司'] = clean(companyA.text());

    let lines = toLines($, box).map(clean).filter(Boolean);
    if (lines.every((l) => l === title)) {
      // 區塊裡只有標題（配對日報）：改用信件順序切段
      segments ??= mailSegments(html);
      const seg = segments.get(id);
      if (seg) {
        lines = seg.lines;
        if (!fields['公司'] && seg.company) fields['公司'] = seg.company;
      }
    }
    // 104 固定欄位：「標籤」一行、「值」一行（或「標籤：值」）
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([^：:]{2,6})\s*[：:]?\s*(.*)$/);
      const key = m && STRUCTURED[m[1]];
      if (!key || fields[key]) continue;
      const value = m[2] || lines[i + 1] || '';
      if (value && !STRUCTURED[value]) fields[key] = value.slice(0, 100);
    }
    // 摘要式通知（一行裡有「台北市大安區 | 經歷不拘 | 大學」）：只收短、明確的片段，沒寫就留空不亂猜
    const tokens = lines.flatMap((l) => l.split(/\s*[|｜•·]\s*/)).map(clean)
      .filter((t) => t && t !== title && t.length <= 25 && !BUTTON_RE.test(t));
    for (const t of tokens) {
      if (!fields['薪資'] && SALARY_RE.test(t)) fields['薪資'] = t;
      else if (!fields['經歷'] && EXP_RE.test(t) && !/[：:]$/.test(t)) fields['經歷'] = t;
      else if (!fields['學歷'] && EDU_RE.test(t) && !/[：:]$/.test(t)) fields['學歷'] = t;
      else if (!fields['工作地點'] && LOOKS_LIKE_PLACE.test(t.replace(/台/g, '臺'))) fields['工作地點'] = t;
      else if (!fields['公司'] && COMPANY_RE.test(t)) fields['公司'] = t;
    }
    fields['類型'] = /詢問意願|邀請|面試/.test(subject) ? '企業邀請' : '職缺通知';
    if (mailDate) fields['通知日期'] = mailDate;
    if (subject) fields['信件主旨'] = clean(subject);

    items.push({
      name: fields['公司'] ? `${title}｜${fields['公司']}` : title,
      url: `https://www.104.com.tw/job/${id}`,
      sourceId: id,
      fields,
    });
  }
  return items;
}

async function fetchMails(env, { days, log }) {
  const client = new ImapFlow({
    host: env.IMAP_HOST || 'imap.gmail.com',
    port: Number(env.IMAP_PORT || 993),
    secure: true,
    // Secrets 貼上時常多帶空白或換行
    auth: { user: String(env.IMAP_USER).trim(), pass: String(env.IMAP_PASSWORD).trim() },
    logger: false,
  });
  try {
    await client.connect();
  } catch (err) {
    // imapflow 只會說 Command failed，把伺服器實際回應帶出來（不含帳密）
    const detail = [err.serverResponseCode, err.responseText].filter(Boolean).join(' ');
    throw new Error(`信箱登入失敗${detail ? `：${detail}` : `：${err.message}`}（請確認 IMAP_USER 是完整信箱、IMAP_PASSWORD 是應用程式密碼）`);
  }
  try {
    let mailbox = env.IMAP_MAILBOX || 'INBOX';
    if (mailbox.toLowerCase() === 'all') {
      mailbox = (await client.list()).find((b) => b.specialUse === '\\All')?.path ?? 'INBOX';
    }
    const lock = await client.getMailboxLock(mailbox);
    try {
      const since = new Date(Date.now() - days * 86400_000);
      const uids = (await client.search({ since, from: env.MAIL_FROM || '104.com.tw' }, { uid: true })) || [];
      log?.(`[mail104] ${mailbox}：最近 ${days} 天有 ${uids.length} 封 104 的信`);
      const mails = [];
      if (uids.length) {
        for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
          const parsed = await simpleParser(msg.source);
          mails.push({ html: parsed.html || parsed.textAsHtml || '', date: parsed.date, subject: parsed.subject });
        }
      }
      return mails;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/** 沒辦法用 IMAP 時：讀資料夾裡手動下載的 .eml（Gmail「⋮ → 下載郵件」） */
async function readMailDir(dir, log) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.eml'));
  const mails = [];
  for (const f of files) {
    const parsed = await simpleParser(readFileSync(join(dir, f)));
    if (!/104\.com\.tw/i.test(parsed.from?.text ?? '') && !JOB_RE.test(parsed.html || parsed.text || '')) continue;
    mails.push({ html: parsed.html || parsed.textAsHtml || '', date: parsed.date, subject: parsed.subject });
  }
  log?.(`[mail104] ${dir}：${files.length} 個 .eml，其中 ${mails.length} 封是 104 的信`);
  return mails;
}

const hasEml = (dir) => existsSync(dir) && readdirSync(dir).some((f) => f.toLowerCase().endsWith('.eml'));

export function createMail104Adapter(env = process.env, { mailDir = env.MAIL_DIR || 'mail' } = {}) {
  const imap = !!(env.IMAP_USER && env.IMAP_PASSWORD);
  return {
    id: 'mail104',
    name: '104 職缺通知信',
    baseUrl: 'https://www.104.com.tw',
    volatileFields: ['通知日期', '信件主旨'],
    // MAIL104_CONFIGURED=true：雲端匯出網頁時只需要知道「有設定信箱」，不必拿到信箱密碼
    configured: imap || hasEml(mailDir) || env.MAIL104_CONFIGURED === 'true',

    /** 取代列表分頁：讀信（IMAP 和/或 mail 資料夾）→ 職缺（同一職缺出現在多封信時，以最新一封為準） */
    async collect({ isFirstRun, sinceDays = 3, initialDays = 30, log }) {
      if (!this.configured) {
        throw new Error('尚未設定信箱：請在 .env 設定 IMAP_USER、IMAP_PASSWORD，或把 104 通知信的 .eml 放進 mail 資料夾');
      }
      const mails = [
        ...(imap ? await fetchMails(env, { days: isFirstRun ? initialDays : sinceDays, log }) : []),
        ...(await readMailDir(mailDir, log)),
      ];
      mails.sort((a, b) => new Date(a.date) - new Date(b.date));
      const byId = new Map();
      for (const m of mails) for (const item of parseJobMail(m.html, m)) byId.set(item.sourceId, item);
      return [...byId.values()];
    },
  };
}
