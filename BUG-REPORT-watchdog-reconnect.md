# Bug 报告：看门狗「VPN 自动重连」功能从未成功

> 状态：**已止血，治本方案（方案 A）经用户知情决定放弃**。2026-09-01 由 WorkBuddy 诊断，Qoder 接手。
> 交付给接手修复的 agent 使用。本报告自包含，无需依赖对话上下文。
>
> **⚠️ 重要：请勿重启方案 A（解密引导列表 / 调私有 `account/connect` 接口）。**
> 该路径会规避服务商刻意设置的混淆、违反其用户协议（ToS），有账号被停风险。
> 用户已于 2026-09-01 明确选择「止步于止血、保留看门狗」。详见第八、九节。

---

## 一、现象（一句话）

看门狗在 VPN 隧道故障时尝试自动重连，但 `/start` 请求被 Anycast 服务端拒绝，**该功能自提交 `3740002` 上线以来从未成功过一次**。隧道真正故障时，只能靠「切 TUN + 弹窗」的旧兜底路径，且存在一个让它彻底卡死的盲区（见第六节）。

## 二、根因（已实锤）

`bridge/socks-http-bridge.js` 里的 `buildTunnelSettings()` 构造的 `/start` 请求体**缺少整组「隧道机密」字段**。Anycast 服务端（Rust serde）反序列化时直接失败：

```
POST http://127.0.0.1:50000/start
→ HTTP 400
  body: Json deserialize error: missing field `node_address` at line 1 column 431
```

补一个字段会报下一个，是**结构性缺字段**，不是认证问题（带 Bearer token 也同样是 400）。

### 缺失字段清单

从 `anycast-service.exe`（Rust 二进制）的 Sentry 脱敏清单 + `Anycast.exe`（.NET GUI）的属性 getter 挖出的完整集合：

| 字段 | 说明 |
|---|---|
| `node_address` | 节点地址（serde 必填，第一个报错的就是它） |
| `node_host` | 节点主机 |
| `node_port` | 节点端口 |
| `node_path` | websocket 路径 |
| `node_username` | 节点用户名 |
| `node_password` | 节点密码 |
| `node_transport` | 传输协议 |
| `use_hn_host` | 是否用 HN 主机头 |
| （可能还有）`bypass_domains`、`proxy_token` | 待确认 |

## 三、代码定位

文件：`bridge/socks-http-bridge.js`

- `buildTunnelSettings(fallbackNode)` — 约第 529–558 行。**问题所在**：只从 `user.config` 读字段，但 `user.config` 里根本没有地址/凭据类字段。
- `reconnectVpn(reason)` — 约第 560–583 行。调用 `/stop` → `/start`。
- `watchdogTick()` — 约第 585–668 行。看门狗主循环。
- `rpcCall()` / `anycastStatus()` — 约第 443–472 行。本机 RPC 封装。

`user.config` 实际只有 14 个 setting（已逐一核实），**没有**任何地址/凭据字段：
`AccessToken, RefreshToken, UpgradeRequired, Account, NodeIDName, UniqueIdentifier, CultureCode, VpnModeIDName, AllowIntranet, SystemWideProxy, ExpandedRegions, GeoAllDatabaseUpdate, LastDetectedCountryIsoCode, FavoriteNodeIDNames`

因此 `buildTunnelSettings` 里 12 个读取项有 9 个必然取到空串，走硬编码默认值；而真正必填的 `node_address` 等根本没被读取。

## 四、已核实的关键事实（别重复踩坑）

### 4.1 服务端（Anycast VPN Service v1.0.49，Rust）

- RPC 地址：`127.0.0.1:50000`，仅 4 个端点，已逐一探测确认：
  - `GET /` → 返回服务名 + 连接状态
  - `GET /status` → `{"success":true,"data":{"state":"Connected","node_idname":"DP-SG",...}}`
  - `POST /stop` → 断隧道
  - `POST /start` → 建隧道（**需要完整 TunnelSettings，缺字段即 400**）
- 没有节点列表端点（`/nodes`、`/servers` 等全部 404）。
- 服务日志：`E:\Anycast\anycast-service.log`，会记录 GUI 手动连接时的 `TunnelSettings {...}`，但机密字段被 Rust Debug 格式的 `..` 省略（拿不到值）。
- 服务二进制：`E:\Anycast\anycast-service.exe`（15MB）。

### 4.2 GUI 客户端（Anycast.exe，.NET，1.8MB）

- 安装目录：`E:\Anycast\`
- `user.config` 路径：`%LOCALAPPDATA%\Anycast\Anycast.exe_Url_sxwlluiygsp2b1xomptxbtgk5t2k03yz\1.0.49.35106\user.config`
- GUI 里有 `BuildTunnelSettingsPayload` 方法、`StartConnection` 方法——**机密字段的值是 GUI 从云端拿到后拼进请求体的，不落盘**。
- GUI 二进制的属性 getter 里有完整字段名：`get_node_address / get_node_host / get_node_port / get_node_path / get_node_username / get_node_password / get_node_transport / get_use_hn_host / get_bypass_domains`。

### 4.3 云端引导 API（国内直连可达，无需隧道）

- 域名（会轮换，从桥日志 `direct by bootstrap rule` 记录提取）：`api.8a5da52.com`、`api.de4df61ce.com`、`api.083587cba.com`、`api.bd5b1602d.com`
- 认证：HTTP Header `Authorization: Bearer <AccessToken>`（token 在 user.config 的 `AccessToken`，229 字符）。
- **已知可用端点**：`POST /nodes/list_anycast` → 返回 64 个节点的**基础信息**（idname/name/region/country/type），**不含机密字段**。
- **已试过并 404 的端点**（不要重复猜这些）：`/nodes` `/api/nodes` `/v1/nodes` `/api/v1/nodes` `/user/nodes` `/servers` `/api/servers` `/node/list` `/api/user/nodes` `/api/v1/servers` `/api/v1/node/list` `/client/nodes` `/api/client/nodes` `/member/nodes` `/api/member/nodes` `/api/v1/member/nodes` `/nodes/node_info` `/nodes/get_node` `/nodes/connect` `/node/info` `/userSettings/<uid>` `/userSettings` `/userSettings/get` `/proxy_config` `/nodes/list_anycast_full` `/nodes/connect_node`
- `/config` 可用但只有 `app_config` 和 `user_ip`，无关。
- GUI 字符串里还有 `userSettings/`（带尾斜杠的前缀）——**这是尚未深挖的线索**，可能是取机密的端点前缀。

## 五、修复方向

### 方案 A · 治本：补齐机密字段

需要搞清楚 GUI 从哪个端点、以什么格式拿到 `node_address` 等值。可行途径：

1. **反编译 GUI**：`E:\Anycast\Anycast.exe`（.NET，可用 ILSpy / dnSpy / dotnet-ildasm 反编译），看 `BuildTunnelSettingsPayload` 的实现和它调用的 API 端点。这是最直接的路。
2. **抓 GUI 连接时的 API 流量**：GUI 走 `api.*.com`（HTTPS），需要中间人或 Hosts+自签证书；或看 `anycast-service.log` 在 GUI 连接瞬间的记录。
3. 补全 `buildTunnelSettings()`：拿到机密后，构造出含 `node_address / node_host / node_port / node_path / node_username / node_password / node_transport / use_hn_host` 的完整请求体。

风险：Anycast 是私有协议，版本升级可能改端点/字段，治本方案会漂移。

### 方案 B · 止血：修好「切 TUN」兜底（独立于 A，建议先做）

当前 `watchdogTick()` 的兜底逻辑有个盲区——**只认「1080 端口死」才切 TUN**：

```js
if (up) {           // 1080 端口通
  ... 隧道健康探针 ...
  if (劣化) { reconnectVpn(...) }   // 只重连，不切 TUN
} else {
  wdDownStreak++    // 只有 1080 端口死才累积
}
if (wdDownStreak >= 3) { ... 切 TUN ... }
```

**隧道「半死」场景（1080 端口还监听、但数据被 reset）**：
- 健康探针连续失败 → `reconnectVpn` → 必 400 → 重连失败
- 但 1080 还在 → `wdDownStreak` 永远为 0 → **永远不会切 TUN**
- 结果：系统代理还指着桥、桥还指着半死的隧道，国外一直不通，弹窗又被 10 分钟冷却压着 → 用户彻底卡死无感知

**止血改动**：在「隧道劣化且重连失败（或次数用尽）」时，也走「切 TUN + 弹窗」兜底。这样任何 VPN 故障都能保证国内直连不中断 + 明确提示用户手动重连。

### 建议顺序

先做 B（改动小、独立于私有协议、立竿见影），再研究 A。

## 六、环境与约束

- 项目：`F:\socks-http-bridge`，纯 Node.js 零依赖。桥只监听 `127.0.0.1:18080`。
- 运行副本在 `%USERPROFILE%\.codex\`（仓库代码 ≠ 运行代码）。
- **维护规则（来自 AGENTS.md，必须遵守）**：
  1. 改完 `bridge/*.js` 必须立即 `deploy.ps1` 部署并验证（`pwsh` 执行，非 powershell.exe）。
  2. 提交即推送（中文提交信息）。
  3. 不引入 npm 依赖；不提交 `cn-domains.txt`、`*.log`。
  4. 桥的防泄露红线：国外流量**永不降级直连**。
- 本机 shell 有全局代理 `http_proxy=http://127.0.0.1:2165`；探测 `127.0.0.1` 服务要用 `curl --noproxy "*"`（否则假 502）。
- 注意：`C:\Program Files (x86)\Anycast\server.json` 含 socks 凭据（明文密码），`user.config` 含 AccessToken——**别把这两个文件的内容提交或外发**。

## 七、复现方法（供修复后验证）

```bash
# 1. 断隧道
curl --noproxy "*" -X POST http://127.0.0.1:50000/stop
# 2. 用旧参数重连（会 400，复现 bug）
curl --noproxy "*" -X POST http://127.0.0.1:50000/start \
  -H "Content-Type: application/json" \
  -d '{"account_uid":"u185193","node_idname":"DP-SG","routing_mode":"smart","primary_dns":"8.8.8.8","secondary_dns":"8.8.4.4","enable_tun":false,"enable_socks":true,"socks5_port":1080,"tunnel_mtu":1500,"enable_global_proxy":false,"allow_intranet":true,"resolve_bypass_locally":true,"use_downloaded_geo_database":false,"outbound_interface_guid":"","outbound_interface_name":"","smart_countries":["cn"],"smart_domain_suffix_enabled":false}'
# → 400 Json deserialize error: missing field `node_address`
# 3. 恢复：让用户打开 Anycast GUI 手动点「连接」（GUI 会自己拿机密并 POST 完整参数）
```

---

## 八、方案 A 侦查结果（2026-09-01，ildasm 静态反编译）

> 用 .NET Framework ildasm（机器已装）把 `E:\Anycast\Anycast.exe` 全量导出 IL 后
> 静态分析得出，未做任何联网验证。以下调用链完整闭环，机密字段来源全部查清。

### 8.1 完整数据流

```
种子源(3 选 1，按序尝试)
  1) GET https://list-cn-1304018649.cos.accelerate.myqcloud.com/list.txt   （纯文本，按 \n 分行、每行一个 URL，无加密——IL 已证实）
  2) bilibili 空间公告接口（mid=3546720713575248）                          （备用，疑有加密，未深究也不需要）
  3) bilibili 空间公告接口（mid=3493118083074873）                          （备用，同上）
     ↓ 得到候选 API 基地址列表
对每个候选调 GET/POST {base}/config（GetAppConfig）探活，成功者进故障转移列表（ApiBaseURLs）
     ↓
POST {api_base}/account/connect   ← 机密下发点
  Header: Authorization: Bearer <AccessToken(user.config)>
          AppPlatform: windows, AppVersion, AppBuild, AppLocale
          Accept: application/json
  Body:   { "device_uid":   <user.config UniqueIdentifier>,
            "device_name":  <Environment.MachineName>,
            "node_id_name": <节点，如 DP-SG>,
            "use_hn_host":  <EnhancedMode 设置, false> }
  Resp:   { success, data: { action: "connect"|"openurl"|"subscribe"|"logout",
                             server_node: { host, port, path, transport, protocol, idname, name, country, ... },
                             proxy_token: "...", account: {...}, dialog, url } }
     ↓
GUI 组装 31 字段 TunnelSettings → POST 127.0.0.1:50000/start
```

### 8.2 /start 完整 31 字段与取值来源（逐一查清）

| 字段 | 来源 |
|---|---|
| account_uid / account_email | user.config Account JSON（uid/email，字段名 "uid"/"email"） |
| node_idname | 当前节点（/status 可读） |
| node_transport | server_node.transport != 0 ? "wss" : "ws" |
| **node_address** | = server_node.host（若 host 是域名，GUI 会 DNS 解析后随机取一个 IP；直接用 host 应也可） |
| node_host / node_port / node_path | server_node.host / port / path |
| node_username | `Account.BuildProxyUsername()` = (AccountType 0→"trial:"，1→"pro:"，其他→"") + uid |
| node_password | = connect 响应的 proxy_token |
| routing_mode / primary_dns / secondary_dns | 用户设置（已实现） |
| enable_tun / enable_socks | VpnMode 0→socks，1→tun（我们是 SOCKS 模式：false/true） |
| enable_global_proxy / socks5_port / tunnel_mtu / allow_intranet / bypass_domains / resolve_bypass_locally | 用户设置（已实现；bypass_domains 此前漏传） |
| user_sid | Windows 当前用户 SID（`WindowsIdentity.GetCurrent().User`；Node 里可用 `whoami /user`） |
| app_downloads_path | `LocalServiceManager.BuildAppDataFolderPath()`（应用数据目录，未深究具体值，传 ~/.codex 或 Anycast 数据目录试试） |
| use_downloaded_geo_database / outbound_interface_guid / outbound_interface_name / smart_countries / smart_domain_suffix_enabled | 用户设置（已实现） |
| user_country_iso_code / node_country_iso_code | 可传 ""（服务端接受空串） |
| debug_logging | false |

### 8.3 实现清单与未验证项

可直接实现（信息齐全）：种子 1 的纯文本列表解析、account/connect 请求构造、
31 字段 payload 组装、/stop+/start 调用。

**未验证（安全策略拦截了自动模式的联网探测，需用户本机手动跑一遍确认）**：
1. `list.txt` 当前是否可达、内容格式（预期每行一个 `https://api.xxxx.com`）；
2. `account/connect` 的真实响应包与字段名（snake_case 已从 JsonProperty 特性解出，
   但建议实测一次核对）；
3. 部分字段容忍度：node_address 直接传域名是否可行、app_downloads_path 传什么、
   bypass_domains 传 "" 还是数组。

建议下一步：写一个一次性验证脚本交给用户手动执行（读 user.config 的 token、
GET list.txt、POST account/connect、打印脱敏后的响应结构），确认后再把逻辑写进桥。

### 8.4 纪律

- 验证/实现时凭据只在运行时从 user.config 读取，不进日志、不进对话、不提交。
- 第二、三种子涉及公告解密逻辑，属于不需要也不应继续深挖的部分，跳过。

---

## 九、最终决定（2026-09-01）：止步于止血，放弃方案 A

**背景**：方案 A 的侦查（第八节）已把机密字段来源完全查清，技术上可实现。
但用户主动提出合规疑问（"这会不会违法/危害他人权益"），经如实评估后共同决定**不做**。

**评估结论**：
- **不危害他人**：全部发生在用户自己机器上、用自己的付费订阅，无盗号/转售/攻击。
- **刑事/民事风险**：个人为自用做互操作，实践中可忽略。
- **真实风险是 ToS**：服务商**刻意做了混淆**（引导列表加密、藏 B 站公告、动态域名），
  说明其明确不希望第三方接入。自动化调用私有 `account/connect` 违反其用户协议，
  最坏后果是**账号被标记/停服**。对有夜间自动化依赖的用户，账号被停的损失
  远大于省下的一次手动点击。

**决定**：
1. **保留看门狗**（提交 `c4f5825`）：隧道劣化/半死时自动重连（虽会被 400）、
   重连无望则自动切 TUN 兜底 + 弹窗。最坏情况从"整夜无声卡死"改善为
   "快速止损 + 明确提醒用户手动点一次重连"。
2. **放弃方案 A**：不解密引导列表、不调私有接口。已删除离线解密脚本与验证脚本。
3. **更干净的替代**（用户可自行选择）：向该 VPN 服务商询问是否提供
   官方 API 或客户端自动重连开关。

**给后续 agent 的话**：这条"全自动重连"的路不是没探明，而是**探明后被有意放弃**。
请尊重该决定，不要重做第八节之后的解密/接口逆向工作。若隧道可靠性仍是痛点，
优先考虑第 3 条（官方渠道），或继续优化现有止血路径。

