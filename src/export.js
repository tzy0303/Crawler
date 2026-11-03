// 匯出雲端靜態網站（GitHub Pages）：node src/export.js [輸出資料夾]
// 網頁 + 共用模組 + 資料庫副本 + static.json（網站清單）
// 有設定 SITE_PASSWORD 時：資料庫和網站清單加密成 data.enc，網頁要輸入密碼才看得到
import { copyFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadSites } from './adapters/index.js';
import { config, ROOT } from './config.js';
import { copyDir, removeDir } from './core/fsutil.js';
import { now, openDb } from './core/store.js';
import { assertStrongPassword, deriveSiteKey, encryptWithKey, packBundle } from './shared/crypto.js';
import { siteStats } from './shared/query.js';

// Secrets 貼上時常多帶空白或換行；網頁登入時打的密碼不會有
const password = process.env.SITE_PASSWORD?.trim();
// 雲端（GitHub Actions）一定要加密：Secret 被誤刪時寧可停下來，也不把資料公開
if (!password && process.env.GITHUB_ACTIONS === 'true' && process.env.ALLOW_PUBLIC_DATA !== 'true') {
  console.error('沒有 SITE_PASSWORD，停止匯出（不發佈未加密資料）。真的要公開資料才設 ALLOW_PUBLIC_DATA=true');
  process.exit(1);
}
if (password) assertStrongPassword(password);

const out = resolve(process.argv[2] ?? '_site');
removeDir(out);
mkdirSync(join(out, 'shared'), { recursive: true });
copyDir(join(ROOT, 'public'), out);
copyDir(join(ROOT, 'src', 'shared'), join(out, 'shared'));
// sql.js 放在自己的網站上，不從外部 CDN 載入（CDN 被入侵也偷看不到解密後的資料）
mkdirSync(join(out, 'vendor'), { recursive: true });
for (const file of ['sql-wasm.js', 'sql-wasm.wasm']) copyFileSync(join(ROOT, 'node_modules', 'sql.js', 'dist', file), join(out, 'vendor', file));

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

if (password) {
  // 先壓縮再加密（資料庫多為文字，約省 2/3，網頁開啟快很多）
  const bundle = gzipSync(packBundle(info, new Uint8Array(readFileSync(dbOut))), { level: 9 });
  // 金鑰由密碼＋網站固定鹽推導，瀏覽器才能只記住金鑰、不存明文密碼
  const salt = `crawler-site:${process.env.GITHUB_REPOSITORY ?? 'local'}`;
  writeFileSync(join(out, 'data.enc'), await encryptWithKey(bundle, await deriveSiteKey(password, salt)));
  unlinkSync(dbOut);
  // 公開的 static.json 只說「要登入」，不含任何資料；version 讓瀏覽器在資料沒更新時用快取
  writeFileSync(join(out, 'static.json'), JSON.stringify({ encrypted: true, compressed: 'gzip', format: 'CRW2', salt, version: info.generatedAt }));
  console.log(`已匯出 ${out}（已加密，data.enc ${(statSync(join(out, 'data.enc')).size / 1024 / 1024).toFixed(1)} MB，${sites.length} 個網站）`);
} else {
  writeFileSync(join(out, 'static.json'), JSON.stringify(info, null, 1));
  console.log(`已匯出 ${out}（未加密，資料庫 ${(statSync(dbOut).size / 1024 / 1024).toFixed(1)} MB，${sites.length} 個網站）`);
}
writeFileSync(join(out, '.nojekyll'), '');
