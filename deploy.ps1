# ============================================================
# socks-http-bridge 更新部署脚本（开发用）
# 改完代码后运行：同步脚本到运行目录 → 重启桥 → 验证。
# 右键本文件 -> 使用 PowerShell 运行
# ============================================================
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$codex = Join-Path $env:USERPROFILE '.codex'

Write-Host '=== [1/4] 同步脚本到运行目录 ===' -ForegroundColor Cyan
Copy-Item "$root\bridge\socks-http-bridge.js" "$codex\socks-http-bridge.js" -Force
Copy-Item "$root\bridge\update-cn-rules.js" "$codex\update-cn-rules.js" -Force
Write-Host "已同步到 $codex"

Write-Host '=== [2/4] 重启桥进程 ===' -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'socks-http-bridge' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "已停止旧桥进程 $($_.ProcessId)" }
Start-Sleep -Seconds 1

$task = @('Codex Anycast HTTP Bridge', 'Socks HTTP Bridge') |
    ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue } |
    Select-Object -First 1
if ($task) {
    Start-ScheduledTask -TaskName $task.TaskName
    Write-Host "已通过计划任务启动: $($task.TaskName)"
} else {
    Start-Process -FilePath (Get-Command node).Source -ArgumentList "`"$codex\socks-http-bridge.js`"" -WindowStyle Hidden
    Write-Host '未找到计划任务，已直接启动（建议通过 install.ps1 注册自启）'
}
Start-Sleep -Seconds 3

Write-Host '=== [3/4] 检查监听 ===' -ForegroundColor Cyan
if (netstat -ano | Select-String ':18080\s.*LISTENING') {
    Write-Host '18080 监听正常' -ForegroundColor Green
} else {
    Write-Host '[!] 18080 未监听，请检查 ~/.codex/socks-http-bridge.err.log' -ForegroundColor Red
    exit 1
}

Write-Host '=== [4/4] 连通性抽查 ===' -ForegroundColor Cyan
curl.exe -o NUL -s -w '国内(应直连秒回): %{time_total}s HTTP:%{http_code}' -x http://127.0.0.1:18080 -m 10 https://www.baidu.com/
Write-Host ''
curl.exe -o NUL -s -w '国外(走隧道): %{time_total}s HTTP:%{http_code}' -x http://127.0.0.1:18080 -m 20 https://www.google.com/
Write-Host ''
Write-Host '--- 桥日志最新 2 条 ---'
Get-Content "$codex\socks-http-bridge.log" -Tail 2
Write-Host ''
Write-Host '部署完成。记得提交代码：git add -A; git commit; git push' -ForegroundColor Green
