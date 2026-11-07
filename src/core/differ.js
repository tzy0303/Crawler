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

const EXISTING_COLS = 'id, name, name_key, match_key, source_id, fields_json, description, content_hash';

/**
 * 比對鍵：[公司（作者）, 標題]。所有網站共用；網站重開時 ID 會變，但公司和標題不變 → 算同一筆。
 *  公司（作者）：BeClass 用承辦人員帳號（owner）、104 用「公司」、IT 邦幫忙用「作者」；自訂網站沒有 → 空白
 *  標題：名稱正規化（全形轉半形、壓縮空白）；名稱後面帶的「｜公司」「（作者）」去掉，因為公司另外比
 */
export function matchKey(name, fields = {}, owner = null) {
  const company = normalizeName(owner ?? fields['公司'] ?? fields['作者'] ?? '');
  let title = normalizeName(name);
  if (company) {
    for (const suffix of [`|${company}`, `(${company})`]) {
      if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
    }
  }
  return JSON.stringify([company, title]);
}

/**
 * 找資料庫裡的同一筆：
 *  1. 網站 ID 相同 → 同一筆（改標題也認得，算修改）
 *  2. 公司（作者）+ 標題相同 → 同一筆（網站重開換了 ID）
 *     公司不同就不是同一筆；但已存的那筆不知道公司（舊資料、信裡沒寫）、
 *     或這次資料不完整（partial，例如 BeClass RSS 沒有承辦人員）時，只比標題。公司相同的優先。
 */
function findExisting(db, siteId, sourceId, key, partial) {
  if (sourceId) {
    const byId = db.prepare(`SELECT ${EXISTING_COLS} FROM events WHERE site_id = ? AND source_id = ?`).get(siteId, sourceId);
    if (byId) return byId;
  }
  const [company, core] = JSON.parse(key);
  return db.prepare(
    `SELECT ${EXISTING_COLS} FROM events
     WHERE site_id = ? AND json_extract(match_key, '$[1]') = ?
       AND (json_extract(match_key, '$[0]') IN (?, '') OR (? AND ? = ''))
     ORDER BY json_extract(match_key, '$[0]') = ? DESC, last_seen_at DESC, id DESC LIMIT 1`,
  ).get(siteId, core, company, partial ? 1 : 0, company, company);
}

/** 存回去的比對鍵：這次不知道公司就沿用已記下的 */
function keepKey(key, existing) {
  const [company, core] = JSON.parse(key);
  if (company || !existing.match_key) return key;
  return JSON.stringify([JSON.parse(existing.match_key)[0], core]);
}

/**
 * 判斷同一活動（見 findExisting）：
 *  不存在 → 新增（created_at = updated_at = now）
 *  存在且穩定內容或名稱不同 → 修改（updated_at = now，寫 event_history；改名也算）
 *  存在且相同 → 只更新 last_seen_at 與變動欄位
 * seen：同一次抓取共用的 Set，記下已對到的資料列 id。
 *  同一次抓取裡同公司同名、不同 ID 的（例如同一課程開了好幾個日期）只記第一個看到的，其餘略過，
 *  不然每次抓取都會被不同日期輪流蓋掉、一直算成修改
 * @returns {'new'|'updated'|'same'}
 */
export function upsertEvent(db, siteId, ev, { runId = null, volatile = [], partial = false, seen = null } = {}) {
  const ts = now();
  const nameKey = normalizeName(ev.name);
  const sourceId = ev.sourceId ?? null;
  const hash = contentHash(ev.fields, ev.description, volatile);
  const fieldsJson = JSON.stringify(ev.fields);
  const key = matchKey(ev.name, ev.fields, ev.owner);
  const existing = findExisting(db, siteId, sourceId, key, partial);
  if (existing) {
    if (seen?.has(existing.id)) return 'same';
    seen?.add(existing.id);
  }

  if (!existing) {
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO events (site_id, name, name_key, match_key, url, source_id, fields_json, description, content_hash,
                           created_at, updated_at, last_seen_at, created_run, updated_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(siteId, ev.name, nameKey, key, ev.url ?? null, sourceId, fieldsJson, ev.description ?? null,
      hash, ts, ts, ts, runId, runId);
    seen?.add(Number(lastInsertRowid));
    return 'new';
  }
  // 沒有 ID 的來源不覆蓋已記下的 ID；重開換了 ID 就改記新的
  const keepId = sourceId ?? existing.source_id;
  const reopened = keepId !== existing.source_id;
  const storeKey = keepKey(key, existing);

  // partial：資料來源欄位不完整（例如 RSS），已存在的只記「有看到」，不判斷修改（重開的話換成新 ID、新網址）
  if (partial) {
    db.prepare('UPDATE events SET source_id = ?, url = CASE WHEN ? THEN ? ELSE url END, last_seen_at = ? WHERE id = ?')
      .run(keepId, reopened ? 1 : 0, ev.url ?? null, ts, existing.id);
    return 'same';
  }

  const renamed = existing.name_key !== nameKey;
  if (existing.content_hash === hash && !renamed) {
    db.prepare('UPDATE events SET fields_json = ?, match_key = ?, url = ?, source_id = ?, last_seen_at = ? WHERE id = ?').run(
      fieldsJson, storeKey, ev.url ?? null, keepId, ts, existing.id);
    return 'same';
  }

  const changes = renamed ? { 名稱: { from: existing.name, to: ev.name } } : {};
  Object.assign(changes, diffFields(JSON.parse(existing.fields_json), ev.fields, volatile));
  if ((existing.description ?? '') !== (ev.description ?? '')) {
    changes['活動說明'] = { from: existing.description ?? null, to: ev.description ?? null };
  }
  // 只是多了欄位（∅ → 有值，通常是抓取程式改版多抓到東西）：靜默補上，不算更新
  if (Object.values(changes).every((c) => c.from === null)) {
    db.prepare('UPDATE events SET fields_json = ?, match_key = ?, description = ?, content_hash = ?, url = ?, source_id = ?, last_seen_at = ? WHERE id = ?')
      .run(fieldsJson, storeKey, ev.description ?? null, hash, ev.url ?? null, keepId, ts, existing.id);
    return 'same';
  }
  db.prepare(
    `UPDATE events SET name = ?, name_key = ?, match_key = ?, fields_json = ?, description = ?, content_hash = ?, url = ?, source_id = ?,
                       updated_at = ?, last_seen_at = ?, updated_run = ?
     WHERE id = ?`,
  ).run(ev.name, nameKey, storeKey, fieldsJson, ev.description ?? null, hash, ev.url ?? null, keepId, ts, ts, runId, existing.id);
  db.prepare('INSERT INTO event_history (event_id, run_id, changed_at, changes_json) VALUES (?, ?, ?, ?)').run(
    existing.id, runId, ts, JSON.stringify(changes));
  return 'updated';
}
