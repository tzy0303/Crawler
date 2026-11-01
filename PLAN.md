# 網站活動更新爬蟲：規劃

## Context
要做一支爬蟲，定期抓取活動報名網站（第一個目標是 BeClass，之後還會加入類似網站）：
1. 活動**第一次出現時存起來**。之後用**活動名稱**判斷是不是同一筆，並記錄「新增時間」與「修改時間」。
2. 篩選條件**依網站實際有的欄位動態產生**：網站有「地點」就能篩地點，有「類別」就能篩類別。

`D:\網站更新爬蟲` 目前是空資料夾。本機有 Node v25，沒有 Python，所以用 Node.js 來做。

## 實測 BeClass 結構（2026-10-30）
- 列表頁：`/default.php?name=ShowList&op=ShowRegist&od=lastmod`，依最後編修時間排序，共約 303 頁。分頁格式之後實作時再確認。
- 每筆活動連到 `https://www.beclass.com/rid=<hex>`，`rid` 是網站自己的 ID。
- 列表上就有：名稱、(活動日期)、報名期限 N 天、限額 N 名、尚餘 N 人。
- 詳細頁有：標題、`活動日期：`、類別（例如「課程/講座」，也出現在 `<title>`）、`地點：`（在「活動地點資訊」區塊）、活動說明、主辦單位。
- 用一般瀏覽器 UA 加 curl 就能抓（WebFetch 會被回 403），頁面是 UTF-8，不需要用無頭瀏覽器。

## 架構

```
src/
  adapters/beclass.js   # 該網站的列表網址、分頁、列表/詳細頁解析
  core/fetcher.js       # fetch + UA + 速率限制(1~2 秒/頁) + 重試
  core/extract.js       # 通用「標籤：值」抽取 + 欄位正規化
  core/store.js         # SQLite（node:sqlite，Node 內建，不用裝原生套件）
  core/differ.js        # 名稱比對、內容雜湊、判斷新增/修改
  crawl.js              # CLI：node src/crawl.js --site beclass --pages 5
  server.js             # 小型查詢 API + 靜態網頁
public/index.html       # 篩選介面（依欄位清單動態產生）
data/crawler.db         # 放在 D:
```

### Adapter 介面（新增網站只要多寫一個檔案）
```js
export default {
  id: 'beclass', name: 'BeClass', baseUrl: 'https://www.beclass.com',
  listUrl(page) {...},
  parseList(html) -> [{ name, url, sourceId, fields:{活動日期, 報名期限, 限額, 尚餘} }],
  parseDetail(html) -> { fields:{ 地點, 類別, 活動日期, 主辦單位, ... }, description },
  fieldMap: { '地點':'location', '活動日期':'event_date', '類別':'category' } // 對到共用欄位名，可省略
}
```
`extract.js` 會掃整頁所有「XX：值」的組合當作備援，所以 adapter 沒有特別寫到的欄位也能被抓到。

### 資料表
- **sites**：id, name, base_url
- **events**：id, site_id, **name（UNIQUE(site_id, name)）**, url, source_id, fields_json, content_hash, **created_at**, **updated_at**, last_seen_at
- **event_history**：event_id, changed_at, old_fields_json, new_fields_json（記錄每次修改了什麼）
- **site_fields**：site_id, field_key, label, type(text/date/number/enum), sample_values_json, seen_count, last_seen_at，這張表就是「動態篩選欄位」的來源

### 名稱判斷規則（differ.js）
- 名稱先正規化：去掉頭尾空白、全形空白轉半形、連續空白壓成一個。
- 名稱**不存在** → INSERT，`created_at = updated_at = now`。
- 名稱**存在**而且 content_hash 不一樣 → UPDATE fields，`updated_at = now`，並寫一筆 event_history。
- 名稱存在、內容相同 → 只更新 `last_seen_at`。
- content_hash 只算穩定的欄位（地點、活動日期、類別、說明）。「報名期限 14.6 天」「尚餘 N 人」這類每天都在變的欄位會排除，以免每次跑都被當成「修改」。排除名單由 adapter 宣告：`volatileFields: ['報名期限','尚餘']`。

### 動態篩選
- 每次爬完都會統計該網站各欄位的出現率。出現率 ≥ 30% 的欄位才當作「可篩選」，避免單一活動寫的雜項變成一個篩選條件。
- 型別用推斷的：值像 `YYYY-MM-DD` 就是 date（產生日期區間篩選）；純數字是 number（範圍）；不同值少於 50 種是 enum（下拉選單）；其他是 text（關鍵字）。
- `GET /api/sites/:id/fields` 回傳欄位清單，前端依清單產生篩選表單。所以 BeClass 會出現「地點、類別、活動日期」，換成沒有地點的網站，地點篩選就自動消失。
- 地點另外再拆出「縣市」（用正則比對 22 縣市名稱），當成 enum，方便篩選。
- 共用的篩選條件：名稱關鍵字、新增時間區間、修改時間區間、只看「本次新增／本次修改」。

### 爬取策略
- 增量模式（預設）：用 `od=lastmod` 從第 1 頁往後抓。只要連續一整頁都是「已存在且內容沒變」就停下來，所以平常只需要抓幾頁。
- 完整模式：`--full` 會掃全部頁面（第一次建資料時用）。
- 詳細頁只在「新活動」或「列表資訊有變」時才抓，減少請求數。
- 速率：每秒最多 1 個請求，並帶一般瀏覽器 UA。
- 第一次（DB 是空的）預設抓 20 頁（約 400 筆）。要全部抓就用 `--full`。

### 排程（每天自動抓 1 次）
- 排程寫在 server.js 裡：每分鐘檢查一次，到了 `CRAWL_TIME`（預設 06:00）就跑。
- 電腦關機或睡眠錯過時間的話，開機後會自動補跑（看今天排定的時間之後有沒有成功跑過）。
- crawl_runs 資料表會記錄每次執行的時間、頁數、新增數、修改數和錯誤。網頁上可以看最近幾次執行，也有「立即抓取」按鈕。
- 用同一把鎖避免重複執行。

### 部署（本機 Windows）
- `scripts/install-task.ps1`：建立 Windows 工作排程「網站更新爬蟲」，登入時用隱藏視窗啟動 `node src/server.js`，失敗會自動重啟，沒有執行時間上限。
- `scripts/uninstall-task.ps1`：移除這個排程。
- 網頁介面在 http://localhost:5190，日誌寫到 `data/logs/`。
- 設定放在 `config.json`：port、CRAWL_TIME、每站的頁數上限。

## 實作順序
1. `package.json`（type: module），依賴只有 `cheerio`；資料庫用 `node:sqlite`。
2. 寫 fetcher、store（建表）、BeClass adapter，先把列表 1 頁存進 DB。
3. 寫 differ（新增/修改/history），再寫詳細頁解析和通用欄位抽取。
4. 寫 site_fields 統計與型別推斷。
5. 寫 server.js（API：活動列表＋篩選、欄位清單、活動歷史）和 public/index.html。
6. 寫 README，說明怎麼新增 adapter。

## 驗證
- `node src/crawl.js --site beclass --pages 2`：DB 會有約 40 筆，created_at = updated_at。
- 立刻再跑一次：新增 0 筆、修改 0 筆，確認變動欄位沒有被誤判成修改。
- 手動改 DB 裡某一筆的地點後再跑：該筆的 updated_at 會更新，並寫入 event_history。
- `GET /api/sites/beclass/fields` 會出現 地點／類別／活動日期，型別也正確。
- 打開網頁介面，用「地點含 高雄」「類別 = 課程/講座」篩選，結果要正確。
- 單元測試（`node --test`）：用存下來的 HTML fixture 測 parseList、parseDetail、名稱正規化和 differ。

## 追加需求（2026-11-01）

### 5. 網頁新增網站（其他網站同樣功能）
- `src/adapters/generic.js`：通用 adapter，設定存在 `sites.json`，不用寫程式。
- 「網站管理」對話框：貼上列表網址 → `POST /api/site-configs/preview` 自動分析 → 預覽活動和欄位 → 儲存。
  - 活動連結規則：把連結網址一般化（數字 → `#`、hex/任意段 → `*`），出現最多次、文字最長的那組就是活動連結。
  - 分頁：找「下一頁 / 2」連結，把頁碼換成 `{page}`。
  - 名稱：取卡片裡的標題元素，並去掉開頭黏著的日期。
  - 欄位：通用「標籤：值」抽取，支援民國年；勾選「每天會變」的欄位 → volatileFields。
- 網站可以啟用、停用、編輯、刪除（可選擇連同資料一起刪），也可以單獨抓一個網站。
- 已用華山 1914 實測：自動找到 `exhibition/*` 和 `?page={page}`。

### 6. 雲端部署（本機關機也能用；免費、不用信用卡）
- 使用者要求免費、註冊不綁信用卡 → **GitHub Actions + GitHub Pages**。
- `.github/workflows/crawl.yml`：每天 UTC 22:00（台灣 06:00）執行，或手動觸發，或 sites.json 變更時自動執行。
  流程：取回 data 分支的資料庫 → 抓取 → 強制推回 data 分支（只保留一份）→ `src/export.js` → 發佈到 Pages。
- 網頁靜態模式：載入 static.json 和 crawler.db，用 sql.js 跑共用的 `src/shared/query.js`（跟伺服器同一套查詢）。
- 新增/修改網站：瀏覽器用 GitHub fine-grained token 改 sites.json（內容 API），推送後會自動觸發抓取。雲端版不能預覽，連結規則和分頁在抓取時自動判斷。
- 網站設定從資料庫的 site_configs 改存到 sites.json（本機版、雲端版共用）。
- Dockerfile 保留給付費主機（`/data` 要掛持久化磁碟，ADMIN_PASSWORD 啟用登入）。
- 待辦：使用者建立 public repo → 推送程式碼和現有資料（data 分支）→ Pages 來源設成 GitHub Actions → 建立權杖。

### 7. 104 職缺（讀通知信，不爬 104）
- 104 對程式一律回 403，不繞過；改讀使用者信箱裡 104 寄的職缺通知信（IMAP，Gmail 應用程式密碼）。
- `src/adapters/mail104.js`：用 collect() 取代翻頁；解析信中 `104.com.tw/job/<id>` 連結（含追蹤轉址裡編碼過的），
  往上找只含該職缺的區塊，辨識公司（含 company 連結）、地區、薪資、經歷、學歷；名稱 =「職缺｜公司」。
- 通知日期、信件主旨列為 volatile；地區 → 縣市。
- 帳密只放 `.env`（本機）或 GitHub Secrets（雲端），沒設定時顯示「未設定信箱」並略過排程。
- 待驗證：用真實的 104 通知信確認解析結果。
