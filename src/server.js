import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { loadSites } from './adapters/index.js';
import { analyzeListPage, createGenericAdapter } from './adapters/generic.js';
import { config, log, ROOT } from './config.js';
import { runCrawl } from './core/crawler.js';
import { fetchHtml } from './core/fetcher.js';
import { readSitesFile, writeSitesFile } from './core/sites-file.js';
import { markStaleRuns, openDb, tx } from './core/store.js';
import { getEvent, getSiteFields, listRuns, queryEvents, siteStats, siteSummary } from './shared/query.js';
import { startDailyScheduler } from './scheduler.js';

const db = openDb(config.dbFile);
markStaleRuns(db);
const STATIC_DIRS = {
  '/shared/': join(ROOT, 'src', 'shared'),
  '/vendor/': join(ROOT, 'node_modules', 'sql.js', 'dist'),
  '/': join(ROOT, 'public'),
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm' };
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
// 預設只接受本機連線；要讓其他電腦連（Docker、雲端）設 HOST=0.0.0.0，而且一定要設 ADMIN_PASSWORD
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);
if (!LOOPBACK && !process.env.ADMIN_PASSWORD) {
  log(`[http] HOST=${HOST} 會開放給其他電腦連線，必須設定 ADMIN_PASSWORD，停止啟動`);
  process.exit(1);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw httpError(413, '資料太大');
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw httpError(400, '資料格式錯誤（需要 JSON）');
  }
}

const clientIp = (req) => req.socket.remoteAddress ?? '?';

// 登入失敗太多次就暫時封鎖（每個 IP：15 分鐘內 10 次）
const LOGIN_WINDOW = 15 * 60_000, LOGIN_MAX_FAILS = 10;
const loginFails = new Map(); // ip → { count, since }
const lockedOut = (ip) => {
  const f = loginFails.get(ip);
  if (f && Date.now() - f.since > LOGIN_WINDOW) loginFails.delete(ip);
  return (loginFails.get(ip)?.count ?? 0) >= LOGIN_MAX_FAILS;
};

/** 設了 ADMIN_PASSWORD 就要求 Basic Auth */
function authorized(req) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return true;
  const m = (req.headers.authorization ?? '').match(/^Basic (.+)$/);
  if (!m) return false;
  const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  const a = Buffer.from(`${user}:${rest.join(':')}`);
  const b = Buffer.from(`${process.env.ADMIN_USER ?? 'admin'}:${pass}`);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    const ip = clientIp(req);
    const f = loginFails.get(ip) ?? { count: 0, since: Date.now() };
    loginFails.set(ip, { ...f, count: f.count + 1 });
    log(`[http] 登入失敗 ${ip}（第 ${f.count + 1} 次）`);
  }
  return ok;
}

/**
 * 擋掉別的網站冒用你的瀏覽器發出的請求（CSRF），以及 DNS rebinding：
 * 只聽本機時 Host 必須是 localhost；寫入類請求的 Origin 必須是本站、內容必須是 JSON。
 */
function rejectForeign(req) {
  const host = req.headers.host ?? '';
  if (LOOPBACK && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return '不接受這個網址的連線';
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return '不接受其他網站送來的請求';
  if (req.headers['sec-fetch-site'] === 'cross-site') return '不接受其他網站送來的請求';
  if ((req.method === 'POST' || req.method === 'PUT') && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    return '需要 Content-Type: application/json';
  }
  return null;
}

async function handle(req, res) {
  // 不讓別的網站把這個頁面嵌進框架（點擊劫持）、不讓瀏覽器亂猜檔案類型
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');

  const url = new URL(req.url, 'http://localhost');
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return json(res, 400, { error: '網址格式錯誤' });
  }
  const p = url.searchParams;
  const method = req.method;
  const ip = clientIp(req);
  let m;

  if (path === '/healthz') return json(res, 200, { ok: true });
  const foreign = rejectForeign(req);
  if (foreign) {
    log(`[http] 拒絕 ${ip} ${method} ${path}：${foreign}`);
    return json(res, 403, { error: foreign });
  }
  if (lockedOut(ip)) return json(res, 429, { error: '登入失敗太多次，請 15 分鐘後再試' });
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
    log(`[網站] 新增 ${id}（${name}）來源 ${ip}`);
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
      log(`[網站] 修改 ${cur.id} 來源 ${ip}`);
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
      log(`[網站] 刪除 ${cur.id}${p.get('purge') === '1' ? '（含資料）' : ''} 來源 ${ip}`);
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
  if (path === '/api/summary') return json(res, 200, siteSummary(db, p.get('site')));
  if (path === '/api/status') {
    return json(res, 200, { crawling: !!crawling, crawlTime: config.crawlTime, nextRunAt: scheduler.state.nextRunAt });
  }
  if (path === '/api/crawl' && method === 'POST') {
    const { site } = await readBody(req);
    if (site && !findSite(site)) return json(res, 404, { error: '沒有這個網站' });
    const already = !!crawling;
    log(`[http] 手動抓取 ${site || '全部'} 來源 ${ip}`);
    crawl('manual', site || null).catch(() => {});
    return json(res, 202, { started: !already, crawling: true });
  }

  // 靜態檔：/shared/* → src/shared（前端共用查詢），其他 → public
  const [prefix, dir] = Object.entries(STATIC_DIRS).find(([pre]) => path.startsWith(pre));
  const file = normalize(join(dir, path === '/' ? 'index.html' : path.slice(prefix.length)));
  if (file !== dir && !file.startsWith(dir + sep)) return json(res, 403, { error: 'forbidden' });
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
    if (err.status && err.status < 500) return json(res, err.status, { error: err.message });
    log(`[http] ${req.url} ${err.stack}`);
    json(res, 500, { error: '伺服器發生錯誤，詳情請看日誌' });
  });
}).listen(config.port, HOST, () =>
  log(`[http] http://${LOOPBACK ? 'localhost' : HOST}:${config.port}${LOOPBACK ? '（只接受本機連線）' : ''}${process.env.ADMIN_PASSWORD ? '（已啟用登入）' : ''}`));
