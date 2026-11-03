import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_BYTES = 10 * 1024 * 1024; // 一頁最多 10 MB
const MAX_REDIRECTS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

/**
 * 內部網路、本機、雲端主機資訊服務等位址：爬蟲不能連（避免被當成跳板探測內網，SSRF）
 */
export function isPrivateAddress(ip) {
  const v4 = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i);
  if (v4) {
    const [a, b, c] = v4.slice(1).map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 // 本機、私有、多播與保留
      || (a === 100 && b >= 64 && b <= 127) // 電信業者 NAT
      || (a === 169 && b === 254) // link-local（雲端主機資訊服務 169.254.169.254）
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 0)
      || (a === 198 && (b === 18 || b === 19))
      || ip.endsWith('168.63.129.16'); // Azure 主機服務（GitHub Actions 跑在 Azure）
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

async function assertPublicUrl(url) {
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error(`只能抓 http/https 網址：${url.href}`), { fatal: true });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) {
    throw Object.assign(new Error(`不允許連到內部網路位址：${url.hostname}`), { fatal: true });
  }
}

/** 自己處理轉址，每一跳都檢查位址 */
async function safeFetch(href, headers) {
  let url = new URL(href);
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const location = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!location) return res;
    if (hop >= MAX_REDIRECTS) throw new Error(`轉址太多次 ${href}`);
    url = new URL(location, url);
  }
}

async function readLimited(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw Object.assign(new Error(`頁面太大（超過 10 MB）${res.url}`), { fatal: true });
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** 從 Content-Type 或 <meta charset> 判斷編碼（台灣網站常見 big5） */
function detectEncoding(buf, contentType) {
  const fromHeader = contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
  if (fromHeader) return fromHeader;
  const head = new TextDecoder('latin1').decode(buf.slice(0, 4096));
  return head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
}

/** 抓 HTML：全域速率限制（預設每秒 1 個請求）+ 重試；encoding 預設自動判斷 */
export async function fetchHtml(url, { minInterval = 1000, retries = 3, encoding = 'auto' } = {}) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequestAt + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await safeFetch(url, { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const buf = await readLimited(res);
      const enc = encoding === 'auto' ? detectEncoding(buf, res.headers.get('content-type')) : encoding;
      try {
        return new TextDecoder(enc).decode(buf);
      } catch {
        return new TextDecoder('utf-8').decode(buf);
      }
    } catch (err) {
      if (err.fatal || attempt >= retries) throw err;
      await sleep(3000 * attempt);
    }
  }
}
