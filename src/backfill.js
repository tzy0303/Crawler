// 替所有現有資料重新推算衍生欄位（地點、地區、縣市），規則改了之後舊資料也會補上。
// 衍生欄位不算「修改」，不動 content_hash 和修改時間。用法：node src/backfill.js
import { loadSites } from './adapters/index.js';
import { config, log } from './config.js';
import { addDerivedFields, DERIVED_FIELDS } from './core/extract.js';
import { recomputeSiteFields } from './core/fields.js';
import { openDb, tx } from './core/store.js';

const db = openDb(config.dbFile);

// 一次性修正（只執行一次，記在 migrations 資料表）
db.exec('CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, ran_at TEXT NOT NULL)');
const MIGRATIONS = {
  // 104 通知信解析改版（欄位改名、去掉信件雜訊）造成的假「更新」：清掉修改紀錄，最新更新回到首次出現
  '2026-11-02-mail104-reparse': () => {
    db.prepare("DELETE FROM event_history WHERE event_id IN (SELECT id FROM events WHERE site_id = 'mail104')").run();
    db.prepare("UPDATE events SET updated_at = created_at, updated_run = created_run WHERE site_id = 'mail104'").run();
  },
  // 配對日報的公司、地點之前沒抓到，名稱少了「｜公司」：清掉 104 的資料，下次當作首次抓取，重讀最近 30 天的信
  '2026-11-03-mail104-company': () => {
    db.prepare("DELETE FROM event_history WHERE event_id IN (SELECT id FROM events WHERE site_id = 'mail104')").run();
    db.prepare("DELETE FROM events WHERE site_id = 'mail104'").run();
    db.prepare("DELETE FROM site_fields WHERE site_id = 'mail104'").run();
  },
};
for (const [id, run] of Object.entries(MIGRATIONS)) {
  if (db.prepare('SELECT 1 FROM migrations WHERE id = ?').get(id)) continue;
  tx(db, () => {
    run();
    db.prepare("INSERT INTO migrations (id, ran_at) VALUES (?, datetime('now'))").run(id);
  });
  log(`[修正] 已執行 ${id}`);
}

const defaults = new Map(loadSites(config).map((s) => [s.adapter.id, s.adapter.defaultLocation]));
const rows = db.prepare('SELECT id, site_id, fields_json, description FROM events').all();
const update = db.prepare('UPDATE events SET fields_json = ? WHERE id = ?');
let changed = 0;
tx(db, () => {
  for (const r of rows) {
    const fields = JSON.parse(r.fields_json);
    for (const k of DERIVED_FIELDS) delete fields[k];
    addDerivedFields(fields, { defaultLocation: defaults.get(r.site_id), text: r.description });
    const json = JSON.stringify(fields);
    if (json !== r.fields_json) {
      update.run(json, r.id);
      changed++;
    }
  }
});
for (const siteId of new Set(rows.map((r) => r.site_id))) recomputeSiteFields(db, siteId);
db.close();
log(`[補齊] 衍生欄位：${rows.length} 筆中更新 ${changed} 筆`);
