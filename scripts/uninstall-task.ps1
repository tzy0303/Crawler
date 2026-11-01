# 移除部署：停止並刪除 Windows 工作排程
$TaskName = '網站更新爬蟲'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*src/server.js*' -and $_.CommandLine -like '*disable-warning*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "已移除「$TaskName」"
