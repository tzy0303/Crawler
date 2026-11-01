import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
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

/** console + data/logs/YYYY-MM.log */
export function log(msg) {
  const line = `${now()} ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${line.slice(0, 7)}.log`), line + '\n');
  } catch {
    // 寫日誌失敗不影響爬蟲
  }
}
