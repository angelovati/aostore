// The app must work behind a proxy that serves it under a subpath and strips
// it before forwarding (Home Assistant ingress), so nothing may point at "/".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'familysync-subpath-'));
process.env.FEED_BASE_URL = 'http://umbrel.local:3743';
const { server } = require('../server');
const { createProxy } = require('../scripts/subpath-proxy');

const PUBLIC = path.join(__dirname, '..', 'public');
const PREFIX = '/prueba/subpath/';
let proxy;
let base;

test.before(() => new Promise((resolve) => server.listen(0, () => {
  proxy = createProxy({ target: `http://127.0.0.1:${server.address().port}`, prefix: PREFIX });
  proxy.listen(0, () => {
    base = `http://127.0.0.1:${proxy.address().port}${PREFIX}`;
    resolve();
  });
})));
test.after(() => {
  proxy.close();
  server.close();
});

test('frontend files use only relative URLs', () => {
  const absolute = [
    /(?:href|src|action)\s*=\s*["']\/(?!\/)/g, // HTML attributes from the root
    /url\(\s*["']?\/(?!\/)/g, // CSS url(/...)
    /["'`]\/(?:api|cal|static|assets)\b/g, // root-relative paths in strings
    /\b(?:https?|wss?):\/\/(?:localhost|127\.|192\.168\.|umbrel\.local)/g, // hard-coded hosts
    /\bhistory\.(?:push|replace)State\b/g, // path routing instead of hash routing
  ];
  for (const file of fs.readdirSync(PUBLIC)) {
    const text = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    for (const re of absolute) {
      assert.deepStrictEqual(text.match(re), null, `${file} has a non-relative URL: ${re}`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  assert.strictEqual(manifest.start_url, './');
  assert.strictEqual(manifest.scope, './');
});

test('page, assets, API and feed load through the subpath', async () => {
  const html = await (await fetch(base)).text();
  const assets = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1]);
  assert.ok(assets.includes('app.js') && assets.includes('styles.css'));
  for (const asset of assets) {
    const res = await fetch(new URL(asset, base));
    assert.strictEqual(res.status, 200, asset);
  }

  // API calls as the frontend makes them, relative to the page
  const member = await (await fetch(new URL('api/members', base), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sofi' }),
  })).json();
  assert.ok(member.id);
  const list = await (await fetch(new URL('api/members', base))).json();
  assert.deepStrictEqual(list.map((m) => m.name), ['Sofi']);

  const settings = await (await fetch(new URL('api/settings', base))).json();
  const feed = await fetch(new URL(settings.feedPath, base));
  assert.strictEqual(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /text\/calendar/);
  assert.strictEqual(settings.directFeedUrl, `http://umbrel.local:3743/${settings.feedPath}`);
});

test('responses allow embedding in an iframe and never redirect to the root', async () => {
  for (const p of ['', 'app.js', 'api/agenda', 'api/nada', 'no-existe']) {
    const res = await fetch(new URL(p, base), { redirect: 'manual' });
    assert.ok(res.status < 300 || res.status >= 400, `${p} redirected`);
    assert.strictEqual(res.headers.get('x-frame-options'), null);
    assert.doesNotMatch(res.headers.get('content-security-policy') || '', /frame-ancestors/);
    assert.strictEqual(res.headers.get('set-cookie'), null);
  }
});
