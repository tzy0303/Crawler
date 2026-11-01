# 部署：建立 Windows 工作排程，登入時在背景啟動網頁伺服器（內含每日自動抓取排程）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
$ErrorActionPreference = 'Stop'
$TaskName = '網站更新爬蟲'
$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node).Source

$cmd = "Set-Location -LiteralPath '$Root'; & '$Node' --env-file-if-exists=.env --disable-warning=ExperimentalWarning src/server.js"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description '活動網站更新爬蟲：http://localhost:5190，每天自動抓取一次' | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "已安裝並啟動「$TaskName」，網頁：http://localhost:5190"
