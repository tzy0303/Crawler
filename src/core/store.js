import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT
);
CREATE TABLE IF NOT EXISTS events (
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
  updated_run INTEGER,
  UNIQUE (site_id, name_key)
);
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
  return db;
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
