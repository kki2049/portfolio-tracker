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

// DATA_FILE 可通过环境变量指定；Railway Volume 挂到 /data 时设 DATA_FILE=/data/portfolio_data.json
const DATA_FILE = process.env.DATA_FILE
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'portfolio_data.json')
      : path.join(__dirname, 'portfolio_data.json'));

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

// ── 通用 JSON 抓取 ────────────────────────────────────────
function fetchJson(reqUrl) {
  return new Promise(function(resolve, reject) {
    const opts = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' },
      timeout: 8000,
    };
    const req = https.get(reqUrl, opts, function(res) {
      let buf = '';
      res.on('data', function(d) { buf += d; });
      res.on('end', function() {
        try { resolve(JSON.parse(buf)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
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

  if (req.method === 'GET' && pathname === '/api/stock-info') {
    const code   = (parsed.query.code   || '').trim();
    const market = (parsed.query.market || 'A').trim();
    var info = { name: null, industry: null };
    try {
      // 统一走 Yahoo Finance（可从 Railway 美国服务器访问）
      var yfSym;
      if (market === 'A') {
        var suffix = (code.startsWith('6') || code.startsWith('5')) ? '.SS' : '.SZ';
        yfSym = code + suffix;
      } else if (market === 'HK') {
        yfSym = code.padStart(4, '0') + '.HK';
      } else {
        yfSym = code.toUpperCase();
      }
      var yfUrl = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' +
        encodeURIComponent(yfSym) + '?modules=assetProfile,quoteType';
      var yfData = await fetchJson(yfUrl);
      var r0 = yfData && yfData.quoteSummary && yfData.quoteSummary.result && yfData.quoteSummary.result[0];
      if (r0) {
        info.name     = (r0.quoteType && (r0.quoteType.longName || r0.quoteType.shortName)) || null;
        info.industry = (r0.assetProfile && (r0.assetProfile.industry || r0.assetProfile.sector)) || null;
      }
    } catch(e) { /* silently fail */ }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(info));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/parse-screenshot') {
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请在 Railway 环境变量中设置 ANTHROPIC_API_KEY' }));
      return;
    }
    let body = '';
    req.on('data', function(d) { body += d; });
    req.on('end', async function() {
      try {
        const { image, mediaType } = JSON.parse(body);
        const claudeBody = JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
              { type: 'text', text: '请从这张券商持仓截图中提取所有股票持仓信息，返回JSON数组，每项格式：{"code":"代码","name":"名称","shares":持股数量,"cost":成本均价,"market":"A或HK或US"}。A股代码6位数字，港股4位数字，美股英文字母。shares和cost必须是数字。只返回JSON数组，不要其他文字。' }
            ]
          }]
        });
        const result = await new Promise(function(resolve, reject) {
          const opts = {
            hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'Content-Length': Buffer.byteLength(claudeBody)
            }
          };
          const r = https.request(opts, function(rs) {
            let buf = '';
            rs.on('data', function(d) { buf += d; });
            rs.on('end', function() { try { resolve(JSON.parse(buf)); } catch(e) { reject(e); } });
          });
          r.on('error', reject);
          r.write(claudeBody); r.end();
        });
        const text = (result.content && result.content[0] && result.content[0].text) || '[]';
        const match = text.match(/\[[\s\S]*\]/);
        const positions = match ? JSON.parse(match[0]) : [];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ positions }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
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
