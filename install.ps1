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
# 看门狗（在桥进程里）靠这个脚本来切换系统代理，部署一份到运行目录
Copy-Item "$root\switch-mode.ps1" "$codex\switch-mode.ps1" -Force

# 计划任务直接跑 node 会在用户会话里弹出一个可见控制台窗口，用户手滑关掉
# 就等于杀了桥，而系统代理仍指向 18080 -> 全站打不开。用 wscript 包装静默启动。
# 末参数 bWaitOnReturn=True：让 wscript 存活到 node 退出，计划任务才能继续
# 跟踪进程生命周期（RestartCount / 停止任务 才会作用到真正的桥进程）。
# 脚本路径由 WScript.Arguments(0) 传入，两个任务共用这一个包装器；
# 引号用 Chr(34) 拼接，避免 VBS 嵌套引号转义踩坑。
$launcher = Join-Path $codex 'run-hidden.vbs'
@"
Dim sh, node, js
Set sh = CreateObject("WScript.Shell")
node = "$node"
js = WScript.Arguments(0)
sh.Run Chr(34) & node & Chr(34) & " " & Chr(34) & js & Chr(34), 0, True
"@ | ForEach-Object { [System.IO.File]::WriteAllText($launcher, $_, [System.Text.Encoding]::Unicode) }
Write-Host "已部署到 ~/.codex/（含静默启动器 run-hidden.vbs）"

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
$bypass = '<local>;baidu.com;*.baidu.com;qq.com;*.qq.com;tencent.com;*.tencent.com;aliyun.com;*.aliyun.com;aliyuncs.com;*.aliyuncs.com;taobao.com;*.taobao.com;tmall.com;*.tmall.com;jd.com;*.jd.com;bilibili.com;*.bilibili.com;hdslb.com;*.hdslb.com;bilivideo.com;*.bilivideo.com;163.com;*.163.com;weibo.com;*.weibo.com;douyin.com;*.douyin.com;bytedance.com;*.bytedance.com;polymas.com;*.polymas.com;aihaoke.net;*.aihaoke.net'
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
# 触发器与主体都必须限定当前用户：不带 -User 的 -AtLogOn 会生成 UserId=* 的
# "任意用户登录"触发器，注册它才需要管理员权限（非提权下报 0x80070005）。
# 限定到当前用户后，README 教的"右键 -> 使用 PowerShell 运行"即可完整装好。
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

# Register-ScheduledTask 抛的是 CimException，$ErrorActionPreference='Stop' 拦不住，
# 失败后脚本会继续往下并打印"已注册"。必须显式回查任务是否真的落库。
function Register-TaskVerified {
    param($TaskName, $Action, $Trigger, $Settings, $Description)
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
        -Settings $Settings -Principal $principal -Description $Description | Out-Null
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
        throw "计划任务 '$TaskName' 注册失败（系统中查不到）。若报 0x80070005，请确认当前用户有权创建计划任务。"
    }
}

$bridgeTask = 'Socks HTTP Bridge'
if (Get-ScheduledTask -TaskName $bridgeTask -ErrorAction SilentlyContinue) { Unregister-ScheduledTask $bridgeTask -Confirm:$false }
$act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`" `"$codex\socks-http-bridge.js`""
$trig = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# 桥是常驻守护进程，必须显式取消 Task Scheduler 默认的 72 小时执行时限（PT72H）。
# 否则连续跑满 3 天会被系统强杀，而系统代理仍指向 127.0.0.1:18080 -> 全部流量静默断网。
# PT0S 在计划任务里表示"无限制"。
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-TaskVerified $bridgeTask $act $trig $set '常驻HTTP->SOCKS代理桥(含国内域名直连分流)'
Write-Host "已注册: $bridgeTask (登录时自启)"

$updateTask = 'Update CN Domain Rules'
if (Get-ScheduledTask -TaskName $updateTask -ErrorAction SilentlyContinue) { Unregister-ScheduledTask $updateTask -Confirm:$false }
$act2 = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`" `"$codex\update-cn-rules.js`""
$trig2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9:00AM
$set2 = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-TaskVerified $updateTask $act2 $trig2 $set2 '每周更新国内域名直连规则'
Write-Host "已注册: $updateTask (每周一 09:00)"

Write-Host '=== [7/7] 启动桥 ===' -ForegroundColor Cyan
# 先清掉可能在跑的旧桥（含手工启动的）。否则新任务会因端口占用退出，
# 而 netstat 显示的仍是旧进程的监听 -> 误报安装成功。
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'socks-http-bridge' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "已停止旧桥进程 $($_.ProcessId)" }
Start-Sleep -Seconds 1
Start-ScheduledTask $bridgeTask
Start-Sleep -Seconds 3
$listen = netstat -ano | Select-String ':18080\s.*LISTENING'
if ($listen) { Write-Host '桥已在 127.0.0.1:18080 监听' -ForegroundColor Green }
else { Write-Host '[!] 18080 未监听，请查看 ~/.codex/socks-http-bridge.log' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '=== 安装完成，请自检 ===' -ForegroundColor Green
Write-Host @'
1. 确认 VPN 客户端已用 SOCKS 模式连接，且「设为系统代理」未勾选
2. 测试国外：curl.exe -x http://127.0.0.1:18080 https://www.google.com
3. 测试国内：浏览器打开 B 站 / 百度应无卡顿
4. 日志位置：%USERPROFILE%\.codex\socks-http-bridge.log
5. 卸载：运行仓库内 uninstall.ps1
'@
