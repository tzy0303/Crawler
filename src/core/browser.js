import { assertPublicUrl, throttle, UA } from './fetcher.js';

/**
 * 用真的瀏覽器（Chrome，無畫面）抓網頁：給「內容要等 JavaScript 跑完才出現」的網站用。
 * sites.json 設 "browser": true 才會用；其他網站照舊用一般抓取（快、省資源）。
 *
 * - 用電腦上已安裝的 Chrome（GitHub Actions 的 ubuntu-latest 內建），不另外下載瀏覽器；
 *   要指定別的 Chrome/Edge 可設環境變數 CHROME_PATH
 * - User-Agent 在瀏覽器原本的字串後面加上 SiteUpdateWatcher/1.0，誠實標明是爬蟲
 * - 每個請求（含轉址、圖片以外的資源）都檢查不能連到內部網路
 * - 遇到 Cloudflare 之類的「確認你是人類」頁面就停，不繞過
 */

const MAX_CHARS = 10 * 1024 * 1024;
const SKIP_TYPES = new Set(['image', 'media', 'font']); // 用不到，省流量也比較快
const CHALLENGE = /<title>\s*(Just a moment|Attention Required|請稍候|Access denied)|challenges\.cloudflare\.com|cf-chl-|captcha/i;

let browserPromise = null;
let contextPromise = null;

async function getContext() {
  contextPromise ??= (async () => {
    const { chromium } = await import('playwright-core');
    browserPromise = chromium.launch(
      process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
    );
    const browser = await browserPromise;
    const probe = await browser.newPage();
    const defaultUa = await probe.evaluate(() => navigator.userAgent);
    await probe.close();
    const context = await browser.newContext({
      userAgent: `${defaultUa} ${UA}`,
      locale: 'zh-TW',
      serviceWorkers: 'block', // service worker 發的請求攔不到，直接停用
    });
    // 所有請求自己轉送：不自動跟轉址，轉址後的新網址會再進來這裡檢查一次
    await context.route('**/*', async (route) => {
      const req = route.request();
      if (SKIP_TYPES.has(req.resourceType())) return route.abort();
      try {
        await assertPublicUrl(new URL(req.url()));
      } catch {
        return route.abort('blockedbyclient');
      }
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout: 30000 });
        await route.fulfill({ response });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    return context;
  })();
  try {
    return await contextPromise;
  } catch (err) {
    contextPromise = null;
    throw Object.assign(new Error(`無法啟動瀏覽器（需要安裝 Chrome，或設定 CHROME_PATH）：${err.message}`), { fatal: true });
  }
}

/** 用瀏覽器開網頁，等內容載入完，回傳畫面上的 HTML（介面和 fetchHtml 相同，encoding 由瀏覽器處理） */
export async function fetchRendered(url, { minInterval = 1000, retries = 3, waitMs = 10000 } = {}) {
  await assertPublicUrl(new URL(url));
  const context = await getContext();
  for (let attempt = 1; ; attempt++) {
    await throttle(minInterval);
    const page = await context.newPage();
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // 等網路安靜下來（JavaScript 載完資料）；有些網站一直有追蹤請求，等不到就用目前的內容
      await page.waitForLoadState('networkidle', { timeout: waitMs }).catch(() => {});
      const html = await page.content();
      if (CHALLENGE.test(html.slice(0, 20000)) && (!res || res.status() >= 400 || html.length < 50000)) {
        throw Object.assign(new Error(`網站要求驗證「是不是真人」，不繞過：${url}`), { fatal: true });
      }
      if (res && !res.ok()) throw new Error(`HTTP ${res.status()} ${url}`);
      if (html.length > MAX_CHARS) throw Object.assign(new Error(`頁面太大（超過 10 MB）${url}`), { fatal: true });
      return html;
    } catch (err) {
      if (err.fatal || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    } finally {
      await page.close().catch(() => {});
    }
  }
}

/** 抓完要關掉瀏覽器，否則程式不會結束 */
export async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = contextPromise = null;
  await browser?.close();
}
