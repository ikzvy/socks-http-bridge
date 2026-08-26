# AGENTS.md — AI 维护者须知

> 任何 AI 编程助手在修改本项目前必须先读完本文件，并严格遵守「维护规则」。

## 项目是什么

`socks-http-bridge` 是一个常驻运行的 **HTTP → SOCKS5 代理桥**（纯 Node.js、零依赖），
解决"VPN 客户端只提供 SOCKS 端口、但软件只认 HTTP 代理"的问题，并内置
**11 万+ 条国内域名规则的直连分流**（命中国内域名直接本地连接，不进海外隧道）。

## 架构速览

```
程序请求 → Windows 系统代理(127.0.0.1:18080)
              ├─ ProxyOverride 命中 → 直连
              └─ 未命中 → 本桥
                   ├─ cn-domains.txt 命中国内域名 → 本地 DNS 直连
                   └─ 其余 → SOCKS5 127.0.0.1:1080 → VPN 隧道
```

关键事实：
- **仓库里的代码不是正在运行的代码**。运行副本在 `%USERPROFILE%\.codex\`：
  `socks-http-bridge.js`、`update-cn-rules.js`、`cn-domains.txt`（运行时生成，不入库）。
- 桥由 Windows 计划任务在用户登录时拉起，任务名可能是
  `Codex Anycast HTTP Bridge`（早期手工部署）或 `Socks HTTP Bridge`（install.ps1 部署）。
- 桥只处理 TCP/HTTP(S)；游戏等 UDP 流量不经过它。
- `cn-domains.txt` 由 `bridge/update-cn-rules.js` 从社区规则源（Loyalsoldier/clash-rules、
  felixonmars/dnsmasq-china-list）下载生成，**禁止手改该文件**，也禁止把它提交进仓库。

## 维护规则（必须遵守）

1. **改完必部署**：凡修改了 `bridge/*.js`，必须立即执行 `deploy.ps1` 让改动在本机生效，
   不得要求用户手动运行：
   ```powershell
   pwsh -NoProfile -ExecutionPolicy Bypass -File "<仓库路径>\deploy.ps1"
   ```
   并检查输出：`18080 监听正常`、国内抽查秒回、国外抽查可达。任何一步失败必须排查，
   错误日志在 `%USERPROFILE%\.codex\socks-http-bridge.err.log`。
2. **改了规则解析逻辑时**：部署后还需重新生成规则文件验证解析正常：
   ```powershell
   node "$env:USERPROFILE\.codex\update-cn-rules.js"
   ```
   预期输出约 11 万条（若骤降说明解析正则写坏了）。
3. **提交即推送**：部署验证通过后，`git add -A` → `git commit`（中文提交信息，说明改了什么）
   → `git push`。不要只提交不推送。
4. **不要做的事**：
   - 不要引入 npm 依赖（本项目刻意零依赖）
   - 不要修改用户机器上 `%USERPROFILE%\.codex\` 以外的系统配置（注册表/环境变量只能
     通过 install.ps1 / uninstall.ps1 走）
   - 不要提交生成物：`cn-domains.txt`、`*.log`
   - 不要在桥里加鉴权/加密以外的网络监听端口；桥必须只监听 127.0.0.1
5. **改桥脚本的自检项**：修改后需确认三条路径都通——
   ① 国内域名直连（日志出现 `direct by cn rule`）；
   ② 国外域名进 SOCKS；
   ③ SOCKS 不可用时自动降级直连（可临时断开 VPN 验证，验完提醒用户重连）。

## 文件地图

| 路径 | 说明 | 可改 |
|---|---|---|
| `bridge/socks-http-bridge.js` | 桥本体：HTTP 代理解析、规则匹配、SOCKS 转发、降级直连 | ✅ |
| `bridge/update-cn-rules.js` | 规则更新器：下载/解析/去重/写出 cn-domains.txt | ✅ |
| `install.ps1` | 新机器一键安装 | ✅ |
| `deploy.ps1` | 更新部署（同步运行目录+重启桥+验证） | ✅ |
| `uninstall.ps1` | 卸载 | ✅ |
| `README.md` / `LICENSE` / `AGENTS.md` | 文档 | ✅ |

## 常见维护场景

- **某个国内站仍走隧道**：优先把域名加进用户的系统代理 `ProxyOverride`
  （注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`），
  而不是改代码；同时在提交信息中记录。
- **国外软件连不上**：先确认 `netstat -ano | findstr :1080` 有监听，
  无监听 = VPN 客户端未连接或不在 SOCKS 模式，与本项目代码无关。
- **桥进程不在**：`Start-ScheduledTask '<计划任务名>'`；仍失败看 `.err.log`。
- **日志过大**：可直接清空 `%USERPROFILE%\.codex\socks-http-bridge.log`。

## 环境假设

- Windows 10/11，PowerShell 7（`pwsh`）可用，Node.js 18+
- VPN 客户端提供 SOCKS5 127.0.0.1:1080（端口不同则同步修改桥脚本常量与 install.ps1）
