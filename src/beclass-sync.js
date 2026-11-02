// 家裡電腦每天抓 BeClass（BeClass 封鎖雲端主機 IP）→ 加密推到 data-beclass 分支 → 通知雲端合併並發佈網站。
// 執行的是這台電腦上的程式，不是 GitHub 送來的：repo 被改也不會在這台電腦執行任何東西。
// .env：SITE_PASSWORD、GH_SYNC_TOKEN（只授權此 repo：Contents、Actions 讀寫）、GH_REPO（例如 tzy0303/Crawler）
//       選填 BECLASS_DB_FILE（預設 data/beclass.db）、GH_BRANCH（預設 main）
// 用法：node --env-file-if-exists=.env src/beclass-sync.js
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { log, ROOT } from './config.js';
import { githubClient } from './core/github.js';
import { now } from './core/store.js';

const env = process.env;
// 沒有密碼就停：不能把未加密的資料推到 public repo
if (!env.SITE_PASSWORD?.trim()) {
  log('[BeClass 同步] 沒有設定 SITE_PASSWORD，停止（不推送未加密資料）');
  process.exit(1);
}
const gh = githubClient({ repo: env.GH_REPO, token: env.GH_SYNC_TOKEN?.trim() });
const dbFile = resolve(ROOT, env.BECLASS_DB_FILE || 'data/beclass.db');

/** 用同一個 node 跑專案裡的腳本，資料庫指向 BeClass 專用的檔案 */
function run(script, ...args) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join('src', script), ...args], {
    cwd: ROOT,
    env: { ...env, DB_FILE: dbFile },
    stdio: 'inherit',
  });
  return r.status === 0;
}

// 抓取失敗（例如部分頁面逾時）仍推送已抓到的資料，和雲端版的做法一樣
if (!run('crawl.js', '--site', 'beclass')) log('[BeClass 同步] 抓取有錯誤，仍推送目前資料');
if (!run('backfill.js')) {
  log('[BeClass 同步] 補齊地點失敗，停止');
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'beclass-sync-'));
try {
  const out = join(dir, 'beclass.enc');
  if (!run('fragment.js', 'export', 'beclass', out)) throw new Error('匯出失敗');
  const sha = await gh.replaceBranch('data-beclass', 'beclass.enc', readFileSync(out), `beclass ${now()}`);
  log(`[BeClass 同步] 已推送 data-beclass（${sha.slice(0, 7)}）`);
  if (await gh.ensureWorkflowEnabled('crawl.yml')) log('[BeClass 同步] 雲端每日抓取被 GitHub 停用了，已重新啟用');
  // site=beclass：雲端只合併 BeClass 並發佈，不重抓其他網站
  await gh.dispatch('crawl.yml', env.GH_BRANCH || 'main', { site: 'beclass' });
  log('[BeClass 同步] 已通知雲端合併發佈');
} catch (err) {
  log(`[BeClass 同步] 失敗：${err.message}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
