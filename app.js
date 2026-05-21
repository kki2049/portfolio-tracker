#!/usr/bin/env node
// 持仓损益追踪器 — 多用户版（PostgreSQL）
'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const urlMod = require('url');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '8888', 10);

// ── PostgreSQL ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT,
      used_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portfolios (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{"v":3,"positions":[],"snapshots":{},"customThemes":[]}'::jsonb
    );
  `);

  // Bootstrap: if no users exist, print an admin invite code to the logs
  const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM users');
  if (parseInt(rows[0].cnt, 10) === 0) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    await pool.query(
      'INSERT INTO invite_codes (code, created_by) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [code, 'system']
    );
    console.log('\n' + '='.repeat(52));
    console.log('  首次启动！管理员邀请码：' + code);
    console.log('  使用此邀请码注册第一个账号（自动成为管理员）');
    console.log('='.repeat(52) + '\n');
  }
}

// ── Password hashing (crypto.scrypt, no extra deps) ─────────
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

// ── Session ─────────────────────────────────────────────────
async function getSession(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const r = await pool.query(
    `SELECT s.user_id, s.expires_at, u.username, u.is_admin
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token = $1`,
    [token]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  if (new Date(row.expires_at) < new Date()) {
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    return null;
  }
  return { userId: row.user_id, username: row.username, isAdmin: row.is_admin };
}

// ── Per-user portfolio data ──────────────────────────────────
async function loadUserData(userId) {
  const r = await pool.query('SELECT data FROM portfolios WHERE user_id = $1', [userId]);
  if (!r.rows.length) return { v: 3, positions: [], snapshots: {}, customThemes: [] };
  return r.rows[0].data;
}

async function saveUserData(userId, data) {
  await pool.query(
    `INSERT INTO portfolios (user_id, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET data = $2::jsonb`,
    [userId, JSON.stringify(data)]
  );
}

// ── Helpers ──────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

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

// ── Price fetching ───────────────────────────────────────────
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

function fetchQuotesBulk(symbols) {
  return new Promise(function(resolve) {
    const reqUrl = 'https://query2.finance.yahoo.com/v7/finance/quote?symbols=' + symbols.join(',');
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
    req.on('error', function() { resolve(null); });
    req.on('timeout', function() { req.destroy(); resolve(null); });
  });
}

function fetchPrices(symbols) {
  if (!symbols.length) return Promise.resolve({});
  return fetchQuotesBulk(symbols).then(function(bulkResult) {
    if (bulkResult) return bulkResult;
    return Promise.all(symbols.map(fetchOnePrice)).then(function(results) {
      const map = {};
      symbols.forEach(function(sym, i) { map[sym] = results[i]; });
      return map;
    });
  });
}

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
    // ── Static ──────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/') {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // ── Public: login ────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/login') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: '请求格式错误' }); }
      const username = (body.username || '').trim();
      const password = body.password || '';
      const r = await pool.query('SELECT id, password_hash, is_admin FROM users WHERE username = $1', [username]);
      if (!r.rows.length) return jsonRes(res, 401, { error: '用户名或密码错误' });
      const user = r.rows[0];
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) return jsonRes(res, 401, { error: '用户名或密码错误' });
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await pool.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, user.id, expires]);
      return jsonRes(res, 200, { token, username, isAdmin: user.is_admin });
    }

    // ── Public: register ─────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/register') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: '请求格式错误' }); }
      const username   = (body.username   || '').trim();
      const password   = body.password   || '';
      const inviteCode = (body.inviteCode || '').trim().toUpperCase();

      if (!username || !password || !inviteCode) return jsonRes(res, 400, { error: '请填写所有字段' });
      if (username.length < 2 || username.length > 20) return jsonRes(res, 400, { error: '用户名长度 2-20 个字符' });
      if (password.length < 6) return jsonRes(res, 400, { error: '密码至少 6 位' });

      const invR = await pool.query('SELECT * FROM invite_codes WHERE code = $1 AND used_by IS NULL', [inviteCode]);
      if (!invR.rows.length) return jsonRes(res, 400, { error: '邀请码无效或已使用' });

      const existR = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      if (existR.rows.length) return jsonRes(res, 400, { error: '用户名已存在' });

      const countR = await pool.query('SELECT COUNT(*) AS cnt FROM users');
      const isAdmin = parseInt(countR.rows[0].cnt, 10) === 0;

      const hash = await hashPassword(password);
      const userId = uid();
      await pool.query(
        'INSERT INTO users (id, username, password_hash, is_admin) VALUES ($1, $2, $3, $4)',
        [userId, username, hash, isAdmin]
      );
      await pool.query('UPDATE invite_codes SET used_by = $1 WHERE code = $2', [userId, inviteCode]);

      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await pool.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, expires]);
      return jsonRes(res, 200, { token, username, isAdmin });
    }

    // ── All remaining routes require a valid session ──────────
    const session = await getSession(req);
    if (!session) return jsonRes(res, 401, { error: 'unauthorized' });

    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = (req.headers['authorization'] || '').slice(7);
      if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
      return jsonRes(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      return jsonRes(res, 200, { username: session.username, isAdmin: session.isAdmin });
    }

    if (req.method === 'GET' && pathname === '/api/portfolio') {
      const data = await loadUserData(session.userId);
      return jsonRes(res, 200, data);
    }

    if (req.method === 'POST' && pathname === '/api/portfolio') {
      let data;
      try { data = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: 'Bad Request' }); }
      await saveUserData(session.userId, data);
      return jsonRes(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/prices') {
      const raw  = parsed.query.symbols || '';
      const syms = raw.split(',').map(s => s.trim()).filter(Boolean);
      const result = await fetchPrices(syms);
      return jsonRes(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/exchange-rate') {
      try {
        const [usdRes, hkdRes] = await Promise.all([
          fetchOnePrice('USDCNY=X'),
          fetchOnePrice('HKDCNY=X'),
        ]);
        return jsonRes(res, 200, {
          USD: (usdRes.price > 1)   ? +usdRes.price.toFixed(4) : 7.25,
          HKD: (hkdRes.price > 0.1) ? +hkdRes.price.toFixed(4) : 0.93,
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
        if (market === 'A') {
          const suffix = (code.startsWith('6') || code.startsWith('5')) ? '.SS' : '.SZ';
          yfSym = code + suffix;
        } else if (market === 'HK') {
          yfSym = code.padStart(4, '0') + '.HK';
        } else {
          yfSym = code.toUpperCase();
        }
        const yfUrl = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' +
          encodeURIComponent(yfSym) + '?modules=assetProfile,quoteType';
        const yfData = await fetchJson(yfUrl);
        const r0 = yfData && yfData.quoteSummary && yfData.quoteSummary.result && yfData.quoteSummary.result[0];
        if (r0) {
          info.name     = (r0.quoteType && (r0.quoteType.longName || r0.quoteType.shortName)) || null;
          info.industry = (r0.assetProfile && (r0.assetProfile.industry || r0.assetProfile.sector)) || null;
        }
      } catch { /* silently fail */ }
      return jsonRes(res, 200, info);
    }

    // ── Admin ────────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/api/admin/invite') {
      if (!session.isAdmin) return jsonRes(res, 403, { error: '无权限' });
      const code = crypto.randomBytes(4).toString('hex').toUpperCase();
      await pool.query('INSERT INTO invite_codes (code, created_by) VALUES ($1, $2)', [code, session.userId]);
      return jsonRes(res, 200, { code });
    }

    if (req.method === 'GET' && pathname === '/api/admin/users') {
      if (!session.isAdmin) return jsonRes(res, 403, { error: '无权限' });
      const r = await pool.query(
        'SELECT username, is_admin, created_at FROM users ORDER BY created_at'
      );
      return jsonRes(res, 200, r.rows);
    }

    res.writeHead(404); res.end('Not Found');

  } catch (err) {
    console.error('Request error:', err.message);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal Server Error'); }
  }
});

const isCloud = !!process.env.PORT;

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', function() {
    if (isCloud) {
      console.log('持仓损益追踪器 (多用户版) 已启动，端口 ' + PORT);
    } else {
      const ip   = getLocalIP();
      const line = '='.repeat(52);
      console.log('\n' + line);
      console.log('  持仓损益追踪器 (多用户版) 已启动！');
      console.log(line);
      console.log('  本机浏览器: http://localhost:' + PORT);
      console.log('  手机/平板:   http://' + ip + ':' + PORT + '  (需同一WiFi)');
      console.log(line + '\n');
    }
  });
}).catch(err => {
  console.error('数据库初始化失败:', err.message);
  process.exit(1);
});
