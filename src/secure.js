// 雲端用：加解密 data 分支上的資料庫（密碼來自環境變數 SITE_PASSWORD）
// 用法：node src/secure.js encrypt <輸入> <輸出>
//       node src/secure.js decrypt <輸入> <輸出>   （輸入是未加密的舊檔時直接複製）
import { readFileSync, writeFileSync } from 'node:fs';
import { decryptBytes, encryptBytes, isEncrypted } from './shared/crypto.js';

const [cmd, input, output] = process.argv.slice(2);
// Secrets 貼上時常多帶空白或換行；網頁登入時打的密碼不會有
const password = process.env.SITE_PASSWORD?.trim();
if (!password) {
  console.error('沒有設定 SITE_PASSWORD');
  process.exit(1);
}
const bytes = new Uint8Array(readFileSync(input));
if (cmd === 'encrypt') {
  writeFileSync(output, await encryptBytes(bytes, password));
} else if (cmd === 'decrypt') {
  writeFileSync(output, isEncrypted(bytes) ? await decryptBytes(bytes, password) : bytes);
} else {
  console.error('用法：node src/secure.js encrypt|decrypt <輸入> <輸出>');
  process.exit(1);
}
console.log(`${cmd} 完成：${output}`);
