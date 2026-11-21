// Pool Remote server.
// Serves the phone app from ./public and forwards /api/* to nodejs-poolController (njsPC).
// No dependencies: runs on plain Node.js 18+.

const http = require('http');
const fs = require('fs');
const path = require('path');
const energy = require('./energy');

const PORT = parseInt(process.env.PORT || '8080', 10);
const NJSPC_URL = new URL(process.env.NJSPC_URL || 'http://127.0.0.1:4200');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function proxy(req, res) {
  const target = req.url.replace(/^\/api/, '') || '/';
  const headers = { 'content-type': req.headers['content-type'] || 'application/json', accept: 'application/json' };
  // Forward the body length: without it Node drops the body of DELETE requests.
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  if (req.headers['transfer-encoding']) headers['transfer-encoding'] = req.headers['transfer-encoding'];
  const upstream = http.request(
    {
      hostname: NJSPC_URL.hostname,
      port: NJSPC_URL.port || 80,
      path: target,
      method: req.method,
      headers,
      timeout: 15000,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, {
        'content-type': up.headers['content-type'] || 'application/json',
        'cache-control': 'no-store',
      });
      up.pipe(res);
    }
  );
  upstream.on('timeout', () => upstream.destroy(new Error('poolController timed out')));
  upstream.on('error', (err) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `Cannot reach poolController at ${NJSPC_URL.origin}: ${err.message}` }));
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      // Always revalidate so phones pick up app updates right away.
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

// Endpoints served by Pool Remote itself (not forwarded to poolController).
function local(req, res) {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/local/energy') return sendJson(res, 200, energy.report());
  if (req.method === 'PUT' && (url === '/local/energy/rate' || url === '/local/energy/settings')) {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', () => {
      try {
        energy.setSettings(JSON.parse(raw || '{}'));
        sendJson(res, 200, energy.report());
      } catch (err) {
        sendJson(res, 400, { message: err.message });
      }
    });
    return;
  }
  sendJson(res, 404, { message: 'Not found' });
}

const server = http.createServer((req, res) => {
  if (req.url === '/api' || req.url.startsWith('/api/')) return proxy(req, res);
  if (req.url.startsWith('/local/')) return local(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  serveStatic(req, res);
});

energy.start(NJSPC_URL);

server.listen(PORT, () => {
  console.log(`Pool Remote running on http://0.0.0.0:${PORT} (poolController: ${NJSPC_URL.origin})`);
});
