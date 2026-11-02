// 替所有現有資料重新推算衍生欄位（地點、地區、縣市），規則改了之後舊資料也會補上。
// 衍生欄位不算「修改」，不動 content_hash 和修改時間。用法：node src/backfill.js
import { loadSites } from './adapters/index.js';
import { config, log } from './config.js';
import { addDerivedFields, DERIVED_FIELDS } from './core/extract.js';
import { recomputeSiteFields } from './core/fields.js';
import { openDb, tx } from './core/store.js';

const db = openDb(config.dbFile);
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
