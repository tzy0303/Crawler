// 密碼加解密（AES-256-GCM，金鑰用 PBKDF2-SHA256 從密碼推導）。
// Node（globalThis.crypto）與瀏覽器（WebCrypto）共用：雲端匯出時加密，網頁登入時在瀏覽器解密。
// 格式：'CRW1'(4) + salt(16) + iv(12) + ciphertext

const MAGIC = [0x43, 0x52, 0x57, 0x31];

/** 網站密碼至少 12 個字：加密檔可以公開下載，太短會被離線暴力猜出來 */
export const MIN_PASSWORD_LENGTH = 12;
export function assertStrongPassword(password) {
  if ((password ?? '').length < MIN_PASSWORD_LENGTH) throw new Error(`SITE_PASSWORD 太短：至少要 ${MIN_PASSWORD_LENGTH} 個字`);
}
const ITERATIONS = 600_000;

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export const isEncrypted = (bytes) => bytes.length > 32 && MAGIC.every((b, i) => bytes[i] === b);

export async function encryptBytes(bytes, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(4 + 16 + 12 + ct.length);
  out.set(MAGIC, 0);
  out.set(salt, 4);
  out.set(iv, 20);
  out.set(ct, 32);
  return out;
}

/** 密碼錯誤或檔案被改過會丟出錯誤 */
export async function decryptBytes(bytes, password) {
  if (!isEncrypted(bytes)) throw new Error('不是加密檔');
  const key = await deriveKey(password, bytes.slice(4, 20));
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(20, 32) }, key, bytes.slice(32)));
  } catch {
    throw new Error('密碼錯誤');
  }
}

// ---- 網站資料包（CRW2）：用「網站固定鹽」推導金鑰 ----
// 鹽每個網站固定（公開沒關係，作用是讓不同網站的同一密碼推出不同金鑰），
// 所以瀏覽器可以只記住「不能匯出的金鑰」，不用存明文密碼，網站每天更新後也還能用。
// 格式：'CRW2'(4) + iv(12) + ciphertext
const MAGIC2 = [0x43, 0x52, 0x57, 0x32];

/** 由密碼＋網站固定鹽推導 AES 金鑰（不可匯出：記住後也拿不回原始密碼或金鑰內容） */
export async function deriveSiteKey(password, siteSalt) {
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(siteSalt))).slice(0, 16);
  return deriveKey(password, salt);
}

export const isSiteEncrypted = (bytes) => bytes.length > 16 && MAGIC2.every((b, i) => bytes[i] === b);

export async function encryptWithKey(bytes, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(4 + 12 + ct.length);
  out.set(MAGIC2, 0);
  out.set(iv, 4);
  out.set(ct, 16);
  return out;
}

export async function decryptWithKey(bytes, key) {
  if (!isSiteEncrypted(bytes)) throw new Error('不是網站資料包');
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(4, 16) }, key, bytes.slice(16)));
  } catch {
    throw new Error('密碼錯誤');
  }
}

/** 網站資料包：網站清單（JSON）+ 資料庫，一起加密，登入時只要推導一次金鑰 */
export function packBundle(json, dbBytes) {
  const head = new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(4 + head.length + dbBytes.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(dbBytes, 4 + head.length);
  return out;
}

export function unpackBundle(bytes) {
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  return {
    json: JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len))),
    db: bytes.subarray(4 + len),
  };
}
