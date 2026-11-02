// 查詢邏輯：伺服器（node:sqlite）和雲端靜態網頁（瀏覽器 sql.js）共用。
// db 只需要 prepare(sql).get(...args) / .all(...args)。

export function getSiteFields(db, siteId, { all = false } = {}) {
  return db
    .prepare(
      `SELECT field_key AS key, type, coverage, filterable, distinct_count AS distinctCount, values_json
       FROM site_fields WHERE site_id = ? ${all ? '' : 'AND filterable = 1'} ORDER BY coverage DESC, field_key`,
    )
    .all(siteId)
    .map(({ values_json, ...f }) => ({ ...f, filterable: !!f.filterable, values: JSON.parse(values_json ?? '[]') }));
}

/** 活動列表 + 篩選。p：URLSearchParams */
export function queryEvents(db, p) {
  const site = p.get('site');
  const where = ['e.site_id = ?'];
  const args = [site];
  const q = p.get('q');
  if (q) {
    where.push('(e.name LIKE ? OR e.description LIKE ?)');
    args.push(`%${q}%`, `%${q}%`);
  }
  for (const [param, col, op] of [
    ['created_from', 'created_at', '>='], ['created_to', 'created_at', '<='],
    ['updated_from', 'updated_at', '>='], ['updated_to', 'updated_at', '<='],
  ]) {
    const v = p.get(param);
    if (v) {
      where.push(`e.${col} ${op} ?`);
      args.push(op === '<=' && v.length === 10 ? `${v} 23:59:59` : v);
    }
  }
  const kind = p.get('kind'); // new | updated（搭配 run = 某次抓取）
  const run = p.get('run');
  if (run) {
    if (kind === 'new') {
      where.push('e.created_run = ?');
      args.push(Number(run));
    } else if (kind === 'updated') {
      where.push('e.updated_run = ? AND e.created_run IS NOT e.updated_run');
      args.push(Number(run));
    } else {
      where.push('(e.created_run = ? OR e.updated_run = ?)');
      args.push(Number(run), Number(run));
    }
  } else if (kind === 'updated') {
    where.push('e.updated_at > e.created_at');
  }

  // 動態欄位篩選：只接受該網站真的有的欄位（白名單）
  const known = new Map(getSiteFields(db, site, { all: true }).map((f) => [f.key, f]));
  let filters = {};
  try {
    filters = JSON.parse(p.get('filters') || '{}');
  } catch {
    // 忽略壞掉的 filters
  }
  for (const [key, cond] of Object.entries(filters)) {
    const f = known.get(key);
    if (!f || !cond) continue;
    const path = `$."${key.replace(/"/g, '')}"`;
    const num = f.type === 'number';
    const expr = num ? 'CAST(json_extract(e.fields_json, ?) AS REAL)' : 'json_extract(e.fields_json, ?)';
    if (cond.eq != null && cond.eq !== '') {
      const list = [].concat(cond.eq);
      const marks = list.map(() => '?').join(',');
      // tags：陣列裡任一個值符合
      where.push(f.type === 'tags'
        ? `EXISTS (SELECT 1 FROM json_each(e.fields_json, ?) WHERE value IN (${marks}))`
        : `${expr} IN (${marks})`);
      args.push(path, ...list);
    }
    if (cond.like) {
      where.push(`${expr} LIKE ?`);
      args.push(path, `%${cond.like}%`);
    }
    if (cond.min != null && cond.min !== '') {
      where.push(`${expr} >= ?`);
      args.push(path, num ? Number(cond.min) : cond.min);
    }
    if (cond.max != null && cond.max !== '') {
      where.push(`${expr} <= ?`);
      args.push(path, num ? Number(cond.max) : cond.max);
    }
  }

  const sortCols = { created: 'e.created_at', updated: 'e.updated_at', name: 'e.name', seen: 'e.last_seen_at' };
  const sort = sortCols[p.get('sort')] ?? 'e.created_at';
  const dir = p.get('dir') === 'asc' ? 'ASC' : 'DESC';
  // size=all：下載用，取全部
  const size = p.get('size') === 'all' ? 100000 : Math.min(Math.max(Number(p.get('size')) || 50, 1), 500);
  const page = Math.max(Number(p.get('page')) || 1, 1);
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM events e WHERE ${w}`).get(...args).n;
  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.url, e.fields_json, e.created_at, e.updated_at, e.last_seen_at, e.created_run, e.updated_run,
              (SELECT json_group_array(changed_at) FROM
                (SELECT changed_at FROM event_history h WHERE h.event_id = e.id ORDER BY h.changed_at)) AS history_json
       FROM events e WHERE ${w} ORDER BY ${sort} ${dir}, e.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, size, (page - 1) * size)
    .map(({ fields_json, history_json, ...r }) => withTimes({ ...r, fields: JSON.parse(fields_json) }, JSON.parse(history_json ?? '[]')));
  return { total, page, size, rows };
}

/**
 * 三個時間資訊：
 *  first_seen：第一次抓到的時間
 *  latest：最近一次內容有變動的時間（沒變過＝first_seen）
 *  timeline：歷史時間點陣列 [第一次抓到, 每一次變動…]
 */
function withTimes(r, changes) {
  const timeline = [r.created_at, ...changes.filter((t) => t && t !== r.created_at)];
  return { ...r, first_seen: r.created_at, latest: timeline[timeline.length - 1], timeline };
}

export function getEvent(db, id) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(id));
  if (!ev) return null;
  const history = db
    .prepare('SELECT run_id, changed_at, changes_json FROM event_history WHERE event_id = ? ORDER BY id DESC')
    .all(ev.id)
    .map(({ changes_json, ...h }) => ({ ...h, changes: JSON.parse(changes_json) }));
  const { fields_json, ...rest } = ev;
  return withTimes({ ...rest, fields: JSON.parse(fields_json), history }, [...history].reverse().map((h) => h.changed_at));
}

export function listRuns(db, site, limit = 20) {
  return db
    .prepare(`SELECT * FROM crawl_runs ${site ? 'WHERE site_id = ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(...(site ? [site] : []), Math.min(Number(limit) || 20, 200));
}

export function siteStats(db, siteId) {
  return {
    count: db.prepare('SELECT COUNT(*) AS n FROM events WHERE site_id = ?').get(siteId)?.n ?? 0,
    lastRun: db.prepare('SELECT * FROM crawl_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(siteId) ?? null,
  };
}

/** 頂端統計：總筆數、今天新增、今天更新、近 7 天新增（台灣時間） */
export function siteSummary(db, siteId) {
  const day = (offset = 0) => new Date(Date.now() - offset * 86400_000).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 10);
  const n = (sql, ...args) => db.prepare(sql).get(siteId, ...args)?.n ?? 0;
  return {
    total: n('SELECT COUNT(*) AS n FROM events WHERE site_id = ?'),
    today_new: n('SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND created_at >= ?', day()),
    today_updated: n('SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND updated_at >= ? AND updated_at > created_at', day()),
    week_new: n('SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND created_at >= ?', day(6)),
    today: day(),
    week_start: day(6),
  };
}
