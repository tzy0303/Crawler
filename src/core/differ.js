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

/**
 * 以「名稱」判斷同一活動：
 *  不存在 → 新增（created_at = updated_at = now）
 *  存在且穩定內容不同 → 修改（updated_at = now，寫 event_history）
 *  存在且相同 → 只更新 last_seen_at 與變動欄位
 * @returns {'new'|'updated'|'same'}
 */
export function upsertEvent(db, siteId, ev, { runId = null, volatile = [] } = {}) {
  const ts = now();
  const nameKey = normalizeName(ev.name);
  const hash = contentHash(ev.fields, ev.description, volatile);
  const fieldsJson = JSON.stringify(ev.fields);
  const existing = db
    .prepare('SELECT id, fields_json, description, content_hash FROM events WHERE site_id = ? AND name_key = ?')
    .get(siteId, nameKey);

  if (!existing) {
    db.prepare(
      `INSERT INTO events (site_id, name, name_key, url, source_id, fields_json, description, content_hash,
                           created_at, updated_at, last_seen_at, created_run, updated_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(siteId, ev.name, nameKey, ev.url ?? null, ev.sourceId ?? null, fieldsJson, ev.description ?? null,
      hash, ts, ts, ts, runId, runId);
    return 'new';
  }

  if (existing.content_hash === hash) {
    db.prepare('UPDATE events SET fields_json = ?, url = ?, source_id = ?, last_seen_at = ? WHERE id = ?').run(
      fieldsJson, ev.url ?? null, ev.sourceId ?? null, ts, existing.id);
    return 'same';
  }

  const changes = diffFields(JSON.parse(existing.fields_json), ev.fields, volatile);
  if ((existing.description ?? '') !== (ev.description ?? '')) {
    changes['活動說明'] = { from: existing.description ?? null, to: ev.description ?? null };
  }
  db.prepare(
    `UPDATE events SET name = ?, fields_json = ?, description = ?, content_hash = ?, url = ?, source_id = ?,
                       updated_at = ?, last_seen_at = ?, updated_run = ?
     WHERE id = ?`,
  ).run(ev.name, fieldsJson, ev.description ?? null, hash, ev.url ?? null, ev.sourceId ?? null, ts, ts, runId,
    existing.id);
  db.prepare('INSERT INTO event_history (event_id, run_id, changed_at, changes_json) VALUES (?, ?, ?, ?)').run(
    existing.id, runId, ts, JSON.stringify(changes));
  return 'updated';
}
