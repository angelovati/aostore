const test = require('node:test');
const assert = require('node:assert');
const { paymentDates, birthdays, buildAgenda } = require('../lib/agenda');
const { addMonths } = require('../lib/dates');

test('monthly payments due on the 31st fall on the last day of short months', () => {
  const p = { date: '2026-01-31', recurrence: 'monthly' };
  assert.deepStrictEqual(paymentDates(p, '2026-01-01', '2026-05-31'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
});

test('recurring payments start at their first date and stop at until', () => {
  const p = { date: '2026-03-10', recurrence: 'monthly', until: '2026-06-10' };
  assert.deepStrictEqual(paymentDates(p, '2026-01-01', '2026-12-31'), ['2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10']);
});

test('ranges far after the first date still list each due date once', () => {
  const p = { date: '2015-07-05', recurrence: 'monthly' };
  assert.deepStrictEqual(paymentDates(p, '2026-10-01', '2026-11-30'), ['2026-10-05', '2026-11-05']);
  const y = { date: '2020-02-29', recurrence: 'yearly' };
  assert.deepStrictEqual(paymentDates(y, '2023-01-01', '2024-12-31'), ['2023-02-28', '2024-02-29']);
});

test('one-off payments appear only on their date', () => {
  const p = { date: '2026-10-20', recurrence: 'once' };
  assert.deepStrictEqual(paymentDates(p, '2026-10-01', '2026-10-31'), ['2026-10-20']);
  assert.deepStrictEqual(paymentDates(p, '2026-11-01', '2026-11-30'), []);
});

test('addMonths clamps to the end of the month', () => {
  assert.strictEqual(addMonths('2024-01-31', 1), '2024-02-29');
  assert.strictEqual(addMonths('2026-12-15', 2), '2027-02-15');
  assert.strictEqual(addMonths('2026-03-31', -1), '2026-02-28');
});

test('birthdays count the age turned', () => {
  assert.deepStrictEqual(birthdays('2019-05-03', '2026-01-01', '2026-12-31'), [{ date: '2026-05-03', years: 7 }]);
});

test('agenda joins every module and knows what is done', () => {
  const data = {
    members: [{ id: 'm1', name: 'Sofi', birthDate: '2020-10-15' }],
    vehicles: [{ id: 'v1', name: 'Corolla' }],
    appointments: [
      { id: 'a1', memberId: 'm1', date: '2026-10-12', time: '16:30', specialty: 'Pediatría', status: 'pendiente' },
      { id: 'a2', memberId: 'm1', date: '2026-10-13', specialty: 'Dentista', status: 'cancelado' },
    ],
    payments: [{ id: 'p1', name: 'Cuota escolar', amount: 150000, currency: 'ARS', date: '2026-03-10', recurrence: 'monthly', paid: ['2026-10-10'] }],
    vaccines: [{ id: 'x1', memberId: 'm1', name: 'Antigripal', dueDate: '2026-10-20' }],
    maintenance: [
      { id: 'r1', vehicleId: 'v1', date: '2026-04-01', kind: 'service', nextDate: '2026-10-01' },
      { id: 'r2', vehicleId: 'v1', date: '2026-09-20', kind: 'service', nextDate: '2027-03-20' },
    ],
  };
  const events = buildAgenda(data, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepStrictEqual(
    events.map((e) => [e.date, e.module, e.title, e.done]),
    [
      ['2026-10-01', 'maintenance', 'Service — Corolla', true],
      ['2026-10-10', 'payments', 'Cuota escolar', true],
      ['2026-10-12', 'appointments', 'Pediatría — Sofi', false],
      ['2026-10-15', 'birthdays', 'Cumpleaños de Sofi (6)', false],
      ['2026-10-20', 'vaccines', 'Vacuna Antigripal — Sofi', false],
    ]
  );
});

test('due dates before a payment was entered are not owed', () => {
  const data = { members: [], vehicles: [], appointments: [], vaccines: [], maintenance: [],
    payments: [{ id: 'p', name: 'Alquiler', date: '2025-06-01', recurrence: 'monthly', paid: [], createdAt: '2026-10-09' }] };
  const done = buildAgenda(data, { from: '2026-09-01', to: '2026-11-30' }).map((e) => [e.date, e.done]);
  assert.deepStrictEqual(done, [['2026-09-01', true], ['2026-10-01', true], ['2026-11-01', false]]);
});
