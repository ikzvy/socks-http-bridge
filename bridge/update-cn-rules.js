'use strict';
// 更新国内域名直连规则文件 ~/.codex/cn-domains.txt
// 数据源：
//   1. Loyalsoldier/clash-rules direct.txt（每日构建，精选国内服务域名）
//   2. felixonmars/dnsmasq-china-list accelerated-domains.china.conf（11万+ 全量）
// 输出：每行一个域名后缀，供 socks-http-bridge.js 匹配直连
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const OUT = path.join(os.homedir(), '.codex', 'cn-domains.txt');
const SOURCES = [
  {
    name: 'clash-rules/direct.txt',
    urls: [
      'https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/direct.txt',
      'https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt',
    ],
    kind: 'clash',
  },
  {
    name: 'dnsmasq-china-list/accelerated',
    urls: [
      'https://raw.githubusercontent.com/felixonmars/dnsmasq-china-list/master/accelerated-domains.china.conf',
      'https://cdn.jsdelivr.net/gh/felixonmars/dnsmasq-china-list@master/accelerated-domains.china.conf',
    ],
    kind: 'dnsmasq',
  },
];

function fetchText(url, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'cn-rules-updater/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(res.headers.location, timeoutMs));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function fetchWithFallback(urls) {
  let lastErr;
  for (const u of urls) {
    try {
      return await fetchText(u);
    } catch (e) {
      lastErr = e;
      console.error(`  [WARN] ${u} 失败: ${e.message}`);
    }
  }
  throw lastErr;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function parseClash(text, out) {
  let n = 0;
  for (const raw of text.split('\n')) {
    // 兼容两种格式：`  - 'domain'`（behavior: domain）与 `  - DOMAIN-SUFFIX,domain`
    let m = raw.match(/^\s*-\s*'?([A-Za-z0-9._-]+)'?\s*$/);
    if (!m) m = raw.match(/^\s*-\s*DOMAIN(?:-SUFFIX)?,([A-Za-z0-9._-]+)/);
    if (!m) continue;
    const d = m[1].toLowerCase();
    if (DOMAIN_RE.test(d)) { out.add(d); n++; }
  }
  return n;
}

function parseDnsmasq(text, out) {
  let n = 0;
  for (const raw of text.split('\n')) {
    const m = raw.match(/^server=\/([^/]+)\//);
    if (!m) continue;
    const d = m[1].toLowerCase();
    if (DOMAIN_RE.test(d)) { out.add(d); n++; }
  }
  return n;
}

(async () => {
  const set = new Set(['cn']); // 兜底：所有 .cn 域名直连
  for (const src of SOURCES) {
    console.log(`下载 ${src.name} ...`);
    const text = await fetchWithFallback(src.urls);
    const n = src.kind === 'clash' ? parseClash(text, set) : parseDnsmasq(text, set);
    console.log(`  解析出 ${n} 条，累计去重后 ${set.size} 条`);
  }
  const lines = [...set].sort();
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  console.log(`[OK] 已写入 ${OUT}，共 ${lines.length} 条域名后缀`);
})().catch((e) => {
  console.error(`[FAIL] ${e.message}`);
  process.exit(1);
});
