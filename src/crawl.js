// 用法：node src/crawl.js [--site beclass] [--skip beclass,xxx] [--pages N] [--full]
import { parseArgs } from 'node:util';
import { loadSites } from './adapters/index.js';
import { config, log } from './config.js';
import { runCrawl } from './core/crawler.js';
import { openDb } from './core/store.js';

const { values } = parseArgs({
  options: {
    site: { type: 'string' },
    skip: { type: 'string' }, // 雲端用：BeClass 由家裡電腦（self-hosted runner）抓
    pages: { type: 'string' },
    full: { type: 'boolean', default: false },
  },
});

const db = openDb(config.dbFile);
const all = loadSites(config);
const skip = new Set((values.skip ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const sites = values.site
  ? all.filter((s) => s.adapter.id === values.site)
  : all.filter((s) => s.enabled && !skip.has(s.adapter.id));
if (values.site && !sites.length) {
  log(`未知的網站：${values.site}（可用：${all.map((s) => s.adapter.id).join(', ')}）`);
  process.exitCode = 1;
}

for (const site of sites) {
  const pages = values.pages ? Number(values.pages) : undefined;
  try {
    await runCrawl(db, site.adapter, {
      maxPages: pages ?? site.maxPages,
      initialPages: pages ?? site.initialPages,
      full: values.full,
      trigger: 'cli',
      log,
      ...site.options,
    });
  } catch {
    process.exitCode = 1;
  }
}
db.close();
