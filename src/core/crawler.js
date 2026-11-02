import { fetchHtml } from './fetcher.js';
import { addDerivedFields, DERIVED_FIELDS, normalizeName } from './extract.js';
import { upsertEvent } from './differ.js';
import { recomputeSiteFields } from './fields.js';
import { ensureSite, finishRun, startRun } from './store.js';

const QUIET_PAGES_TO_STOP = 2;
// GitHub Actions 的執行紀錄是公開的：雲端只記數量，不印出活動/職缺名稱
const ON_CI = !!process.env.GITHUB_ACTIONS;

/**
 * 爬一個網站。
 *  增量（預設）：從第 1 頁往後，連續 2 頁沒有新增/修改就停
 *  full：掃到最後一頁
 *  adapter 有 collect()（例如讀通知信）時：一次取得所有項目，不翻頁
 */
export async function runCrawl(db, adapter, { maxPages = 30, initialPages = 20, full = false, trigger = 'manual',
  log = console.log, fetch = fetchHtml, ...sourceOpts } = {}) {
  ensureSite(db, adapter);
  const isFirstRun = !db.prepare('SELECT 1 FROM events WHERE site_id = ? LIMIT 1').get(adapter.id);
  const pageLimit = full ? Infinity : isFirstRun ? initialPages : maxPages;
  const runId = startRun(db, adapter.id, trigger);
  const stats = { pages: 0, seen: 0, newCount: 0, updatedCount: 0, failedDetails: 0 };
  const seenKeys = new Set();
  const volatile = [...(adapter.volatileFields ?? []), ...DERIVED_FIELDS];
  log(`[${adapter.id}] run #${runId} 開始（${full ? '完整' : isFirstRun ? '首次' : '增量'}）`);

  const itemLog = ON_CI ? () => {} : log;
  const record = (item, extra = {}, partial = false) => {
    const fields = { ...item.fields, ...extra.fields };
    const derived = addDerivedFields(fields, { defaultLocation: adapter.defaultLocation, text: extra.description });
    const result = upsertEvent(db, adapter.id,
      { name: item.name, url: item.url, sourceId: item.sourceId, fields, description: extra.description },
      { runId, volatile: [...volatile, ...derived], partial });
    stats.seen++;
    if (result === 'new') {
      stats.newCount++;
      itemLog(`[${adapter.id}]   + 新增：${item.name}`);
    } else if (result === 'updated') {
      stats.updatedCount++;
      itemLog(`[${adapter.id}]   * 修改：${item.name}`);
    }
    return result !== 'same';
  };

  try {
    if (adapter.collect) {
      const items = await adapter.collect({ isFirstRun, log, maxPages, initialPages, ...sourceOpts });
      stats.pages = 1;
      for (const item of items) {
        const key = normalizeName(item.name);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        record(item);
      }
      recomputeSiteFields(db, adapter.id);
      finishRun(db, runId, stats);
      log(`[${adapter.id}] run #${runId} 完成：${items.length} 筆、新增 ${stats.newCount}、修改 ${stats.updatedCount}`);
      return { runId, ...stats };
    }

    let quiet = 0;
    const fetchOpts = { encoding: adapter.encoding ?? 'auto' };
    for (let page = 1; page <= pageLimit; page++) {
      const listUrl = adapter.listUrl(page);
      if (!listUrl) break;
      let html;
      try {
        html = await fetch(listUrl, fetchOpts);
      } catch (err) {
        // 列表頁被擋（403）而網站有官方 RSS 之類的備援 → 改用備援，只新增不判斷修改
        if (page !== 1 || !adapter.fallback || !/HTTP 403/.test(err.message)) throw err;
        log(`[${adapter.id}] 列表頁被拒（403），改讀官方 RSS：${adapter.fallback.url}`);
        const items = adapter.fallback.parse(await fetch(adapter.fallback.url, fetchOpts));
        stats.pages = 1;
        for (const item of items) {
          const key = normalizeName(item.name);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          record(item, {}, true);
        }
        break;
      }
      const { items, totalPages } = adapter.parseList(html, listUrl);
      stats.pages = page;
      // 沒有資料，或整頁都是這次已看過的（超過最後一頁時有些網站會重複顯示最後一頁）→ 結束
      if (!items.length || items.every((i) => seenKeys.has(normalizeName(i.name)))) break;
      let changed = 0;
      for (const item of items) {
        const key = normalizeName(item.name);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        let detail;
        try {
          detail = adapter.parseDetail ? adapter.parseDetail(await fetch(item.url, fetchOpts), item.url) : { fields: {} };
        } catch (err) {
          // 詳細頁抓不到就跳過，避免只有列表欄位時被誤判成「修改」；下次再補
          stats.failedDetails++;
          itemLog(`[${adapter.id}]   詳細頁失敗：${item.name}：${err.message}`);
          continue;
        }
        if (record(item, detail)) changed++;
      }
      log(`[${adapter.id}] 第 ${page}${totalPages ? `/${totalPages}` : ''} 頁：${items.length} 筆，變動 ${changed}`);
      if (totalPages && page >= totalPages) break;
      if (!full && !isFirstRun) {
        quiet = changed ? 0 : quiet + 1;
        if (quiet >= QUIET_PAGES_TO_STOP) break;
      }
    }
    recomputeSiteFields(db, adapter.id);
    finishRun(db, runId, stats);
    log(`[${adapter.id}] run #${runId} 完成：${stats.pages} 頁、看過 ${stats.seen}、新增 ${stats.newCount}、修改 ${stats.updatedCount}`);
    return { runId, ...stats };
  } catch (err) {
    recomputeSiteFields(db, adapter.id);
    finishRun(db, runId, stats, err.message);
    log(`[${adapter.id}] run #${runId} 失敗：${err.message}`);
    throw err;
  }
}
