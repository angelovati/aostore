// The HTTP API against a temporary data directory
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'familysync-'));
const { server, store } = require('../server');

let base;
test.before(() => new Promise((resolve) => server.listen(0, () => {
  base = `http://127.0.0.1:${server.address().port}`;
  resolve();
})));
test.after(() => server.close());

async function call(method, url, body) {
  const res = await fetch(base + url, { method, body: body && JSON.stringify(body), headers: body ? { 'Content-Type': 'application/json' } : {} });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}

test('members, appointments and references', async () => {
  const { body: sofi } = await call('POST', '/api/members', { name: 'Sofi', birthDate: '2020-10-15' });
  assert.ok(sofi.id);
  const bad = await call('POST', '/api/appointments', { memberId: 'nadie', date: '2026-10-12', specialty: 'Pediatría' });
  assert.strictEqual(bad.status, 400);
  const { body: appt } = await call('POST', '/api/appointments', { memberId: sofi.id, date: '2026-10-12', time: '16:30', specialty: 'Pediatría' });
  assert.strictEqual(appt.status, 'pendiente');
  const { body: done } = await call('PUT', `/api/appointments/${appt.id}`, { status: 'realizado' });
  assert.strictEqual(done.time, '16:30');
  assert.strictEqual((await call('DELETE', `/api/members/${sofi.id}`)).status, 409);
  assert.strictEqual((await call('POST', '/api/members', { birthDate: '2020-02-30', name: 'x' })).status, 400);
  // Saved to disk
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'familysync.json'), 'utf8'));
  assert.strictEqual(saved.appointments[0].status, 'realizado');
});

test('payments are marked paid per due date', async () => {
  const { body: p } = await call('POST', '/api/payments', { name: 'Alquiler', amount: 500000, date: '2026-01-05' });
  assert.strictEqual(p.recurrence, 'monthly');
  await call('POST', `/api/payments/${p.id}/paid`, { date: '2026-10-05', paid: true });
  const { body: events } = await call('GET', '/api/agenda?from=2026-09-01&to=2026-10-31');
  const rent = events.filter((e) => e.module === 'payments').map((e) => [e.date, e.done]);
  // Due dates before the payment was entered count as settled
  const created = store.data.payments[0].createdAt;
  assert.deepStrictEqual(rent, [['2026-09-05', '2026-09-05' < created], ['2026-10-05', true]]);
  assert.strictEqual((await call('GET', '/api/agenda?from=2026-10-31&to=2026-01-01')).status, 400);
});

test('national vaccine schedule is added once', async () => {
  const { body: [member] } = await call('GET', '/api/members');
  const { body: first } = await call('POST', '/api/vaccines/plan', { memberId: member.id, markPastApplied: true });
  assert.ok(first.length > 20);
  const bcg = first.find((v) => v.name === 'BCG');
  assert.strictEqual(bcg.dueDate, '2020-10-15');
  assert.strictEqual(bcg.appliedDate, '2020-10-15');
  const eleven = first.find((v) => v.name === 'VPH');
  assert.strictEqual(eleven.dueDate, '2031-10-15');
  assert.strictEqual(eleven.appliedDate, undefined);
  const { body: again } = await call('POST', '/api/vaccines/plan', { memberId: member.id });
  assert.deepStrictEqual(again, []);
});

test('calendar feed needs the secret token', async () => {
  assert.strictEqual((await call('GET', '/cal/wrong.ics')).status, 404);
  const { body: settings } = await call('GET', '/api/settings');
  assert.strictEqual(settings.feedPath, `cal/${store.data.settings.feedToken}.ics`);
  assert.strictEqual(settings.directFeedUrl, null);
  const feed = await call('GET', `/${settings.feedPath}`);
  assert.strictEqual(feed.status, 200);
  assert.match(feed.body, /SUMMARY:Alquiler/);
  // Calendar apps may check the address with HEAD first
  const head = await fetch(`${base}/${settings.feedPath}`, { method: 'HEAD' });
  assert.strictEqual(head.status, 200);
  assert.match(head.headers.get('content-type'), /text\/calendar/);
  assert.strictEqual(Number(head.headers.get('content-length')), Buffer.byteLength(feed.body));
  assert.strictEqual((await fetch(`${base}/`, { method: 'HEAD' })).status, 200);
});

test('static files cannot escape the public folder', async () => {
  assert.strictEqual((await call('GET', '/')).status, 200);
  assert.strictEqual((await call('GET', '/..%2fserver.js')).status, 404);
  assert.strictEqual((await call('GET', '/api/nada')).status, 404);
});
