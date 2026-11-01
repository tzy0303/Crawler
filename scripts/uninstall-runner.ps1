# 移除 BeClass 用的 GitHub runner（先到 GitHub 取得移除碼：Settings → Actions → Runners → home-pc → Remove）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\uninstall-runner.ps1 -Token <移除碼>
param([Parameter(Mandatory = $true)][string]$Token)
$TaskName = 'GitHub Runner BeClass'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'Runner.Listener.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Set-Location -LiteralPath 'D:\actions-runner'
& .\config.cmd remove --token $Token
Write-Host '已移除'
