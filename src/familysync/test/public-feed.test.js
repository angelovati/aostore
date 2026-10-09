// Publishing the calendar on the internet: the feed-only port, the public
// address setting and changing the secret token
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'familysync-public-'));
const { server, feedServer, store } = require('../server');

let app;
let feed;
const listen = (s) => new Promise((resolve) => s.listen(0, () => resolve(`http://127.0.0.1:${s.address().port}`)));
test.before(async () => {
  app = await listen(server);
  feed = await listen(feedServer);
});
test.after(() => {
  server.close();
  feedServer.close();
});

async function json(method, url, body) {
  const res = await fetch(url, { method, body: body && JSON.stringify(body), headers: body ? { 'Content-Type': 'application/json' } : {} });
  return { status: res.status, body: await res.json() };
}

test('the feed port serves only the calendar', async () => {
  const token = store.data.settings.feedToken;
  const ok = await fetch(`${feed}/cal/${token}.ics`);
  assert.strictEqual(ok.status, 200);
  assert.match(await ok.text(), /^BEGIN:VCALENDAR/);
  assert.strictEqual((await fetch(`${feed}/cal/${token}.ics`, { method: 'HEAD' })).status, 200);
  for (const p of ['/', '/index.html', '/app.js', '/api/members', '/api/settings', '/cal/wrong.ics', `/cal/${token}.ics/x`]) {
    const res = await fetch(feed + p);
    assert.strictEqual(res.status, 404, p);
    assert.doesNotMatch(await res.text(), /FamilySync|members|feedToken/, p);
  }
  const post = await fetch(`${feed}/api/members`, { method: 'POST', body: '{"name":"x"}' });
  assert.strictEqual(post.status, 404);
  assert.strictEqual(store.data.members.length, 0);
});

test('public address is validated and used for the feed link', async () => {
  assert.strictEqual((await json('PUT', `${app}/api/settings`, { publicFeedBase: 'no es una url' })).status, 400);
  assert.strictEqual((await json('PUT', `${app}/api/settings`, { publicFeedBase: 'ftp://x.com' })).status, 400);
  const { body } = await json('PUT', `${app}/api/settings`, { publicFeedBase: ' https://familysync.example.com ' });
  assert.strictEqual(body.publicFeedBase, 'https://familysync.example.com/');
  assert.strictEqual(body.publicFeedUrl, `https://familysync.example.com/cal/${store.data.settings.feedToken}.ics`);
  // Saved to disk
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'familysync.json'), 'utf8'));
  assert.strictEqual(saved.settings.publicFeedBase, 'https://familysync.example.com/');
  const cleared = await json('PUT', `${app}/api/settings`, { publicFeedBase: '' });
  assert.strictEqual(cleared.body.publicFeedUrl, null);
});

test('a new secret token retires the old address', async () => {
  const old = store.data.settings.feedToken;
  const { body } = await json('POST', `${app}/api/settings/feed-token`);
  assert.notStrictEqual(store.data.settings.feedToken, old);
  assert.strictEqual(body.feedPath, `cal/${store.data.settings.feedToken}.ics`);
  assert.strictEqual((await fetch(`${feed}/cal/${old}.ics`)).status, 404);
  assert.strictEqual((await fetch(`${feed}/${body.feedPath}`)).status, 200);
});
