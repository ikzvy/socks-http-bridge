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
    execFile('reg.exe', ['query', PROXY_REG, '/v', 'ProxyEnable'], (err, stdout) => {
      if (err) return resolve(null);
      const m = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i.exec(stdout || '');
      resolve(m ? parseInt(m[1], 16) === 1 : null);
    });
  });
}

function runSwitchMode(mode) {
  execFile('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SWITCH_MODE_SCRIPT, '-Mode', mode],
    { timeout: 30000 },
    (err) => {
      wdBusy = false;
      if (err) log(`watchdog: switch-mode ${mode} 失败: ${err.message}`);
      else log(`watchdog: 系统代理已切换到 ${mode}`);
    });
}

async function watchdogTick() {
  try {
    if (fs.existsSync(WATCHDOG_DISABLED_FLAG)) return;
    const up = await probeSocks();
    if (up) { wdUpStreak++; wdDownStreak = 0; } else { wdDownStreak++; wdUpStreak = 0; }

    if (wdBusy) return;
    if (wdDownStreak >= WATCHDOG_DOWN_THRESHOLD) {
      wdDownStreak = 0;
      if ((await readProxyEnable()) === true) {
        wdBusy = true;
        log('watchdog: 隧道(1080)持续不通，自动把系统代理切到 TUN');
        runSwitchMode('TUN');
      }
    } else if (wdUpStreak >= WATCHDOG_UP_THRESHOLD) {
      wdUpStreak = 0;
      if ((await readProxyEnable()) === false) {
        wdBusy = true;
        log('watchdog: 隧道(1080)已恢复，自动把系统代理切到 Bridge');
        runSwitchMode('Bridge');
      }
    }
  } catch (e) {
    wdBusy = false;
    log('watchdog: tick 出错 ' + e.message);
  }
}

setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
watchdogTick();
