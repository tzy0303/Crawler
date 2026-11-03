// 活動更新爬蟲：網頁程式（從 index.html 拆出來，才能套用嚴格的內容安全政策 CSP）
// 被嵌進別的網站的框架時不顯示（防點擊劫持；GitHub Pages 不能設 X-Frame-Options）
if (window.top !== window.self) { document.documentElement.hidden = true; throw new Error('不允許在框架中開啟'); }
const $ = (id) => document.getElementById(id);
const esc = (s) => String(Array.isArray(s) ? s.join('、') : s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const api = (u, opt) => staticApi(u, opt);
const fail = (msg) => new Error(JSON.stringify({ error: msg }));
const errMsg = (e) => { try { return JSON.parse(e.message).error ?? e.message; } catch { return e.message; } };
/** 外部網站來的連結只允許 http/https，擋掉 javascript: 之類會在本站執行的網址 */
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : '#'; } catch { return '#'; } };

// ---- 雲端網頁（GitHub Pages）：瀏覽器直接查 SQLite（sql.js），寫入走 GitHub API ----
let STATIC = null, Q = null, sqlDb = null;
const SQLJS = 'vendor/'; // 放在自己網站上，不從外部 CDN 載入
async function initStatic() {
  const r = await fetch('static.json', { cache: 'no-store' }).catch(() => null);
  if (!r?.ok) throw fail('找不到網站資料（static.json）。這個網頁要由 src/export.js 匯出後才能使用。');
  STATIC = await r.json();
  await new Promise((ok, no) => { const s = document.createElement('script'); s.src = SQLJS + 'sql-wasm.js'; s.onload = ok; s.onerror = () => no(new Error('sql.js 載入失敗')); document.head.appendChild(s); });
  const SQL = await initSqlJs({ locateFile: (f) => SQLJS + f });
  let dbBytes;
  if (STATIC.encrypted) {
    // 有設網站密碼：資料加密在 data.enc，登入後在瀏覽器解密
    const C = await import('./shared/crypto.js');
    // 有 version 時讓瀏覽器快取：資料沒更新就不用重新下載
    const enc = new Uint8Array(await (await fetch(STATIC.version ? `data.enc?v=${encodeURIComponent(STATIC.version)}` : 'data.enc', { cache: STATIC.version ? 'default' : 'no-store' })).arrayBuffer());
    const gunzip = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    // CRW2：金鑰＝密碼＋網站固定鹽，瀏覽器只記住不可匯出的金鑰；舊格式（CRW1）只能每次輸入密碼
    const v2 = STATIC.format === 'CRW2';
    const decrypted = v2
      ? await login((key) => C.decryptWithKey(enc, key).then((d) => { SITE_KEY = key; return d; }), (pw) => C.deriveSiteKey(pw, STATIC.salt), true)
      : await login((pw) => C.decryptBytes(enc, pw), async (pw) => pw, false);
    CRYPTO = C;
    await migrateGhToken();
    const { json, db } = C.unpackBundle(STATIC.compressed === 'gzip' ? await gunzip(decrypted) : decrypted);
    STATIC = json;
    dbBytes = db;
    $('logoutBtn').hidden = false;
  } else {
    dbBytes = new Uint8Array(await (await fetch(`crawler.db?v=${encodeURIComponent(STATIC.generatedAt)}`)).arrayBuffer());
  }
  sqlDb = new SQL.Database(dbBytes);
  Q = await import('./shared/query.js');
}
/**
 * 「記住這台裝置」只存不可匯出的金鑰（IndexedDB），不存明文密碼；30 天後自動失效。
 * 金鑰以網站固定鹽為索引，網站每天更新後仍可用；密碼改了就解不開，會自動清掉並要求重新登入。
 */
const KEY_TTL = 30 * 86400_000;
function keyStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('crawler-auth', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('keys', mode);
      const req = fn(tx.objectStore('keys'));
      tx.oncomplete = () => { open.result.close(); resolve(req?.result); };
      tx.onerror = () => reject(tx.error);
    };
  });
}
const savedKey = async () => {
  try { const v = await keyStore('readonly', (s) => s.get(STATIC.salt)); return v && Date.now() - v.savedAt < KEY_TTL ? v.key : null; } catch { return null; }
};
const saveKey = (key) => keyStore('readwrite', (s) => s.put({ key, savedAt: Date.now() }, STATIC.salt)).catch(() => {});
const clearKeys = () => keyStore('readwrite', (s) => s.clear()).catch(() => {});

/** 登入：先試記住的金鑰，不行就顯示登入畫面；derive 由密碼得到金鑰，decrypt 解密成功才繼續 */
async function login(decrypt, derive, canRemember) {
  try { localStorage.removeItem('site_pw'); sessionStorage.removeItem('site_pw'); } catch {} // 舊版存的明文密碼，一律清掉
  if (canRemember) {
    const key = await savedKey();
    if (key) { try { return await decrypt(key); } catch { await clearKeys(); } }
  } else {
    $('loginRemember').closest('label').hidden = true;
  }
  $('loginBox').hidden = false;
  $('loginPw').focus();
  return new Promise((resolve) => {
    $('loginForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const pw = $('loginPw').value;
      if (!pw) return;
      $('loginBtn').disabled = true; $('loginBtn').textContent = '驗證中…'; $('loginErr').textContent = '';
      try {
        const key = await derive(pw);
        const data = await decrypt(key);
        if (canRemember && $('loginRemember').checked) await saveKey(key);
        $('loginPw').value = '';
        $('loginBox').hidden = true;
        resolve(data);
      } catch {
        $('loginErr').textContent = '密碼錯誤';
        $('loginPw').select();
      } finally { $('loginBtn').disabled = false; $('loginBtn').textContent = '登入'; }
    };
  });
}
// 登出：清掉記住的金鑰和 GitHub 權杖
$('logoutBtn').onclick = async () => {
  await clearKeys();
  forgetGhToken();
  try { localStorage.removeItem('site_pw'); sessionStorage.removeItem('site_pw'); } catch {}
  location.reload();
};

// 讓 sql.js 跟 node:sqlite 一樣用 prepare(sql).get/all
const wrapDb = { prepare: (sql) => ({
  all(...args) { const st = sqlDb.prepare(sql); st.bind(args); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; },
  get(...args) { return this.all(...args)[0]; },
}) };

const CFG_KEYS = ['listUrl', 'linkPattern', 'fetchDetail', 'titleSelector', 'contentSelector', 'trackDescription', 'volatileFields', 'maxPages', 'initialPages', 'encoding', 'defaultLocation'];
function cleanCfg(b) {
  const c = {};
  for (const k of CFG_KEYS) if (b[k] !== undefined && b[k] !== '') c[k] = b[k];
  if (!/^https?:\/\//i.test(c.listUrl ?? '')) throw fail('列表網址需以 http:// 或 https:// 開頭');
  c.fetchDetail = c.fetchDetail !== false; c.trackDescription = !!c.trackDescription;
  c.volatileFields = [].concat(c.volatileFields ?? []).filter(Boolean);
  c.maxPages = Math.min(Math.max(Number(c.maxPages) || 5, 1), 100);
  return c;
}
function newId(listUrl, list) {
  const base = new URL(listUrl.replaceAll('{page}', '1')).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const taken = new Set([...STATIC.sites.map((s) => s.id), ...list.map((s) => s.id)]);
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/**
 * GitHub 權杖：用登入後的網站金鑰加密才存（gh_token_enc），沒登入網站就解不開；
 * 沒有網站金鑰時（未設網站密碼）只放在記憶體，不寫進瀏覽器。舊版的明文 gh_token 登入後自動轉成加密版。
 */
let SITE_KEY = null, CRYPTO = null;
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const forgetGhToken = () => { gh.memToken = null; try { localStorage.removeItem('gh_token'); localStorage.removeItem('gh_token_enc'); } catch {} };
async function storeGhToken(t) {
  gh.memToken = t;
  try {
    localStorage.removeItem('gh_token');
    if (SITE_KEY && CRYPTO) localStorage.setItem('gh_token_enc', b64(await CRYPTO.encryptWithKey(new TextEncoder().encode(t), SITE_KEY)));
  } catch {}
}
async function migrateGhToken() {
  let plain = null;
  try { plain = localStorage.getItem('gh_token'); } catch {}
  if (plain) await storeGhToken(plain);
}
async function loadGhToken() {
  if (gh.memToken) return gh.memToken;
  let enc = null;
  try { enc = localStorage.getItem('gh_token_enc'); } catch {}
  if (enc && SITE_KEY && CRYPTO) {
    try { return (gh.memToken = new TextDecoder().decode(await CRYPTO.decryptWithKey(unb64(enc), SITE_KEY))); } catch { forgetGhToken(); }
  }
  return null;
}

const gh = {
  memToken: null,
  async token() {
    let t = await loadGhToken();
    if (!t) {
      t = (prompt('請貼上 GitHub 權杖（Fine-grained token：此 repo 的 Contents、Actions 讀寫權限）。\n會用網站密碼加密後才存在這台電腦的瀏覽器裡。') || '').trim();
      if (!t) throw fail('需要 GitHub 權杖才能修改網站或觸發抓取');
      await storeGhToken(t);
    }
    return t;
  },
  async call(path, opt = {}, allow404 = false) {
    if (!STATIC.repo) throw fail('這份網頁沒有設定 GitHub repo，無法修改');
    const r = await fetch(`https://api.github.com/repos/${STATIC.repo}${path}`, { ...opt, headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${await this.token()}`, 'X-GitHub-Api-Version': '2022-11-28',
      ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (r.status === 401) { forgetGhToken(); throw fail('GitHub 權杖無效或過期，請重新操作並輸入新的權杖'); }
    if (r.status === 404 && allow404) return null;
    if (!r.ok) throw fail(`GitHub ${r.status}：${(await r.json().catch(() => ({}))).message ?? ''}（請確認權杖有 Contents、Actions 寫入權限）`);
    return r.status === 204 ? {} : r.json();
  },
  /** 讀 sites.json → mutate(list) → 寫回（會自動觸發 GitHub 抓取） */
  async updateSites(mutate, message) {
    const cur = await this.call(`/contents/sites.json?ref=${encodeURIComponent(STATIC.branch)}`, {}, true);
    const list = cur ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cur.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)))) : [];
    const result = mutate(list);
    let bin = '';
    new TextEncoder().encode(JSON.stringify(list, null, 2) + '\n').forEach((b) => (bin += String.fromCharCode(b)));
    await this.call('/contents/sites.json', { method: 'PUT', body: JSON.stringify({ message, content: btoa(bin), branch: STATIC.branch, ...(cur ? { sha: cur.sha } : {}) }) });
    return result;
  },
  dispatch(site) {
    // BeClass 封鎖雲端主機，由家裡電腦每天排程抓；GitHub 不能遠端叫家裡電腦執行程式（安全考量）
    if (site === 'beclass') return Promise.reject(fail('BeClass 由家裡電腦每天 12:00 自動抓取，網頁無法立即觸發。要馬上更新，請在家裡電腦執行工作排程「網站更新爬蟲 BeClass 同步」。'));
    return this.call('/actions/workflows/crawl.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: STATIC.branch, inputs: { site: site || '' } }) });
  },
};

async function staticApi(u, opt = {}) {
  const url = new URL(u, location.href);
  const path = url.pathname.slice(url.pathname.indexOf('/api/'));
  const p = url.searchParams, method = opt.method ?? 'GET', body = opt.body ? JSON.parse(opt.body) : {};
  let m;
  if (path === '/api/sites') return STATIC.sites;
  if ((m = path.match(/^\/api\/sites\/([\w-]+)\/fields$/))) return Q.getSiteFields(wrapDb, m[1], { all: p.get('all') === '1' });
  if (path === '/api/events') return Q.queryEvents(wrapDb, p);
  if ((m = path.match(/^\/api\/events\/(\d+)$/))) return Q.getEvent(wrapDb, m[1]);
  if (path === '/api/runs') return Q.listRuns(wrapDb, p.get('site'), p.get('limit'));
  if (path === '/api/summary') return Q.siteSummary(wrapDb, p.get('site'));
  if (path === '/api/status') return { crawlTime: STATIC.crawlTime };
  if (path === '/api/crawl') { await gh.dispatch(body.site); return { started: true }; }
  if (path === '/api/site-configs' && method === 'POST') {
    return gh.updateSites((list) => {
      const id = newId(body.listUrl, list);
      list.push({ id, name: body.name || id, enabled: true, ...cleanCfg(body) });
      return { id };
    }, `新增網站：${body.name || body.listUrl}`);
  }
  if ((m = path.match(/^\/api\/site-configs\/([\w-]+)$/))) {
    return gh.updateSites((list) => {
      const i = list.findIndex((s) => s.id === m[1]);
      if (i < 0) throw fail('找不到這個網站的設定');
      if (method === 'DELETE') { list.splice(i, 1); return { ok: true }; }
      const { name, enabled, ...rest } = body;
      list[i] = { ...list[i], ...cleanCfg({ ...list[i], ...rest }) };
      if (name !== undefined) list[i].name = String(name).trim() || list[i].name;
      if (enabled !== undefined) list[i].enabled = !!enabled;
      return { ok: true };
    }, `${method === 'DELETE' ? '刪除' : '修改'}網站：${m[1]}`);
  }
  throw fail('not found');
}
let fields = [], lastRun = null, state = { page: 1, sort: 'created', dir: 'desc' };
const SHOW_COLS = 4;

let siteList = [];
async function loadSites(selectId) {
  siteList = await api('/api/sites');
  const keep = selectId ?? $('site').value;
  $('site').innerHTML = siteList.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}（${s.count}）${s.configured === false ? '（未設定信箱）' : s.enabled ? '' : '（已停用）'}</option>`).join('');
  if (siteList.some((s) => s.id === keep)) $('site').value = keep;
}

async function loadFields() {
  fields = await api(`/api/sites/${$('site').value}/fields`);
  $('dynFilters').innerHTML = fields.length ? fields.map((f, i) => {
    const id = `f${i}`;
    const head = `<label>${esc(f.key)} <span class="muted">${Math.round(f.coverage * 100)}%</span></label>`;
    if (f.type === 'enum' || f.type === 'tags') return head + `<select id="${id}"><option value="">全部</option>${f.values.map((v) => `<option value="${esc(v.value)}">${esc(v.value)}（${v.count}）</option>`).join('')}</select>`;
    if (f.type === 'date') return head + `<div class="row"><input type="date" id="${id}_min"><input type="date" id="${id}_max"></div>`;
    if (f.type === 'number') return head + `<div class="row"><input type="number" id="${id}_min" placeholder="最小"><input type="number" id="${id}_max" placeholder="最大"></div>`;
    return head + `<input id="${id}" placeholder="包含…">`;
  }).join('') : '<span class="muted">尚無資料，先抓取一次</span>';
}

function buildFilters() {
  const out = {};
  fields.forEach((f, i) => {
    const id = `f${i}`, c = {};
    if (f.type === 'enum' || f.type === 'tags') c.eq = $(id).value;
    else if (f.type === 'date' || f.type === 'number') { c.min = $(`${id}_min`).value; c.max = $(`${id}_max`).value; }
    else c.like = $(id).value;
    if (Object.values(c).some((v) => v !== '')) out[f.key] = c;
  });
  return out;
}

/** 台灣時間字串 → 相對時間（3 小時前） */
function rel(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + '+08:00');
  const sec = (Date.now() - d) / 1000;
  if (sec < 60) return '剛剛';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分鐘前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小時前';
  if (sec < 86400 * 30) return Math.floor(sec / 86400) + ' 天前';
  return ts.slice(0, 10);
}
const timeCell = (ts, label) => `<td class="t" data-l="${label}" title="${esc(ts)}">${esc(rel(ts))}<div class="abs">${esc((ts ?? '').slice(5, 16))}</div></td>`;

let summaryInfo = null;
function currentParams(extra = {}) {
  const p = new URLSearchParams({ site: $('site').value, page: state.page, sort: state.sort, dir: state.dir, size: 50, ...extra });
  for (const k of ['q', 'created_from', 'created_to', 'updated_from', 'updated_to']) if ($(k).value) p.set(k, $(k).value);
  const kind = $('kind').value;
  if ((kind === 'lastnew' || kind === 'lastupd') && lastRun) { p.set('run', lastRun.id); p.set('kind', kind === 'lastnew' ? 'new' : 'updated'); }
  if (kind === 'updated') p.set('kind', 'updated');
  const f = buildFilters();
  if (Object.keys(f).length) p.set('filters', JSON.stringify(f));
  return p;
}

async function loadEvents() {
  const p = currentParams();
  $('tbl').innerHTML = '<tbody><tr><td class="loading">讀取中…</td></tr></tbody>';
  const data = await api(`/api/events?${p}`);
  const keys = fields.filter((f) => f.type !== 'number').map((f) => f.key);
  // 重要的欄位先放；縣市、地點（已有地區）和 104 信件本身的資訊（主旨、日期）不佔表格欄位
  const FIRST = ['地區', '公司', '薪資'], HIDE = ['縣市', '地點', '信件主旨', '通知日期'];
  const cols = [...FIRST.filter((k) => keys.includes(k)), ...keys.filter((k) => !FIRST.includes(k) && !HIDE.includes(k))].slice(0, SHOW_COLS);
  const th = (key, label) => `<th data-sort="${key}">${label}${state.sort === key ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
  const head = `<thead><tr>${th('name', '名稱')}${cols.map((c) => th(`f:${c}`, esc(c))).join('')}${th('created', '首次出現')}${th('updated', '最新更新')}${th('history', '歷史時間點')}</tr></thead>`;
  const body = data.rows.map((r) => {
    const isNew = lastRun && r.created_run === lastRun.id;
    const isUpd = lastRun && r.updated_run === lastRun.id && r.created_run !== r.updated_run;
    return `<tr><td class="name">${isNew ? '<span class="badge b-new">新</span>' : ''}${isUpd ? '<span class="badge b-upd">改</span>' : ''}<a href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener" title="到原網站">${esc(r.name)} ↗</a></td>` +
      cols.map((c) => `<td data-l="${esc(c)}">${esc(r.fields[c])}</td>`).join('') +
      timeCell(r.first_seen, '首次出現') + timeCell(r.latest, '最新更新') +
      `<td data-l="歷史時間點"><button class="hist" data-id="${r.id}" title="查看詳情與修改紀錄&#10;${esc(r.timeline.join('\n'))}">${r.timeline.length} 個・詳情</button></td></tr>`;
  }).join('');
  let empty = '';
  if (!data.total) {
    empty = $('site').value === 'mail104' && !p.has('filters') && !p.has('q')
      ? `<tr><td colspan="9" class="empty">還沒有職缺。系統會讀信箱裡 104 寄來的「職缺通知信」：<br>
        到 104 搜尋職缺 → 儲存搜尋條件 →「訂閱・管理通知」選每日發送。收到後每天 ${esc(STATIC?.crawlTime ?? '12:00')} 會自動出現。</td></tr>`
      : '<tr><td colspan="9" class="empty">沒有符合條件的資料</td></tr>';
  }
  $('tbl').innerHTML = head + '<tbody>' + body + empty + '</tbody>';
  const pages = Math.max(1, Math.ceil(data.total / data.size));
  $('summary').textContent = `共 ${data.total} 筆，第 ${data.page} / ${pages} 頁`;
  $('pager').innerHTML = `<button ${data.page <= 1 ? 'disabled' : ''} data-p="${data.page - 1}">上一頁</button><button ${data.page >= pages ? 'disabled' : ''} data-p="${data.page + 1}">下一頁</button>`;
}

async function loadSummary() {
  summaryInfo = await api(`/api/summary?site=${$('site').value}`);
  $('c_total').textContent = summaryInfo.total;
  $('c_new').textContent = summaryInfo.today_new;
  $('c_upd').textContent = summaryInfo.today_updated;
}

const failReason = (e = '') => /HTTP 40[13]|HTTP 429/.test(e) ? '網站拒絕存取' : /登入失敗/.test(e) ? '信箱登入失敗' : /HTTP 404/.test(e) ? '找不到網址' : '錯誤';
async function loadRuns() {
  const runs = await api(`/api/runs?site=${$('site').value}&limit=8`);
  lastRun = runs.find((r) => r.status === 'done') ?? null;
  $('runs').innerHTML = runs.map((r) => `<tr title="${esc(r.error ?? '')}"><td>${esc(r.started_at.slice(5, 16))}</td><td>${r.status === 'failed' ? `<span class="err">失敗：${esc(failReason(r.error))}</span>` : esc(r.status === 'done' ? '完成' : r.status === 'running' ? '執行中' : r.status)}</td><td>+${r.new_count} / *${r.updated_count}</td></tr>`).join('') || '<tr><td class="muted">尚未執行</td></tr>';
  const r = runs[0];
  $('c_run').innerHTML = r ? (r.status === 'failed' ? `<span class="err">失敗：${esc(failReason(r.error))}</span>` : `${esc(rel(r.started_at))}　+${r.new_count} / *${r.updated_count}`) : '尚未執行';
  $('c_run_l').textContent = r ? `最近一次抓取（${r.started_at.slice(5, 16)}）` : '最近一次抓取';
  const st = await api('/api/status');
  $('status').textContent = `資料更新於 ${STATIC.generatedAt}｜每天 ${st.crawlTime} 由 GitHub 自動抓取`;
}

async function showEvent(id) {
  const e = await api(`/api/events/${id}`);
  const changes = [...e.history].reverse(); // 舊 → 新
  const fmtChange = (h) => `<ul style="margin:4px 0">${Object.entries(h.changes).map(([k, c]) => `<li>${esc(k)}：${k === '活動說明' ? '（內容變更）' : `${esc(c.from ?? '∅')} → ${esc(c.to ?? '∅')}`}</li>`).join('')}</ul>`;
  const items = [`<li class="first${changes.length ? '' : ' last'}"><b>${esc(e.first_seen)}</b>　首次出現</li>`,
    ...changes.map((h, i) => `<li class="${i === changes.length - 1 ? 'last' : ''}"><b>${esc(h.changed_at)}</b>　更新${fmtChange(h)}</li>`)];
  $('dlgBody').innerHTML = `<h3 style="margin-top:0"><a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener">${esc(e.name)}</a></h3>
    <div class="cards" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div class="card"><div class="l">首次出現</div><b>${esc(e.first_seen)}</b></div>
      <div class="card"><div class="l">最新更新</div><b>${esc(e.latest)}</b></div>
      <div class="card"><div class="l">最後看到</div><b>${esc(e.last_seen_at)}</b></div>
    </div>
    <h4>歷史時間點（${e.timeline.length} 個）</h4><ul class="timeline">${items.join('')}</ul>
    <h4>欄位</h4><table>${Object.entries(e.fields).map(([k, v]) => `<tr><th style="position:static">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    ${e.description ? `<h4>活動說明</h4><pre>${esc(e.description)}</pre>` : ''}`;
  $('dlg').showModal();
}

/** 下載目前篩選結果：CSV（歷史時間點以 | 分隔）、JSON（歷史時間點是陣列） */
async function download(type) {
  const data = await api(`/api/events?${currentParams({ page: 1, size: 'all' })}`);
  const site = $('site').value;
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16).replace(/[-: ]/g, '');
  let blob;
  if (type === 'json') {
    const out = data.rows.map((r) => ({ name: r.name, url: r.url, first_seen: r.first_seen, latest: r.latest, timeline: r.timeline, last_seen: r.last_seen_at, fields: r.fields }));
    blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  } else {
    const keys = [...new Set(data.rows.flatMap((r) => Object.keys(r.fields)))];
    const cell = (v) => { const t = Array.isArray(v) ? v.join('、') : String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [['名稱', '網址', '首次出現', '最新更新', '歷史時間點', '時間點數', ...keys].map(cell).join(',')];
    for (const r of data.rows) lines.push([r.name, r.url, r.first_seen, r.latest, r.timeline.join(' | '), r.timeline.length, ...keys.map((k) => r.fields[k])].map(cell).join(','));
    blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${site}-${stamp}.${type}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** 快速篩選 */
function quick(kind) {
  for (const k of ['created_from', 'created_to', 'updated_from', 'updated_to']) $(k).value = '';
  $('kind').value = '';
  const sm = summaryInfo ?? {};
  if (kind === 'today') $('created_from').value = sm.today ?? '';
  if (kind === 'week') $('created_from').value = sm.week_start ?? '';
  if (kind === 'todayupd') { $('updated_from').value = sm.today ?? ''; $('kind').value = 'updated'; }
  if (kind === 'updated') $('kind').value = 'updated';
  document.querySelectorAll('#quick .chip').forEach((c) => c.classList.toggle('on', c.dataset.quick === kind));
  state.page = 1;
  loadEvents();
}
document.querySelectorAll('[data-quick]').forEach((el) => (el.onclick = () => quick(el.dataset.quick)));
$('dlCsv').onclick = () => download('csv').catch((e) => alert(errMsg(e)));
$('dlJson').onclick = () => download('json').catch((e) => alert(errMsg(e)));

async function refreshAll() {
  await Promise.all([loadRuns(), loadFields(), loadSummary()]);
  document.querySelectorAll('#quick .chip').forEach((c) => c.classList.toggle('on', c.dataset.quick === 'all'));
  state.page = 1;
  await loadEvents();
}

$('site').onchange = refreshAll;
$('apply').onclick = () => { state.page = 1; loadEvents(); };
$('reset').onclick = () => { document.querySelectorAll('aside input, aside select:not(#site)').forEach((el) => (el.value = '')); state.page = 1; loadEvents(); };
$('q').onkeydown = (ev) => { if (ev.key === 'Enter') $('apply').click(); };
$('tbl').onclick = (ev) => {
  const a = ev.target.closest('a[data-id], button.hist'); if (a) { ev.preventDefault(); showEvent(a.dataset.id); return; }
  const th = ev.target.closest('th[data-sort]');
  if (th) { state.dir = state.sort === th.dataset.sort && state.dir === 'desc' ? 'asc' : 'desc'; state.sort = th.dataset.sort; loadEvents(); }
};
$('pager').onclick = (ev) => { const b = ev.target.closest('button[data-p]'); if (b) { state.page = Number(b.dataset.p); loadEvents(); } };
async function startCrawl(site) {
  try { await api('/api/crawl', { method: 'POST', body: JSON.stringify({ site }) }); alert('已通知 GitHub 開始抓取，約 2～10 分鐘後重新整理頁面就會看到新資料。'); }
  catch (e) { alert(errMsg(e)); }
}
$('crawlBtn').onclick = () => startCrawl($('site').value);

// ---- 網站管理 ----
const post = (u, body, method = 'POST') => api(u, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let editingId = null;

function renderSiteTable() {
  $('siteTbl').innerHTML = '<tr><th>網站</th><th>活動數</th><th>每天自動抓</th><th>最後抓取</th><th></th></tr>' + siteList.map((s) => {
    const r = s.lastRun;
    const run = r ? `${esc(r.started_at.slice(5, 16))} ${r.status === 'done' ? `+${r.new_count} / *${r.updated_count}` : r.status === 'failed' ? `<span class="err" title="${esc(r.error)}">失敗</span>` : esc(r.status)}` : '—';
    return `<tr><td>${esc(s.name)}<div class="muted">${esc(s.baseUrl)}${s.custom ? '' : '（內建）'}${s.configured === false ? '<span class="err">（未設定信箱，請看 README）</span>' : ''}</div></td><td>${s.count}</td>
      <td>${s.custom ? `<input type="checkbox" data-toggle="${esc(s.id)}" ${s.enabled ? 'checked' : ''} style="width:auto">` : (s.enabled ? '是' : '否')}</td>
      <td class="t">${run}</td>
      <td class="actions"><button data-crawl="${esc(s.id)}">抓取</button>${s.custom ? ` <button data-edit="${esc(s.id)}">編輯</button> <button data-del="${esc(s.id)}">刪除</button>` : ''}</td></tr>`;
  }).join('');
}

function resetForm() {
  editingId = null;
  $('formTitle').textContent = '新增網站';
  for (const k of ['name', 'listUrl', 'linkPattern', 'titleSelector', 'contentSelector', 'defaultLocation']) $(`sf_${k}`).value = '';
  $('sf_volatile').value = '';
  $('sf_maxPages').value = 5; $('sf_fetchDetail').checked = true; $('sf_trackDescription').checked = false; $('sf_encoding').value = 'auto';
  $('sf_msg').innerHTML = '';
}

function formConfig() {
  return {
    name: $('sf_name').value.trim(), listUrl: $('sf_listUrl').value.trim(), linkPattern: $('sf_linkPattern').value.trim(),
    maxPages: Number($('sf_maxPages').value) || 5, fetchDetail: $('sf_fetchDetail').checked,
    titleSelector: $('sf_titleSelector').value.trim(), contentSelector: $('sf_contentSelector').value.trim(),
    trackDescription: $('sf_trackDescription').checked, encoding: $('sf_encoding').value,
    defaultLocation: $('sf_defaultLocation').value.trim(),
    volatileFields: $('sf_volatile').value.split(/[,，、]/).map((x) => x.trim()).filter(Boolean),
  };
}

$('sitesBtn').onclick = async () => { await loadSites(); renderSiteTable(); resetForm(); $('sitesDlg').showModal(); };
$('sitesClose').onclick = () => $('sitesDlg').close();
$('sf_cancel').onclick = resetForm;
$('clearToken').onclick = (ev) => { ev.preventDefault(); forgetGhToken(); alert('已清除。'); };
$('sf_save').onclick = async () => {
  const cfg = formConfig();
  try {
    const r = editingId ? await post(`/api/site-configs/${editingId}`, cfg, 'PUT') : await post('/api/site-configs', cfg);
    await loadSites(editingId ?? r.id);
    renderSiteTable();
    resetForm();
    $('sf_msg').textContent = '已儲存到 GitHub，系統會自動開始抓取（約 2～10 分鐘），完成後重新整理頁面就會看到這個網站。';
  } catch (e) {
    $('sf_msg').innerHTML = `<span class="err">${esc(errMsg(e))}</span>`;
  }
};
$('siteTbl').onclick = async (ev) => {
  const b = ev.target.closest('button');
  const t = ev.target.closest('input[data-toggle]');
  if (t) { await post(`/api/site-configs/${t.dataset.toggle}`, { enabled: t.checked }, 'PUT'); await loadSites(); return; }
  if (!b) return;
  if (b.dataset.crawl) { startCrawl(b.dataset.crawl); b.textContent = '抓取中…'; b.disabled = true; }
  if (b.dataset.edit) {
    const s = siteList.find((x) => x.id === b.dataset.edit);
    resetForm(); editingId = s.id;
    $('formTitle').textContent = `編輯網站：${s.name}`;
    $('sf_name').value = s.name;
    for (const k of ['listUrl', 'linkPattern', 'titleSelector', 'contentSelector', 'maxPages', 'defaultLocation']) $(`sf_${k}`).value = s.config[k] ?? (k === 'maxPages' ? 5 : '');
    $('sf_fetchDetail').checked = s.config.fetchDetail !== false;
    $('sf_trackDescription').checked = !!s.config.trackDescription;
    $('sf_encoding').value = s.config.encoding || 'auto';
    $('sf_volatile').value = (s.config.volatileFields ?? []).join(', ');
    $('formTitle').scrollIntoView({ behavior: 'smooth' });
  }
  if (b.dataset.del) {
    const s = siteList.find((x) => x.id === b.dataset.del);
    if (!confirm(`刪除「${s.name}」？`)) return;
    try { await api(`/api/site-configs/${encodeURIComponent(s.id)}`, { method: 'DELETE' }); }
    catch (e) { $('sf_msg').innerHTML = `<span class="err">${esc(errMsg(e))}</span>`; return; }
    // 網站清單是發佈時的快照，要等 GitHub 重新發佈才會更新，先在畫面上拿掉
    STATIC.sites = STATIC.sites.filter((x) => x.id !== s.id);
    $('sf_msg').textContent = `已從 GitHub 刪除「${s.name}」，約 2～10 分鐘後重新整理頁面就會完全更新。`;
    await loadSites(); renderSiteTable(); refreshAll();
  }
};

initStatic().then(() => loadSites()).then(refreshAll).catch((e) => ($('summary').textContent = '載入失敗：' + errMsg(e)));
