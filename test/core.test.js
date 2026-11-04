import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import beclass from '../src/adapters/beclass.js';
import { deriveCity, labelValues, normalizeName } from '../src/core/extract.js';
import { upsertEvent } from '../src/core/differ.js';
import { getSiteFields, inferType, recomputeSiteFields } from '../src/core/fields.js';
import { openDb } from '../src/core/store.js';
import { runCrawl } from '../src/core/crawler.js';
import { analyzeListPage, createGenericAdapter, normalizeDate } from '../src/adapters/generic.js';
import { createMail104Adapter, parseJobMail } from '../src/adapters/mail104.js';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('beclass parseList', () => {
  const { items, totalPages } = beclass.parseList(fixture('beclass-list.html'));
  assert.equal(items.length, 20);
  assert.ok(totalPages > 1);
  for (const it of items) {
    assert.ok(it.name && it.url.startsWith('https://www.beclass.com/rid='));
    assert.ok(it.sourceId);
  }
  const withQuota = items.find((i) => '名額上限' in i.fields);
  assert.equal(typeof withQuota.fields['名額上限'], 'number');
});

test('beclass parseDetail 抓到地點、類別、活動日期、說明', () => {
  const d = beclass.parseDetail(fixture('beclass-detail.html'));
  assert.match(d.name, /馬頭山/);
  assert.equal(d.fields['活動日期'], '2026-11-15');
  assert.deepEqual(d.fields['類別'], ['課程/講座']);
  assert.match(d.fields['地點'], /高雄市內門區/);
  assert.match(d.description, /^活動說明/);
});

test('normalizeName / deriveCity / labelValues', () => {
  assert.equal(normalizeName('  ＡＢＣ　活動  2026 '), 'ABC 活動 2026');
  assert.equal(deriveCity('845台灣高雄市內門區'), '高雄市');
  assert.equal(deriveCity('台北 大安森林公園'), '臺北市');
  assert.equal(deriveCity('Google Meet 線上'), '線上');
  assert.deepEqual(labelValues(['地點：台中', 'https://x.com', '時間: 10:00', '地點：別處']), { 地點: '台中', 時間: '10:00' });
});

test('inferType', () => {
  assert.equal(inferType(['2026-01-01', '2026-02-03']), 'date');
  assert.equal(inferType([1, 2.5, 30]), 'number');
  assert.equal(inferType(['講座', '講座', '戶外', '講座']), 'enum');
  assert.equal(inferType([['講座', '付費'], ['戶外']]), 'tags');
});

test('用名稱判斷：新增 → 相同 → 只變動欄位不算修改 → 修改寫歷史', () => {
  const db = openDb(':memory:');
  const volatile = ['尚餘名額'];
  const ev = { name: '健行 A', url: 'u1', fields: { 地點: '台北', 尚餘名額: 5 }, description: 'd' };
  assert.equal(upsertEvent(db, 's', ev, { volatile }), 'new');
  assert.equal(upsertEvent(db, 's', ev, { volatile }), 'same');
  assert.equal(upsertEvent(db, 's', { ...ev, name: '健行　A', fields: { 地點: '台北', 尚餘名額: 1 } }, { volatile }), 'same');
  assert.equal(upsertEvent(db, 's', { ...ev, fields: { 地點: '新竹', 尚餘名額: 1 } }, { volatile }), 'updated');
  const row = db.prepare('SELECT * FROM events').get();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
  assert.ok(row.updated_at >= row.created_at);
  const hist = db.prepare('SELECT changes_json FROM event_history').all();
  assert.equal(hist.length, 1);
  assert.deepEqual(JSON.parse(hist[0].changes_json), { 地點: { from: '台北', to: '新竹' } });
});

test('動態欄位：只有出現率夠高的欄位可篩選', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 10; i++) {
    const fields = { 類別: i % 2 ? '講座' : '戶外', 活動日期: `2026-11-${10 + i}` };
    if (i === 0) fields['雜項'] = 'x';
    upsertEvent(db, 's', { name: `e${i}`, fields });
  }
  recomputeSiteFields(db, 's');
  const f = Object.fromEntries(getSiteFields(db, 's').map((x) => [x.key, x]));
  assert.equal(f['類別'].type, 'enum');
  assert.equal(f['活動日期'].type, 'date');
  assert.ok(!('雜項' in f));
});

test('runCrawl 用 fixture 跑兩次：第二次 0 新增 0 修改', async () => {
  const db = openDb(':memory:');
  const list = fixture('beclass-list.html');
  const detail = fixture('beclass-detail.html');
  const fetch = async (url) => (url.includes('ShowList') ? (url.endsWith('page=1') ? list : '<html></html>') : detail);
  const opts = { fetch, log: () => {}, maxPages: 3, initialPages: 3 };
  const r1 = await runCrawl(db, beclass, opts);
  assert.equal(r1.newCount, 20);
  const r2 = await runCrawl(db, beclass, opts);
  assert.equal(r2.newCount, 0);
  assert.equal(r2.updatedCount, 0);
  assert.ok(getSiteFields(db, 'beclass', { all: true }).some((f) => f.key === '縣市'));
});

test('通用 adapter：自動分析連結規則與分頁，解析列表', () => {
  const url = 'https://www.beclass.com/default.php?name=ShowList&op=ShowRegist&od=lastmod&page=1';
  const html = fixture('beclass-list.html');
  const { candidates, pageTemplate } = analyzeListPage(html, url);
  assert.equal(candidates[0].pattern, 'www.beclass.com/rid=*');
  assert.match(pageTemplate, /page=\{page\}$/);
  const ad = createGenericAdapter({ id: 'g', name: 'g', listUrl: pageTemplate, linkPattern: candidates[0].pattern });
  assert.equal(ad.listUrl(3).endsWith('page=3'), true);
  const { items } = ad.parseList(html, url);
  assert.equal(items.length, 20);
  assert.ok(items.every((i) => i.url.includes('/rid=')));
});

test('通用 adapter：卡片式連結取標題、去掉開頭日期；標籤去符號', () => {
  const html = `<ul>${[1, 2, 3].map((i) => `<li><a href="/event/${i}"><span>2026.10.3${i} - 2026.11.01</span><h3>2026.10.3${i} - 2026.11.01活動名稱${i}號</h3><p>東2館</p></a></li>`).join('')}</ul>`;
  const { candidates } = analyzeListPage(html, 'https://x.com/list');
  assert.equal(candidates[0].pattern, 'x.com/event/#');
  const ad = createGenericAdapter({ id: 'g', name: 'g', listUrl: 'https://x.com/list', linkPattern: candidates[0].pattern });
  assert.deepEqual(ad.parseList(html, 'https://x.com/list').items.map((i) => i.name), ['活動名稱1號', '活動名稱2號', '活動名稱3號']);
  assert.deepEqual(labelValues(['┃活動地點：華山']), { 活動地點: '華山' });
  assert.equal(normalizeDate('115年11月5日'), '2026-11-05');
});

test('通用 adapter：只填網址（雲端新增）時，抓取當下自動判斷連結規則與分頁', () => {
  const url = 'https://www.beclass.com/default.php?name=ShowList&op=ShowRegist&od=lastmod';
  const ad = createGenericAdapter({ id: 'g', name: 'g', listUrl: url });
  assert.equal(ad.listUrl(1), url);
  const { items, totalPages } = ad.parseList(fixture('beclass-list.html'), url);
  assert.equal(items.length, 20);
  assert.equal(totalPages, null);
  assert.match(ad.listUrl(2), /od=lastmod&page=2$/);
});

const MAIL_HTML = `<html><body><table>
  <tr><td>您訂閱的「行銷企劃」有 2 個新職缺</td></tr>
  <tr><td><table><tr><td>
    <a href="https://www.104.com.tw/job/7abcd?jobsource=mail_alert">行銷企劃專員</a><br>
    <a href="https://www.104.com.tw/company/1a2b3c">好棒棒股份有限公司</a><br>
    台北市大安區 | 經歷不拘 | 大學<br>月薪 35,000~45,000元<br>
    <a href="https://www.104.com.tw/job/7abcd?jobsource=mail_apply">立即應徵</a>
  </td></tr></table></td></tr>
  <tr><td><table><tr><td>
    <a href="https://click.example.com/r?u=https%3A%2F%2Fwww.104.com.tw%2Fjob%2F8efgh%3Fjobsource%3Dmail">數位行銷企劃</a>
    <p>高雄市前鎮區</p><p>2年以上</p><p>待遇面議</p><p>某某企業社</p>
  </td></tr></table></td></tr>
</table></body></html>`;

test('104 通知信：解析職缺、公司、地區、薪資、經歷、學歷', () => {
  const items = parseJobMail(MAIL_HTML, { date: '2026-11-01T01:00:00Z', subject: '104 職缺通知' });
  assert.equal(items.length, 2);
  const [a, b] = items;
  assert.equal(a.name, '行銷企劃專員｜好棒棒股份有限公司');
  assert.equal(a.url, 'https://www.104.com.tw/job/7abcd');
  assert.equal(a.fields['工作地點'], '台北市大安區');
  assert.equal(a.fields['經歷'], '經歷不拘');
  assert.equal(a.fields['學歷'], '大學');
  assert.equal(a.fields['薪資'], '月薪 35,000~45,000元');
  assert.equal(a.fields['通知日期'], '2026-11-01');
  assert.equal(b.sourceId, '8efgh'); // 追蹤轉址裡編碼過的連結也找得到
  assert.equal(b.name, '數位行銷企劃｜某某企業社');
  assert.equal(b.fields['薪資'], '待遇面議');
  assert.equal(b.fields['經歷'], '2年以上');
});

test('collect 型來源（通知信）：新增 → 同一職缺改薪資算修改，通知日期變動不算', async () => {
  const db = openDb(':memory:');
  let batch = [{ name: '工程師｜A 公司', url: 'u', sourceId: '1', fields: { 薪資: '月薪 4萬', 工作地點: '新竹市', 通知日期: '2026-11-01' } }];
  const adapter = { id: 'mail104', name: 'm', baseUrl: 'x', volatileFields: ['通知日期'], collect: async () => batch };
  const r1 = await runCrawl(db, adapter, { log: () => {} });
  assert.equal(r1.newCount, 1);
  batch = [{ ...batch[0], fields: { ...batch[0].fields, 通知日期: '2026-11-02' } }];
  assert.equal((await runCrawl(db, adapter, { log: () => {} })).updatedCount, 0);
  batch = [{ ...batch[0], fields: { ...batch[0].fields, 薪資: '月薪 5萬' } }];
  assert.equal((await runCrawl(db, adapter, { log: () => {} })).updatedCount, 1);
  assert.equal(JSON.parse(db.prepare('SELECT fields_json FROM events').get().fields_json)['縣市'], '新竹市');
});

test('104 通知信：讀 mail 資料夾裡的 .eml', async () => {
  const dir = new URL('./fixtures/_mail/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const eml = [
    'From: 104人力銀行 <noreply@104.com.tw>',
    'To: me@example.com',
    'Subject: =?UTF-8?B?' + Buffer.from('104 職缺通知').toString('base64') + '?=',
    'Date: Sat, 31 Oct 2026 23:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(MAIL_HTML).toString('base64'),
  ].join('\r\n');
  writeFileSync(new URL('job.eml', dir), eml);
  try {
    const ad = createMail104Adapter({}, { mailDir: fileURLToPath(dir) });
    assert.equal(ad.configured, true);
    const items = await ad.collect({ isFirstRun: true, log: () => {} });
    assert.deepEqual(items.map((i) => i.sourceId).sort(), ['7abcd', '8efgh']);
    assert.equal(items.find((i) => i.sourceId === '7abcd').fields['通知日期'], '2026-11-01');
  } finally {
    unlinkSync(new URL('job.eml', dir));
  }
});

test('BeClass 列表頁 403 → 改讀官方 RSS：只新增，已存在的不判斷修改', async () => {
  const db = openDb(':memory:');
  const list = fixture('beclass-list.html');
  const detail = fixture('beclass-detail.html');
  const okFetch = async (url) => (url.includes('ShowList') ? (url.endsWith('page=1') ? list : '<html></html>') : detail);
  await runCrawl(db, beclass, { fetch: okFetch, log: () => {}, maxPages: 1, initialPages: 1 });
  const existing = beclass.parseList(list).items[0];
  const rss = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>
    <item><title><![CDATA[${existing.name}]]></title><link>https://www.beclass.com/m/rid=${existing.sourceId}</link><Date>2099-01-01</Date></item>
    <item><title><![CDATA[ RSS 新活動 ]]></title><link>https://www.beclass.com/m/rid=abc123</link><Date>2026-12-01</Date></item>
  </channel></rss>`;
  const blocked = async (url) => {
    if (url.endsWith('backend.php')) return rss;
    throw new Error(`HTTP 403 ${url}`);
  };
  const r = await runCrawl(db, beclass, { fetch: blocked, log: () => {} });
  assert.equal(r.newCount, 1);
  assert.equal(r.updatedCount, 0);
  const row = db.prepare("SELECT url, fields_json FROM events WHERE name = 'RSS 新活動'").get();
  assert.equal(row.url, 'https://www.beclass.com/rid=abc123');
  assert.equal(JSON.parse(row.fields_json)['活動日期'], '2026-12-01');
});

test('網站密碼：加密 → 正確密碼解得開、錯誤密碼失敗；資料包打包/拆包', async () => {
  const { encryptBytes, decryptBytes, isEncrypted, packBundle, unpackBundle } = await import('../src/shared/crypto.js');
  const db = new TextEncoder().encode('SQLite format 3\0 假資料庫內容');
  const enc = await encryptBytes(packBundle({ sites: [{ id: 'a' }] }, db), '正確的長密碼 2026!');
  assert.ok(isEncrypted(enc));
  assert.ok(!new TextDecoder().decode(enc).includes('假資料庫'));
  const { json, db: back } = unpackBundle(await decryptBytes(enc, '正確的長密碼 2026!'));
  assert.deepEqual(json, { sites: [{ id: 'a' }] });
  assert.deepEqual([...back], [...db]);
  await assert.rejects(() => decryptBytes(enc, '錯的'), /密碼錯誤/);
});

test('合併另一個資料庫的網站資料：整批取代該網站，id 重新編號不衝突', async () => {
  const { mergeSitesFrom } = await import('../src/core/merge.js');
  const dir = new URL('./fixtures/_merge/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const srcFile = fileURLToPath(new URL('src.db', dir));
  try {
    const src = openDb(srcFile);
    let batch = [{ name: 'A 活動', url: 'a', fields: { 地點: '台北' } }, { name: 'B 活動', url: 'b', fields: { 地點: '台中' } }];
    const ad = { id: 'beclass', name: 'BeClass', baseUrl: 'x', collect: async () => batch };
    await runCrawl(src, ad, { log: () => {} });
    batch = [{ ...batch[0], fields: { 地點: '高雄' } }, batch[1]];
    await runCrawl(src, ad, { log: () => {} });
    src.exec('PRAGMA journal_mode = DELETE;');
    src.close();

    const db = openDb(':memory:');
    for (const n of ['h1', 'h2', 'h3']) upsertEvent(db, 'huashan', { name: n, fields: {} });
    upsertEvent(db, 'beclass', { name: '舊的', fields: {} });
    mergeSitesFrom(db, srcFile, () => {});

    assert.deepEqual(db.prepare("SELECT name FROM events WHERE site_id = 'beclass' ORDER BY name").all().map((r) => r.name), ['A 活動', 'B 活動']);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE site_id = 'huashan'").get().n, 3);
    const a = db.prepare("SELECT * FROM events WHERE name = 'A 活動'").get();
    assert.equal(JSON.parse(a.fields_json)['地點'], '高雄');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM event_history WHERE event_id = ?').get(a.id).n, 1);
    assert.equal(db.prepare('SELECT site_id FROM crawl_runs WHERE id = ?').get(a.updated_run).site_id, 'beclass');
  } finally {
    for (const f of ['src.db', 'src.db-wal', 'src.db-shm']) { try { unlinkSync(new URL(f, dir)); } catch {} }
  }
});

test('地點統一：活動地點/地區/預設地點 → 地點；補上的地點不算修改', async () => {
  const { addDerivedFields } = await import('../src/core/extract.js');
  const a = { 活動地點: '華山 東2館' };
  assert.deepEqual(addDerivedFields(a), ['地點']);
  assert.equal(a['地點'], '華山 東2館');
  const b = { 工作地點: '台北市大安區' };
  addDerivedFields(b);
  assert.equal(b['地點'], '台北市大安區');
  assert.equal(b['地區'], '臺北市大安區');
  assert.equal(b['縣市'], '臺北市');
  const c = { 日期: '2026-11-01' };
  addDerivedFields(c, { defaultLocation: '華山1914（臺北市中正區）' });
  assert.equal(c['地點'], '華山1914（臺北市中正區）');
  assert.equal(c['縣市'], '臺北市');

  // 舊資料沒有地點欄位，之後補上「地點」不應被判成修改
  const db = openDb(':memory:');
  upsertEvent(db, 'h', { name: '展覽', fields: { 活動地點: '東2館' } });
  let batch = [{ name: '展覽', fields: { 活動地點: '東2館' } }];
  const ad = { id: 'h', name: 'h', baseUrl: 'x', collect: async () => batch };
  const r = await runCrawl(db, ad, { log: () => {} });
  assert.equal(r.updatedCount, 0);
  assert.equal(JSON.parse(db.prepare('SELECT fields_json FROM events').get().fields_json)['地點'], '東2館');
});

test('地區：只取縣市＋鄉鎮市區兩層', async () => {
  const { deriveArea, addDerivedFields } = await import('../src/core/extract.js');
  assert.equal(deriveArea('845台灣高雄市內門區內豊里內埔82號'), '高雄市內門區');
  assert.equal(deriveArea('桃園市桃園區中正路100號'), '桃園市桃園區');
  assert.equal(deriveArea('台東縣台東市中華路一段'), '臺東縣臺東市');
  assert.equal(deriveArea('桃園市平鎮區中豐路'), '桃園市平鎮區');
  assert.equal(deriveArea('高雄市前鎮區成功二路'), '高雄市前鎮區');
  assert.equal(deriveArea('5F FORUM（台灣台北市中山區南京西路14號）'), '臺北市中山區');
  assert.equal(deriveArea('臺北市大安森林公園'), '臺北市');
  assert.equal(deriveArea('Google Meet 線上'), '線上');
  // 沒有地點欄位時，從活動說明找地址
  const f = { 日期: '2026-11-01' };
  addDerivedFields(f, { text: '時間：下午兩點\n地點：宜蘭縣羅東鎮中正北路' });
  assert.equal(f['地區'], '宜蘭縣羅東鎮');
  assert.equal(f['縣市'], '宜蘭縣');
});

test('IT 邦幫忙：同主題同作者合成一筆，最新一篇換了才算更新', async () => {
  const { groupByTopic, parseArticle } = await import('../src/adapters/ithelp.js');
  const html = `<div class="qa-header"><h2 class="qa-header__title"> Day 30｜完整展示 </h2>
    <a href="https://ithelp.ithome.com.tw/tags/articles/%E9%9B%BB%E5%BD%B1" class="tag qa-header__tagList">電影收藏</a>
    <a class="qa-header__info-person">ppp</a><a title="2026-11-01 21:47:56" class="qa-header__info-time">x</a></div>`;
  const a = parseArticle(html, 'https://ithelp.ithome.com.tw/articles/3');
  assert.equal(a.topic, '電影收藏');
  assert.equal(a.time, '2026-11-01 21:47:56');
  const arts = [a, { ...a, url: 'u2', title: 'Day 29｜測試', time: '2026-10-31 20:00:00' }, { ...a, author: '別人', title: 'Python 入門', time: '2026-11-01' }];
  const items = groupByTopic(arts);
  assert.equal(items.length, 2);
  const g = items.find((i) => i.name === '電影收藏（ppp）');
  assert.equal(g.fields['進度'], 'Day 30');
  assert.equal(g.fields['本次看到篇數'], 2);
  assert.match(g.url, /tags\/articles/);

  const db = openDb(':memory:');
  let batch = [g];
  const ad = { id: 'ithelp', name: 'i', baseUrl: 'x', volatileFields: ['本次看到篇數'], collect: async () => batch };
  await runCrawl(db, ad, { log: () => {} });
  batch = [{ ...g, fields: { ...g.fields, 本次看到篇數: 1 } }];
  assert.equal((await runCrawl(db, ad, { log: () => {} })).updatedCount, 0);
  batch = [{ ...g, fields: { ...g.fields, 最新一篇: 'Day 31｜新文章', 進度: 'Day 31' } }];
  assert.equal((await runCrawl(db, ad, { log: () => {} })).updatedCount, 1);
});

test('104 企業邀請信：標籤一行、值一行的固定欄位；沒寫地點不亂猜', () => {
  const html = `<table><tr><td><a href="https://www.104.com.tw/company/abc">某某科技有限公司</a></td></tr>
    <tr><td><a href="https://www.104.com.tw/job/xyz9?jobsource=vip">後端工程師</a></td></tr>
    <tr><td>工作介紹</td></tr><tr><td>我們在臺北城深耕多年，歡迎加入</td></tr>
    <tr><td>職務類別</td></tr><tr><td>軟體工程師、後端工程師</td></tr>
    <tr><td>工作待遇</td></tr><tr><td>月薪 50,000~70,000元</td></tr>
    <tr><td>上班地點</td></tr><tr><td>新北市板橋區文化路一段</td></tr>
    <tr><td>休假制度</td></tr><tr><td>週休二日</td></tr></table>`;
  const [job] = parseJobMail(html, { subject: '【某某科技有限公司】發給您的【詢問意願】' });
  assert.equal(job.name, '後端工程師｜某某科技有限公司');
  assert.equal(job.fields['職務類別'], '軟體工程師、後端工程師');
  assert.equal(job.fields['薪資'], '月薪 50,000~70,000元');
  assert.equal(job.fields['工作地點'], '新北市板橋區文化路一段');
  assert.equal(job.fields['休假制度'], '週休二日');
  assert.equal(job.fields['類型'], '企業邀請');

  const noPlace = html.replace(/<tr><td>上班地點.*?文化路一段<\/td><\/tr>/, '');
  assert.equal(parseJobMail(noPlace, {})[0].fields['工作地點'], undefined);
});

test('只是多了欄位（∅ → 有值）不算更新', () => {
  const db = openDb(':memory:');
  upsertEvent(db, 's', { name: 'A', fields: { 地點: '台北' } });
  assert.equal(upsertEvent(db, 's', { name: 'A', fields: { 地點: '台北', 類型: '企業邀請' } }), 'same');
  assert.equal(JSON.parse(db.prepare('SELECT fields_json FROM events').get().fields_json)['類型'], '企業邀請');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM event_history').get().n, 0);
  assert.equal(upsertEvent(db, 's', { name: 'A', fields: { 地點: '高雄', 類型: '企業邀請' } }), 'updated');
});

test('網站資料包（CRW2）：網站固定鹽推導金鑰，同密碼同鹽可重複解密、錯密碼失敗', async () => {
  const C = await import('../src/shared/crypto.js');
  const data = new TextEncoder().encode('秘密資料');
  const k1 = await C.deriveSiteKey('長密碼#2026', 'crawler-site:me/repo');
  const enc = await C.encryptWithKey(data, k1);
  assert.ok(C.isSiteEncrypted(enc));
  // 重新推導（例如隔天網站更新後用記住的金鑰）也解得開
  const k2 = await C.deriveSiteKey('長密碼#2026', 'crawler-site:me/repo');
  assert.equal(new TextDecoder().decode(await C.decryptWithKey(enc, k2)), '秘密資料');
  await assert.rejects(async () => C.decryptWithKey(enc, await C.deriveSiteKey('錯的', 'crawler-site:me/repo')), /密碼錯誤/);
  await assert.rejects(async () => C.decryptWithKey(enc, await C.deriveSiteKey('長密碼#2026', 'crawler-site:other/repo')), /密碼錯誤/);
  // 金鑰不可匯出
  await assert.rejects(() => crypto.subtle.exportKey('raw', k1));
});

test('github replaceBranch：建立孤立 commit，分支不存在時改用新增', async () => {
  const { githubClient } = await import('../src/core/github.js');
  const calls = [];
  const reply = (status, body = {}) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = async (url, opt) => {
    calls.push([opt.method, url.replace('https://api.github.com/repos/o/r', ''), opt.body && JSON.parse(opt.body), opt.headers.Authorization]);
    if (url.endsWith('/git/blobs')) return reply(201, { sha: 'b1' });
    if (url.endsWith('/git/trees')) return reply(201, { sha: 't1' });
    if (url.endsWith('/git/commits')) return reply(201, { sha: 'c1' });
    if (opt.method === 'PATCH') return reply(422, { message: 'Reference does not exist' });
    return reply(201);
  };
  const gh = githubClient({ repo: 'o/r', token: 'tok', fetchImpl });
  assert.equal(await gh.replaceBranch('data-beclass', 'beclass.enc', new Uint8Array([1, 2]), 'm'), 'c1');
  assert.deepEqual(calls.map((c) => `${c[0]} ${c[1]}`), [
    'POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'PATCH /git/refs/heads/data-beclass', 'POST /git/refs',
  ]);
  assert.equal(calls[0][2].content, 'AQI=');
  assert.deepEqual(calls[2][2].parents, []);
  assert.deepEqual(calls[4][2], { ref: 'refs/heads/data-beclass', sha: 'c1' });
  assert.ok(calls.every((c) => c[3] === 'Bearer tok'));
  assert.throws(() => githubClient({ repo: 'o/r/../x', token: 't' }), /GH_REPO/);
  assert.throws(() => githubClient({ repo: 'o/r' }), /GH_SYNC_TOKEN/);
});

test('mail104：MAIL104_CONFIGURED 只影響「已設定」顯示，不會沒有密碼也去登入信箱', () => {
  const empty = fileURLToPath(new URL('./fixtures/', import.meta.url));
  assert.equal(createMail104Adapter({}, { mailDir: empty }).configured, false);
  assert.equal(createMail104Adapter({ MAIL104_CONFIGURED: 'true' }, { mailDir: empty }).configured, true);
  assert.equal(createMail104Adapter({ MAIL104_CONFIGURED: 'false' }, { mailDir: empty }).configured, false);
});

test('github ensureWorkflowEnabled：被停用才重新啟用', async () => {
  const { githubClient } = await import('../src/core/github.js');
  for (const [state, expected] of [['active', ['GET']], ['disabled_inactivity', ['GET', 'PUT']]]) {
    const methods = [];
    const fetchImpl = async (url, opt) => {
      methods.push(opt.method);
      return { ok: true, status: opt.method === 'PUT' ? 204 : 200, json: async () => ({ state }) };
    };
    const enabled = await githubClient({ repo: 'o/r', token: 't', fetchImpl }).ensureWorkflowEnabled('crawl.yml');
    assert.equal(enabled, state !== 'active');
    assert.deepEqual(methods, expected);
  }
});

test('104 配對日報：所有職缺在同一個表格、一個欄位一列，也要抓到公司和地點', () => {
  const job = (id, title, company, info, salary) => `
    <tr><td><a href="https://www.104.com.tw/job/${id}?jobsource=match_mail">${title}</a></td></tr>
    <tr><td><a href="https://www.104.com.tw/company/c${id}?jobsource=match_mail">${company}</a></td></tr>
    <tr><td>${info}</td></tr>
    <tr><td>【工作內容】負責系統開發，熟悉大學以上程度的資料結構</td></tr>
    <tr><td>${salary}</td></tr>
    <tr><td><a href="https://104app.onelink.me/x/apply?af_r=https://www.104.com.tw/job/${id}?apply=form">我要應徵</a></td></tr>`;
  const html = `<table><tbody>
    <tr><td><a href="https://pda.104.com.tw/work/mate/list/x">更多</a></td></tr>
    ${job('aaa1', '後端工程師', '甲科技股份有限公司', '台北市中山區 | 經歷不拘 | 專科 | 軟體業', '年薪 600,000~900,000元')}
    ${job('bbb2', '韌體工程師', '乙工業有限公司', '新竹市|3年以上|大學以上', '待遇面議')}
  </tbody></table>`;
  const items = parseJobMail(html, { subject: '配對日報' });
  assert.deepEqual(items.map((i) => i.name), ['後端工程師｜甲科技股份有限公司', '韌體工程師｜乙工業有限公司']);
  assert.equal(items[0].fields['工作地點'], '台北市中山區');
  assert.equal(items[0].fields['學歷'], '專科');
  assert.equal(items[0].fields['薪資'], '年薪 600,000~900,000元');
  assert.equal(items[1].fields['工作地點'], '新竹市');
  assert.equal(items[1].fields['經歷'], '3年以上');
  assert.equal(items[1].fields['薪資'], '待遇面議');
});

test('SSRF：內部網路位址一律擋下，公開位址放行', async () => {
  const { isPrivateAddress } = await import('../src/core/fetcher.js');
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.0.1', '169.254.169.254', '168.63.129.16', '100.64.1.1', '0.0.0.0', '::1', 'fe80::1', 'fd12::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '203.74.205.1', '172.32.0.1', '2001:4860::8888']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('網站密碼至少 12 個字', async () => {
  const { assertStrongPassword } = await import('../src/shared/crypto.js');
  assert.throws(() => assertStrongPassword('short-pw'), /至少要 12/);
  assert.throws(() => assertStrongPassword(undefined), /至少要 12/);
  assert.doesNotThrow(() => assertStrongPassword('a-long-enough-password'));
});

test('同一筆用網站 ID 判斷：改名算修改、同名不同 ID 分開、舊資料用名稱認領', () => {
  const db = openDb(':memory:');
  assert.equal(upsertEvent(db, 's', { name: '2/14 司馬庫斯', url: 'u', sourceId: 'r1', fields: { 地點: '新竹' } }), 'new');
  assert.equal(upsertEvent(db, 's', { name: '2/13 司馬庫斯', url: 'u', sourceId: 'r1', fields: { 地點: '新竹' } }), 'updated');
  const rows = db.prepare("SELECT id, name FROM events WHERE site_id = 's'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '2/13 司馬庫斯');
  const h = JSON.parse(db.prepare('SELECT changes_json FROM event_history WHERE event_id = ?').get(rows[0].id).changes_json);
  assert.deepEqual(h['名稱'], { from: '2/14 司馬庫斯', to: '2/13 司馬庫斯' });
  // 同名不同 ID：兩筆
  assert.equal(upsertEvent(db, 's', { name: '親子營', url: 'a', sourceId: 'x1', fields: {} }), 'new');
  assert.equal(upsertEvent(db, 's', { name: '親子營', url: 'b', sourceId: 'x2', fields: {} }), 'new');
  // 舊資料沒有 ID：用名稱認領並補上 ID，不算新增
  upsertEvent(db, 's', { name: '舊活動', url: 'c', sourceId: null, fields: {} });
  assert.equal(upsertEvent(db, 's', { name: '舊活動', url: 'c', sourceId: 'old1', fields: {} }), 'same');
  assert.equal(db.prepare("SELECT source_id FROM events WHERE name = '舊活動'").get().source_id, 'old1');
});

test('舊版資料庫升級：拿掉名稱唯一限制、同 ID 重複的合併成一筆並記下改名', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { rmSync } = await import('node:fs');
  const file = join(tmpdir(), `migrate-${process.pid}.db`);
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
    url TEXT, source_id TEXT, fields_json TEXT NOT NULL DEFAULT '{}', description TEXT, content_hash TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, created_run INTEGER, updated_run INTEGER, UNIQUE (site_id, name_key));
    CREATE TABLE event_history (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES events (id),
    run_id INTEGER, changed_at TEXT NOT NULL, changes_json TEXT NOT NULL);
    INSERT INTO events VALUES (1,'b','舊名','舊名','u','r9','{}',NULL,'h1','2026-11-01 10:00:00','2026-11-01 10:00:00','2026-11-02 12:00:00',1,1);
    INSERT INTO events VALUES (2,'b','新名','新名','u','r9','{"地點":"台北"}',NULL,'h2','2026-11-03 12:00:00','2026-11-03 12:00:00','2026-11-03 12:00:00',5,5);
    INSERT INTO event_history VALUES (1,1,2,'2026-11-01 20:00:00','{"地點":{"from":null,"to":"x"}}');`);
  old.close();
  try {
    const db = openDb(file);
    assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'events'").get().sql, /UNIQUE/);
    const rows = db.prepare('SELECT * FROM events').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 1); // 保留最早的那筆
    assert.equal(rows[0].created_at, '2026-11-01 10:00:00');
    assert.equal(rows[0].name, '新名');
    assert.equal(rows[0].updated_at, '2026-11-03 12:00:00');
    const hist = db.prepare('SELECT changes_json FROM event_history WHERE event_id = 1 ORDER BY changed_at').all().map((r) => JSON.parse(r.changes_json));
    assert.equal(hist.length, 2);
    assert.deepEqual(hist[1]['名稱'], { from: '舊名', to: '新名' });
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    db.close();
  } finally {
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }
});

test('自訂網站：網址當 ID，去掉追蹤參數', async () => {
  const { urlSourceId } = await import('../src/adapters/generic.js');
  assert.equal(urlSourceId('https://www.accupass.com/event/123?utm_source=x&b=2&a=1#top'), 'www.accupass.com/event/123?a=1&b=2');
  assert.equal(urlSourceId('https://x.com/e/9/'), urlSourceId('https://x.com/e/9'));
});

test('資料品質：最近資料某欄位填寫率大幅下降、或抓到 0 筆時回報', async () => {
  const { checkQuality } = await import('../src/quality.js');
  const db = openDb(':memory:');
  const now = Date.parse('2026-11-04T12:00:00+08:00');
  const add = (i, fields, seen) => db.prepare(
    `INSERT INTO events (site_id, name, name_key, fields_json, created_at, updated_at, last_seen_at) VALUES ('s', ?, ?, ?, ?, ?, ?)`,
  ).run(`活動${i}`, `活動${i}`, JSON.stringify(fields), seen, seen, seen);
  for (let i = 0; i < 20; i++) add(i, { 公司: '甲公司', 薪資: '面議' }, '2026-10-01 12:00:00'); // 以前：都有公司
  for (let i = 20; i < 35; i++) add(i, { 薪資: '面議' }, '2026-11-04 11:00:00'); // 最近：公司不見了
  const problems = checkQuality(db, { now });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /「公司」填寫率從 100% 掉到 0%/);

  db.prepare("INSERT INTO crawl_runs (site_id, trigger, started_at, status, seen) VALUES ('s', 'cli', '2026-11-04 11:00:00', 'done', 0)").run();
  assert.ok(checkQuality(db, { now }).some((p) => /抓到 0 筆/.test(p)));
});

test('github downloadFile：用 raw 格式下載檔案', async () => {
  const { githubClient } = await import('../src/core/github.js');
  let seen;
  const fetchImpl = async (url, opt) => { seen = [url, opt.headers.Accept]; return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([7, 8]).buffer }; };
  const bytes = await githubClient({ repo: 'o/r', token: 't', fetchImpl }).downloadFile('data', 'crawler.db.enc');
  assert.deepEqual([...bytes], [7, 8]);
  assert.deepEqual(seen, ['https://api.github.com/repos/o/r/contents/crawler.db.enc?ref=data', 'application/vnd.github.raw']);
});
