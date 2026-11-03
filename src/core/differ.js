import { createHash } from 'node:crypto';
import { normalizeName } from './extract.js';
import { now } from './store.js';

/** 只用穩定欄位算雜湊；volatile（剩餘天數、尚餘名額…）每天都變，不算修改 */
export function contentHash(fields, description, volatile = []) {
  const stable = Object.keys(fields)
    .filter((k) => !volatile.includes(k))
    .sort()
    .map((k) => [k, fields[k]]);
  return createHash('sha1')
    .update(JSON.stringify([stable, description ?? '']))
    .digest('hex');
}

export function diffFields(oldFields, newFields, volatile = []) {
  const changes = {};
  const keys = new Set([...Object.keys(oldFields), ...Object.keys(newFields)]);
  for (const k of keys) {
    if (volatile.includes(k)) continue;
    if (JSON.stringify(oldFields[k] ?? null) !== JSON.stringify(newFields[k] ?? null)) {
      changes[k] = { from: oldFields[k] ?? null, to: newFields[k] ?? null };
    }
  }
  return changes;
}

const EXISTING_COLS = 'id, name, name_key, source_id, fields_json, description, content_hash';

/**
 * 找資料庫裡的同一筆：
 *  有網站 ID → 用 ID 找；找不到再用名稱認領「還沒有 ID 的舊資料」（不會認領別的 ID，同名不同場次分開記）
 *  沒有 ID → 用名稱找
 */
function findExisting(db, siteId, sourceId, nameKey) {
  if (sourceId) {
    return db.prepare(`SELECT ${EXISTING_COLS} FROM events WHERE site_id = ? AND source_id = ?`).get(siteId, sourceId)
      ?? db.prepare(`SELECT ${EXISTING_COLS} FROM events WHERE site_id = ? AND name_key = ? AND source_id IS NULL`).get(siteId, nameKey);
  }
  return db
    .prepare(`SELECT ${EXISTING_COLS} FROM events WHERE site_id = ? AND name_key = ? ORDER BY source_id IS NULL DESC, id LIMIT 1`)
    .get(siteId, nameKey);
}

/**
 * 判斷同一活動（見 findExisting）：
 *  不存在 → 新增（created_at = updated_at = now）
 *  存在且穩定內容或名稱不同 → 修改（updated_at = now，寫 event_history；改名也算）
 *  存在且相同 → 只更新 last_seen_at 與變動欄位
 * @returns {'new'|'updated'|'same'}
 */
export function upsertEvent(db, siteId, ev, { runId = null, volatile = [], partial = false } = {}) {
  const ts = now();
  const nameKey = normalizeName(ev.name);
  const sourceId = ev.sourceId ?? null;
  const hash = contentHash(ev.fields, ev.description, volatile);
  const fieldsJson = JSON.stringify(ev.fields);
  const existing = findExisting(db, siteId, sourceId, nameKey);

  if (!existing) {
    db.prepare(
      `INSERT INTO events (site_id, name, name_key, url, source_id, fields_json, description, content_hash,
                           created_at, updated_at, last_seen_at, created_run, updated_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(siteId, ev.name, nameKey, ev.url ?? null, sourceId, fieldsJson, ev.description ?? null,
      hash, ts, ts, ts, runId, runId);
    return 'new';
  }
  // 沒有 ID 的來源不覆蓋已記下的 ID
  const keepId = sourceId ?? existing.source_id;

  // partial：資料來源欄位不完整（例如 RSS），已存在的只記「有看到」，不判斷修改
  if (partial) {
    db.prepare('UPDATE events SET last_seen_at = ? WHERE id = ?').run(ts, existing.id);
    return 'same';
  }

  const renamed = existing.name_key !== nameKey;
  if (existing.content_hash === hash && !renamed) {
    db.prepare('UPDATE events SET fields_json = ?, url = ?, source_id = ?, last_seen_at = ? WHERE id = ?').run(
      fieldsJson, ev.url ?? null, keepId, ts, existing.id);
    return 'same';
  }

  const changes = renamed ? { 名稱: { from: existing.name, to: ev.name } } : {};
  Object.assign(changes, diffFields(JSON.parse(existing.fields_json), ev.fields, volatile));
  if ((existing.description ?? '') !== (ev.description ?? '')) {
    changes['活動說明'] = { from: existing.description ?? null, to: ev.description ?? null };
  }
  // 只是多了欄位（∅ → 有值，通常是抓取程式改版多抓到東西）：靜默補上，不算更新
  if (Object.values(changes).every((c) => c.from === null)) {
    db.prepare('UPDATE events SET fields_json = ?, description = ?, content_hash = ?, url = ?, source_id = ?, last_seen_at = ? WHERE id = ?')
      .run(fieldsJson, ev.description ?? null, hash, ev.url ?? null, keepId, ts, existing.id);
    return 'same';
  }
  db.prepare(
    `UPDATE events SET name = ?, name_key = ?, fields_json = ?, description = ?, content_hash = ?, url = ?, source_id = ?,
                       updated_at = ?, last_seen_at = ?, updated_run = ?
     WHERE id = ?`,
  ).run(ev.name, nameKey, fieldsJson, ev.description ?? null, hash, ev.url ?? null, keepId, ts, ts, runId, existing.id);
  db.prepare('INSERT INTO event_history (event_id, run_id, changed_at, changes_json) VALUES (?, ?, ?, ?)').run(
    existing.id, runId, ts, JSON.stringify(changes));
  return 'updated';
}
