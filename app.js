#!/usr/bin/env node
// 持仓损益追踪器 — 多用户版（文件存储，兼容 Railway Volume）
'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const urlMod = require('url');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8888', 10);

// ── 数据目录：Railway Volume > DATA_FILE env > 本地 data/ ──
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (process.env.DATA_FILE ? path.dirname(process.env.DATA_FILE) : null)
  || path.join(__dirname, 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function readJson(name, def) {
  try {
    const f = path.join(DATA_DIR, name);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return def;
}
function writeJson(name, data) {
  ensureDir();
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2), 'utf8');
}

// ── 用户 / 邀请码 / 会话 ─────────────────────────────────────
function getUsers()    { return readJson('users.json', []); }
function saveUsers(u)  { writeJson('users.json', u); }

function getInvites()  { return readJson('invite_codes.json', []); }
function saveInvites(i){ writeJson('invite_codes.json', i); }

function getSessions() {
  const now = Date.now();
  return readJson('sessions.json', []).filter(s => new Date(s.expires_at).getTime() > now);
}
function saveSessions(s) { writeJson('sessions.json', s); }

function getUserData(userId) {
  return readJson('portfolio_' + userId + '.json', { v:3, positions:[], snapshots:{}, customThemes:[] });
}
function saveUserData(userId, data) {
  writeJson('portfolio_' + userId + '.json', data);
}

// ── 首次启动：生成管理员邀请码 ───────────────────────────────
function bootstrap() {
  ensureDir();
  const users = getUsers();
  if (users.length === 0) {
    const invites = getInvites();
    const hasUnused = invites.some(i => !i.used_by);
    if (!hasUnused) {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      invites.push({ code, created_by: 'system', used_by: null, created_at: new Date().toISOString() });
      saveInvites(invites);
      console.log('\n' + '='.repeat(52));
      console.log('  首次启动！管理员邀请码：' + code);
      console.log('  使用此邀请码注册第一个账号（自动成为管理员）');
      console.log('='.repeat(52) + '\n');
    }
  }
}

// ── 密码（crypto.scrypt，无额外依赖）────────────────────────
function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(pw, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(salt + ':' + key.toString('hex'));
    });
  });
}
function verifyPassword(pw, stored) {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(':');
    crypto.scrypt(pw, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(key.toString('hex') === hash);
    });
  });
}

// ── 会话 ─────────────────────────────────────────────────────
function getSession(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const sessions = getSessions();
  const sess = sessions.find(s => s.token === token);
  if (!sess) return null;
  const users = getUsers();
  const user = users.find(u => u.id === sess.user_id);
  if (!user) return null;
  return { userId: user.id, username: user.username, isAdmin: user.is_admin };
}

// ── 工具 ─────────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => resolve(body));
  });
}

function jsonRes(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ── 行情获取 ─────────────────────────────────────────────────
function fetchOnePrice(symbol) {
  return new Promise(function(resolve) {
    const reqUrl = 'https://query2.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(symbol) + '?interval=1d&range=1d';
    const options = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
      timeout: 12000,
    };
    const req = https.get(reqUrl, options, function(res) {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', function() {
        try {
          const data = JSON.parse(buf);
          const result = data && data.chart && data.chart.result && data.chart.result[0];
          if (!result) {
            const msg = (data && data.chart && data.chart.error && data.chart.error.description) || '未找到该证券';
            return resolve({ price:null, prev:null, change:null, changePct:null, currency:null, name:symbol, error:msg });
          }
          const meta = result.meta;
          const price = meta.regularMarketPrice;
          const prev  = meta.chartPreviousClose || meta.previousClose || price;
          resolve({ price, prev, change: price-prev, changePct: prev?(price-prev)/prev*100:0,
            currency: meta.currency||'USD', name: meta.longName||meta.shortName||symbol, error: null });
        } catch(e) {
          resolve({ price:null, prev:null, change:null, changePct:null, currency:null, name:symbol, error:e.message });
        }
      });
    });
    req.on('error', e => resolve({ price:null, prev:null, change:null, changePct:null, currency:null, name:symbol, error:e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ price:null, prev:null, change:null, changePct:null, currency:null, name:symbol, error:'请求超时' }); });
  });
}

function fetchQuotesBulk(symbols) {
  return new Promise(function(resolve) {
    const reqUrl = 'https://query2.finance.yahoo.com/v7/finance/quote?symbols=' + symbols.join(',');
    const options = {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
      timeout: 12000,
    };
    const req = https.get(reqUrl, options, function(res) {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', function() {
        try {
          const data = JSON.parse(buf);
          const results = data && data.quoteResponse && data.quoteResponse.result;
          if (!results || !results.length) return resolve(null);
          const map = {};
          results.forEach(function(r) {
            const price = r.regularMarketPrice;
            const prev  = r.regularMarketPreviousClose || price;
            map[r.symbol] = {
              price, prev,
              change:    r.regularMarketChange    || (price - prev),
              changePct: r.regularMarketChangePercent || (prev ? (price-prev)/prev*100 : 0),
              currency:  r.currency || 'USD',
              name:      r.longName || r.shortName || r.symbol,
              marketState:        r.marketState        || 'REGULAR',
              preMarketPrice:     r.preMarketPrice     || null,
              preMarketChange:    r.preMarketChange    || null,
              preMarketChangePct: r.preMarketChangePercent || null,
              postMarketPrice:    r.postMarketPrice    || null,
              postMarketChange:   r.postMarketChange   || null,
              postMarketChangePct: r.postMarketChangePercent || null,
              error: null,
            };
          });
          resolve(map);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function fetchPrices(symbols) {
  if (!symbols.length) return Promise.resolve({});
  return fetchQuotesBulk(symbols).then(function(bulk) {
    if (bulk) return bulk;
    return Promise.all(symbols.map(fetchOnePrice)).then(function(results) {
      const map = {};
      symbols.forEach((sym, i) => { map[sym] = results[i]; });
      return map;
    });
  });
}

function fetchJson(reqUrl) {
  return new Promise(function(resolve, reject) {
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 8000 };
    const req = https.get(reqUrl, opts, function(res) {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
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

// ── HTTP Server ──────────────────────────────────────────────
const HTML_FILE = path.join(__dirname, 'index.html');

const server = http.createServer(async function(req, res) {
  const parsed   = urlMod.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  try {
    // ── 静态页面 ─────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/') {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ── 登录（公开）─────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/login') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: '请求格式错误' }); }
      const username = (body.username || '').trim();
      const password = body.password || '';
      const users = getUsers();
      const user = users.find(u => u.username === username);
      if (!user) return jsonRes(res, 401, { error: '用户名或密码错误' });
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) return jsonRes(res, 401, { error: '用户名或密码错误' });
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const sessions = getSessions();
      sessions.push({ token, user_id: user.id, expires_at: expires });
      saveSessions(sessions);
      return jsonRes(res, 200, { token, username, isAdmin: user.is_admin });
    }

    // ── 注册（公开）─────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/register') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: '请求格式错误' }); }
      const username   = (body.username   || '').trim();
      const password   = body.password   || '';
      const inviteCode = (body.inviteCode || '').trim().toUpperCase();

      if (!username || !password || !inviteCode) return jsonRes(res, 400, { error: '请填写所有字段' });
      if (username.length < 2 || username.length > 20) return jsonRes(res, 400, { error: '用户名长度 2-20 个字符' });
      if (password.length < 6) return jsonRes(res, 400, { error: '密码至少 6 位' });

      const invites = getInvites();
      const inv = invites.find(i => i.code === inviteCode && !i.used_by);
      if (!inv) return jsonRes(res, 400, { error: '邀请码无效或已使用' });

      const users = getUsers();
      if (users.find(u => u.username === username)) return jsonRes(res, 400, { error: '用户名已存在' });

      const isAdmin = users.length === 0;
      const hash = await hashPassword(password);
      const userId = uid();
      users.push({ id: userId, username, password_hash: hash, is_admin: isAdmin, created_at: new Date().toISOString() });
      saveUsers(users);

      inv.used_by = userId;
      saveInvites(invites);

      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const sessions = getSessions();
      sessions.push({ token, user_id: userId, expires_at: expires });
      saveSessions(sessions);
      return jsonRes(res, 200, { token, username, isAdmin });
    }

    // ── 需要登录的接口 ───────────────────────────────────────
    const session = getSession(req);
    if (!session) return jsonRes(res, 401, { error: 'unauthorized' });

    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = (req.headers['authorization'] || '').slice(7);
      saveSessions(getSessions().filter(s => s.token !== token));
      return jsonRes(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      return jsonRes(res, 200, { username: session.username, isAdmin: session.isAdmin });
    }

    if (req.method === 'GET' && pathname === '/api/portfolio') {
      return jsonRes(res, 200, getUserData(session.userId));
    }

    if (req.method === 'POST' && pathname === '/api/portfolio') {
      let data;
      try { data = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: 'Bad Request' }); }
      saveUserData(session.userId, data);
      return jsonRes(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/prices') {
      const syms = (parsed.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
      return jsonRes(res, 200, await fetchPrices(syms));
    }

    if (req.method === 'GET' && pathname === '/api/exchange-rate') {
      try {
        const [usdRes, hkdRes] = await Promise.all([fetchOnePrice('USDCNY=X'), fetchOnePrice('HKDCNY=X')]);
        return jsonRes(res, 200, {
          USD: usdRes.price > 1   ? +usdRes.price.toFixed(4) : 7.25,
          HKD: hkdRes.price > 0.1 ? +hkdRes.price.toFixed(4) : 0.93,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        return jsonRes(res, 200, { USD: 7.25, HKD: 0.93, updatedAt: null });
      }
    }

    if (req.method === 'GET' && pathname === '/api/stock-info') {
      const code   = (parsed.query.code   || '').trim();
      const market = (parsed.query.market || 'A').trim();
      let info = { name: null, industry: null };
      try {
        let yfSym;
        if (market === 'A') yfSym = code + ((code.startsWith('6')||code.startsWith('5'))?'.SS':'.SZ');
        else if (market === 'HK') yfSym = code.padStart(4,'0') + '.HK';
        else yfSym = code.toUpperCase();
        const yfData = await fetchJson('https://query1.finance.yahoo.com/v10/finance/quoteSummary/' +
          encodeURIComponent(yfSym) + '?modules=assetProfile,quoteType');
        const r0 = yfData && yfData.quoteSummary && yfData.quoteSummary.result && yfData.quoteSummary.result[0];
        if (r0) {
          info.name     = (r0.quoteType && (r0.quoteType.longName || r0.quoteType.shortName)) || null;
          info.industry = (r0.assetProfile && (r0.assetProfile.industry || r0.assetProfile.sector)) || null;
        }
      } catch {}
      return jsonRes(res, 200, info);
    }

    // ── 管理员接口 ───────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/admin/invite') {
      if (!session.isAdmin) return jsonRes(res, 403, { error: '无权限' });
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      const invites = getInvites();
      invites.push({ code, created_by: session.userId, used_by: null, created_at: new Date().toISOString() });
      saveInvites(invites);
      return jsonRes(res, 200, { code });
    }

    if (req.method === 'GET' && pathname === '/api/admin/users') {
      if (!session.isAdmin) return jsonRes(res, 403, { error: '无权限' });
      const users = getUsers().map(u => ({ username: u.username, is_admin: u.is_admin, created_at: u.created_at }));
      return jsonRes(res, 200, users);
    }

    res.writeHead(404); res.end('Not Found');

  } catch (err) {
    console.error('Request error:', err.message);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal Server Error'); }
  }
});

bootstrap();

const isCloud = !!process.env.PORT;
server.listen(PORT, '0.0.0.0', function() {
  if (isCloud) {
    console.log('持仓损益追踪器 (多用户版) 已启动，端口 ' + PORT);
    console.log('数据目录：' + DATA_DIR);
  } else {
    const ip   = getLocalIP();
    const line = '='.repeat(52);
    console.log('\n' + line);
    console.log('  持仓损益追踪器 (多用户版) 已启动！');
    console.log(line);
    console.log('  本机浏览器: http://localhost:' + PORT);
    console.log('  手机/平板:   http://' + ip + ':' + PORT + '  (需同一WiFi)');
    console.log('  数据目录:    ' + DATA_DIR);
    console.log(line + '\n');
  }
});
