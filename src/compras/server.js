const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { compareItem, buildPlan } = require('./lib/compare');
const { parseListLine } = require('./lib/match');
const { stores } = require('./lib/stores');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LIST_FILE = path.join(DATA_DIR, 'list.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw new Error('Pedido demasiado grande');
  }
  return data ? JSON.parse(data) : {};
}

function readList() {
  try {
    return JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  } catch {
    return { text: '', stores: stores.map((s) => s.id) };
  }
}

function lines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseListLine);
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i]);
      }
    })
  );
  return out;
}

const routes = {
  'GET /api/stores': () => stores.map(({ id, name, color }) => ({ id, name, color })),
  'GET /api/list': () => readList(),
  'PUT /api/list': async (req) => {
    const body = await readBody(req);
    const list = { text: String(body.text || ''), stores: Array.isArray(body.stores) ? body.stores : undefined };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LIST_FILE, JSON.stringify(list, null, 2));
    return list;
  },
  // One product: { query, stores? }
  'POST /api/compare-item': async (req) => {
    const body = await readBody(req);
    const { quantity, query } = parseListLine(body.query);
    if (!query) throw Object.assign(new Error('Falta el producto a buscar'), { status: 400 });
    return { quantity, ...(await compareItem(query, { storeIds: body.stores })) };
  },
  // Whole list: { text, stores? } -> items and the per-store cart plan
  'POST /api/compare': async (req) => {
    const body = await readBody(req);
    const items = await mapLimit(lines(body.text), 2, async ({ quantity, query }) => ({
      quantity,
      ...(await compareItem(query, { storeIds: body.stores })),
    }));
    return { items, plan: buildPlan(items) };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    try {
      send(res, 200, await route(req));
    } catch (err) {
      console.error(err);
      send(res, err.status || 500, { error: err.message });
    }
    return;
  }
  if (req.method !== 'GET') return send(res, 404, { error: 'No encontrado' });
  const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Prohibido' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'No encontrado' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Compras escuchando en http://0.0.0.0:${PORT}`));
