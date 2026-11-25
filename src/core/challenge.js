/**
 * 「確認你是真人」頁面（Cloudflare、reCAPTCHA、hCaptcha、Turnstile、Imperva、DataDome 等）的判斷。
 *
 * 原則：網站要求真人驗證 = 網站不想被自動抓。偵測到就停止這個網站這一次的抓取、通知人，
 * 不解驗證碼、不換 IP、不偽裝瀏覽器。之後的處理是人決定：改用官方 RSS/通知信、降低頻率、或停用該網站。
 */
const MARKERS = new RegExp([
  String.raw`<title>\s*(Just a moment|Attention Required|請稍候|Access denied|Security check|Verify you are human|人機驗證|安全驗證)`,
  String.raw`challenges\.cloudflare\.com`, String.raw`cf-chl-`, String.raw`cf_chl_`, String.raw`cf-turnstile`,
  String.raw`g-recaptcha`, String.raw`recaptcha/api`, String.raw`hcaptcha\.com`, String.raw`h-captcha`,
  String.raw`px-captcha`, String.raw`_Incapsula_Resource`, String.raw`captcha-delivery\.com`,
].join('|'), 'i');

// 正常網頁也可能帶 reCAPTCHA（登入、報名表單）：只有「被拒（4xx/5xx）」或「頁面很小、幾乎只有驗證」才算
const SMALL_PAGE = 50000;

export function isChallenge(html, status = 200) {
  if (!html) return false;
  return MARKERS.test(html.slice(0, 20000)) && (status >= 400 || html.length < SMALL_PAGE);
}

/** fatal：同一頁重試也沒用；challenge：整個網站這次都停，不要一頁頁去撞 */
export function challengeError(url) {
  return Object.assign(new Error(`網站要求真人驗證，已停止抓這個網站（不繞過）：${url}`), { fatal: true, challenge: true });
}
