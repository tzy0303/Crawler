# 網站活動更新爬蟲

定期抓取活動網站（內建 BeClass，其他網站可以直接在網頁上新增）：

- 活動第一次出現時存起來；之後**用活動名稱判斷**是否為同一筆，記錄**新增時間**與**修改時間**，修改內容會留在修改紀錄。
- 篩選條件**依網站實際有的欄位自動產生**（有地點就能篩地點，還會從地點推出縣市）。
- **每天自動抓 1 次**（中午 12:00，錯過會補跑）。
- **在網頁上新增網站**：貼上列表網址 → 自動分析活動連結與分頁 → 預覽 → 儲存，不用寫程式。

需要 Node.js 22.13 以上，資料庫用 Node 內建的 SQLite（`data/crawler.db`）。

## 使用

```bash
npm install
npm start                     # 網頁介面 + 每日排程：http://localhost:5190
npm run crawl                 # 手動抓所有啟用的網站（增量）
npm run crawl -- --site beclass --pages 5
npm run crawl -- --site beclass --full   # 全部頁面（BeClass 約 300 頁，要 1~2 小時）
npm test
```

## 新增網站（網頁）

右上角「網站管理」→ 新增網站：

1. 貼上活動**列表頁**網址，按「分析」。
2. 系統會找出重複出現的活動連結（例如 `www.huashan1914.com/exhibition/*`）和分頁網址（`?page={page}`），預覽第 1 頁的活動和前 3 個活動的欄位。
3. 勾選「每天會變」的欄位（剩餘名額、瀏覽次數等），這些欄位變動不算修改。
4. 儲存。之後每天會和其他網站一起自動抓。

限制：
- 用 JavaScript 動態載入列表的網站（例如 Accupass）抓不到連結，分析時會提示。
- 欄位只抓頁面上「標籤：值」格式的內容（例如「地點：台北市…」），抓得到多少取決於網站本身。
- 結構特殊的網站可以像 `src/adapters/beclass.js` 一樣寫專用 adapter，在 `src/adapters/index.js` 註冊。

## 104 職缺（讀通知信，不爬 104）

104 會擋掉自動程式（HTTP 403），所以不抓 104 網站，改成讀你信箱裡 104 寄來的**職缺通知信**，把信裡的職缺存進系統。名稱用「職缺名稱｜公司」判斷：新的職缺記錄新增時間，同一職缺的薪資等內容變了就記錄修改時間。另外也可以依地區、縣市、薪資、經歷、學歷篩選。

1. 在 104 存好搜尋條件，並開啟 **email 職缺通知**。
2. 信箱要能用 IMAP 讀取。Gmail：開啟兩步驟驗證 → [建立應用程式密碼](https://myaccount.google.com/apppasswords)。
3. 本機：複製 `.env.example` 成 `.env`，填上 `IMAP_USER`、`IMAP_PASSWORD`，然後重新啟動服務。
   雲端：repo **Settings → Secrets and variables → Actions** 新增 `IMAP_USER`、`IMAP_PASSWORD`。
4. 第一次會讀最近 30 天的信，之後每天讀最近 3 天的信（`config.json` 的 `sites.mail104.initialDays`、`sinceDays`）。

沒設定信箱時，網站清單會顯示「未設定信箱」，排程也會略過。注意：雲端版網頁是公開的，職缺資料也會公開。

## 部署到雲端：GitHub（免費、不用信用卡，本機關機也能用）

用 GitHub Actions 每天抓取，GitHub Pages 放網頁。

- `.github/workflows/crawl.yml`：每天台灣 12:00（GitHub 排程可能延遲）執行 `src/crawl.js`。資料庫存在 repo 的 **`data` 分支**（只保留最新一份，repo 不會越長越大），再用 `src/export.js` 匯出網頁發佈到 Pages。
- **網頁**：瀏覽器直接載入資料庫（sql.js）查詢，篩選、修改紀錄和本機版一樣。
- **新增/修改網站**：在雲端網頁的「網站管理」操作，會用你的 GitHub 權杖修改 repo 的 `sites.json`，並自動觸發一次抓取（約 2～10 分鐘後重新整理就看得到）。雲端版不能即時預覽，活動連結和分頁會在抓取時自動判斷。
- **立即抓取**：網頁按鈕，或 GitHub → Actions → 每日抓取 → Run workflow。

一次性設定：

1. 建一個 **public** repo（GitHub Pages 免費版只支援 public repo，所以活動資料和 `sites.json` 會是公開的）。
2. 推上程式碼。
3. repo **Settings → Pages → Source 選「GitHub Actions」**。
4. 到 GitHub 個人 **Settings → Developer settings → Fine-grained tokens** 建立權杖：只授權這個 repo，權限 **Contents: Read and write**、**Actions: Read and write**。第一次在網頁修改網站時貼上，權杖只存在你的瀏覽器裡。

**網站密碼（建議設定）**：在 repo **Settings → Secrets and variables → Actions** 新增 `SITE_PASSWORD`，之後雲端每次執行都會：
- 把網頁資料加密成 `data.enc`（AES-256-GCM，金鑰由密碼經 PBKDF2 推導），打開網頁要先輸入密碼，在瀏覽器裡解密。
- `data` 分支也只存加密後的 `crawler.db.enc`，public repo 裡看不到內容。
- 執行紀錄（公開）只記數量，不印出活動和職缺名稱。

這是一組共用密碼，不是個人帳號。加密檔可以公開下載，所以密碼請設 12 個字以上。登入時可以勾選「記住這台裝置」，按右上角「登出」可以清除。

注意：public repo 如果連續 60 天沒有任何活動，GitHub 會自動停用排程。屆時到 Actions 頁面按一下重新啟用即可。

## BeClass（家裡電腦）

BeClass 封鎖雲端主機的 IP，所以由家裡電腦每天抓：Windows 工作排程在 12:00 執行 `src/beclass-sync.js`，抓完加密推到 `data-beclass` 分支，再通知雲端合併並發佈網站。12:00 沒開機的話，開機後會補跑；家裡電腦一直沒開時，雲端 12:30 的排程仍會照常發佈其他網站。

**安全設計**：家裡電腦執行的是這個資料夾裡的程式，GitHub 無法遠端叫它執行任何東西（不使用 self-hosted runner）。所以 repo 就算被改，也不會影響家裡電腦。代價是程式更新後要自己 `git pull`，網頁上也不能「立即抓取」BeClass。

一次性設定：

1. GitHub 個人 **Settings → Developer settings → Fine-grained tokens** 建立一個**新的**權杖（不要和網頁用的共用）：只授權這個 repo，**Contents: Read and write**、**Actions: Read and write**，設定到期日（例如 1 年）。
2. `.env` 填上 `SITE_PASSWORD`（和 GitHub Secrets 相同）、`GH_SYNC_TOKEN`、`GH_REPO`（見 `.env.example`）。
3. 安裝排程（會自動沿用舊的 `D:\actions-runner-data\beclass.db`）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-beclass-task.ps1
   Start-ScheduledTask -TaskName '網站更新爬蟲 BeClass 同步'   # 立刻試跑，日誌在 data\logs\
   ```
4. 移除：`scripts\uninstall-beclass-task.ps1`。

## 部署到其他雲端主機（Docker）

專案也包好了 `Dockerfile`，可以部署到任何支援 Docker **和持久化磁碟**的平台（Zeabur、Railway、Fly.io…，大多要付費）。

| 設定 | 值 |
|---|---|
| 持久化磁碟 | 掛到 `/data`（資料庫、`sites.json`、日誌都在這裡）；**沒有掛磁碟的話，每次重新部署資料都會消失** |
| `ADMIN_PASSWORD` | **一定要設**。網頁會要求登入，帳號預設 `admin` |
| `ADMIN_USER` | 選填，登入帳號 |
| `CRAWL_TIME` | 選填，每日抓取時間（台灣時間，預設 06:00） |
| `PORT` | 平台通常會自動帶入，預設 8080 |
| 實例 | 要**一直開著**（不能用「閒置自動休眠」的免費方案，不然排程不會跑） |

健康檢查路徑：`/healthz`。

要把本機資料搬上去：先停掉本機服務，再把 `data/crawler.db` 上傳到雲端磁碟的 `/data/crawler.db`（各平台方式不同），然後重新啟動。

## 部署到本機 Windows（開機登入就自動執行）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1    # 安裝並啟動
powershell -ExecutionPolicy Bypass -File scripts\uninstall-task.ps1  # 移除
```

會建立 Windows 工作排程「網站更新爬蟲」，登入時在背景啟動 `src/server.js`。日誌在 `data/logs/YYYY-MM.log`。

## 設定 `config.json`

| 欄位 | 說明 |
|---|---|
| `port` | 網頁介面埠號（預設 5190，環境變數 `PORT` 優先） |
| `crawlTime` | 每天自動抓取時間（台灣時間 HH:mm） |
| `dbFile` | SQLite 檔案位置（環境變數 `DB_FILE` 優先） |
| `sites.<id>` | 內建網站的 `enabled`、`maxPages`（增量最多幾頁）、`initialPages`（第一次抓幾頁） |

網頁新增的網站設定存在 `sites.json`（本機版、雲端版共用）。

## 判斷規則

- **同一活動**：名稱正規化後相同（全形轉半形、壓縮空白）。
- **修改**：穩定欄位有變才算。每天會變的欄位（`volatileFields`）和衍生欄位（縣市）不算。
- **增量抓取**：從第 1 頁往後抓，連續 2 頁沒有新增或修改就停，或是抓到頁數上限為止。
- **可篩選欄位**：出現率 ≥ 30%，而且至少有 2 種不同的值（每筆都一樣的頁尾電話不算）。型別自動判斷：日期 → 區間；數字 → 範圍；多值標籤/值種類少 → 下拉選單；其他 → 關鍵字。

## 結構

```
src/adapters/    beclass.js（專用）、generic.js（網頁新增的通用 adapter + 自動分析）、index.js（內建 + sites.json）
src/core/        fetcher（速率限制/重試/編碼）、extract（欄位抽取/縣市）、differ（新增/修改判斷）、
                 fields（動態欄位）、store（SQLite）、crawler
src/crawl.js     CLI
src/export.js    匯出雲端靜態網頁（GitHub Pages）
src/beclass-sync.js  家裡電腦：抓 BeClass → 加密推到 data-beclass → 通知雲端合併
src/shared/      查詢邏輯（伺服器與瀏覽器共用）
src/server.js    API + 網頁 + 每日排程 + 登入
src/scheduler.js 每日排程
public/          網頁介面
scripts/         Windows 本機部署腳本
.github/workflows/crawl.yml  GitHub 每日抓取 + 發佈網頁
Dockerfile       其他雲端主機
```
