import { readFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { now } from './core/store.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const raw = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
export const config = {
  ...raw,
  port: Number(process.env.PORT ?? raw.port ?? 5190),
  crawlTime: process.env.CRAWL_TIME ?? raw.crawlTime ?? '06:00',
  dbFile: resolve(ROOT, process.env.DB_FILE ?? raw.dbFile ?? 'data/crawler.db'),
  sitesFile: resolve(ROOT, process.env.SITES_FILE ?? raw.sitesFile ?? 'sites.json'),
};

const LOG_DIR = join(dirname(config.dbFile), 'logs');

const KEEP_MONTHS = 12;
let pruned = false;
/** 刪掉 12 個月以前的日誌（每次執行檢查一次） */
function pruneLogs(month) {
  pruned = true;
  const [y, m] = month.split('-').map(Number);
  const oldest = new Date(Date.UTC(y, m - 1 - (KEEP_MONTHS - 1), 1)).toISOString().slice(0, 7);
  for (const f of readdirSync(LOG_DIR)) if (/^d{4}-d{2}.log$/.test(f) && f.slice(0, 7) < oldest) unlinkSync(join(LOG_DIR, f));
}

/** console + data/logs/YYYY-MM.log（保留 12 個月） */
export function log(msg) {
  const line = `${now()} ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (!pruned) pruneLogs(line.slice(0, 7));
    appendFileSync(join(LOG_DIR, `${line.slice(0, 7)}.log`), line + '\n');
  } catch {
    // 寫日誌失敗不影響爬蟲
  }
}
