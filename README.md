# socks-http-bridge

一个轻量的 **HTTP → SOCKS5 代理桥**（纯 Node.js，无第三方依赖），专为
"只有 SOCKS 代理、但软件只认 HTTP 代理" 的场景设计，并内置 **11 万+ 条
国内域名规则的直连分流**，让国内网站不绕道海外隧道。

## 解决什么问题

很多 VPN 客户端（如 AnyCast）只提供 SOCKS5 端口，但：

- Codex 桌面端等软件不认 `socks=` 格式的系统代理
- 部分程序只支持 HTTP 代理
- VPN 客户端自带的"智能分流"在纯 SOCKS 模式下往往不生效，
  国内流量也被塞进海外隧道，导致 B 站、淘宝等明显卡顿

本项目用一个 ~240 行的 Node 脚本解决以上所有问题。

## 工作原理

```
程序发请求
  │
  ▼
① Windows 系统代理：命中绕过名单（ProxyOverride）？
  ├─ 是 → 直连
  └─ 否 → 127.0.0.1:18080（本桥）
           │
           ▼
  ② 桥内匹配国内域名规则（cn-domains.txt，11万+ 条，后缀匹配）
           ├─ 命中国内 → 本地 DNS 解析 + 直连
           └─ 未命中 → 转发至 SOCKS5 127.0.0.1:1080 → VPN 隧道
```

- SOCKS 不可用时自动降级直连，国内上网不受影响
- 规则文件缺失时行为等同最简桥（全部进 SOCKS），不会报错
- 规则文件更新后热加载，无需重启

## 文件结构

| 文件 | 说明 |
|---|---|
| `bridge/socks-http-bridge.js` | 代理桥本体（含国内域名分流） |
| `bridge/update-cn-rules.js` | 规则更新器（下载/解析/去重社区规则源） |
| `install.ps1` | 一键安装（部署脚本 + 系统代理 + 环境变量 + 计划任务） |
| `deploy.ps1` | 更新部署：改完代码后同步到运行目录并重启桥（开发用） |
| `uninstall.ps1` | 一键卸载，恢复直连 |
| `AGENTS.md` | AI 维护者须知（任何 AI 接手维护前必读） |

## 安装

**前提**：
1. 已安装 [Node.js](https://nodejs.org)（LTS 版，18+）
2. VPN 客户端已用 **SOCKS 模式**（默认端口 1080）连接；
   若客户端有「设为系统代理」选项，保持**取消勾选**（本方案接管系统代理）

**步骤**：克隆/下载本仓库后，右键 `install.ps1` → **使用 PowerShell 运行**，
按提示等待 7 步完成。验证：

```powershell
# 国外（应走隧道，返回 200）
curl.exe -x http://127.0.0.1:18080 https://www.google.com
# 国内（应直连，秒回）
curl.exe -x http://127.0.0.1:18080 https://www.baidu.com
```

## 安装脚本做了什么

1. 复制 `bridge/` 下两个脚本到 `%USERPROFILE%\.codex\`
2. 运行规则更新器生成 `cn-domains.txt`
3. 系统代理指向 `127.0.0.1:18080`，写入高频国内域名绕过名单
4. 写入用户环境变量 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`（供 CLI 工具）
5. 注册计划任务：登录时自启桥（失败自动重启 3 次）；每周一 09:00 更新规则

## 规则数据来源（致谢）

`update-cn-rules.js` 运行时从以下社区项目下载并合并去重（不随本仓库分发数据）：

- [Loyalsoldier/clash-rules](https://github.com/Loyalsoldier/clash-rules)（GPL-3.0，每日自动构建）
- [felixonmars/dnsmasq-china-list](https://github.com/felixonmars/dnsmasq-china-list)（维护 10 年+ 的国内域名列表）

另内置 `.cn` 顶级域兜底直连。

## 常见问题

**Q: 某个国内站还是卡？**
查桥日志：`%USERPROFILE%\.codex\socks-http-bridge.log` 搜 `direct by cn rule`。
未命中的域名可加进系统代理的 `ProxyOverride`
（`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`）。

**Q: 国外软件连不上？**
确认 1080 在监听（`netstat -ano | findstr :1080`），不在就是 VPN 没连或不在 SOCKS 模式。

**Q: 打游戏延迟高？**
本方案只代理 HTTP/HTTPS，游戏 UDP 不受影响；请勿切 VPN 客户端的 TUN 模式。

**Q: 日志太多？**
国内命中会记 `direct by cn rule` 行，可定期清空日志文件。

## 卸载

右键 `uninstall.ps1` → 使用 PowerShell 运行。

## License

GPL-3.0。规则数据由上游社区项目维护，运行时按需下载。
