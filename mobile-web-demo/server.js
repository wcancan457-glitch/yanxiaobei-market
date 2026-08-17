const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');
const mailer = require('./mailer');
const { sanitizeProductImage, sanitizeImageClass } = require('./content-security');
const {
  FORMAT_MESSAGE: STUDENT_ID_FORMAT_MESSAGE,
  normalizeStudentId,
  validStudentId
} = require('./student-id');
const {
  SCHOOL_EMAIL_DOMAIN,
  FORMAT_MESSAGE: SCHOOL_EMAIL_FORMAT_MESSAGE,
  normalizeSchoolEmail,
  validSchoolEmail
} = require('./school-email');

const root = __dirname;
const port = Number(process.env.PORT || 5177);
const SESSION_COOKIE = 'yxb_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const authTokenSecret = String(process.env.AUTH_TOKEN_SECRET || '');
const emailDeliveryConfigured = mailer.configured && authTokenSecret.length >= 32;
const rateBuckets = new Map();
const messageEventClients = new Map();

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
  res.setHeader('Cache-Control', 'no-store');
  send(res, status, JSON.stringify(value));
}

function openMessageEventStream(req, res, userId, tokenHash) {
  let clients = messageEventClients.get(userId);
  if (clients?.size >= 5) {
    res.writeHead(204, {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end();
    return;
  }
  if (!clients) {
    clients = new Set();
    messageEventClients.set(userId, clients);
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders?.();
  res.socket?.setKeepAlive(true);

  let heartbeat = null;
  let heartbeatBusy = false;
  const client = {
    tokenHash,
    closed: false,
    write(chunk) {
      if (this.closed) return false;
      if (res.destroyed || res.writableEnded) {
        this.close();
        return false;
      }
      try {
        if (!res.write(chunk)) {
          this.close();
          return false;
        }
        return true;
      } catch {
        this.close();
        return false;
      }
    },
    send(event, payload) {
      return this.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      heartbeat = null;
      if (this.closed) return;
      this.closed = true;
      clients.delete(this);
      if (!clients.size) messageEventClients.delete(userId);
      if (!res.destroyed && !res.writableEnded) {
        try { res.end(); } catch {}
      }
    }
  };

  clients.add(client);
  heartbeat = setInterval(async () => {
    if (client.closed || res.destroyed || res.writableEnded) {
      client.close();
      return;
    }
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const validUser = await db.getSessionUser(tokenHash);
      if (client.closed || res.destroyed || res.writableEnded) {
        client.close();
        return;
      }
      if (!validUser || String(validUser.id) !== userId) {
        client.send('session_expired', { at: Date.now() });
        client.close();
        return;
      }
      client.write(': keepalive\n\n');
    } catch {
      client.write(': keepalive\n\n');
    } finally {
      heartbeatBusy = false;
    }
  }, 20_000);
  heartbeat.unref?.();

  req.on('close', () => client.close());
  res.on('close', () => client.close());
  res.on('error', () => client.close());
  if (!client.write('retry: 3000\n\n')) {
    client.close();
    return;
  }
  client.send('ready', { at: Date.now() });
}

function publishMessageAvailable(userIds) {
  const signal = { at: Date.now() };
  new Set(userIds.map(String)).forEach((userId) => {
    const clients = messageEventClients.get(userId);
    if (!clients) return;
    [...clients].forEach((client) => client.send('message_available', signal));
  });
}

function publishVisibilityChanged(userIds = null) {
  const signal = { at: Date.now() };
  const targets = userIds
    ? new Set(userIds.map(String).map((userId) => messageEventClients.get(userId)).filter(Boolean))
    : new Set(messageEventClients.values());
  targets.forEach((clients) => {
    [...clients].forEach((client) => client.send('visibility_changed', signal));
  });
}

function closeMessageStreamsForUser(userId) {
  const clients = messageEventClients.get(String(userId));
  if (!clients) return;
  [...clients].forEach((client) => {
    client.send('session_expired', { at: Date.now() });
    client.close();
  });
}

function closeMessageStreamsForToken(tokenHash) {
  [...messageEventClients.values()].forEach((clients) => {
    [...clients].forEach((client) => {
      if (client.tokenHash !== tokenHash) return;
      client.send('session_expired', { at: Date.now() });
      client.close();
    });
  });
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded.at(-1) || String(req.socket.remoteAddress || 'unknown');
}

function enforceRateLimit(req, scope, limit, windowMs, subject = '') {
  const now = Date.now();
  const identity = subject
    ? `account:${String(subject).slice(0, 150)}`
    : `ip:${clientIp(req)}`;
  const key = `${scope}:${identity}`;
  const active = (rateBuckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  if (active.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((active[0] + windowMs - now) / 1000));
    const waitText = retryAfter < 60 ? `${retryAfter} 秒` : `约 ${Math.ceil(retryAfter / 60)} 分钟`;
    const error = new db.AppError(429, `操作次数已达上限，请在${waitText}后再试`, 'rate_limited');
    error.retryAfter = retryAfter;
    throw error;
  }
  active.push(now);
  rateBuckets.set(key, active);
  if (rateBuckets.size > 2_000) {
    for (const [bucketKey, timestamps] of rateBuckets.entries()) {
      if (!timestamps.some((timestamp) => now - timestamp < 60 * 60 * 1000)) rateBuckets.delete(bucketKey);
    }
  }
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

async function requireAdmin(req) {
  const user = await requireUser(req);
  if (!user.isAdmin) throw new db.AppError(403, '无管理员权限', 'admin_required');
  return user;
}

async function requireVerifiedUser(req) {
  const user = await requireUser(req);
  if (!user.isVerified) {
    throw new db.AppError(
      403,
      '请先完成北工大校园身份认证，再使用发布、接单和聊天功能',
      'identity_verification_required'
    );
  }
  return user;
}

function schoolEmail(value, optional = false) {
  const email = normalizeSchoolEmail(value);
  if (!email && optional) return '';
  if (!validSchoolEmail(email)) throw new db.AppError(400, SCHOOL_EMAIL_FORMAT_MESSAGE);
  return email;
}

function validatePassword(password) {
  if (password.length < 8 || password.length > 72) {
    throw new db.AppError(400, '密码长度需要为8-72位');
  }
}

function authCodeHash(userId, purpose, destination, code) {
  return crypto.createHmac('sha256', authTokenSecret)
    .update(`${userId}:${purpose}:${String(destination).toLowerCase()}:${code}`)
    .digest('hex');
}

async function sendAuthCode(user, purpose) {
  if (!emailDeliveryConfigured) {
    throw new db.AppError(503, '邮件发送服务尚未配置，可暂时联系管理员人工认证', 'mail_not_configured');
  }
  if (!user.school_email) throw new db.AppError(400, '账号尚未绑定校内邮箱');
  const destination = schoolEmail(user.school_email);
  const code = String(crypto.randomInt(100000, 1000000));
  const tokenHash = authCodeHash(user.id, purpose, destination, code);
  await db.issueAuthToken({
    userId: user.id,
    purpose,
    tokenHash,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS)
  });
  try {
    await mailer.sendCode({ to: destination, purpose, code });
  } catch (error) {
    await db.deleteAuthToken(tokenHash).catch(() => {});
    throw new db.AppError(503, '验证码邮件发送失败，请稍后重试', 'mail_delivery_failed');
  }
}

function text(value, maxLength, fallback = '') {
  const result = String(value ?? '').trim().slice(0, maxLength);
  return result || fallback;
}

function idempotencyKey(req, label = '发布') {
  const supplied = String(req.headers['idempotency-key'] || '').trim();
  if (!supplied) return crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(supplied)) {
    throw new db.AppError(400, `${label}请求标识格式不正确，请刷新页面后重试`);
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
  let image;
  let imgClass;
  try {
    image = sanitizeProductImage(body.image);
    imgClass = sanitizeImageClass(body.imgClass);
  } catch (error) {
    throw new db.AppError(400, error.message, 'invalid_product_image');
  }
  const input = {
    title: text(body.title, 100),
    category: text(body.category, 30),
    condition: text(body.condition, 30) || '未填写',
    campus: text(body.campus, 30),
    campusText: text(body.campusText, 30),
    price: positiveNumber(body.price, '价格'),
    location: text(body.location, 120),
    desc: text(body.desc, 5000),
    image,
    imgClass,
    symbol: text(body.symbol, 10)
  };
  if (!input.title || !input.category || !input.campus || !input.campusText || !input.location || !input.desc) {
    throw new db.AppError(400, '请补全商品信息');
  }
  return input;
}

function taskInput(body) {
  const taskTypes = ['pickup', 'errand', 'part_time', 'skill', 'other'];
  const deadlineAt = new Date(String(body.deadlineAt || ''));
  const estimatedMinutes = Number(body.estimatedMinutes);
  const input = {
    title: text(body.title, 100),
    taskType: text(body.taskType, 30),
    campus: text(body.campus, 30),
    campusText: text(body.campusText, 30),
    reward: positiveNumber(body.reward, '报酬'),
    location: text(body.location, 120),
    desc: text(body.desc, 5000),
    deadlineAt,
    estimatedMinutes
  };
  if (!input.title || !taskTypes.includes(input.taskType) || !input.campus || !input.campusText || !input.location || !input.desc) {
    throw new db.AppError(400, '请补全任务信息');
  }
  if (!Number.isFinite(deadlineAt.getTime())) {
    throw new db.AppError(400, '请选择明确的任务截止日期和时间');
  }
  const now = Date.now();
  if (deadlineAt.getTime() <= now) {
    throw new db.AppError(400, '截止时间必须晚于当前时间');
  }
  if (deadlineAt.getTime() > now + 365 * 24 * 60 * 60 * 1000) {
    throw new db.AppError(400, '截止时间不能超过一年');
  }
  if (!Number.isInteger(estimatedMinutes) || estimatedMinutes < 5 || estimatedMinutes > 1440) {
    throw new db.AppError(400, '请选择预计耗时');
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

  if (pathname === '/api/events' && req.method === 'GET') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) throw new db.AppError(401, '请先登录', 'authentication_required');
    const tokenHash = sessionTokenHash(token);
    const user = await db.getSessionUser(tokenHash);
    if (!user) throw new db.AppError(401, '请先登录', 'authentication_required');
    openMessageEventStream(req, res, String(user.id), tokenHash);
    return true;
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    const health = await db.healthcheck();
    sendJson(res, 200, { ok: true, database: health.database });
    return true;
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const studentId = normalizeStudentId(body.studentId);
    enforceRateLimit(req, 'register-ip', 50, 60 * 60 * 1000);
    enforceRateLimit(req, 'register-account', 5, 60 * 60 * 1000, studentId);
    const password = String(body.password || '');
    if (!validStudentId(studentId)) throw new db.AppError(400, STUDENT_ID_FORMAT_MESSAGE);
    const registeredEmail = schoolEmail(body.schoolEmail, true) || null;
    validatePassword(password);
    const user = await db.createUser({
      studentId,
      passwordHash: passwordHash(password),
      name: text(body.name, 30, `同学${studentId.slice(-4)}`),
      campus: text(body.campus, 30, '平乐园校区'),
      schoolEmail: registeredEmail
    });
    await createSession(req, res, user.id);
    let verificationSent = false;
    if (registeredEmail && emailDeliveryConfigured) {
      const stored = await db.findUserByStudentId(studentId);
      try {
        await sendAuthCode(stored, 'verify_email');
        verificationSent = true;
      } catch (error) {
        console.error('Failed to send registration verification email:', error.message);
      }
    }
    sendJson(res, 201, { ok: true, user, verificationSent });
    return true;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const studentId = normalizeStudentId(body.studentId);
    enforceRateLimit(req, 'login-ip', 100, 15 * 60 * 1000);
    enforceRateLimit(req, 'login-account', 10, 15 * 60 * 1000, studentId);
    const password = String(body.password || '');
    const stored = await db.findUserByStudentId(studentId);
    if (!stored || !passwordMatches(password, stored.password_hash)) {
      throw new db.AppError(401, '学号或密码错误');
    }
    if (stored.is_disabled) {
      throw new db.AppError(403, '账号已停用，请联系平台管理员', 'account_disabled');
    }
    await db.recordLogin(stored.id);
    const user = db.publicUser(stored, true, true);
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
    if (token) {
      const tokenHash = sessionTokenHash(token);
      await db.deleteSession(tokenHash);
      closeMessageStreamsForToken(tokenHash);
    }
    setSessionCookie(req, res, '', 0);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/auth/request-verification' && req.method === 'POST') {
    const user = await requireUser(req);
    if (user.isVerified) throw new db.AppError(409, '该账号已经完成校园身份认证');
    const body = await readJsonBody(req);
    const email = schoolEmail(body.schoolEmail || user.schoolEmail);
    enforceRateLimit(req, 'request-verification', 10, 60 * 60 * 1000, user.id);
    const updated = await db.updateSchoolEmail(user.id, email);
    const stored = await db.findUserByStudentId(updated.studentId);
    await sendAuthCode(stored, 'verify_email');
    sendJson(res, 200, { ok: true, message: '验证码已发送到学生邮箱，请检查收件箱和垃圾邮件', retryAfter: 60 });
    return true;
  }

  if (pathname === '/api/auth/school-email' && req.method === 'PATCH') {
    const user = await requireUser(req);
    if (user.isVerified) throw new db.AppError(409, '已认证账号不能自行更换校内邮箱');
    const body = await readJsonBody(req);
    const email = schoolEmail(body.schoolEmail);
    const updated = await db.updateSchoolEmail(user.id, email);
    sendJson(res, 200, { ok: true, user: updated, message: '校内邮箱已保存，可联系管理员人工核验' });
    return true;
  }

  if (pathname === '/api/auth/verify-email' && req.method === 'POST') {
    const user = await requireUser(req);
    enforceRateLimit(req, 'verify-email', 10, 15 * 60 * 1000, user.id);
    if (user.isVerified) {
      sendJson(res, 200, { ok: true, user });
      return true;
    }
    const body = await readJsonBody(req);
    const code = String(body.code || '').trim();
    if (!/^\d{6}$/.test(code)) throw new db.AppError(400, '请输入6位数字验证码');
    await db.consumeAuthToken({
      userId: user.id,
      purpose: 'verify_email',
      tokenHash: authCodeHash(user.id, 'verify_email', schoolEmail(user.schoolEmail), code)
    });
    const verified = await db.markIdentityVerified(user.id, 'email', schoolEmail(user.schoolEmail));
    sendJson(res, 200, { ok: true, user: verified });
    return true;
  }

  if (pathname === '/api/auth/forgot-password' && req.method === 'POST') {
    if (!emailDeliveryConfigured) {
      throw new db.AppError(503, '邮件发送服务尚未配置，请联系管理员协助处理', 'mail_not_configured');
    }
    const body = await readJsonBody(req);
    const studentId = normalizeStudentId(body.studentId);
    enforceRateLimit(req, 'forgot-password-ip', 50, 60 * 60 * 1000);
    enforceRateLimit(req, 'forgot-password-account', 5, 60 * 60 * 1000, studentId);
    if (!validStudentId(studentId)) throw new db.AppError(400, STUDENT_ID_FORMAT_MESSAGE);
    const email = schoolEmail(body.schoolEmail);
    const user = await db.findVerifiedUserForReset(studentId, email);
    if (user) await sendAuthCode(user, 'reset_password');
    sendJson(res, 200, { ok: true, message: '如果学号与已认证邮箱匹配，验证码会发送到该邮箱' });
    return true;
  }

  if (pathname === '/api/auth/reset-password' && req.method === 'POST') {
    if (!emailDeliveryConfigured) {
      throw new db.AppError(503, '邮件发送服务尚未配置，请联系管理员协助处理', 'mail_not_configured');
    }
    const body = await readJsonBody(req);
    const studentId = normalizeStudentId(body.studentId);
    enforceRateLimit(req, 'reset-password-ip', 100, 15 * 60 * 1000);
    enforceRateLimit(req, 'reset-password-account', 10, 15 * 60 * 1000, studentId);
    const code = String(body.code || '').trim();
    const nextPassword = String(body.newPassword || '');
    if (!validStudentId(studentId)) throw new db.AppError(400, STUDENT_ID_FORMAT_MESSAGE);
    const email = schoolEmail(body.schoolEmail);
    if (!/^\d{6}$/.test(code)) throw new db.AppError(400, '请输入6位数字验证码');
    validatePassword(nextPassword);
    const user = await db.findVerifiedUserForReset(studentId, email);
    if (!user) throw new db.AppError(400, '验证码不正确或已过期', 'invalid_auth_code');
    await db.consumeAuthToken({
      userId: user.id,
      purpose: 'reset_password',
      tokenHash: authCodeHash(user.id, 'reset_password', email, code)
    });
    await db.resetUserPassword(user.id, passwordHash(nextPassword));
    closeMessageStreamsForUser(user.id);
    sendJson(res, 200, { ok: true, message: '密码已重置，请使用新密码登录' });
    return true;
  }

  if (pathname === '/api/bootstrap' && req.method === 'GET') {
    const user = await sessionUser(req);
    const state = await db.getBootstrap(user?.id || null);
    sendJson(res, 200, {
      ...state,
      currentUser: user,
      authCapabilities: {
        schoolEmailDomain: SCHOOL_EMAIL_DOMAIN,
        emailDeliveryConfigured
      }
    });
    return true;
  }

  if (pathname === '/api/admin/overview' && req.method === 'GET') {
    await requireAdmin(req);
    const overview = await db.getAdminOverview();
    sendJson(res, 200, { ok: true, overview });
    return true;
  }

  if (pathname === '/api/admin/users' && req.method === 'GET') {
    await requireAdmin(req);
    const search = String(requestUrl.searchParams.get('query') || '');
    const requestedStatus = String(requestUrl.searchParams.get('status') || 'all');
    const status = ['all', 'active', 'disabled', 'online', 'unverified'].includes(requestedStatus)
      ? requestedStatus
      : 'all';
    const users = await db.getAdminUsers(search, status);
    sendJson(res, 200, { ok: true, users });
    return true;
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && req.method === 'PATCH') {
    const admin = await requireAdmin(req);
    const body = await readJsonBody(req);
    const action = String(body.action || '');
    const result = await db.manageAdminUser(admin.id, adminUserMatch[1], action);
    if (action === 'disable' || action === 'force_logout') closeMessageStreamsForUser(adminUserMatch[1]);
    if (action === 'disable' || action === 'enable') publishVisibilityChanged();
    if (action === 'verify_identity') publishVisibilityChanged([adminUserMatch[1]]);
    sendJson(res, 200, { ok: true, result });
    return true;
  }

  if (pathname === '/api/admin/reports' && req.method === 'GET') {
    await requireAdmin(req);
    const requestedStatus = String(requestUrl.searchParams.get('status') || 'pending');
    const status = ['all', 'pending', 'reviewing', 'resolved', 'dismissed'].includes(requestedStatus)
      ? requestedStatus
      : 'pending';
    const reports = await db.getAdminReports(status);
    sendJson(res, 200, { ok: true, reports });
    return true;
  }

  const adminReportMatch = pathname.match(/^\/api\/admin\/reports\/([^/]+)$/);
  if (adminReportMatch && req.method === 'PATCH') {
    const admin = await requireAdmin(req);
    const body = await readJsonBody(req);
    const report = await db.manageReport(
      admin.id,
      adminReportMatch[1],
      String(body.action || ''),
      text(body.resolution, 500)
    );
    if (String(body.action || '') === 'disable_target' && report.targetOwnerId) {
      closeMessageStreamsForUser(report.targetOwnerId);
      publishVisibilityChanged();
    }
    sendJson(res, 200, { ok: true, report });
    return true;
  }

  if (pathname === '/api/products' && req.method === 'POST') {
    const user = await requireVerifiedUser(req);
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
    const user = await requireVerifiedUser(req);
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
    const user = await requireVerifiedUser(req);
    const body = await readJsonBody(req);
    const task = await db.updateTask(user.id, taskMatch[1], body.action);
    sendJson(res, 200, { ok: true, task });
    return true;
  }

  const taskApplicationMatch = pathname.match(/^\/api\/task-applications\/([^/]+)$/);
  if (taskApplicationMatch && req.method === 'PATCH') {
    const user = await requireVerifiedUser(req);
    const body = await readJsonBody(req);
    const result = await db.manageTaskApplication(user.id, taskApplicationMatch[1], String(body.action || ''));
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (pathname === '/api/intents' && req.method === 'POST') {
    const user = await requireVerifiedUser(req);
    const body = await readJsonBody(req);
    const result = await db.createIntent(user.id, text(body.productId, 100));
    sendJson(res, 201, { ok: true, ...result });
    if (result.message) publishMessageAvailable([result.message.from, result.message.to]);
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

  if (pathname === '/api/messages' && req.method === 'GET') {
    const user = await requireUser(req);
    const after = String(requestUrl.searchParams.get('after') || '').slice(0, 200);
    const result = await db.getMessagesSince(user.id, after, 100);
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (pathname === '/api/messages' && req.method === 'POST') {
    const user = await requireVerifiedUser(req);
    const body = await readJsonBody(req);
    const message = await db.createMessage(user.id, {
      productId: text(body.productId, 100),
      peerId: text(body.peerId, 100),
      text: text(body.text, 2000),
      requestId: idempotencyKey(req, '消息发送')
    });
    sendJson(res, 201, { ok: true, message });
    publishMessageAvailable([message.from, message.to]);
    return true;
  }

  if (pathname === '/api/notifications/read' && req.method === 'PATCH') {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const updated = await db.markNotificationsRead(user.id, text(body.notificationId, 100, 'all'));
    sendJson(res, 200, { ok: true, updated });
    return true;
  }

  if (pathname === '/api/blocks' && req.method === 'POST') {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const block = await db.blockUser(user.id, text(body.targetUserId, 100));
    sendJson(res, 201, { ok: true, block });
    publishVisibilityChanged([user.id, block.userId]);
    return true;
  }

  const blockMatch = pathname.match(/^\/api\/blocks\/([^/]+)$/);
  if (blockMatch && req.method === 'DELETE') {
    const user = await requireUser(req);
    await db.unblockUser(user.id, blockMatch[1]);
    sendJson(res, 200, { ok: true });
    publishVisibilityChanged([user.id, blockMatch[1]]);
    return true;
  }

  if (pathname === '/api/reports' && req.method === 'POST') {
    const user = await requireUser(req);
    enforceRateLimit(req, 'report', 10, 60 * 60 * 1000, user.id);
    const body = await readJsonBody(req);
    const targetType = text(body.targetType, 20);
    const reason = text(body.reason, 30);
    if (!['product', 'task', 'user'].includes(targetType)) throw new db.AppError(400, '举报对象类型不合法');
    if (!['spam', 'fraud', 'prohibited', 'harassment', 'privacy', 'other'].includes(reason)) {
      throw new db.AppError(400, '请选择举报原因');
    }
    const description = text(body.description, 1000);
    if (!description) throw new db.AppError(400, '请补充举报说明');
    const report = await db.createReport(user.id, {
      targetType,
      targetId: text(body.targetId, 120),
      reason,
      description
    });
    sendJson(res, 201, { ok: true, report });
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
      if (status === 429 && Number(error.retryAfter) > 0) {
        res.setHeader('Retry-After', String(Math.ceil(Number(error.retryAfter))));
      }
      sendJson(res, status, {
        ok: false,
        error: status >= 500 ? '服务器暂时不可用，请稍后重试' : error.message,
        code: error.code || 'server_error',
        ...(Number(error.retryAfter) > 0 ? { retryAfter: Math.ceil(Number(error.retryAfter)) } : {})
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
  [...messageEventClients.values()].forEach((clients) => {
    [...clients].forEach((client) => client.close());
  });
  server.close(async () => {
    if (db.pool) await db.pool.end().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
