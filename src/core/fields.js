import { CORE_FIELDS } from './extract.js';
import { now, tx } from './store.js';

const DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;
const NUM_RE = /^-?\d+(\.\d+)?$/;
const FILTERABLE_COVERAGE = 0.3;
const MAX_ENUM = 50;

export function inferType(values) {
  if (values.some(Array.isArray)) return 'tags';
  const strs = values.map((v) => String(v));
  const ratio = (re) => strs.filter((s) => re.test(s)).length / strs.length;
  if (ratio(DATE_RE) >= 0.8) return 'date';
  if (ratio(NUM_RE) >= 0.8) return 'number';
  const distinct = new Set(strs).size;
  const avgLen = strs.reduce((n, s) => n + s.length, 0) / strs.length;
  // 值短（像類別、縣市）或重複度高 → 下拉選單；長地址之類 → 關鍵字
  if (distinct <= MAX_ENUM && (avgLen <= 12 || distinct <= Math.max(5, strs.length * 0.6))) return 'enum';
  return 'text';
}

/** 依目前資料重算該網站有哪些欄位、型別、出現率 → 動態篩選條件來源 */
export function recomputeSiteFields(db, siteId) {
  const rows = db.prepare('SELECT fields_json FROM events WHERE site_id = ?').all(siteId);
  const total = rows.length;
  const byKey = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(JSON.parse(r.fields_json))) {
      if (v === null || v === '') continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(v);
    }
  }
  const ts = now();
  tx(db, () => {
    db.prepare('DELETE FROM site_fields WHERE site_id = ?').run(siteId);
    const ins = db.prepare(
      `INSERT INTO site_fields (site_id, field_key, type, coverage, filterable, distinct_count, values_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [key, values] of byKey) {
      const type = inferType(values);
      const coverage = values.length / total;
      const counts = new Map();
      for (const v of values.flat()) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_ENUM).map(([value, count]) => ({ value, count }));
      const listAll = type === 'enum' || type === 'tags';
      // 每筆都一樣的值（頁尾電話、地址）篩選沒意義
      // 地點、縣市每個網站都要能篩，不受出現率門檻限制
      const filterable = (coverage >= FILTERABLE_COVERAGE || CORE_FIELDS.includes(key)) && counts.size >= 2;
      ins.run(siteId, key, type, coverage, filterable ? 1 : 0, counts.size,
        JSON.stringify(listAll ? top : top.slice(0, 5)), ts);
    }
  });
}

export { getSiteFields } from '../shared/query.js';
