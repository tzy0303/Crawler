// 印出資料庫的活動筆數（雲端存回前檢查資料有沒有被寫壞）。用法：node src/db-count.js <資料庫>
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2], { readOnly: true });
console.log(db.prepare('SELECT COUNT(*) AS n FROM events').get().n);
db.close();
