// 資料品質檢查：抓取「成功」但內容壞掉（網站改版、解析程式出錯）時也要知道。
// 比較「最近看到的資料」和「比較早的資料」各欄位的填寫率，大幅下降就回報；某網站這次抓到 0 筆也回報。
// 用法：node src/quality.js        （有問題時印出問題，一行一個；沒問題不印）
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { openDb } from './core/store.js';

const RECENT_HOURS = 20; // 「最近」= 這一輪抓取看到的（每天跑一次）
const MIN_ROWS = 10; // 筆數太少不判斷，避免誤報
const MIN_OLD_COVERAGE = 0.6; // 以前至少 60% 有填的欄位才檢查

const taipei = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
const pct = (x) => `${Math.round(x * 100)}%`;

function coverage(rows) {
  const counts = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(JSON.parse(r.fields_json))) {
      if (v !== null && v !== '' && !(Array.isArray(v) && !v.length)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return new Map([...counts].map(([k, n]) => [k, n / rows.length]));
}

/** @returns {string[]} 問題描述（不含活動或職缺名稱，可以放進公開的 Issue） */
export function checkQuality(db, { now = Date.now() } = {}) {
  const since = taipei(now - RECENT_HOURS * 3600_000);
  const problems = [];
  for (const { site_id: site } of db.prepare('SELECT DISTINCT site_id FROM events').all()) {
    const recent = db.prepare('SELECT fields_json FROM events WHERE site_id = ? AND last_seen_at >= ?').all(site, since);
    const older = db.prepare('SELECT fields_json FROM events WHERE site_id = ? AND last_seen_at < ?').all(site, since);

    // 這一輪有抓（有完成的紀錄）卻一筆都沒看到
    const run = db.prepare("SELECT seen FROM crawl_runs WHERE site_id = ? AND status = 'done' AND started_at >= ? ORDER BY id DESC LIMIT 1")
      .get(site, since);
    if (run && run.seen === 0) problems.push(`${site}：這次抓到 0 筆（網站可能改版或擋掉了）`);

    if (recent.length < MIN_ROWS || older.length < MIN_ROWS) continue;
    const before = coverage(older);
    const after = coverage(recent);
    for (const [field, was] of before) {
      const now_ = after.get(field) ?? 0;
      if (was >= MIN_OLD_COVERAGE && now_ < was / 2) {
        problems.push(`${site}：「${field}」填寫率從 ${pct(was)} 掉到 ${pct(now_)}（最近 ${recent.length} 筆），解析可能壞了`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb(config.dbFile);
  for (const p of checkQuality(db)) console.log(p);
  db.close();
}
