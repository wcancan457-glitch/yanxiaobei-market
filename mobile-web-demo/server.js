const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const dbFile = path.join(dataDir, 'db.json');
const authFile = path.join(dataDir, 'auth.json');
const port = Number(process.env.PORT || 5177);
const SESSION_COOKIE = 'yxb_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
    return cookies;
  }, {});
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + digest;
}

function passwordMatches(password, stored) {
  const parts = String(stored || '').split(':');
  const salt = parts[0];
  const digest = parts[1];
  if (!salt || !digest) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, campus: user.campus };
}

function authStore() {
  const store = readJson(authFile, { version: 1, users: {} });
  if (!store.users || typeof store.users !== 'object') store.users = {};
  return store;
}

function sessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return authStore().users[session.userId] || null;
}

function isSecureRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return Boolean(req.socket.encrypted) || forwardedProto === 'https';
}

function setSessionCookie(req, res, token, maxAge = SESSION_TTL_MS / 1000) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + encodeURIComponent(token) + '; Max-Age=' + maxAge + '; Path=/; HttpOnly; SameSite=Lax' + secure);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function validStudentId(value) {
  return /^\d{4,20}$/.test(String(value || '').trim());
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost:' + port).pathname);
  const safePath = path.normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(root, safePath);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (filePath !== root && !filePath.startsWith(rootPrefix)) {
    send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      return;
    }
    send(res, 200, data, types[path.extname(filePath)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  const requestUrl = new URL(req.url, 'http://localhost:' + port);

  if (requestUrl.pathname === '/api/auth/register' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const id = String(body.studentId || '').trim();
      const password = String(body.password || '');
      const name = String(body.name || ('同学' + id.slice(-4))).trim().slice(0, 30);
      const campus = String(body.campus || '平乐园校区').trim().slice(0, 30);
      if (!validStudentId(id)) {
        send(res, 400, JSON.stringify({ ok: false, error: '学号需要是4-20位数字' }));
        return;
      }
      if (password.length < 6 || password.length > 72) {
        send(res, 400, JSON.stringify({ ok: false, error: '密码长度需要为6-72位' }));
        return;
      }
      const store = authStore();
      if (store.users[id]) {
        send(res, 409, JSON.stringify({ ok: false, error: '该学号已注册，请直接登录' }));
        return;
      }
      const user = {
        id,
        name: name || ('同学' + id.slice(-4)),
        campus: campus || '平乐园校区',
        passwordHash: passwordHash(password),
        createdAt: new Date().toISOString()
      };
      store.users[id] = user;
      writeJson(authFile, store);

      const state = readJson(dbFile, {});
      state.users = state.users && typeof state.users === 'object' ? state.users : {};
      state.users[id] = { id, name: user.name, campus: user.campus };
      writeJson(dbFile, state);

      setSessionCookie(req, res, createSession(id));
      send(res, 201, JSON.stringify({ ok: true, user: publicUser(user) }));
    } catch {
      send(res, 400, JSON.stringify({ ok: false, error: '注册请求格式不正确' }));
    }
    return;
  }

  if (requestUrl.pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const id = String(body.studentId || '').trim();
      const password = String(body.password || '');
      const user = authStore().users[id];
      if (!user || !passwordMatches(password, user.passwordHash)) {
        send(res, 401, JSON.stringify({ ok: false, error: '学号或密码错误' }));
        return;
      }
      setSessionCookie(req, res, createSession(id));
      send(res, 200, JSON.stringify({ ok: true, user: publicUser(user) }));
    } catch {
      send(res, 400, JSON.stringify({ ok: false, error: '登录请求格式不正确' }));
    }
    return;
  }

  if (requestUrl.pathname === '/api/auth/me' && req.method === 'GET') {
    const user = sessionUser(req);
    send(res, 200, JSON.stringify({ authenticated: Boolean(user), user: publicUser(user) }));
    return;
  }

  if (requestUrl.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    setSessionCookie(req, res, '', 0);
    send(res, 200, JSON.stringify({ ok: true }));
    return;
  }

  if (requestUrl.pathname === '/api/state' && req.method === 'GET') {
    if (!fs.existsSync(dbFile)) {
      send(res, 200, '{}');
      return;
    }
    send(res, 200, fs.readFileSync(dbFile));
    return;
  }

  if (requestUrl.pathname === '/api/state' && req.method === 'POST') {
    if (!sessionUser(req)) {
      send(res, 403, JSON.stringify({ ok: false, error: 'forbidden' }));
      return;
    }
    try {
      const body = await readBody(req);
      const json = JSON.parse(body);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(dbFile, JSON.stringify(json, null, 2));
      send(res, 200, JSON.stringify({ ok: true }));
    } catch (error) {
      send(res, 400, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(port, '127.0.0.1', () => {
  console.log('燕小北集市服务已启动：http://localhost:' + port);
});
