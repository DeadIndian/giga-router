const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { buildSite } = require('./build-site.cjs');

// Serve the exact public artifact at a project subpath, just like GitHub Pages.
function serveSite(directory, basePath = '/giga-router/') {
  const types = { 'index.html': 'text/html; charset=utf-8', 'styles.css': 'text/css; charset=utf-8', 'site.js': 'text/javascript; charset=utf-8', 'assets/favicon.svg': 'image/svg+xml', 'sitemap.xml': 'application/xml' };
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400).end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    if (pathname === basePath.slice(0, -1) || pathname === '/') { res.writeHead(302, { Location: basePath }).end(); return; }
    const file = pathname.startsWith(basePath) ? pathname.slice(basePath.length) || 'index.html' : '';
    if (!Object.hasOwn(types, file)) { res.writeHead(404).end('Not found'); return; }
    try {
      const content = fs.readFileSync(path.join(directory, file));
      res.writeHead(200, { 'Content-Type': types[file], 'Content-Length': content.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(404).end('Not found'); }
  }).listen(0, '127.0.0.1');
}

module.exports = { serveSite };
if (require.main === module) {
  const { directory } = buildSite();
  const server = serveSite(directory);
  server.once('listening', () => console.log(`Website preview: http://127.0.0.1:${server.address().port}/giga-router/\nPress Ctrl+C to stop.`));
  const stop = () => { server.closeAllConnections(); server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
