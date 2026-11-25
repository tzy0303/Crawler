/**
 * 「確認你是真人」頁面（Cloudflare、reCAPTCHA、hCaptcha、Turnstile、Imperva、DataDome 等）的判斷。
 *
 * 原則：網站要求真人驗證 = 網站不想被自動抓。偵測到就停止這個網站這一次的抓取、通知人，
 * 不解驗證碼、不換 IP、不偽裝瀏覽器。之後的處理是人決定：改用官方 RSS/通知信、降低頻率、或停用該網站。
 */

// 驗證頁本身才有的特徵（例：104 回 403、5 KB、<title>Just a moment...、cf_chl_opt）
const STRONG = new RegExp([
  String.raw`<title>\s*(Just a moment|Attention Required|請稍候|Access denied|Security check|Verify you are human|人機驗證|安全驗證)`,
  String.raw`cf_chl_opt`, String.raw`_Incapsula_Resource`, String.raw`captcha-delivery\.com`, String.raw`px-captcha`,
].join('|'), 'i');

// 驗證「元件」：正常頁面的留言區、報名表單也會嵌（例：iThome 文章頁 47 KB 載入 Turnstile）
const WIDGET = /challenges\.cloudflare\.com|cf-turnstile|g-recaptcha|recaptcha\/api|hcaptcha\.com|h-captcha/i;

const SMALL_PAGE = 50000; // 驗證頁通常只有幾 KB
const TINY_PAGE = 8000; // 只有元件、幾乎沒有內容

export function isChallenge(html, status = 200) {
  if (!html) return false;
  const head = html.slice(0, 20000);
  if (STRONG.test(head)) return status >= 400 || html.length < SMALL_PAGE;
  if (WIDGET.test(head)) return status >= 400 || html.length < TINY_PAGE;
  return false;
}

/** fatal：同一頁重試也沒用；challenge：整個網站這次都停，不要一頁頁去撞 */
export function challengeError(url) {
  return Object.assign(new Error(`網站要求真人驗證，已停止抓這個網站（不繞過）：${url}`), { fatal: true, challenge: true });
}
