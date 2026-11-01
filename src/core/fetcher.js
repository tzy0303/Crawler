const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

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
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const enc = encoding === 'auto' ? detectEncoding(buf, res.headers.get('content-type')) : encoding;
      try {
        return new TextDecoder(enc).decode(buf);
      } catch {
        return new TextDecoder('utf-8').decode(buf);
      }
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(3000 * attempt);
    }
  }
}
