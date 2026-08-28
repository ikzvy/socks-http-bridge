# ============================================================
# socks-http-bridge 模式切换脚本
# 用法（右键"使用 PowerShell 运行"不行，需带参数）：
#   pwsh -File switch-mode.ps1 -Mode TUN     # Anycast 用 TUN 模式时
#   pwsh -File switch-mode.ps1 -Mode Bridge  # Anycast 用 SOCKS 模式时（默认）
#
# 背景：Anycast 客户端切到 TUN 模式时会停掉 1080 SOCKS 端口，
# 此时若系统代理仍指向本桥，国外请求会全部 502。
# 两种模式必须配套切换系统代理与代理环境变量：
#   TUN    -> 关闭系统代理、清除代理环境变量，全部流量交给 TUN
#   Bridge -> 开启系统代理 127.0.0.1:18080、写入代理环境变量
# ============================================================
param([Parameter(Mandatory=$true)][ValidateSet('TUN','Bridge')][string]$Mode)

$ErrorActionPreference = 'Stop'
$inets = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$codex = Join-Path $env:USERPROFILE '.codex'
# 与 install.ps1 保持一致的高频国内域名绕过名单
$noProxy = 'localhost,127.0.0.1,::1,qoder.com.cn,qoder.com,qoder.cn,qoder.sh,aliyuncs.com,codebuddy.cn,codebuddy.com,doubao.com,cici.com,dola.com,volces.com,volcengine.com,xiaoheihe.net,heybox.com,maxjia.com,steamstatic.com,epicgames.com,battlenet.com,blizzard.com,ea.com,ubisoft.com,riotgames.com,rockstargames.com,hdslb.com,bilivideo.com,bilivideo.cn,biliapi.net,biliapi.com,bcdn.net,acgvideo.com,im9.com'

if ($Mode -eq 'TUN') {
    Write-Host '=== 切换到 TUN 模式（Anycast 全权接管）===' -ForegroundColor Cyan
    Set-ItemProperty $inets -Name ProxyEnable -Value 0
    foreach ($v in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY') {
        [Environment]::SetEnvironmentVariable($v, $null, 'User')
        [Environment]::SetEnvironmentVariable($v.ToLower(), $null, 'User')
    }
    Write-Host '已关闭系统代理，已清除 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY 环境变量'
    Write-Host '注意：已在运行的程序（浏览器/Antigravity）需完全重启后才会放弃旧代理设置'
}
else {
    Write-Host '=== 切换到 Bridge 模式（本桥接管系统代理）===' -ForegroundColor Cyan
    Set-ItemProperty $inets -Name ProxyServer -Value '127.0.0.1:18080'
    Set-ItemProperty $inets -Name ProxyEnable -Value 1
    [Environment]::SetEnvironmentVariable('HTTP_PROXY', 'http://127.0.0.1:18080', 'User')
    [Environment]::SetEnvironmentVariable('HTTPS_PROXY', 'http://127.0.0.1:18080', 'User')
    [Environment]::SetEnvironmentVariable('ALL_PROXY', 'http://127.0.0.1:18080', 'User')
    [Environment]::SetEnvironmentVariable('NO_PROXY', $noProxy, 'User')
    # 确认桥在运行
    if (-not (netstat -ano | Select-String ':18080\s.*LISTENING')) {
        $task = @('Codex Anycast HTTP Bridge', 'Socks HTTP Bridge') |
            ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue } |
            Select-Object -First 1
        if ($task) { Start-ScheduledTask -TaskName $task.TaskName }
        else { Start-Process -FilePath (Get-Command node).Source -ArgumentList "`"$codex\socks-http-bridge.js`"" -WindowStyle Hidden }
        Start-Sleep -Seconds 2
    }
    Write-Host '已开启系统代理 127.0.0.1:18080 并写入代理环境变量'
}

Write-Host '=== 当前状态 ===' -ForegroundColor Cyan
Get-ItemProperty $inets | Select-Object ProxyEnable, ProxyServer | Format-List
Write-Host '完成。切换模式后请完全重启浏览器/Antigravity 等应用。'
