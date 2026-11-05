# 家裡電腦每天 06:00 抓 BeClass 並推到 GitHub（取代原本的 self-hosted runner）
# 執行的是這個資料夾裡的程式，不是 GitHub 送來的；要更新程式請自己 git pull。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install-beclass-task.ps1
$ErrorActionPreference = 'Stop'
$TaskName = '網站更新爬蟲 BeClass 同步'
$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node).Source
$EnvFile = Join-Path $Root '.env'

# 檢查 .env 有必要的設定（只檢查有沒有，不印出內容）
# 一定要指定 UTF8：PowerShell 5.1 預設用 Big5 讀，中文註解會吃掉換行
$envText = if (Test-Path -LiteralPath $EnvFile) { Get-Content -LiteralPath $EnvFile -Raw -Encoding UTF8 } else { '' }
$missing = 'SITE_PASSWORD', 'GH_SYNC_TOKEN', 'GH_REPO' | Where-Object { $envText -notmatch "(?m)^\s*$_\s*=\s*\S" }
if ($missing) { throw ".env 缺少：$($missing -join '、')（請看 README「BeClass（家裡電腦）」）" }

# 沿用 runner 時期的資料庫，增量抓取才能接續
$OldDb = 'D:\actions-runner-data\beclass.db'
$NewDb = Join-Path $Root 'data\beclass.db'
if ((Test-Path -LiteralPath $OldDb) -and -not (Test-Path -LiteralPath $NewDb)) {
  New-Item -ItemType Directory -Force (Split-Path $NewDb) | Out-Null
  Copy-Item -LiteralPath $OldDb -Destination $NewDb
  Write-Host "已複製舊資料庫：$OldDb → $NewDb"
}

$cmd = "Set-Location -LiteralPath '$Root'; & '$Node' --env-file-if-exists=.env --disable-warning=ExperimentalWarning src/beclass-sync.js"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -Daily -At '06:00'
# StartWhenAvailable：06:00 沒開機的話，開機後補跑
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description '每天抓 BeClass，加密推到 GitHub data-beclass 分支，再通知雲端合併發佈' | Out-Null
Write-Host "已安裝「$TaskName」，每天 06:00 執行。日誌：data\logs\"
Write-Host "要立刻試跑：Start-ScheduledTask -TaskName '$TaskName'"
