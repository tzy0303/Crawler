import { openDb, tx } from './store.js';

/**
 * 把另一個資料庫（例如家裡電腦抓的 BeClass）裡的網站資料併進 db：
 * 這些網站的資料整批取代；id 重新編號，避免和 db 裡其他網站衝突。
 * srcFile 會先用 openDb 升級成目前的格式（例如合併同 ID 的重複資料），所以要傳暫存的複本。
 * @returns 併入的網站 id
 */
export function mergeSitesFrom(db, srcFile, log = console.log) {
  const src = openDb(srcFile);
  const ids = src.prepare('SELECT DISTINCT site_id FROM events UNION SELECT DISTINCT site_id FROM crawl_runs').all().map((r) => r.site_id);
  tx(db, () => {
    for (const siteId of ids) {
      db.prepare('DELETE FROM event_history WHERE event_id IN (SELECT id FROM events WHERE site_id = ?)').run(siteId);
      for (const t of ['events', 'site_fields', 'crawl_runs']) db.prepare(`DELETE FROM ${t} WHERE site_id = ?`).run(siteId);
      const site = src.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
      if (site) {
        db.prepare('INSERT INTO sites (id, name, base_url) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url')
          .run(site.id, site.name, site.base_url);
      }

      const runMap = new Map();
      for (const r of src.prepare('SELECT * FROM crawl_runs WHERE site_id = ? ORDER BY id').all(siteId)) {
        const { lastInsertRowid } = db.prepare(
          `INSERT INTO crawl_runs (site_id, trigger, started_at, finished_at, status, pages, seen, new_count, updated_count, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(r.site_id, r.trigger, r.started_at, r.finished_at, r.status, r.pages, r.seen, r.new_count, r.updated_count, r.error);
        runMap.set(r.id, Number(lastInsertRowid));
      }
      const mapRun = (id) => (id == null ? null : runMap.get(id) ?? null);

      const eventMap = new Map();
      for (const e of src.prepare('SELECT * FROM events WHERE site_id = ? ORDER BY id').all(siteId)) {
        const { lastInsertRowid } = db.prepare(
          `INSERT INTO events (site_id, name, name_key, url, source_id, fields_json, description, content_hash,
                               created_at, updated_at, last_seen_at, created_run, updated_run)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(e.site_id, e.name, e.name_key, e.url, e.source_id, e.fields_json, e.description, e.content_hash,
          e.created_at, e.updated_at, e.last_seen_at, mapRun(e.created_run), mapRun(e.updated_run));
        eventMap.set(e.id, Number(lastInsertRowid));
      }
      for (const h of src.prepare(
        'SELECT h.* FROM event_history h JOIN events e ON e.id = h.event_id WHERE e.site_id = ? ORDER BY h.id').all(siteId)) {
        db.prepare('INSERT INTO event_history (event_id, run_id, changed_at, changes_json) VALUES (?, ?, ?, ?)')
          .run(eventMap.get(h.event_id), mapRun(h.run_id), h.changed_at, h.changes_json);
      }
      for (const f of src.prepare('SELECT * FROM site_fields WHERE site_id = ?').all(siteId)) {
        db.prepare(
          `INSERT INTO site_fields (site_id, field_key, type, coverage, filterable, distinct_count, values_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(f.site_id, f.field_key, f.type, f.coverage, f.filterable, f.distinct_count, f.values_json, f.updated_at);
      }
      log(`[合併] ${siteId}：${eventMap.size} 筆`);
    }
  });
  src.close();
  return ids;
}
