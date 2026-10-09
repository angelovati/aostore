const { addMonths, toDate } = require('./dates');

const KIND_LABELS = {
  service: 'Service',
  reparacion: 'Reparación',
  neumaticos: 'Neumáticos',
  vtv: 'VTV',
  otro: 'Mantenimiento',
};

// Due dates of a payment between from and to (inclusive). Monthly payments due
// on the 31st fall on the last day of shorter months.
function paymentDates(payment, from, to) {
  const step = { monthly: 1, yearly: 12 }[payment.recurrence];
  const end = payment.until && payment.until < to ? payment.until : to;
  if (!step) return payment.date >= from && payment.date <= end ? [payment.date] : [];
  const out = [];
  // Jump close to `from` instead of walking from a start date years back
  let n = 0;
  if (payment.date < from) {
    const a = toDate(payment.date);
    const b = toDate(from);
    const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
    n = Math.max(0, Math.floor(months / step) - 1);
  }
  for (;; n++) {
    // Always offset from the first date so a 31st is not lost after February
    const d = addMonths(payment.date, n * step);
    if (d > end) break;
    if (d >= from) out.push(d);
  }
  return out;
}

// Yearly date of a birthday, Feb 29 -> Feb 28 on other years
function birthdays(birthDate, from, to) {
  const out = [];
  const born = toDate(birthDate);
  for (let y = toDate(from).getUTCFullYear(); y <= toDate(to).getUTCFullYear(); y++) {
    const years = y - born.getUTCFullYear();
    if (years < 1) continue;
    const d = addMonths(birthDate, years * 12);
    if (d >= from && d <= to) out.push({ date: d, years });
  }
  return out;
}

// Every dated thing in the family, as one list of events sorted by date and time
function buildAgenda(data, { from, to }) {
  const members = new Map(data.members.map((m) => [m.id, m]));
  const vehicles = new Map(data.vehicles.map((v) => [v.id, v]));
  const inRange = (d) => d && d >= from && d <= to;
  const events = [];

  for (const a of data.appointments) {
    if (!inRange(a.date) || a.status === 'cancelado') continue;
    const m = members.get(a.memberId);
    events.push({
      uid: `appointment-${a.id}`,
      module: 'appointments',
      ref: a.id,
      date: a.date,
      time: a.time,
      title: `${a.specialty}${m ? ` — ${m.name}` : ''}`,
      detail: [a.doctor, a.place].filter(Boolean).join(' · '),
      memberId: a.memberId,
      done: a.status === 'realizado',
    });
  }

  for (const p of data.payments) {
    for (const date of paymentDates(p, from, to)) {
      events.push({
        uid: `payment-${p.id}-${date}`,
        module: 'payments',
        ref: p.id,
        date,
        title: p.name,
        detail: p.notes || '',
        amount: p.amount,
        currency: p.currency,
        // Due dates before the payment was entered are not reported as owed
        done: p.paid.includes(date) || Boolean(p.createdAt && date < p.createdAt),
      });
    }
  }

  for (const v of data.vaccines) {
    if (!inRange(v.dueDate)) continue;
    const m = members.get(v.memberId);
    events.push({
      uid: `vaccine-${v.id}`,
      module: 'vaccines',
      ref: v.id,
      date: v.dueDate,
      title: `Vacuna ${v.name}${v.dose ? ` (${v.dose})` : ''}${m ? ` — ${m.name}` : ''}`,
      detail: v.place || '',
      memberId: v.memberId,
      done: Boolean(v.appliedDate),
    });
  }

  for (const r of data.maintenance) {
    if (!inRange(r.nextDate)) continue;
    const v = vehicles.get(r.vehicleId);
    // Done once a later visit of the same kind was recorded for that vehicle
    const done = data.maintenance.some(
      (o) => o.id !== r.id && o.vehicleId === r.vehicleId && o.kind === r.kind && o.date > r.date
    );
    events.push({
      uid: `maintenance-${r.id}`,
      module: 'maintenance',
      ref: r.id,
      date: r.nextDate,
      title: `${KIND_LABELS[r.kind] || 'Mantenimiento'}${v ? ` — ${v.name}` : ''}`,
      detail: r.nextKm ? `o a los ${r.nextKm.toLocaleString('es-AR')} km` : '',
      done,
    });
  }

  for (const m of data.members) {
    if (!m.birthDate) continue;
    for (const { date, years } of birthdays(m.birthDate, from, to)) {
      events.push({
        uid: `birthday-${m.id}-${date.slice(0, 4)}`,
        module: 'birthdays',
        ref: m.id,
        date,
        title: `Cumpleaños de ${m.name} (${years})`,
        detail: '',
        memberId: m.id,
        done: false,
      });
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
}

module.exports = { buildAgenda, paymentDates, birthdays };
