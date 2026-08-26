const assert = require('assert');
const { spawn } = require('child_process');
const { Pool } = require('pg');

const port = Number(process.env.TEST_PORT || 5199);
const baseUrl = `http://127.0.0.1:${port}`;
const databaseUrl = String(process.env.DATABASE_URL || '').trim();

if (!databaseUrl) throw new Error('DATABASE_URL is required for HTTP flow tests');

const administrativeDatabaseUrl = String(process.env.TEST_ADMIN_DATABASE_URL || databaseUrl).trim();
const localDatabase = /@(localhost|127\.0\.0\.1)(:|\/)/i.test(administrativeDatabaseUrl);
const pool = new Pool({
  connectionString: administrativeDatabaseUrl,
  ssl: localDatabase ? false : { rejectUnauthorized: false }
});
const studentId = `2099${String(Date.now()).slice(-10)}`;
const password = 'Test-pass-2026';
const schoolEmail = `flow-${studentId}@emails.bjut.edu.cn`;
let cookie = '';
let server;
let userId = '';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {})
    }
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';', 1)[0];
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  return { response, body };
}

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const result = await request('/api/health');
      if (result.response.ok) return;
      lastError = new Error(`health status ${result.response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError || new Error('server did not start');
}

async function cleanup() {
  if (userId) {
    await pool.query('delete from products where seller_id = $1 or buyer_id = $1', [userId]).catch(() => {});
    await pool.query('delete from tasks where publisher_id = $1 or taker_id = $1', [userId]).catch(() => {});
    await pool.query('delete from users where id = $1', [userId]).catch(() => {});
  } else {
    await pool.query('delete from users where student_id = $1', [studentId]).catch(() => {});
  }
}

async function main() {
  await cleanup();
  server = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      AUTH_TOKEN_SECRET: process.env.AUTH_TOKEN_SECRET || 'test-secret-that-is-at-least-32-characters-long'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  await waitForServer();

  let result = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ studentId, password, campus: '平乐园校区', schoolEmail })
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  userId = String(result.body.user.id);

  await pool.query(
    `update users set email_verified_at = now(), verification_method = 'manual'
     where id = $1`,
    [userId]
  );

  const productPayload = {
    title: 'HTTP流程测试教材',
    category: '教材资料',
    condition: '轻微使用痕迹',
    campus: 'pingleyuan',
    campusText: '平乐园校区',
    price: 18,
    location: '图书馆门口',
    desc: '自动化测试创建，流程结束后会删除。',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    imgClass: 'img-book',
    symbol: '书'
  };

  result = await request('/api/products', {
    method: 'POST',
    headers: { 'Idempotency-Key': `pre_nickname_${studentId}` },
    body: JSON.stringify(productPayload)
  });
  assert.equal(result.response.status, 428, JSON.stringify(result.body));
  assert.equal(result.body.code, 'nickname_setup_required');

  result = await request('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify({ name: `流程同学${studentId.slice(-4)}` })
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.nicknameRequired, false);

  result = await request('/api/products', {
    method: 'POST',
    headers: { 'Idempotency-Key': `publish_${studentId}` },
    body: JSON.stringify(productPayload)
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  const productId = result.body.product.id;

  result = await request('/api/bootstrap');
  assert.equal(result.response.status, 200);
  assert(result.body.products.some((product) => product.id === productId));

  result = await request('/api/auth/logout', { method: 'POST' });
  assert.equal(result.response.status, 200);
  cookie = '';

  result = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ studentId, password: 'definitely-wrong' })
  });
  assert.equal(result.response.status, 401, JSON.stringify(result.body));
  assert.equal(result.body.code, 'invalid_credentials');

  result = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ studentId, password })
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert(cookie.includes('yxb_session='));

  result = await request('/api/products', {
    method: 'POST',
    headers: { 'Idempotency-Key': `large_image_${studentId}` },
    body: JSON.stringify({
      ...productPayload,
      image: `data:image/jpeg;base64,${'a'.repeat(3_050_000)}`
    })
  });
  assert.equal(result.response.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, 'invalid_product_image');

  result = await request('/api/products', {
    method: 'POST',
    body: JSON.stringify({ ...productPayload, desc: 'x'.repeat(4_050_000) })
  });
  assert.equal(result.response.status, 413, JSON.stringify(result.body));
  assert.equal(result.body.code, 'request_too_large');

  console.log('HTTP flow tests passed: register, verify gate, nickname gate, publish, logout, login, upload limits');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    if (server && !server.killed) server.kill('SIGTERM');
    await pool.end().catch(() => {});
  });
