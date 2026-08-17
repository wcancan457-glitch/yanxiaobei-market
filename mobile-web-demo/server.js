const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');
const {
  FORMAT_MESSAGE: STUDENT_ID_FORMAT_MESSAGE,
  normalizeStudentId,
  validStudentId
} = require('./student-id');

const root = __dirname;
const port = Number(process.env.PORT || 5177);
const SESSION_COOKIE = 'yxb_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 7_000_000) {
        req.destroy();
        reject(new db.AppError(413, '请求内容过大'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch (error) {
    if (error instanceof db.AppError) throw error;
    throw new db.AppError(400, '请求格式不正确');
  }
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
  return `${salt}:${digest}`;
}

function passwordMatches(password, stored) {
  if (!stored || String(stored).startsWith('!')) return false;
  const [salt, digest] = String(stored).split(':');
  if (!salt || !digest) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sessionTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function isSecureRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return Boolean(req.socket.encrypted) || forwardedProto === 'https';
}

function setSessionCookie(req, res, token, maxAge = SESSION_TTL_MS / 1000) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`
  );
}

async function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.createSession({
    tokenHash: sessionTokenHash(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS)
  });
  setSessionCookie(req, res, token);
}

async function sessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  return token ? db.getSessionUser(sessionTokenHash(token)) : null;
}

async function requireUser(req) {
  const user = await sessionUser(req);
  if (!user) throw new db.AppError(401, '请先登录', 'authentication_required');
  return user;
}

function text(value, maxLength, fallback = '') {
  const result = String(value ?? '').trim().slice(0, maxLength);
  return result || fallback;
}

function idempotencyKey(req) {
  const supplied = String(req.headers['idempotency-key'] || '').trim();
  if (!supplied) return crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(supplied)) {
    throw new db.AppError(400, '发布请求标识格式不正确，请刷新页面后重试');
  }
  return supplied;
}

function positiveNumber(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0 || result > 1_000_000) {
    throw new db.AppError(400, `${label}需要是有效的正数`);
  }
  return result;
}

function productInput(body) {
  const input = {
    title: text(body.title, 100),
    category: text(body.category, 30),
    campus: text(body.campus, 30),
    campusText: text(body.campusText, 30),
    price: positiveNumber(body.price, '价格'),
    location: text(body.location, 120),
    desc: text(body.desc, 5000),
    image: text(body.image, 6_000_000),
    imgClass: text(body.imgClass, 30),
    symbol: text(body.symbol, 10)
  };
  if (!input.title || !input.category || !input.campus || !input.campusText || !input.location || !input.desc) {
    throw new db.AppError(400, '请补全商品信息');
  }
  return input;
}

function taskInput(body) {
  const input = {
    title: text(body.title, 100),
    campus: text(body.campus, 30),
    campusText: text(body.campusText, 30),
    reward: positiveNumber(body.reward, '报酬'),
    location: text(body.location, 120),
    desc: text(body.desc, 5000)
  };
  if (!input.title || !input.campus || !input.campusText || !input.location || !input.desc) {
    throw new db.AppError(400, '请补全任务信息');
  }
  return input;
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
  } catch {
    send(res, 400, 'Bad request', 'text/plain; charset=utf-8');
    return;
  }
  const safePath = path.normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(root, safePath);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (filePath !== root && !filePath.startsWith(rootPrefix)) {
    send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      return;
    }
    send(res, 200, data, types[path.extname(filePath)] || 'application/octet-stream');
  });
}

async function handleApi(req, res, requestUrl) {
  const pathname = requestUrl.pathname;

  if (pathname === '/api/health' && req.method === 'GET') {
    const health = await db.healthcheck();
    sendJson(res, 200, { ok: true, database: health.database });
    return true;
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const studentId = normalizeStudentId(body.studentId);
    const password = String(body.password || '');
    if (!validStudentId(studentId)) throw new db.AppError(400, STUDENT_ID_FORMAT_MESSAGE);
    if (password.length < 6 || password.length > 72) throw new db.AppError(400, '密码长度需要为6-72位');
    const user = await db.createUser({
      studentId,
      passwordHash: passwordHash(password),
      name: text(body.name, 30, `同学${studentId.slice(-4)}`),
      campus: text(body.campus, 30, '平乐园校区')
    });
    await createSession(req, res, user.id);
    sendJson(res, 201, { ok: true, user });
    return true;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const studentId = normalizeStudentId(body.studentId);
    const password = String(body.password || '');
    const stored = await db.findUserByStudentId(studentId);
    if (!stored || !passwordMatches(password, stored.password_hash)) {
      throw new db.AppError(401, '学号或密码错误');
    }
    const user = db.publicUser(stored, true);
    await createSession(req, res, user.id);
    sendJson(res, 200, { ok: true, user });
    return true;
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const user = await sessionUser(req);
    sendJson(res, 200, { authenticated: Boolean(user), user });
    return true;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) await db.deleteSession(sessionTokenHash(token));
    setSessionCookie(req, res, '', 0);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/bootstrap' && req.method === 'GET') {
    const user = await sessionUser(req);
    const state = await db.getBootstrap(user?.id || null);
    sendJson(res, 200, { ...state, currentUser: user });
    return true;
  }

  if (pathname === '/api/products' && req.method === 'POST') {
    const user = await requireUser(req);
    const product = await db.createProduct(
      user.id,
      productInput(await readJsonBody(req)),
      idempotencyKey(req)
    );
    sendJson(res, 201, { ok: true, product });
    return true;
  }

  const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch && req.method === 'PATCH') {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const product = await db.setProductAvailability(user.id, productMatch[1], body.status);
    sendJson(res, 200, { ok: true, product });
    return true;
  }
  if (productMatch && req.method === 'DELETE') {
    const user = await requireUser(req);
    await db.deleteProduct(user.id, productMatch[1]);
    sendJson(res, 200, { ok: true });
    return true;
  }

  const tradeMatch = pathname.match(/^\/api\/products\/([^/]+)\/trade$/);
  if (tradeMatch && req.method === 'PATCH') {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const result = await db.updateTrade(user.id, tradeMatch[1], body.action);
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (pathname === '/api/tasks' && req.method === 'POST') {
    const user = await requireUser(req);
    const task = await db.createTask(
      user.id,
      taskInput(await readJsonBody(req)),
      idempotencyKey(req)
    );
    sendJson(res, 201, { ok: true, task });
    return true;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === 'PATCH') {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const task = await db.updateTask(user.id, taskMatch[1], body.action);
    sendJson(res, 200, { ok: true, task });
    return true;
  }

  if (pathname === '/api/intents' && req.method === 'POST') {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const result = await db.createIntent(user.id, text(body.productId, 100));
    sendJson(res, 201, { ok: true, ...result });
    return true;
  }

  const intentMatch = pathname.match(/^\/api\/intents\/([^/]+)$/);
  if (intentMatch && req.method === 'PATCH') {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const result = await db.updateIntent(user.id, intentMatch[1], body.action);
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (pathname === '/api/messages' && req.method === 'POST') {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const message = await db.createMessage(user.id, {
      productId: text(body.productId, 100),
      peerId: text(body.peerId, 100),
      text: text(body.text, 2000)
    });
    sendJson(res, 201, { ok: true, message });
    return true;
  }

  if (pathname === '/api/state') {
    sendJson(res, 410, { ok: false, error: '旧版整体状态接口已停用，请升级客户端' });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  const requestUrl = new URL(req.url, `http://localhost:${port}`);
  if (requestUrl.pathname.startsWith('/api/')) {
    try {
      const handled = await handleApi(req, res, requestUrl);
      if (!handled) sendJson(res, 404, { ok: false, error: '接口不存在' });
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(error);
      sendJson(res, status, {
        ok: false,
        error: status >= 500 ? '服务器暂时不可用，请稍后重试' : error.message,
        code: error.code || 'server_error'
      });
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`燕小北集市服务已启动：http://localhost:${port}`);
  console.log(`PostgreSQL：${db.databaseConfigured ? '已配置' : '未配置'}`);
});

async function shutdown() {
  server.close(async () => {
    if (db.pool) await db.pool.end().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
