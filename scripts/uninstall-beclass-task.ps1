# 移除 BeClass 每日同步排程
$TaskName = '網站更新爬蟲 BeClass 同步'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "已移除「$TaskName」"
