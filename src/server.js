import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { loadSites } from './adapters/index.js';
import { analyzeListPage, createGenericAdapter } from './adapters/generic.js';
import { config, log, ROOT } from './config.js';
import { runCrawl } from './core/crawler.js';
import { fetchHtml } from './core/fetcher.js';
import { readSitesFile, writeSitesFile } from './core/sites-file.js';
import { markStaleRuns, openDb, tx } from './core/store.js';
import { getEvent, getSiteFields, listRuns, queryEvents, siteStats } from './shared/query.js';
import { startDailyScheduler } from './scheduler.js';

const db = openDb(config.dbFile);
markStaleRuns(db);
const STATIC_DIRS = { '/shared/': join(ROOT, 'src', 'shared'), '/': join(ROOT, 'public') };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const sites = () => loadSites(config);
const findSite = (id) => sites().find((s) => s.adapter.id === id);

// ---- 爬取（排程與手動共用一把鎖，一次只跑一個） ----
let crawling = null;
function crawl(trigger, siteId = null) {
  if (crawling) return crawling;
  crawling = (async () => {
    const targets = siteId ? sites().filter((s) => s.adapter.id === siteId) : sites().filter((s) => s.enabled);
    const results = [];
    for (const s of targets) {
      try {
        results.push(await runCrawl(db, s.adapter, { maxPages: s.maxPages, initialPages: s.initialPages, trigger, log, ...s.options }));
      } catch (err) {
        results.push({ site: s.adapter.id, error: err.message });
      }
    }
    return results;
  })().finally(() => {
    crawling = null;
  });
  return crawling;
}

const scheduler = startDailyScheduler({
  time: config.crawlTime,
  task: () => crawl('schedule'),
  lastRunAt: () => db.prepare(`SELECT MAX(started_at) AS t FROM crawl_runs WHERE status = 'done'`).get().t,
  log,
});

// ---- 網站設定（網頁新增網站，存 sites.json） ----
const CONFIG_KEYS = ['listUrl', 'linkPattern', 'fetchDetail', 'titleSelector', 'contentSelector', 'trackDescription',
  'volatileFields', 'maxPages', 'initialPages', 'encoding', 'autoPaging', 'defaultLocation'];

function cleanConfig(body) {
  const cfg = {};
  for (const k of CONFIG_KEYS) if (body[k] !== undefined && body[k] !== '') cfg[k] = body[k];
  if (!/^https?:\/\//i.test(cfg.listUrl ?? '')) throw new Error('列表網址需以 http:// 或 https:// 開頭');
  cfg.fetchDetail = cfg.fetchDetail !== false;
  cfg.trackDescription = !!cfg.trackDescription;
  cfg.volatileFields = [].concat(cfg.volatileFields ?? []).filter(Boolean);
  cfg.maxPages = Math.min(Math.max(Number(cfg.maxPages) || 5, 1), 100);
  if (cfg.initialPages) cfg.initialPages = Math.min(Math.max(Number(cfg.initialPages), 1), 300);
  createGenericAdapter({ ...cfg, id: 'check', name: 'check' }); // 驗證規則可用
  return cfg;
}

function newSiteId(listUrl) {
  const base = new URL(listUrl.replaceAll('{page}', '1')).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  let id = base;
  for (let i = 2; findSite(id); i++) id = `${base}-${i}`;
  return id;
}

async function previewSite(body) {
  if (!/^https?:\/\//i.test(body.listUrl ?? '')) throw new Error('請輸入完整的列表網址（http/https）');
  const pageUrl = body.listUrl.replaceAll('{page}', '1');
  let html;
  try {
    html = await fetchHtml(pageUrl, { minInterval: 300, retries: 1, encoding: body.encoding || 'auto' });
  } catch (err) {
    const status = Number(err.message.match(/HTTP (\d+)/)?.[1]);
    if (status === 403 || status === 401 || status === 429) {
      throw new Error(`這個網站拒絕自動程式存取（HTTP ${status}），無法抓取。這類網站通常有防爬蟲機制，或需要登入（例如 104、Facebook）。`);
    }
    if (status === 404) throw new Error('找不到這個網址（HTTP 404），請確認網址是否正確。');
    throw new Error(`無法開啟這個網址：${err.message}`);
  }
  const analysis = analyzeListPage(html, pageUrl);
  const linkPattern = body.linkPattern || analysis.candidates[0]?.pattern || null;
  const title = html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim() ?? '';
  const result = { pageUrl, title, ...analysis, linkPattern, items: [], details: [] };
  if (!linkPattern) return result;
  const adapter = createGenericAdapter({ ...body, linkPattern, id: 'preview', name: 'preview' });
  result.items = adapter.parseList(html, pageUrl).items.slice(0, 20);
  if (adapter.parseDetail) {
    for (const item of result.items.slice(0, 3)) {
      try {
        const d = adapter.parseDetail(await fetchHtml(item.url, { minInterval: 300, retries: 1 }), item.url);
        result.details.push({ name: item.name, url: item.url, fields: { ...item.fields, ...d.fields } });
      } catch (err) {
        result.details.push({ name: item.name, url: item.url, error: err.message });
      }
    }
  }
  return result;
}

// ---- HTTP ----
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new Error('body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/** 設了 ADMIN_PASSWORD 就要求 Basic Auth */
function authorized(req) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return true;
  const m = (req.headers.authorization ?? '').match(/^Basic (.+)$/);
  if (!m) return false;
  const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  const a = Buffer.from(`${user}:${rest.join(':')}`);
  const b = Buffer.from(`${process.env.ADMIN_USER ?? 'admin'}:${pass}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  const p = url.searchParams;
  const method = req.method;
  let m;

  if (path === '/healthz') return json(res, 200, { ok: true });
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="crawler", charset="UTF-8"' });
    return res.end('需要登入');
  }

  if (path === '/api/sites' && method === 'GET') {
    return json(res, 200, sites().map((s) => ({
      id: s.adapter.id,
      name: s.adapter.name,
      baseUrl: s.adapter.baseUrl,
      custom: s.custom,
      enabled: s.enabled,
      configured: s.adapter.configured !== false,
      maxPages: s.maxPages,
      config: s.config ?? null,
      ...siteStats(db, s.adapter.id),
    })));
  }
  if (path === '/api/site-configs/preview' && method === 'POST') {
    try {
      return json(res, 200, await previewSite(await readBody(req)));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }
  if (path === '/api/site-configs' && method === 'POST') {
    const body = await readBody(req);
    let cfg;
    try {
      cfg = cleanConfig(body);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    const id = newSiteId(cfg.listUrl);
    const name = String(body.name || '').trim() || id;
    writeSitesFile(config.sitesFile, [...readSitesFile(config.sitesFile), { id, name, enabled: true, ...cfg }]);
    log(`[網站] 新增 ${id}（${name}）`);
    return json(res, 201, { id });
  }
  if ((m = path.match(/^\/api\/site-configs\/([\w-]+)$/))) {
    const list = readSitesFile(config.sitesFile);
    const idx = list.findIndex((s) => s.id === m[1]);
    if (idx < 0) return json(res, 404, { error: '只有網頁新增的網站可以修改/刪除' });
    const cur = list[idx];
    if (method === 'PUT') {
      const body = await readBody(req);
      let next = { ...cur };
      try {
        if (CONFIG_KEYS.some((k) => k in body)) next = { ...next, ...cleanConfig({ ...cur, ...body }) };
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      if (body.name !== undefined) next.name = String(body.name).trim() || cur.name;
      if (body.enabled !== undefined) next.enabled = !!body.enabled;
      list[idx] = next;
      writeSitesFile(config.sitesFile, list);
      return json(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      list.splice(idx, 1);
      writeSitesFile(config.sitesFile, list);
      if (p.get('purge') === '1') {
        tx(db, () => {
          db.prepare('DELETE FROM event_history WHERE event_id IN (SELECT id FROM events WHERE site_id = ?)').run(cur.id);
          for (const t of ['events', 'site_fields', 'crawl_runs']) db.prepare(`DELETE FROM ${t} WHERE site_id = ?`).run(cur.id);
        });
      }
      log(`[網站] 刪除 ${cur.id}${p.get('purge') === '1' ? '（含資料）' : ''}`);
      return json(res, 200, { ok: true });
    }
  }
  if ((m = path.match(/^\/api\/sites\/([\w-]+)\/fields$/))) {
    return json(res, 200, getSiteFields(db, m[1], { all: p.get('all') === '1' }));
  }
  if (path === '/api/events') {
    if (!p.get('site')) return json(res, 400, { error: 'site 必填' });
    return json(res, 200, queryEvents(db, p));
  }
  if ((m = path.match(/^\/api\/events\/(\d+)$/))) {
    const ev = getEvent(db, m[1]);
    return ev ? json(res, 200, ev) : json(res, 404, { error: 'not found' });
  }
  if (path === '/api/runs') return json(res, 200, listRuns(db, p.get('site'), p.get('limit')));
  if (path === '/api/status') {
    return json(res, 200, { crawling: !!crawling, crawlTime: config.crawlTime, nextRunAt: scheduler.state.nextRunAt });
  }
  if (path === '/api/crawl' && method === 'POST') {
    const { site } = await readBody(req);
    if (site && !findSite(site)) return json(res, 404, { error: '沒有這個網站' });
    const already = !!crawling;
    crawl('manual', site || null).catch(() => {});
    return json(res, 202, { started: !already, crawling: true });
  }

  // 靜態檔：/shared/* → src/shared（前端共用查詢），其他 → public
  const [prefix, dir] = Object.entries(STATIC_DIRS).find(([pre]) => path.startsWith(pre));
  const file = normalize(join(dir, path === '/' ? 'index.html' : path.slice(prefix.length)));
  if (!file.startsWith(dir)) return json(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    log(`[http] ${req.url} ${err.stack}`);
    json(res, 500, { error: err.message });
  });
}).listen(config.port, () => log(`[http] http://localhost:${config.port}${process.env.ADMIN_PASSWORD ? '（已啟用登入）' : ''}`));
