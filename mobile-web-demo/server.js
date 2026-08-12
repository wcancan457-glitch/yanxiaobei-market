const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const dataDir = path.join(root, 'data');
const dbFile = path.join(dataDir, 'db.json');
const port = Number(process.env.PORT || 5177);
const APP_TOKEN = process.env.APP_TOKEN || 'yxb-mvp-2026';

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

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
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

  if (req.url === '/api/state' && req.method === 'GET') {
    if (!fs.existsSync(dbFile)) {
      send(res, 200, '{}');
      return;
    }
    send(res, 200, fs.readFileSync(dbFile));
    return;
  }

  if (req.url === '/api/state' && req.method === 'POST') {
    if (req.headers['x-app-token'] !== APP_TOKEN) {
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
  console.log(`燕小北集市 MVP 已启动：http://localhost:${port}`);
});
