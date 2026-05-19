#!/usr/bin/env node
// 持仓损益追踪器 — 支持本地 & 云端部署
'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const url   = require('url');
const crypto = require('crypto');

const PORT      = parseInt(process.env.PORT || '8888', 10);
const PASSWORD  = process.env.APP_PASSWORD || '';

// Railway 挂载 Volume 时会自动设置 RAILWAY_VOLUME_MOUNT_PATH
const DATA_DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'portfolio_data.json');

// ── 数据存取 ──────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return { accounts: [{ id: uid(), name: '我的账户', positions: [] }] };
}

function saveData(data) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── 密码验证（HTTP Basic Auth）───────────────────────────
function checkAuth(req, res) {
  if (!PASSWORD) return true;
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const colon   = decoded.indexOf(':');
    const pass    = colon >= 0 ? decoded.slice(colon + 1) : decoded;
    if (pass === PASSWORD) return true;
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Portfolio Tracker"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('请输入密码后访问');
  return false;
}

// ── 行情获取（Yahoo Finance v8）──────────────────────────
function fetchOnePrice(symbol) {
  return new Promise(function(resolve) {
    const reqUrl = 'https://query2.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(symbol) + '?interval=1d&range=1d';
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      timeout: 12000,
    };
    const req = https.get(reqUrl, options, function(res) {
      let buf = '';
      res.on('data', function(d) { buf += d; });
      res.on('end', function() {
        try {
          const data   = JSON.parse(buf);
          const result = data && data.chart && data.chart.result && data.chart.result[0];
          if (!result) {
            const msg = (data && data.chart && data.chart.error && data.chart.error.description) || '未找到该证券';
            return resolve({ price:null, prev:null, change:null, changePct:null, currency:null, name:symbol, error:msg });
          }
          const meta  = result.meta;
          const price = meta.regularMarketPrice;
          const prev  = meta.chartPreviousClose || meta.previousClose || price;
          resolve({
            price, prev,
            change:    price - prev,
            changePct: prev ? (price - prev) / prev * 100 : 0,
            currency:  meta.currency || 'USD',
            name:      meta.longName || meta.shortName || symbol,
            error:     null,
          });
        } catch(e) {
          resolve({ price:null, prev:null, change:null, changePct:null, currency:null, name:symbol, error:e.message });
        }
      });
    });
    req.on('error', function(e) {
      resolve({ price:null, prev:null, change:null, changePct:null, currency:null, name:symbol, error:e.message });
    });
    req.on('timeout', function() {
      req.destroy();
      resolve({ price:null, prev:null, change:null, changePct:null, currency:null, name:symbol, error:'请求超时' });
    });
  });
}

function fetchPrices(symbols) {
  if (!symbols.length) return Promise.resolve({});
  return Promise.all(symbols.map(fetchOnePrice)).then(function(results) {
    const map = {};
    symbols.forEach(function(sym, i) { map[sym] = results[i]; });
    return map;
  });
}

// ── 工具 ─────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── HTTP Server ──────────────────────────────────────────
const HTML_FILE = path.join(__dirname, 'index.html');

const server = http.createServer(async function(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (!checkAuth(req, res)) return;

  if (req.method === 'GET' && pathname === '/') {
    try {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) { res.writeHead(500); res.end('index.html not found'); }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/portfolio') {
    const data = loadData();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/prices') {
    const raw  = parsed.query.symbols || '';
    const syms = raw.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    const result = await fetchPrices(syms);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/portfolio') {
    let body = '';
    req.on('data', function(d){ body += d; });
    req.on('end', function(){
      try {
        saveData(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch(e) { res.writeHead(400); res.end('Bad Request'); }
    });
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

const isCloud = !!process.env.PORT;

server.listen(PORT, isCloud ? '0.0.0.0' : '0.0.0.0', function() {
  if (isCloud) {
    console.log('持仓损益追踪器已启动，端口 ' + PORT);
  } else {
    const ip   = getLocalIP();
    const line = '='.repeat(52);
    console.log('\n' + line);
    console.log('  持仓损益追踪器 已启动！');
    console.log(line);
    console.log('  本机浏览器: http://localhost:' + PORT);
    console.log('  手机/平板:   http://' + ip + ':' + PORT + '  (需同一WiFi)');
    console.log(line);
    console.log('  按 Ctrl+C 停止服务');
    console.log(line + '\n');
  }
});
