const test = require('node:test');
const assert = require('node:assert');
const { toIcs } = require('../lib/ics');

const now = new Date('2026-10-09T12:00:00Z');

test('timed and all-day events with reminders', () => {
  const ics = toIcs([
    { uid: 'appointment-a1', module: 'appointments', date: '2026-10-12', time: '16:30', title: 'Pediatría — Sofi', detail: 'Dra. Pérez, Hospital; piso 2', done: false },
    { uid: 'payment-p1-2026-10-31', module: 'payments', date: '2026-10-31', title: 'Alquiler', amount: 500000, currency: 'ARS', done: false },
  ], { now });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261012T163000\r\nDURATION:PT1H/);
  assert.match(ics, /DESCRIPTION:Dra. Pérez\\, Hospital\\; piso 2/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261031\r\nDTEND;VALUE=DATE:20261101/);
  assert.match(ics, /SUMMARY:Alquiler \(\$\s500\.000\\,00\)/);
  assert.strictEqual((ics.match(/BEGIN:VALARM/g) || []).length, 4);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test('done events keep showing without alarms', () => {
  const ics = toIcs([{ uid: 'vaccine-x', module: 'vaccines', date: '2026-10-12', title: 'Vacuna BCG', done: true }], { now });
  assert.match(ics, /SUMMARY:✓ Vacuna BCG/);
  assert.doesNotMatch(ics, /VALARM/);
});

test('long lines are folded at 75 octets', () => {
  const ics = toIcs([{ uid: 'x', module: 'payments', date: '2026-10-12', title: 'Ñ'.repeat(80), done: false }], { now });
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.match(ics.replace(/\r\n /g, ''), new RegExp(`SUMMARY:${'Ñ'.repeat(80)}`));
});
