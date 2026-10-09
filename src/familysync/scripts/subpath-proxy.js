// Reverse proxy that serves the app under a subpath and strips it before
// forwarding, like Home Assistant ingress. Also serves /iframe.html, a page
// that embeds the app in an iframe.
//
//   node scripts/subpath-proxy.js [target] [port] [prefix]
//   node scripts/subpath-proxy.js http://127.0.0.1:3000 8099 /prueba/subpath/
const http = require('node:http');

function createProxy({ target, prefix }) {
  const upstream = new URL(target);
  const bare = prefix.replace(/\/$/, '');
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://proxy');
    if (url.pathname === '/iframe.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><title>iframe</title><style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><iframe src="${prefix}"></iframe>`);
    }
    // Anything outside the prefix is the "host" (Home Assistant): nothing there
    if (url.pathname !== bare && !url.pathname.startsWith(prefix)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(`404 outside prefix: ${url.pathname}`);
    }
    const path = `/${url.pathname.slice(prefix.length)}${url.search}`;
    const headers = { ...req.headers, host: upstream.host, 'x-ingress-path': bare };
    const fwd = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path, headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    fwd.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(String(err));
    });
    req.pipe(fwd);
  });
}

if (require.main === module) {
  const [target = 'http://127.0.0.1:3000', port = '8099', prefix = '/prueba/subpath/'] = process.argv.slice(2);
  createProxy({ target, prefix }).listen(Number(port), () =>
    console.log(`Proxy en http://127.0.0.1:${port}${prefix} -> ${target}`));
}

module.exports = { createProxy };
