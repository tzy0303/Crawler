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
  assert.equal(a.fields['地區'], '台北市大安區');
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
  let batch = [{ name: '工程師｜A 公司', url: 'u', sourceId: '1', fields: { 薪資: '月薪 4萬', 地區: '新竹市', 通知日期: '2026-11-01' } }];
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
