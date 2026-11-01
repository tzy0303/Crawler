# 安裝 GitHub self-hosted runner（給 BeClass 用），並設定登入 Windows 時自動在背景啟動
# 用法：powershell -ExecutionPolicy Bypass -File scripts\setup-runner.ps1 -Token <GitHub 給的註冊碼>
param([Parameter(Mandatory = $true)][string]$Token)
$ErrorActionPreference = 'Stop'
$Runner = 'D:\actions-runner'
$TaskName = 'GitHub Runner BeClass'

Set-Location -LiteralPath $Runner
& .\config.cmd --unattended --url https://github.com/tzy0303/Crawler --token $Token --name home-pc --labels beclass --work _work --replace
if ($LASTEXITCODE -ne 0) { throw 'runner 註冊失敗（註冊碼可能過期，請回 GitHub 頁面重新取得）' }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -Command `"Set-Location -LiteralPath '$Runner'; & .\run.cmd`"" -WorkingDirectory $Runner
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'GitHub self-hosted runner：每天幫雲端抓 BeClass' | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host '完成：runner 已註冊並在背景啟動，之後登入 Windows 會自動啟動'
