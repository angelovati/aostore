const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store, SCHEMAS } = require('./lib/store');
const { buildAgenda } = require('./lib/agenda');
const { toIcs } = require('./lib/ics');
const { planFor } = require('./lib/vaccines');
const { isDate, addDays, addMonths, today } = require('./lib/dates');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const store = new Store(DATA_DIR);

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw Object.assign(new Error('Pedido demasiado grande'), { status: 413 });
  }
  try {
    return data ? JSON.parse(data) : {};
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}

function range(url) {
  const from = url.searchParams.get('from') || today();
  const to = url.searchParams.get('to') || addDays(from, 60);
  if (!isDate(from) || !isDate(to) || to < from) {
    throw Object.assign(new Error('Rango de fechas inválido'), { status: 400 });
  }
  if (to > addMonths(from, 36)) throw Object.assign(new Error('Rango de fechas demasiado largo'), { status: 400 });
  return { from, to };
}

// [method, pattern, handler(req, params, url)]
const routes = [
  ['GET', /^\/api\/agenda$/, (req, p, url) => buildAgenda(store.data, range(url))],
  ['GET', /^\/api\/settings$/, () => ({ feedPath: `/cal/${store.data.settings.feedToken}.ics` })],
  // Marks one occurrence of a payment as paid or unpaid: { date, paid }
  ['POST', /^\/api\/payments\/([\w-]+)\/paid$/, async (req, [id]) => {
    const { date, paid } = await readBody(req);
    if (!isDate(date)) throw Object.assign(new Error('Fecha inválida'), { status: 400 });
    const current = store.get('payments', id).paid;
    return store.update('payments', id, { paid: paid ? [...current, date] : current.filter((d) => d !== date) });
  }],
  // Loads the national schedule for a member: { memberId, markPastApplied }
  ['POST', /^\/api\/vaccines\/plan$/, async (req) => {
    const body = await readBody(req);
    const member = store.get('members', body.memberId);
    const items = planFor(member, store.data.vaccines, { markPastApplied: Boolean(body.markPastApplied) });
    return items.map((item) => store.create('vaccines', item));
  }],
  ['GET', /^\/api\/(\w+)$/, (req, [name]) => store.collection(name)],
  ['POST', /^\/api\/(\w+)$/, async (req, [name]) => store.create(name, await readBody(req))],
  ['PUT', /^\/api\/(\w+)\/([\w-]+)$/, async (req, [name, id]) => store.update(name, id, await readBody(req))],
  ['DELETE', /^\/api\/(\w+)\/([\w-]+)$/, (req, [name, id]) => {
    store.remove(name, id);
    return { ok: true };
  }],
];

function serveFeed(res, token) {
  if (token !== store.data.settings.feedToken) return send(res, 404, { error: 'No encontrado' });
  const now = today();
  const events = buildAgenda(store.data, { from: addMonths(now, -12), to: addMonths(now, 24) });
  res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(toIcs(events));
}

function serveStatic(res, pathname) {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : path.normalize(pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Prohibido' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'No encontrado' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const feed = url.pathname.match(/^\/cal\/([\w-]+)\.ics$/);
  if (feed && req.method === 'GET') return serveFeed(res, feed[1]);

  for (const [method, pattern, handler] of routes) {
    const m = url.pathname.match(pattern);
    if (!m || method !== req.method) continue;
    try {
      send(res, 200, await handler(req, m.slice(1), url));
    } catch (err) {
      if (!err.status) console.error(err);
      send(res, err.status || 500, { error: err.message });
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'No encontrado' });
  if (req.method !== 'GET') return send(res, 405, { error: 'Método no permitido' });
  serveStatic(res, url.pathname);
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`FamilySync escuchando en http://0.0.0.0:${PORT}`));
}

module.exports = { server, store, SCHEMAS };
