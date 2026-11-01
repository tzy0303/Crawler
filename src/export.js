// 匯出雲端靜態網站（GitHub Pages）：node src/export.js [輸出資料夾]
// 網頁 + 共用模組 + 資料庫副本 + static.json（網站清單）
// 有設定 SITE_PASSWORD 時：資料庫和網站清單加密成 data.enc，網頁要輸入密碼才看得到
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadSites } from './adapters/index.js';
import { config, ROOT } from './config.js';
import { copyDir, removeDir } from './core/fsutil.js';
import { now, openDb } from './core/store.js';
import { encryptBytes, packBundle } from './shared/crypto.js';
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
const info = {
  generatedAt: now(),
  repo: process.env.GITHUB_REPOSITORY ?? null,
  branch: process.env.GITHUB_REF_NAME ?? 'main',
  crawlTime: config.crawlTime,
  sites,
};

const password = process.env.SITE_PASSWORD;
if (password) {
  const bundle = packBundle(info, new Uint8Array(readFileSync(dbOut)));
  writeFileSync(join(out, 'data.enc'), await encryptBytes(bundle, password));
  unlinkSync(dbOut);
  // 公開的 static.json 只說「要登入」，不含任何資料
  writeFileSync(join(out, 'static.json'), JSON.stringify({ encrypted: true }));
  console.log(`已匯出 ${out}（已加密，data.enc ${(statSync(join(out, 'data.enc')).size / 1024 / 1024).toFixed(1)} MB，${sites.length} 個網站）`);
} else {
  writeFileSync(join(out, 'static.json'), JSON.stringify(info, null, 1));
  console.log(`已匯出 ${out}（未加密，資料庫 ${(statSync(dbOut).size / 1024 / 1024).toFixed(1)} MB，${sites.length} 個網站）`);
}
writeFileSync(join(out, '.nojekyll'), '');
