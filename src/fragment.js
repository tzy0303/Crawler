// 網站資料片段：家裡電腦（self-hosted runner）抓的 BeClass 匯出成片段，雲端再併進主資料庫。
// 有 SITE_PASSWORD 時片段會加密（public repo 也看不到內容）。
// 用法：node src/fragment.js export <網站id> <輸出檔>
//       node src/fragment.js merge <片段檔>
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, log } from './config.js';
import { mergeSitesFrom } from './core/merge.js';
import { openDb } from './core/store.js';
import { decryptBytes, encryptBytes, isEncrypted } from './shared/crypto.js';

const [cmd, a, b] = process.argv.slice(2);
const password = process.env.SITE_PASSWORD?.trim();
const tmp = join(tmpdir(), `fragment-${process.pid}.db`);

if (cmd === 'export') {
  const [siteId, out] = [a, b];
  const db = openDb(config.dbFile);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  db.close();
  const copy = new DatabaseSync(tmp);
  copy.prepare('DELETE FROM event_history WHERE event_id IN (SELECT id FROM events WHERE site_id <> ?)').run(siteId);
  for (const t of ['events', 'site_fields', 'crawl_runs']) copy.prepare(`DELETE FROM ${t} WHERE site_id <> ?`).run(siteId);
  copy.prepare('DELETE FROM sites WHERE id <> ?').run(siteId);
  copy.exec('PRAGMA journal_mode = DELETE; VACUUM;');
  const n = copy.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  copy.close();
  const bytes = new Uint8Array(readFileSync(tmp));
  writeFileSync(out, password ? await encryptBytes(bytes, password) : bytes);
  unlinkSync(tmp);
  log(`[片段] 已匯出 ${siteId}：${n} 筆${password ? '（已加密）' : ''}`);
} else if (cmd === 'merge') {
  const bytes = new Uint8Array(readFileSync(a));
  writeFileSync(tmp, isEncrypted(bytes) ? await decryptBytes(bytes, password ?? '') : bytes);
  const db = openDb(config.dbFile);
  mergeSitesFrom(db, tmp, log);
  db.close();
  unlinkSync(tmp);
} else {
  console.error('用法：node src/fragment.js export <網站id> <輸出檔> | merge <片段檔>');
  process.exit(1);
}
