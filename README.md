# 網站活動更新爬蟲

每天抓活動網站和 104 職缺通知信，記下每一筆**什麼時候新增**、**什麼時候修改**，加密後發佈成網頁（GitHub Pages），在瀏覽器裡解密查詢。不需要一直開著的伺服器。

- 第一次看到的活動存起來；之後用**網站 ID**（BeClass 的 rid、104 職缺代碼、活動網址）或**公司（作者）＋標題**判斷是否同一筆（網站重開會換 ID，用後者接回原本那筆）。公司（作者）：BeClass 承辦人員帳號、104 公司、IT 邦幫忙作者；自訂網站沒有。
- 修改內容會留在修改紀錄；每天會變的欄位（剩餘名額等）不算修改。
- 篩選條件**依網站實際有的欄位自動產生**（有地點就能篩地點，還會從地點推出縣市）。
- 在網頁的「網站管理」新增網站，不用寫程式。

需要 Node.js 22.13 以上，資料庫用 Node 內建的 SQLite。

## 架構

| 在哪裡 | 做什麼 |
|---|---|
| 家裡電腦 | 每天 06:00 抓 BeClass（BeClass 封鎖雲端主機），加密推到 `data-beclass` 分支，通知雲端合併 |
| GitHub Actions | 每天 06:30 抓其他網站、讀 104 信、合併 BeClass，存回 `data` 分支，發佈網頁；出錯時開 Issue |
| GitHub Pages | 放網頁和加密資料 `data.enc` |
| 你的瀏覽器 | 輸入網站密碼 → 解密 → 用 sql.js 查詢 |

## 指令

```bash
npm install
npm run crawl                 # 手動抓所有啟用的網站（增量，存到 data/crawler.db）
npm run crawl -- --site beclass --pages 5
npm run crawl -- --site beclass --full   # 全部頁面（BeClass 約 300 頁，要 1~2 小時）
npm test
```

平常不需要手動執行：雲端和家裡電腦都會每天自動跑。

## GitHub 設定（一次性）

1. 建一個 **public** repo（GitHub Pages 免費版只支援 public repo，所以 `sites.json` 會是公開的；資料一律加密）。
2. 推上程式碼。
3. repo **Settings → Pages → Source 選「GitHub Actions」**。
4. repo **Settings → Secrets and variables → Actions** 新增：
   - `SITE_PASSWORD`（**必須**，至少 12 個字）：網站密碼。沒有設定或太短，雲端會直接停止、不發佈，避免資料在 public repo 公開。
   - `IMAP_USER`、`IMAP_PASSWORD`：104 通知信的信箱（見下方）。
5. 個人 **Settings → Developer settings → Fine-grained tokens** 建立網頁用的權杖：只授權這個 repo，**Contents: Read and write**、**Actions: Read and write**。第一次在網頁修改網站時貼上，會用網站密碼加密後存在瀏覽器裡。

**網站密碼**：網頁資料加密成 `data.enc`（AES-256-GCM，金鑰由密碼經 PBKDF2 推導），`data` 分支也只放加密檔。這是一組共用密碼，不是個人帳號；加密檔可以公開下載，所以密碼要夠長。登入時可以勾選「記住這台裝置」（只存不能匯出的金鑰，不存密碼），按右上角「登出」清除。

**注意：這個 GitHub 帳號不要再開其他 GitHub Pages 網站。** 同一帳號的所有 Pages 網站共用 `帳號.github.io` 這個網域，瀏覽器會讓它們共用儲存空間，其他網站的程式就能拿到這裡記住的登入金鑰和 GitHub 權杖。真的要開，請先替這個專案設定自訂網域（repo **Settings → Pages → Custom domain**），或改用另一個 GitHub 帳號。

## 每日抓取（雲端）

`.github/workflows/crawl.yml`：每天台灣 06:30（GitHub 排程可能延遲）、家裡電腦推完 BeClass 後、或 main 有新程式時執行。

1. 跑測試，失敗就不抓、不發佈。
2. 從 `data` 分支取回資料庫並解密。
3. 抓各網站、讀 104 信；合併家裡電腦抓的 BeClass。
4. 檢查活動筆數，少了 10% 以上就停止（資料可能被寫壞）。
5. 加密存回 `data` 分支（只保留最新一份），另存 7 天備份。
6. 匯出網頁並發佈到 Pages（只放最近一年還看得到的活動，見下方）。
7. 檢查資料品質和網頁資料大小。

**立即抓取**：網頁的按鈕，或 GitHub → Actions → 每日抓取 → Run workflow。

**出問題時的通知**：抓取失敗、網頁沒發佈、BeClass 超過 3 天沒更新（家裡電腦沒開機）、資料品質有問題、或網頁資料超過 15 MB 時，會在 repo 開一個「每日抓取有問題」的 Issue，GitHub 會寄信給你；問題沒解決前每天在同一個 Issue 留言。處理好後關閉 Issue。

**資料品質檢查**（`src/quality.js`）：抓取「成功」但內容壞掉時也會通知，例如網站改版後某個欄位抓不到。比較最近一次看到的資料和比較早的資料，以前至少 60% 有填的欄位，最近的填寫率掉到一半以下就回報；某個網站這次抓到 0 筆也回報。

**網頁只放最近一年**：`config.json` 的 `webRetentionDays`（預設 365）天內還出現過的活動才放進網頁，網頁才不會越來越慢；完整歷史仍保留在 `data` 分支的資料庫和備份裡。

**備份與還原**：到 Actions 找資料正常那天的執行 → 頁面下方 Artifacts 下載 `crawler-db-…` → 解壓縮得到 `crawler.db.enc` → 推到 `data` 分支取代現有檔案。

**GitHub 以外的備份**：家裡電腦每天同步 BeClass 後，會把雲端的完整資料庫（已加密）下載一份到 `data/backups/crawler-日期.db.enc`，保留最近 30 份（一份約 11 MB）。建議在 `.env` 設 `BACKUP_DIR` 到另一顆硬碟或 OneDrive／Google Drive 的同步資料夾。還原：`node src/secure.js decrypt <備份檔> data/crawler.db`（需要 `.env` 的網站密碼）。

public repo 連續 60 天沒有活動時，GitHub 會自動停用排程；家裡電腦每天同步 BeClass 時會檢查，被停用就自動重新啟用。

**安全設計**：密碼只給用得到的步驟，安裝套件時拿不到任何密碼；抓取、發佈網頁、開 Issue 分成三個 job，各自只有需要的權限。爬蟲不會連到內部網路位址，每次轉址都會再檢查。

## BeClass（家裡電腦）

BeClass 封鎖雲端主機的 IP，所以由家裡電腦每天抓：Windows 工作排程在 06:00 執行 `src/beclass-sync.js`，抓完加密推到 `data-beclass` 分支，再通知雲端合併並發佈網站。06:00 沒開機的話，開機後會補跑；家裡電腦一直沒開時，雲端 06:30 的排程仍會照常發佈其他網站。

家裡電腦執行的是這個資料夾裡的程式，GitHub 無法遠端叫它執行任何東西。所以 repo 就算被改，也不會影響家裡電腦。代價是程式更新後要自己 `git pull`，網頁上也不能「立即抓取」BeClass。

一次性設定：

1. 建立一個**新的** fine-grained 權杖（不要和網頁用的共用）：只授權這個 repo，**Contents: Read and write**、**Actions: Read and write**，設定到期日（例如 1 年）。
2. 複製 `.env.example` 成 `.env`，填上 `SITE_PASSWORD`（和 GitHub Secrets 相同）、`GH_SYNC_TOKEN`、`GH_REPO`。
3. 安裝排程：
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-beclass-task.ps1
   Start-ScheduledTask -TaskName '網站更新爬蟲 BeClass 同步'   # 立刻試跑，日誌在 data\logs\
   ```
4. 移除：`scripts\uninstall-beclass-task.ps1`。

## 104 職缺（讀通知信，不爬 104）

104 會擋掉自動程式（HTTP 403），所以改成讀信箱裡 104 寄來的**職缺通知信**（配對日報、企業邀請）。同一職缺用 104 的職缺代碼判斷，名稱顯示「職缺名稱｜公司」；薪資等內容變了就記錄修改時間。可以依地區、縣市、公司、薪資、經歷、學歷篩選。

1. 在 104 存好搜尋條件，並開啟 **email 職缺通知**。
2. 建議用**專門收 104 信的信箱**。Gmail：開啟兩步驟驗證 → [建立應用程式密碼](https://myaccount.google.com/apppasswords)。
3. 把信箱和應用程式密碼設成 GitHub Secrets 的 `IMAP_USER`、`IMAP_PASSWORD`（本機測試則填在 `.env`）。
4. 第一次會讀最近 30 天的信，之後每天讀最近 3 天的信（`config.json` 的 `sites.mail104.initialDays`、`sinceDays`）。

沒設定信箱時，網站清單會顯示「未設定信箱」，排程也會略過。

## 新增網站（網頁）

右上角「網站管理」→ 填網站名稱和活動**列表頁**網址（頁碼用 `{page}`）→ 儲存。設定會寫進 repo 的 `sites.json` 並自動觸發一次抓取，活動連結和分頁會在抓取時自動判斷，約 2～10 分鐘後重新整理頁面就看得到。

- **新增前先看對方的 robots.txt**（例如 `https://網站/robots.txt`），網站禁止抓的網址就不要加。
- 用 JavaScript 動態載入列表的網站抓不到連結。
- 欄位只抓頁面上「標籤：值」格式的內容（例如「地點：台北市…」）。
- 結構特殊的網站可以像 `src/adapters/beclass.js` 一樣寫專用 adapter，在 `src/adapters/index.js` 註冊。

## 設定 `config.json`

| 欄位 | 說明 |
|---|---|
| `crawlTime` | 網頁上顯示的每日抓取時間（實際排程在 workflow 和家裡電腦的工作排程） |
| `dbFile` | SQLite 檔案位置（環境變數 `DB_FILE` 優先） |
| `webRetentionDays` | 網頁只放幾天內還出現過的活動（預設 365） |
| `sites.<id>` | 內建網站的 `enabled`、`maxPages`（增量最多幾頁）、`initialPages`（第一次抓幾頁） |

網頁新增的網站設定存在 `sites.json`。

## 判斷規則

- **同一活動**：先用網站 ID 找（改標題算修改）；找不到再用「公司（作者）＋標題」找（網站重開換了 ID）。標題會正規化（全形轉半形、壓縮空白）。公司不同就不是同一筆；舊資料或 RSS 沒有公司時只比標題。同一次抓取裡同公司同標題的多筆只記第一筆。
- **修改**：名稱或穩定欄位有變才算。每天會變的欄位（`volatileFields`）和衍生欄位（縣市）不算；只是多抓到原本沒有的欄位也不算。
- **增量抓取**：從第 1 頁往後抓，連續 2 頁沒有新增或修改就停，或是抓到頁數上限為止。
- **可篩選欄位**：出現率 ≥ 30%，而且至少有 2 種不同的值（每筆都一樣的頁尾電話不算）。型別自動判斷：日期 → 區間；數字 → 範圍；多值標籤/值種類少 → 下拉選單；其他 → 關鍵字。

## 結構

```
src/adapters/    beclass、ithelp、mail104（專用）、generic（網頁新增的網站）、index（內建 + sites.json）
src/core/        fetcher（速率限制/重試/擋內網）、extract（欄位抽取/縣市）、differ（新增/修改判斷）、
                 fields（動態欄位）、store（SQLite 與升級）、crawler、merge、github
src/shared/      查詢與加解密（Node 和瀏覽器共用）
src/crawl.js     抓取指令
src/quality.js   資料品質檢查
src/backfill.js  重算衍生欄位、一次性資料修正
src/export.js    匯出雲端網頁（加密）
src/secure.js    資料庫加解密
src/fragment.js  單一網站資料片段的匯出與合併（BeClass）
src/beclass-sync.js  家裡電腦：抓 BeClass → 加密推到 data-beclass → 通知雲端合併
public/          網頁介面
scripts/         家裡電腦的 BeClass 排程安裝與移除
.github/workflows/crawl.yml  每日抓取、發佈網頁、出錯通知
```
