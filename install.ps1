# ============================================================
# socks-http-bridge 一键安装脚本
# 右键本文件 -> 使用 PowerShell 运行
#
# 功能：部署 HTTP->SOCKS5 代理桥（127.0.0.1:18080），内置
# 国内域名规则直连分流；配置系统代理、环境变量与开机自启。
#
# 前提：
#   1. 已安装 Node.js (https://nodejs.org LTS)
#   2. 已安装 AnyCast 类 VPN 并以 SOCKS 模式（端口 1080）连接，
#      且客户端里「设为系统代理」保持取消勾选
# ============================================================
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$codex = Join-Path $env:USERPROFILE '.codex'
$SocksPort = 1080      # AnyCast SOCKS 端口，如有不同请修改

Write-Host '=== [1/7] 检查 Node.js ===' -ForegroundColor Cyan
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Host '[!] 未检测到 Node.js。请先到 https://nodejs.org 下载安装 LTS 版，装完重新运行本脚本。' -ForegroundColor Red
    exit 1
}
Write-Host "OK: $node"

Write-Host '=== [2/7] 部署脚本 ===' -ForegroundColor Cyan
New-Item $codex -ItemType Directory -Force | Out-Null
Copy-Item "$root\bridge\socks-http-bridge.js" "$codex\socks-http-bridge.js" -Force
Copy-Item "$root\bridge\update-cn-rules.js" "$codex\update-cn-rules.js" -Force
Write-Host '已部署到 ~/.codex/'

Write-Host '=== [3/7] 生成国内域名规则（需能访问 GitHub，首次约 1~2 分钟）===' -ForegroundColor Cyan
try {
    & $node "$codex\update-cn-rules.js"
} catch {
    Write-Host '[!] 规则下载失败（不影响安装）。可稍后连上 VPN 再手动执行：' -ForegroundColor Yellow
    Write-Host "    node `"$codex\update-cn-rules.js`"" -ForegroundColor Yellow
    Write-Host '    无规则文件时桥行为=全部流量进 SOCKS（与最简模式一致）。' -ForegroundColor Yellow
}

Write-Host '=== [4/7] 配置系统代理 ===' -ForegroundColor Cyan
$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty -Path $reg -Name ProxyEnable -Value 1
Set-ItemProperty -Path $reg -Name ProxyServer -Value '127.0.0.1:18080'
# 第一层绕过名单：高频国内域名 + 局域网（其余国内域名由桥内规则兜底）
$bypass = '<local>;baidu.com;*.baidu.com;qq.com;*.qq.com;tencent.com;*.tencent.com;aliyun.com;*.aliyun.com;aliyuncs.com;*.aliyuncs.com;taobao.com;*.taobao.com;tmall.com;*.tmall.com;jd.com;*.jd.com;bilibili.com;*.bilibili.com;hdslb.com;*.hdslb.com;bilivideo.com;*.bilivideo.com;163.com;*.163.com;weibo.com;*.weibo.com;douyin.com;*.douyin.com;bytedance.com;*.bytedance.com'
Set-ItemProperty -Path $reg -Name ProxyOverride -Value $bypass
Write-Host 'ProxyServer=127.0.0.1:18080，绕过名单已写入'

Write-Host '=== [5/7] 配置用户环境变量（CLI 工具用）===' -ForegroundColor Cyan
Set-ItemProperty 'HKCU:\Environment' -Name HTTP_PROXY  -Value 'http://127.0.0.1:18080'
Set-ItemProperty 'HKCU:\Environment' -Name HTTPS_PROXY -Value 'http://127.0.0.1:18080'
Set-ItemProperty 'HKCU:\Environment' -Name ALL_PROXY   -Value 'http://127.0.0.1:18080'
Set-ItemProperty 'HKCU:\Environment' -Name NO_PROXY    -Value 'localhost,127.0.0.1,::1,bilibili.com,hdslb.com,bilivideo.com'
Write-Host '环境变量已写入（新开的终端才生效）'

# 广播代理设置变更
Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOptionW(System.IntPtr hInternet, int dwOption, System.IntPtr lpBuffer, int dwBufferLength);
'@
[Win32.Native]::InternetSetOptionW([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[Win32.Native]::InternetSetOptionW([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null

Write-Host '=== [6/7] 注册计划任务 ===' -ForegroundColor Cyan
$bridgeTask = 'Socks HTTP Bridge'
if (Get-ScheduledTask -TaskName $bridgeTask -ErrorAction SilentlyContinue) { Unregister-ScheduledTask $bridgeTask -Confirm:$false }
$act = New-ScheduledTaskAction -Execute $node -Argument "`"$codex\socks-http-bridge.js`""
$trig = New-ScheduledTaskTrigger -AtLogOn
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $bridgeTask -Action $act -Trigger $trig -Settings $set -Description '常驻HTTP->SOCKS代理桥(含国内域名直连分流)' | Out-Null
Write-Host "已注册: $bridgeTask (登录时自启)"

$updateTask = 'Update CN Domain Rules'
if (Get-ScheduledTask -TaskName $updateTask -ErrorAction SilentlyContinue) { Unregister-ScheduledTask $updateTask -Confirm:$false }
$act2 = New-ScheduledTaskAction -Execute $node -Argument "`"$codex\update-cn-rules.js`""
$trig2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9:00AM
$set2 = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $updateTask -Action $act2 -Trigger $trig2 -Settings $set2 -Description '每周更新国内域名直连规则' | Out-Null
Write-Host "已注册: $updateTask (每周一 09:00)"

Write-Host '=== [7/7] 启动桥 ===' -ForegroundColor Cyan
Start-ScheduledTask $bridgeTask
Start-Sleep -Seconds 3
$listen = netstat -ano | Select-String ':18080\s.*LISTENING'
if ($listen) { Write-Host '桥已在 127.0.0.1:18080 监听' -ForegroundColor Green }
else { Write-Host '[!] 18080 未监听，请查看 ~/.codex/socks-http-bridge.err.log' -ForegroundColor Red }

Write-Host ''
Write-Host '=== 安装完成，请自检 ===' -ForegroundColor Green
Write-Host @'
1. 确认 VPN 客户端已用 SOCKS 模式连接，且「设为系统代理」未勾选
2. 测试国外：curl.exe -x http://127.0.0.1:18080 https://www.google.com
3. 测试国内：浏览器打开 B 站 / 百度应无卡顿
4. 日志位置：%USERPROFILE%\.codex\socks-http-bridge.log
5. 卸载：运行仓库内 uninstall.ps1
'@
