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

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = 18080;
const SOCKS_HOST = '127.0.0.1';
const SOCKS_PORT = 1080;
const SOCKS_CONNECT_TIMEOUT_MS = 5000;
const RULES_FILE = path.join(os.homedir(), '.codex', 'cn-domains.txt');

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
  // OpenAI / ChatGPT
  'openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com',
  // Anthropic / xAI
  'anthropic.com', 'claude.ai', 'x.ai',
]);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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

// 其余未知流量：SOCKS 优先，失败降级直连。
// 必须保留：VPN 客户端自身的引导 API（api.wr001.net 等）在隧道未建立时
// 只能直连可达；否则形成"连 VPN 需要走 VPN"的死锁，客户端永远连不上。
// 泄露风险由强制名单兜底：真正的敏感目标（Google/OpenAI 等）不走这里。
function dial(destHost, destPort) {
  return socksDial(destHost, destPort).catch((e) => {
    log(`socks unavailable for ${destHost}:${destPort} (${e.message}), falling back to direct`);
    return directDial(destHost, destPort);
  });
}

// 路由决策：国外强制名单（只进隧道，永不降级）> 国内规则直连 > 其余 SOCKS+降级
function chooseAndDial(destHost, destPort) {
  ensureRules();
  if (isForeign(destHost)) {
    // 强制名单（Google/OpenAI/Anthropic 等）：SOCKS 不可用即 502，
    // 绝不降级直连，防止 VPN 断开时以国内真实 IP 直连造成泄露与风控断连。
    return socksDial(destHost, destPort);
  }
  if (isDomestic(destHost)) {
    log(`direct by cn rule: ${destHost}:${destPort}`);
    return directDial(destHost, destPort);
  }
  return dial(destHost, destPort);
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
