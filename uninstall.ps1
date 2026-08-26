# ============================================================
# socks-http-bridge 卸载脚本（右键 -> 使用 PowerShell 运行）
# 移除计划任务、脚本文件、环境变量；系统代理改回直连。
# ============================================================
$ErrorActionPreference = 'Stop'
$codex = Join-Path $env:USERPROFILE '.codex'

Write-Host '=== [1/5] 停止并删除计划任务 ===' -ForegroundColor Cyan
foreach ($name in @('Socks HTTP Bridge', 'Update CN Domain Rules')) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "已删除计划任务: $name"
    }
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'socks-http-bridge' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "已停止桥进程 $($_.ProcessId)" }

Write-Host '=== [2/5] 关闭系统代理 ===' -ForegroundColor Cyan
$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty -Path $reg -Name ProxyEnable -Value 0
Remove-ItemProperty -Path $reg -Name ProxyServer -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $reg -Name ProxyOverride -ErrorAction SilentlyContinue

Write-Host '=== [3/5] 删除环境变量 ===' -ForegroundColor Cyan
foreach ($v in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY')) {
    Remove-ItemProperty 'HKCU:\Environment' -Name $v -ErrorAction SilentlyContinue
}

Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOptionW(System.IntPtr hInternet, int dwOption, System.IntPtr lpBuffer, int dwBufferLength);
'@
[Win32.Native]::InternetSetOptionW([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[Win32.Native]::InternetSetOptionW([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null

Write-Host '=== [4/5] 删除脚本与规则文件 ===' -ForegroundColor Cyan
foreach ($f in @('socks-http-bridge.js','update-cn-rules.js','cn-domains.txt','socks-http-bridge.js.bak-20260825')) {
    Remove-Item (Join-Path $codex $f) -ErrorAction SilentlyContinue
}
Write-Host '（日志文件 socks-http-bridge.log / .err.log 保留，可手动删除）'

Write-Host '=== [5/5] 完成 ===' -ForegroundColor Green
Write-Host '系统代理已关闭，环境变量已清除。重启浏览器后完全恢复直连。'
