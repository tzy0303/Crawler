// 匯出雲端靜態網站（GitHub Pages）：node src/export.js [輸出資料夾]
// 網頁 + 共用查詢模組 + 資料庫副本 + static.json（網站清單）
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadSites } from './adapters/index.js';
import { config, ROOT } from './config.js';
import { copyDir, removeDir } from './core/fsutil.js';
import { now, openDb } from './core/store.js';
import { siteStats } from './shared/query.js';

const out = resolve(process.argv[2] ?? '_site');
removeDir(out);
mkdirSync(join(out, 'shared'), { recursive: true });
copyDir(join(ROOT, 'public'), out);
copyDir(join(ROOT, 'src', 'shared'), join(out, 'shared'));

const db = openDb(config.dbFile);
const dbOut = join(out, 'crawler.db');
db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
// 瀏覽器（sql.js）不能開 WAL 模式的檔案
const copy = new DatabaseSync(dbOut);
copy.exec('PRAGMA journal_mode = DELETE;');
copy.close();

const sites = loadSites(config).map((s) => ({
  id: s.adapter.id,
  name: s.adapter.name,
  baseUrl: s.adapter.baseUrl,
  custom: s.custom,
  enabled: s.enabled,
  configured: s.adapter.configured !== false,
  maxPages: s.maxPages,
  config: s.config ?? null,
  ...siteStats(db, s.adapter.id),
}));
writeFileSync(join(out, 'static.json'), JSON.stringify({
  generatedAt: now(),
  repo: process.env.GITHUB_REPOSITORY ?? null,
  branch: process.env.GITHUB_REF_NAME ?? 'main',
  crawlTime: config.crawlTime,
  sites,
}, null, 1));
writeFileSync(join(out, '.nojekyll'), '');
console.log(`已匯出 ${out}（資料庫 ${(statSync(dbOut).size / 1024 / 1024).toFixed(1)} MB，${sites.length} 個網站）`);
