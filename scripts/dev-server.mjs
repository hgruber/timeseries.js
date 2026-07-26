#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   Development server: static files (what `npm run serve` does with
   python3 -m http.server) plus one extra route, /dav-proxy.

   The proxy exists because a browser will not talk to a CalDAV server on
   another origin unless that server answers the CORS preflight — and most do
   not: they demand authentication for OPTIONS and answer 401, which is fatal
   regardless of any header, since a preflight must return 2xx. Rather than
   reconfiguring the CalDAV server, the request is routed through here:

     browser ──► http://localhost:8080/dav-proxy?url=<encoded absolute URL>
                   (same origin as the page — no CORS check at all)
                 └─► PROPFIND/REPORT https://dav.example.org/…
                       (a server-to-server request; the same-origin policy is
                        a browser rule and simply does not apply here)

   demo/caldav-live.html reaches it by putting `/dav-proxy?url=` in its Proxy
   field: src/caldav.js builds `proxy + encodeURIComponent(absoluteURL)`.

   This is a DEVELOPMENT tool. It binds to 127.0.0.1 only, because a proxy
   that forwards to an arbitrary target URL is an open relay. Set
   DAV_PROXY_ALLOW to a comma-separated host list to restrict it further:

     DAV_PROXY_ALLOW=dav.example.org npm run serve:proxy

   Usage:  npm run serve:proxy   [PORT=8080]
   ────────────────────────────────────────────────────────────────────────── */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8080;
const ALLOW = (process.env.DAV_PROXY_ALLOW || '')
  .split(',').map((h) => h.trim()).filter(Boolean);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

// Headers worth carrying in either direction. Authorization is the one that
// matters most — without it the CalDAV server answers 401 — and Depth is
// required by WebDAV itself. Hop-by-hop headers and anything identifying the
// browser stay behind.
const FORWARD_REQUEST = ['authorization', 'depth', 'content-type', 'if-match', 'if-none-match'];
const FORWARD_RESPONSE = ['content-type', 'etag', 'dav', 'www-authenticate'];

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

async function davProxy(req, res, target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return send(res, 400, 'dav-proxy: url parameter is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return send(res, 400, 'dav-proxy: only http and https targets are allowed');
  if (ALLOW.length && !ALLOW.includes(url.hostname))
    return send(res, 403, 'dav-proxy: ' + url.hostname + ' is not in DAV_PROXY_ALLOW');

  // Buffered rather than streamed: fetch() needs `duplex: 'half'` for a
  // streaming body, and a DAV request body is a small XML document anyway.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const headers = {};
  for (const name of FORWARD_REQUEST)
    if (req.headers[name] != null) headers[name] = req.headers[name];

  let upstream;
  try {
    upstream = await fetch(url, { method: req.method, headers, body, redirect: 'follow' });
  } catch (e) {
    console.warn('dav-proxy: %s %s failed —', req.method, url.href, e.message);
    return send(res, 502, 'dav-proxy: upstream request failed — ' + e.message);
  }

  const out = {};
  for (const name of FORWARD_RESPONSE) {
    const v = upstream.headers.get(name);
    if (v != null) out[name] = v;
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, out);
  res.end(buf);
  console.log('%s %s → %d', req.method, url.href, upstream.status);
}

function serveStatic(req, res, pathname) {
  // Resolve inside ROOT, then verify — a decoded '..' must not escape it.
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');

  let stat = null;
  try { stat = fs.statSync(file); } catch { /* handled below */ }
  if (stat && stat.isDirectory()) {
    file = path.join(file, 'index.html');
    try { stat = fs.statSync(file); } catch { stat = null; }
  }
  if (!stat || !stat.isFile()) return send(res, 404, 'Not found: ' + pathname);

  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/dav-proxy') {
    const target = url.searchParams.get('url');
    if (!target) return send(res, 400, 'dav-proxy: missing url parameter');
    return davProxy(req, res, target);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  serveStatic(req, res, url.pathname);
}).listen(PORT, '127.0.0.1', () => {
  console.log('serving %s on http://localhost:%d/ (127.0.0.1 only)', ROOT, PORT);
  console.log('  demo:      http://localhost:%d/demo/index.html', PORT);
  console.log('  dav-proxy: enter "/dav-proxy?url=" in the Proxy field of demo/caldav-live.html');
  console.log(ALLOW.length
    ? '  targets restricted to: ' + ALLOW.join(', ')
    : '  any target host allowed — set DAV_PROXY_ALLOW to restrict');
});
