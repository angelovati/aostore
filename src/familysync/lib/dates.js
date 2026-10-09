// Calendar dates are kept as "YYYY-MM-DD" strings and computed in UTC so the
// server's time zone never shifts a day.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toDate(s) {
  return new Date(`${s}T00:00:00Z`);
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// Clamps the day to the target month: Jan 31 + 1 month -> Feb 28/29
function addMonths(s, n) {
  const d = toDate(s);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const target = new Date(Date.UTC(y, m, 1));
  const day = Math.min(d.getUTCDate(), daysInMonth(target.getUTCFullYear(), target.getUTCMonth()));
  return fmt(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day)));
}

function addDays(s, n) {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

// Today in the configured time zone (TZ), not in UTC
function today(timeZone = process.env.TZ || 'America/Argentina/Buenos_Aires') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

module.exports = { isDate, toDate, fmt, daysInMonth, addMonths, addDays, today };
