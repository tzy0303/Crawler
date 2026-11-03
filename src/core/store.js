import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 同一筆活動：有網站自己的 ID（source_id）就用 ID 判斷，沒有才用名稱；所以名稱不設 UNIQUE（同名不同場次可以並存）
const EVENTS_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  url TEXT,
  source_id TEXT,
  fields_json TEXT NOT NULL DEFAULT '{}',
  description TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_run INTEGER,
  updated_run INTEGER`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT
);
CREATE TABLE IF NOT EXISTS events (${EVENTS_COLUMNS}
);
CREATE INDEX IF NOT EXISTS idx_events_name ON events (site_id, name_key);
CREATE INDEX IF NOT EXISTS idx_events_created ON events (site_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_updated ON events (site_id, updated_at);
CREATE TABLE IF NOT EXISTS event_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events (id),
  run_id INTEGER,
  changed_at TEXT NOT NULL,
  changes_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_event ON event_history (event_id);
CREATE TABLE IF NOT EXISTS site_fields (
  site_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  type TEXT NOT NULL,
  coverage REAL NOT NULL,
  filterable INTEGER NOT NULL,
  distinct_count INTEGER NOT NULL,
  values_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, field_key)
);
CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
`;

/** 台灣時間 "YYYY-MM-DD HH:mm:ss"（字串可直接排序/比較） */
export const now = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrateEvents(db);
  return db;
}

/**
 * 舊版資料庫升級（每次開啟都檢查，做過就不會再做）：
 *  1. 拿掉「名稱不可重複」的限制（要重建資料表，SQLite 不能直接刪限制）
 *  2. 同一個 ID 有多筆（活動改名後被當成新活動）→ 合併成一筆，保留最早的首次出現時間，改名記進修改紀錄
 *  3. 建立「同網站同 ID 只能一筆」的索引
 */
function migrateEvents(db) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
  if (/UNIQUE\s*\(\s*site_id\s*,\s*name_key\s*\)/i.test(sql)) {
    // 重建期間暫停外鍵檢查（event_history 指向 events 才能刪舊表）；id 原樣複製，修改紀錄不會對不上
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(db, () => {
        db.exec(`CREATE TABLE events_new (${EVENTS_COLUMNS});
          INSERT INTO events_new SELECT id, site_id, name, name_key, url, source_id, fields_json, description, content_hash,
            created_at, updated_at, last_seen_at, created_run, updated_run FROM events;
          DROP TABLE events;
          ALTER TABLE events_new RENAME TO events;`);
        db.exec(SCHEMA); // 重建索引
      });
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  const groups = db.prepare(
    'SELECT site_id, source_id FROM events WHERE source_id IS NOT NULL GROUP BY site_id, source_id HAVING COUNT(*) > 1',
  ).all();
  if (groups.length) tx(db, () => groups.forEach((g) => mergeDuplicates(db, g.site_id, g.source_id)));
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source ON events (site_id, source_id) WHERE source_id IS NOT NULL');
}

function mergeDuplicates(db, siteId, sourceId) {
  const rows = db.prepare('SELECT * FROM events WHERE site_id = ? AND source_id = ? ORDER BY created_at, id').all(siteId, sourceId);
  const [keep, ...others] = rows;
  const latest = rows.reduce((a, b) => (b.last_seen_at > a.last_seen_at || (b.last_seen_at === a.last_seen_at && b.id > a.id) ? b : a));
  let prevName = keep.name;
  for (const o of others) {
    db.prepare('UPDATE event_history SET event_id = ? WHERE event_id = ?').run(keep.id, o.id);
    if (o.name_key !== keep.name_key || o.name !== prevName) {
      db.prepare('INSERT INTO event_history (event_id, run_id, changed_at, changes_json) VALUES (?, ?, ?, ?)')
        .run(keep.id, o.created_run, o.created_at, JSON.stringify({ 名稱: { from: prevName, to: o.name } }));
      prevName = o.name;
    }
    db.prepare('DELETE FROM events WHERE id = ?').run(o.id);
  }
  const maxOf = (k) => rows.map((r) => r[k]).sort().at(-1);
  const updatedAt = [maxOf('updated_at'), ...others.map((o) => o.created_at)].sort().at(-1);
  db.prepare(
    `UPDATE events SET name = ?, name_key = ?, url = ?, fields_json = ?, description = ?, content_hash = ?,
       updated_at = ?, last_seen_at = ?, updated_run = ? WHERE id = ?`,
  ).run(latest.name, latest.name_key, latest.url, latest.fields_json, latest.description, latest.content_hash,
    updatedAt, maxOf('last_seen_at'), latest.updated_run ?? latest.created_run, keep.id);
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function ensureSite(db, adapter) {
  db.prepare(
    `INSERT INTO sites (id, name, base_url) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url`,
  ).run(adapter.id, adapter.name, adapter.baseUrl);
}

export function startRun(db, siteId, trigger) {
  const r = db
    .prepare(`INSERT INTO crawl_runs (site_id, trigger, started_at, status) VALUES (?, ?, ?, 'running')`)
    .run(siteId, trigger, now());
  return Number(r.lastInsertRowid);
}

export function finishRun(db, runId, stats, error = null) {
  db.prepare(
    `UPDATE crawl_runs SET finished_at = ?, status = ?, pages = ?, seen = ?, new_count = ?, updated_count = ?, error = ?
     WHERE id = ?`,
  ).run(now(), error ? 'failed' : 'done', stats.pages, stats.seen, stats.newCount, stats.updatedCount, error, runId);
}

/** 程式中斷遺留的 running 紀錄標成 aborted */
export function markStaleRuns(db) {
  db.prepare(`UPDATE crawl_runs SET status = 'aborted', finished_at = ? WHERE status = 'running'`).run(now());
}
