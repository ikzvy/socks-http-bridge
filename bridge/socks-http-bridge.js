'use strict';
// HTTP -> SOCKS5 bridge for Codex Desktop + Anycast (resident mode)
// Listens as an HTTP proxy and forwards through the local SOCKS5 port.
// Foreign traffic NEVER falls back to direct (IP-leak protection):
// if the SOCKS upstream is down, requests fail with 502 instead of
// leaking the real (CN) IP to Google/OpenAI etc.
//
// 2026-08-25 升级：接入国内域名规则文件 ~/.codex/cn-domains.txt
// （由 update-cn-rules.js 从 Loyalsoldier/clash-rules + dnsmasq-china-list 生成）。
// 命中国内域名的请求直接本地连接（本地 DNS、最快速路径），不进 SOCKS 隧道。
// 规则文件缺失或加载失败时行为与旧版完全一致（全部尝试 SOCKS）。
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tls = require('tls');
const http = require('http');
const { execFile } = require('child_process');

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = 18080;
const SOCKS_HOST = '127.0.0.1';
const SOCKS_PORT = 1080;
const SOCKS_CONNECT_TIMEOUT_MS = 5000;
const RULES_FILE = path.join(os.homedir(), '.codex', 'cn-domains.txt');
const LOG_FILE = path.join(os.homedir(), '.codex', 'socks-http-bridge.log');

// 强制走 SOCKS 隧道的国外域名后缀（优先级高于 cn-domains.txt）。
// 背景：dnsmasq-china-list 收录了大量历史原因保留的 Google 域名
// （www.gstatic.com、fonts.googleapis.com 等），这些域名在大陆直连是
// 被墙的，直连既会卡死网页资源，也会向 Google 暴露国内真实 IP。
const FOREIGN_SUFFIXES = new Set([
  // Google / Gemini / YouTube
  'google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com',
  'ggpht.com', 'gvt1.com', 'gvt2.com', 'youtube.com', 'ytimg.com',
  'googlevideo.com', 'googlesource.com', 'googleadservices.com',
  'doubleclick.net', 'withgoogle.com',
  'google-analytics.com', 'googletagmanager.com',
  // OpenAI / ChatGPT
  'openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com',
  // Anthropic / xAI
  'anthropic.com', 'claude.ai', 'x.ai',
]);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  // 计划任务以裸 `node xxx.js` 启动，stdout 无人接管；日志必须由桥自己落盘，
  // 否则 README/AGENTS.md 指的 socks-http-bridge.log 永远不会生成。
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { /* 日志写不进去不能影响代理 */ }
}

// ---- 国内域名规则 ----
let cnSet = null;      // Set<域名后缀>
let cnMtime = 0;       // 已加载文件的修改时间

function loadRules() {
  try {
    const text = fs.readFileSync(RULES_FILE, 'utf8');
    const set = new Set();
    for (const raw of text.split('\n')) {
      const d = raw.trim().toLowerCase();
      if (!d || d.startsWith('#')) continue;
      set.add(d);
    }
    if (set.size === 0) { cnSet = null; return; }
    cnSet = set;
    cnMtime = fs.statSync(RULES_FILE).mtimeMs;
    log(`cn rules loaded: ${set.size} domains from ${RULES_FILE}`);
  } catch (e) {
    cnSet = null; // 文件不存在/损坏 -> 保持旧行为
  }
}

// 热重载：文件被更新后下一次连接自动生效
function ensureRules() {
  try {
    const m = fs.statSync(RULES_FILE).mtimeMs;
    if (m > cnMtime) loadRules();
  } catch (e) { /* 文件不在就保持现状 */ }
}

// 强制走隧道的国外域名：host 自身或任一父域命中名单即判定国外
function isForeign(host) {
  const h = (host || '').toLowerCase().replace(/\.$/, '');
  if (!h || /^[0-9a-f:.]+$/.test(h)) return false; // IP 字面量不判断
  const labels = h.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (FOREIGN_SUFFIXES.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

// 域名后缀匹配：host 自身或任一父域命中规则集即判定国内
function isDomestic(host) {
  if (!cnSet) return false;
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || /^[0-9a-f:.]+$/.test(h)) return false; // IP 字面量不判断
  const labels = h.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (cnSet.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

loadRules();

// Dial through SOCKS5 (no auth), resolve domain remotely (like socks5h).
function socksDial(destHost, destPort) {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCKS_PORT, SOCKS_HOST);
    s.setTimeout(SOCKS_CONNECT_TIMEOUT_MS, () => fail(new Error('socks dial timeout')));
    let stage = 0;
    let buf = Buffer.alloc(0);
    let done = false;
    const fail = (e) => {
      if (done) return;
      done = true;
      s.destroy();
      reject(e);
    };
    const onConnect = () => s.write(Buffer.from([5, 1, 0]));
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('socks auth method rejected'));
        stage = 1;
        buf = buf.slice(2);
        const hostBuf = Buffer.from(destHost, 'utf8');
        const req = Buffer.alloc(5 + hostBuf.length + 2);
        req[0] = 5; req[1] = 1; req[2] = 0; req[3] = 3; req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(destPort, 5 + hostBuf.length);
        s.write(req);
        return;
      }
      if (stage === 1) {
        if (buf.length < 4) return;
        if (buf[0] !== 5) return fail(new Error('bad socks version in reply'));
        if (buf[1] !== 0) return fail(new Error('socks connect failed, rep=' + buf[1]));
        const atyp = buf[3];
        let need;
        if (atyp === 1) need = 10;
        else if (atyp === 4) need = 22;
        else if (atyp === 3) {
          if (buf.length < 5) return;
          need = 5 + buf[4] + 2;
        } else return fail(new Error('bad socks atyp=' + atyp));
        if (buf.length < need) return;
        const leftover = buf.slice(need);
        done = true;
        s.setTimeout(0);
        s.removeListener('data', onData);
        s.removeListener('connect', onConnect);
        s.removeListener('error', fail);
        resolve({ socket: s, leftover });
      }
    };
    s.on('connect', onConnect);
    s.on('data', onData);
    s.on('error', fail);
  });
}

// Direct connection fallback (local DNS resolution).
function directDial(destHost, destPort) {
  return new Promise((resolve, reject) => {
    const s = net.connect(destPort, destHost);
    const fail = (e) => { s.destroy(); reject(e); };
    s.on('connect', () => {
      s.removeListener('error', fail);
      resolve({ socket: s, leftover: Buffer.alloc(0) });
    });
    s.on('error', fail);
  });
}

// VPN 客户端（Anycast）自身引导 API：隧道未建立时必须直连可达，
// 否则形成"连 VPN 需要走 VPN"的死锁。这些域名国内可直连，无泄露风险。
const DIRECT_SUFFIXES = new Set([
  'wr001.net', 'wmppt.com', 'yidianyq.com',
]);

// Anycast 已改用随机子域做引导 API，实测子域的 hex 长度会轮换（同时见到
// 7 位 api.8a5da52.com 与 9 位 api.083587cba.com）。把长度锁死在 9 会漏掉
// 短的子域、重新制造掉线后连不回来的死锁；放宽到 5~12 位，这个形状仍足够
// 具体，正常国外服务基本不可能撞上。
const BOOTSTRAP_API_RE = /^api\.[0-9a-f]{5,12}\.com$/;

function isDirect(host) {
  const h = (host || '').toLowerCase().replace(/\.$/, '');
  if (!h || /^[0-9a-f:.]+$/.test(h)) return false;
  if (BOOTSTRAP_API_RE.test(h)) return true;
  const labels = h.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (DIRECT_SUFFIXES.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

// 路由决策：引导白名单直连 > 国外强制名单（只进隧道，永不直连）>
// 国内规则直连 > 其余只进 SOCKS（失败即 502，绝不降级直连）。
// 全桥不存在任何"以国内真实 IP 访问国外服务"的路径。
function chooseAndDial(destHost, destPort) {
  ensureRules();
  if (isDirect(destHost)) {
    log(`direct by bootstrap rule: ${destHost}:${destPort}`);
    return directDial(destHost, destPort);
  }
  if (isForeign(destHost)) {
    return socksDial(destHost, destPort);
  }
  if (isDomestic(destHost)) {
    log(`direct by cn rule: ${destHost}:${destPort}`);
    return directDial(destHost, destPort);
  }
  return socksDial(destHost, destPort);
}

function pipePair(a, b) {
  a.pipe(b);
  b.pipe(a);
  a.on('error', () => b.destroy());
  b.on('error', () => a.destroy());
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
}

const server = net.createServer((client) => {
  client.on('error', () => {});
  let buf = Buffer.alloc(0);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) {
      if (buf.length > 65536) client.destroy();
      return;
    }
    client.removeListener('data', onData);
    client.pause();
    const head = buf.slice(0, idx).toString('latin1');
    const rest = buf.slice(idx + 4);
    const lines = head.split('\r\n');
    const parts = lines[0].split(' ');

    if (parts[0] === 'CONNECT') {
      const hp = (parts[1] || '').split(':');
      const host = hp[0];
      const port = parseInt(hp[1] || '443', 10);
      chooseAndDial(host, port)
        .then(({ socket, leftover }) => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (leftover.length) socket.write(leftover);
          if (rest.length) socket.write(rest);
          pipePair(client, socket);
        })
        .catch((e) => {
          log(`CONNECT ${parts[1]} failed: ${e.message}`);
          client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          client.destroy();
        });
    } else {
      // Plain HTTP request with absolute-form URI
      let u;
      try {
        u = new URL(parts[1]);
      } catch (e) {
        client.destroy();
        return;
      }
      const port = u.port ? parseInt(u.port, 10) : 80;
      chooseAndDial(u.hostname, port)
        .then(({ socket }) => {
          const newLines = [`${parts[0]} ${u.pathname + (u.search || '')} ${parts[2] || 'HTTP/1.1'}`];
          for (const l of lines.slice(1)) {
            if (/^(proxy-connection|proxy-authorization)\s*:/i.test(l)) continue;
            newLines.push(l);
          }
          socket.write(newLines.join('\r\n') + '\r\n\r\n');
          if (rest.length) socket.write(rest);
          pipePair(client, socket);
        })
        .catch((e) => {
          log(`GET ${u.hostname} failed: ${e.message}`);
          client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          client.destroy();
        });
    }
  };
  client.on('data', onData);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`bridge listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> socks5://${SOCKS_HOST}:${SOCKS_PORT}`);
});
server.on('error', (e) => {
  log('listen error: ' + e.message);
  process.exit(1);
});

// ---- 看门狗：系统代理跟着 VPN 隧道自动联动 ----
// 背景：用户关掉 VPN 后隧道(1080)消失，但系统代理仍指着 127.0.0.1:18080，
// 于是"没进国内规则、也不是国外强制名单"的流量（纯 IP 连接、未收录域名等）
// 全部被塞进已死的隧道 -> 国内国外一起挂。正确姿势是"关 VPN 就关代理"，
// 之前只能手动切，这里让桥自动做：
//   1080 持续不通 且 代理开着   -> 切 TUN（关代理），恢复直连
//   1080 恢复     且 代理关着   -> 切 Bridge（开代理）
// 注意：切到 TUN 期间，国外流量是国内真实 IP 直连——这正是用户关 VPN 想要的
// "正常上网"，不属于桥的防泄露降级（桥进程还在，只是系统代理不再指向它）。
// 只在探测阈值满足且当前状态不符时才动作，避免瞬断抖动来回切。
// 放一个空文件 ~/.codex/watchdog-disabled 即可完全停用看门狗。
const WATCHDOG_INTERVAL_MS = 5000;
const WATCHDOG_DOWN_THRESHOLD = 3; // 连续约 15s 不通才切走
const WATCHDOG_UP_THRESHOLD = 2;   // 连续约 10s 恢复才切回
const SWITCH_MODE_SCRIPT = path.join(os.homedir(), '.codex', 'switch-mode.ps1');
const WATCHDOG_DISABLED_FLAG = path.join(os.homedir(), '.codex', 'watchdog-disabled');
const PROXY_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

let wdDownStreak = 0;
let wdUpStreak = 0;
let wdBusy = false; // 一次只跑一个切换，避免重叠

function probeSocks() {
  return new Promise((resolve) => {
    const s = net.connect(SOCKS_PORT, SOCKS_HOST);
    const timer = setTimeout(() => { s.destroy(); resolve(false); }, 3000);
    s.on('connect', () => { clearTimeout(timer); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(timer); s.destroy(); resolve(false); });
  });
}

function readProxyEnable() {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', PROXY_REG, '/v', 'ProxyEnable'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i.exec(stdout || '');
      resolve(m ? parseInt(m[1], 16) === 1 : null);
    });
  });
}

function runSwitchMode(mode) {
  // 2026-08-31 事故：切换脚本曾卡满 30s 被超时杀掉，err.message 只有命令行、
  // 没有任何原因，failover 静默失败。现在记录 killed/退出码/stderr 并自动重试一次。
  const attempt = (n) => {
    // 全局维护约定：PowerShell 一律走 pwsh（7+），禁止 Windows PowerShell 5.1
    execFile('pwsh',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SWITCH_MODE_SCRIPT, '-Mode', mode],
      { timeout: 30000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = `killed=${err.killed ? '超时' : '否'} code=${err.code} stderr=${String(stderr || '').trim().slice(0, 200)}`;
          if (n === 1) {
            log(`watchdog: switch-mode ${mode} 失败(${detail})，2s 后重试`);
            setTimeout(() => attempt(2), 2000);
            return;
          }
          log(`watchdog: switch-mode ${mode} 失败(${detail})`);
        } else {
          log(`watchdog: 系统代理已切换到 ${mode}`);
        }
        wdBusy = false;
      });
  };
  attempt(1);
}

// ---- 隧道健康探针：发现"1080 活着但隧道废了"的半死状态 ----
// 只看 1080 在不在是不够的：Anycast 隧道会劣化成"能 SOCKS 握手、但真实数据
// 被 reset"。探针每 TUNNEL_PROBE_EVERY 个 tick 经隧道完整请求一次国外探测页
// （gstatic 的 generate_204，专为连通性检测设计、无账号、返回 204，正常浏览器
// 也在后台频繁访问它，无风控/封号风险）。连续失败达到阈值就判定隧道劣化并弹窗。
// 探针只走隧道（用 VPN 出口 IP），不影响任何真实请求的路由。
const TUNNEL_PROBE_HOST = 'connectivitycheck.gstatic.com';
const TUNNEL_PROBE_EVERY = 6;      // 每 6 个 tick(约30s) 探一次
const TUNNEL_FAIL_THRESHOLD = 3;   // 连续 3 次失败(约90s) 判定劣化
const NOTIFY_DEBOUNCE_MS = 10 * 60 * 1000; // 弹窗至少间隔 10 分钟，防刷屏

let tunnelProbeCounter = 0;
let tunnelFailStreak = 0;
let tunnelDegraded = false;
let lastNotifyMs = 0;

function probeTunnelHealth() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    const timer = setTimeout(() => finish(false), 8000);
    socksDial(TUNNEL_PROBE_HOST, 443)
      .then(({ socket }) => {
        const tlsSock = tls.connect({ socket, servername: TUNNEL_PROBE_HOST }, () => {
          tlsSock.write(`GET /generate_204 HTTP/1.1\r\nHost: ${TUNNEL_PROBE_HOST}\r\nConnection: close\r\n\r\n`);
        });
        let head = '';
        tlsSock.on('data', (d) => {
          head += d.toString('latin1');
          if (/^HTTP\/1\.[01] \d{3}/.test(head)) { clearTimeout(timer); tlsSock.destroy(); finish(true); }
        });
        tlsSock.on('error', () => { clearTimeout(timer); finish(false); });
        tlsSock.on('close', () => clearTimeout(timer));
      })
      .catch(() => { clearTimeout(timer); finish(false); });
  });
}

function notifyUser(title, text, force = false) {
  const now = Date.now();
  if (!force && now - lastNotifyMs < NOTIFY_DEBOUNCE_MS) return;
  lastNotifyMs = now;
  // NotifyIcon 气泡，用内置 .NET，不装任何模块；日志里始终留有记录兜底。
  const ps = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
    '$n = New-Object System.Windows.Forms.NotifyIcon; ' +
    '$n.Icon = [System.Drawing.SystemIcons]::Warning; ' +
    `$n.BalloonTipTitle = ${JSON.stringify(title)}; ` +
    `$n.BalloonTipText = ${JSON.stringify(text)}; ` +
    '$n.Visible = $true; $n.ShowBalloonTip(10000); ' +
    'Start-Sleep -Seconds 12; $n.Dispose()';
  execFile('pwsh', ['-NoProfile', '-Command', ps], { timeout: 20000, windowsHide: true }, () => {});
}

// ---- VPN 自动重连：隧道坏了先救活隧道，而不是只通知人 ----
// 背景（2026-08-31 凌晨事故）：Anycast 隧道劣化/服务自发重启后不会自动重连，
// 客户端 GUI 也不管，国外流量整夜不通，夜跑的自动化任务全部陪葬。
// Anycast 服务本机 RPC 在 127.0.0.1:50000（/status /stop /start），
// 用户手动点"连接"本质就是 POST /start 带一份 TunnelSettings。
// 看门狗判定隧道劣化/半死时照做一遍尝试自愈。注意：/start 需要完整
// TunnelSettings，其中 node_address 等一组"隧道机密"字段由云端下发给
// GUI、不落盘，本机配置拼不出来——所以重连可能被服务端 400 拒绝。
// 重连失败不僵死：次数用尽后由「劣化切 TUN」兜底（见 watchdogTick），
// 未来机密字段补齐后此路径自然恢复真正的自愈。
//   - 参数实时取自客户端 user.config（账号/节点/DNS 偏好）+ /status（当前节点），
//     用户换节点后重连依然跟着走；
//   - 冷却 + 次数上限防抖，避免反复重连风暴；
//   - 状态为 Disconnected 视为用户主动断开，绝不自动重连（尊重用户意图）。
const ANYCAST_RPC_PORT = 50000;
const RECONNECT_COOLDOWN_MS = 2 * 60 * 1000; // 两次重连尝试至少间隔 2 分钟
const RECONNECT_MAX_ATTEMPTS = 3;            // 单次故障期内最多重连 3 次
const RPC_DEAD_TUN_THRESHOLD = 8;            // 1080 死且服务 RPC 持续不可达约 2 分钟后才 TUN 兜底

// ---- 自发掉线判别 ----
// 2026-09 实测：一个月内 61 次 RPC 报 Disconnected 的掉线全部伴随 Anycast GUI
// 进程退出/重启（anycast-gui.log 每次隧道恢复前都有 "session start"），而手动
// 点"断开"不会重启进程。因此用两条证据区分"用户手动断开"和"客户端自发掉线"：
// GUI 进程不在运行，或 GUI 在这个窗口内刚(重)启动过。
const ANYCAST_GUI_EXE = 'Anycast.exe';
const ANYCAST_GUI_LOG = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Anycast', 'anycast-gui.log'
);
const GUI_RESTART_WINDOW_MS = 4 * 60 * 1000;

let reconnectAttempts = 0;
let lastReconnectMs = 0;
let reconnectBusy = false;
let rpcDeadStreak = 0;
let lastDropNotice = null; // 最近一次掉线提醒 {kind, at}，隧道恢复时用于闭环气泡

function rpcCall(pathname, { method = 'GET', body = null, timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: ANYCAST_RPC_PORT,
      path: pathname,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

async function anycastStatus() {
  const r = await rpcCall('/status');
  return (r && r.json && r.json.success && r.json.data) ? r.json.data : null;
}

function findAnycastUserConfig() {
  try {
    const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Anycast');
    let best = null;
    let bestMtime = 0;
    for (const urlDir of fs.readdirSync(root)) {
      const dir = path.join(root, urlDir);
      let st;
      try { st = fs.statSync(dir); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      for (const ver of fs.readdirSync(dir)) {
        const cfg = path.join(dir, ver, 'user.config');
        try {
          const cs = fs.statSync(cfg);
          if (cs.mtimeMs > bestMtime) { bestMtime = cs.mtimeMs; best = cfg; }
        } catch (e) { /* 该版本目录没有 user.config */ }
      }
    }
    return best;
  } catch (e) { return null; }
}

function cfgValue(xml, name) {
  const m = new RegExp('<setting name="' + name + '"[^>]*>\\s*<value>([\\s\\S]*?)</value>').exec(xml);
  return m ? m[1].trim() : '';
}

const DNS_PRESETS = {
  google: ['8.8.8.8', '8.8.4.4'],
  cloudflare: ['1.1.1.1', '1.0.0.1'],
};

// user.config 里 Account 是一整个序列化 JSON（含令牌等），不能整块往外发。
// 只从中提取账号 uid（服务端要的是形如 u185193 的 account_uid）。
function extractAccountUid(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (!s.startsWith('{')) return s; // 老版本可能直接存 uid 字符串
  try {
    const flat = [];
    const walk = (o) => {
      for (const [k, v] of Object.entries(o || {})) {
        if (v && typeof v === 'object') walk(v);
        else if (typeof v === 'string') flat.push([k.toLowerCase(), v]);
      }
    };
    walk(JSON.parse(s));
    // 优先级：键名含 uid 且值符合服务端格式 > 值符合格式 > 键名含 uid/id
    for (const [k, v] of flat) if (k.includes('uid') && /^u\d+$/.test(v)) return v;
    for (const [k, v] of flat) if (/^u\d{3,}$/.test(v)) return v;
    for (const [k, v] of flat) if (k.includes('uid') || k === 'id') return v;
    return null;
  } catch (e) { return null; }
}

function buildTunnelSettings(fallbackNode) {
  const cfgPath = findAnycastUserConfig();
  if (!cfgPath) return null;
  let xml;
  try { xml = fs.readFileSync(cfgPath, 'utf8'); } catch (e) { return null; }
  const accountUid = extractAccountUid(cfgValue(xml, 'Account'));
  if (!accountUid) return null;
  const dns = DNS_PRESETS[(cfgValue(xml, 'DnsServerIDName') || 'google').toLowerCase()] || DNS_PRESETS.google;
  const smartCountries = cfgValue(xml, 'SmartRoutingCountries')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    account_uid: accountUid,
    node_idname: fallbackNode || cfgValue(xml, 'NodeIDName'),
    routing_mode: (cfgValue(xml, 'RoutingModeIDName') || 'Smart').toLowerCase(),
    primary_dns: dns[0],
    secondary_dns: dns[1],
    enable_tun: false,
    enable_socks: true,
    socks5_port: parseInt(cfgValue(xml, 'LocalSOCKS5Port'), 10) || SOCKS_PORT,
    tunnel_mtu: parseInt(cfgValue(xml, 'TunnelMtu'), 10) || 1500,
    enable_global_proxy: false,
    allow_intranet: cfgValue(xml, 'AllowIntranet') === 'True',
    resolve_bypass_locally: cfgValue(xml, 'ResolveBypassLocally') !== 'False',
    use_downloaded_geo_database: false,
    outbound_interface_guid: cfgValue(xml, 'OutboundInterfaceGuid'),
    outbound_interface_name: cfgValue(xml, 'OutboundInterfaceName'),
    smart_countries: smartCountries.length ? smartCountries : ['cn'],
    smart_domain_suffix_enabled: cfgValue(xml, 'SmartRoutingUseDomainSuffixRules') === 'True',
  };
}

function anycastGuiRecentlyStarted() {
  try {
    const text = fs.readFileSync(ANYCAST_GUI_LOG, 'utf8');
    const re = /session start\s+(\S+)/g;
    let m, last = null;
    while ((m = re.exec(text)) !== null) last = m[1];
    if (!last) return false;
    const t = Date.parse(last);
    return !Number.isNaN(t) && Date.now() - t < GUI_RESTART_WINDOW_MS;
  } catch (e) { return false; }
}

function anycastGuiRunning() {
  return new Promise((resolve) => {
    // 直接全量列出再匹配：最简单也最稳，不依赖 /FI 的参数切分
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(true); // 查询失败按"在运行"处理，退回旧行为
      resolve(String(stdout || '').toLowerCase().includes('"' + ANYCAST_GUI_EXE.toLowerCase() + '"'));
    });
  });
}

// Disconnected 状态的定性：GUI 不在运行或刚重启过 = 自发掉线；否则按用户手动断开
async function isSpontaneousDrop() {
  return !(await anycastGuiRunning()) || anycastGuiRecentlyStarted();
}

async function reconnectVpn(reason, allowDisconnected = false) {
  if (reconnectBusy) return;
  const now = Date.now();
  if (now - lastReconnectMs < RECONNECT_COOLDOWN_MS) return;
  if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) return;
  const st = await anycastStatus();
  if (!st) { log('watchdog: 重连跳过——Anycast 服务 RPC 不可达'); return; }
  if (st.state === 'Disconnected' && !allowDisconnected) return; // 用户主动断开的，不自动重连
  reconnectBusy = true;
  lastReconnectMs = now;
  reconnectAttempts++;
  try {
    log(`watchdog: 尝试自动重连 VPN（${reason}，第 ${reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS} 次）`);
    const settings = buildTunnelSettings(st.node_idname);
    if (!settings) { log('watchdog: 读不到 Anycast 客户端配置，放弃本次重连'); return; }
    await rpcCall('/stop', { method: 'POST', timeout: 5000 });
    await new Promise((r) => setTimeout(r, 2000));
    const r = await rpcCall('/start', { method: 'POST', body: settings, timeout: 15000 });
    if (r && r.json && r.json.success) {
      log('watchdog: 重连请求已受理(/start)，等待隧道建立');
    } else if (r && r.status === 400) {
      // 400 = 服务端直接拒绝请求体（实测缺 node_address 等一组隧道机密字段，
      // 这些值由云端下发给 GUI、不落盘，本地配置读不到）。重试不改变结果，
      // 直接判用尽，让调用方尽快走 TUN 兜底；将来参数补齐后自然恢复。
      reconnectAttempts = RECONNECT_MAX_ATTEMPTS;
      log('watchdog: /start 被拒(400)，重连参数不完整，放弃重连: ' + JSON.stringify(r.json || '').slice(0, 200));
    } else {
      log('watchdog: 重连 /start 返回异常: ' + (r ? JSON.stringify(r.json || r.status) : 'RPC 不可达'));
    }
  } finally {
    reconnectBusy = false;
  }
}

async function watchdogTick() {
  try {
    if (fs.existsSync(WATCHDOG_DISABLED_FLAG)) return;
    const up = await probeSocks();
    if (up) { wdUpStreak++; wdDownStreak = 0; } else { wdDownStreak++; wdUpStreak = 0; }

    // 隧道健康探针：1080 在，但还要定期验证隧道真能传数据（防"半死隧道"）
    if (up) {
      tunnelProbeCounter++;
      if (tunnelProbeCounter >= TUNNEL_PROBE_EVERY) {
        tunnelProbeCounter = 0;
        const healthy = await probeTunnelHealth();
        if (healthy) {
          if (tunnelDegraded) { log('watchdog: 隧道恢复健康'); tunnelDegraded = false; }
          tunnelFailStreak = 0;
          reconnectAttempts = 0;
          rpcDeadStreak = 0;
        } else {
          tunnelFailStreak++;
          if (tunnelFailStreak >= TUNNEL_FAIL_THRESHOLD && !tunnelDegraded) {
            tunnelDegraded = true;
            log('watchdog: 隧道劣化（1080 在但国外连不通），尝试自动重连 VPN');
            notifyUser('代理桥：隧道劣化', 'VPN 显示已连接但国外连不通，正在自动重连…');
            await reconnectVpn('隧道劣化');
          } else if (tunnelDegraded) {
            await reconnectVpn('隧道仍劣化');
          }
          // 劣化 + 重连无望（次数用尽，含被 /start 400 快速判死）→ 切 TUN 兜底：
          // 国内直连继续可用、国外快速失败、弹窗明确提示。不切的话就是
          // "代理指着桥、桥指着半死隧道"的卡死盲区（2026-08-31 凌晨事故路径）。
          if (tunnelDegraded && reconnectAttempts >= RECONNECT_MAX_ATTEMPTS && !wdBusy) {
            if ((await readProxyEnable()) === true) {
              wdBusy = true;
              log('watchdog: 隧道劣化且自动重连无望，把系统代理切到 TUN 兜底');
              runSwitchMode('TUN');
            }
            notifyUser('代理桥：隧道劣化', '自动重连失败，已切到直连兜底。请手动重连 VPN 或切换节点。');
            lastDropNotice = { kind: 'spontaneous', at: Date.now() };
          }
        }
      }
    } else {
      tunnelFailStreak = 0; // 1080 都没了，谈不上隧道健康，重置计数
    }

    if (wdBusy) return;
    if (wdDownStreak >= WATCHDOG_DOWN_THRESHOLD) {
      wdDownStreak = 0;
      // 1080 全死。先问 Anycast 服务 RPC 区分三种情况：
      //   状态 Disconnected = 用户主动断了 -> 不自动重连，沿用关代理逻辑；
      //   RPC 不可达       = 服务挂了/在重启 -> 等它回来，等太久才 TUN 兜底；
      //   其余（半死状态）  = 优先自动重连，重连用尽才 TUN 兜底。
      const st = await anycastStatus();
      if (st && st.state === 'Disconnected') {
        if (await isSpontaneousDrop()) {
          // 客户端自己挂了，不是用户断的：先提醒，再尝试重连。不立即切 TUN——
          // GUI 自愈拉起隧道后一切原样（重连会因缺隧道机密被 400，次数用尽后
          // 走下面的 TUN 兜底）。2026-09-29 前这里是静默的，用户只能靠 GPT 转圈
          // 感知掉线。
          log('watchdog: VPN 疑似自发掉线（Anycast GUI 退出或刚重启），尝试重连');
          notifyUser('代理桥：VPN 自发掉线', 'Anycast 客户端退出/重启导致隧道断开，正在等待自愈并尝试重连…');
          lastDropNotice = { kind: 'spontaneous', at: Date.now() };
          await reconnectVpn('VPN 自发掉线', true);
          if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS && (await readProxyEnable()) === true) {
            wdBusy = true;
            log('watchdog: 自发掉线且重连无望，把系统代理切到 TUN 兜底');
            runSwitchMode('TUN');
          }
        } else if ((await readProxyEnable()) === true) {
          // GUI 活着且没重启过 → 维持"用户手动断开"的旧判定
          wdBusy = true;
          log('watchdog: VPN 为主动断开状态，把系统代理切到 TUN');
          notifyUser('代理桥：VPN 已断开', '检测到 VPN 断开，系统代理已切到直连。');
          lastDropNotice = { kind: 'manual', at: Date.now() };
          runSwitchMode('TUN');
        }
      } else if (!st) {
        rpcDeadStreak++;
        if (rpcDeadStreak >= RPC_DEAD_TUN_THRESHOLD) {
          rpcDeadStreak = 0;
          if ((await readProxyEnable()) === true) {
            wdBusy = true;
            log('watchdog: 隧道(1080)不通且 Anycast 服务长时间无响应，自动把系统代理切到 TUN');
            notifyUser('代理桥：隧道不可用', 'Anycast 服务长时间无响应，已切到直连兜底。');
            lastDropNotice = { kind: 'spontaneous', at: Date.now() };
            runSwitchMode('TUN');
          }
        } else if (rpcDeadStreak === 1) {
          log('watchdog: 隧道(1080)不通，Anycast 服务 RPC 暂不可达（可能在重启），等待恢复');
        }
      } else {
        rpcDeadStreak = 0;
        await reconnectVpn('隧道(1080)不通');
        if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS && (await readProxyEnable()) === true) {
          wdBusy = true;
          log('watchdog: 自动重连次数用尽仍失败，把系统代理切到 TUN 兜底');
          notifyUser('代理桥：隧道不可用', '自动重连失败，已切到直连兜底。请手动重连 VPN。');
          lastDropNotice = { kind: 'spontaneous', at: Date.now() };
          runSwitchMode('TUN');
        }
      }
    } else if (wdUpStreak >= WATCHDOG_UP_THRESHOLD) {
      wdUpStreak = 0;
      // 劣化期间 1080 活着也不切回 Bridge——否则会和上面的劣化 TUN 兜底乒乓；
      // 等健康探针确认恢复（清除 tunnelDegraded）后才允许切回。
      if ((await readProxyEnable()) === false && !tunnelDegraded) {
        wdBusy = true;
        log('watchdog: 隧道(1080)已恢复，自动把系统代理切到 Bridge');
        runSwitchMode('Bridge');
      }
      // 有过掉线提醒的话，恢复时闭环提示一条（force 绕过 10 分钟冷却，
      // 否则几分钟内的短掉线恢复会被上一次掉线气泡的冷却吞掉）。
      if (lastDropNotice) {
        if (Date.now() - lastDropNotice.at < 30 * 60 * 1000) {
          notifyUser('代理桥：VPN 已恢复', '隧道重新可用，国外流量恢复正常路由。', true);
        }
        lastDropNotice = null;
      }
    }
  } catch (e) {
    wdBusy = false;
    log('watchdog: tick 出错 ' + e.message);
  }
}

setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
watchdogTick();
