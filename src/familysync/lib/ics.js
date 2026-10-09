// iCalendar feed (RFC 5545) to subscribe from iPhone, Mac or Google Calendar.
// Times are "floating" (no time zone), so each device shows them as entered.

const { addDays } = require('./dates');

// Reminders per module; all-day events start at 00:00, so -PT15H is 9:00 the day before
const ALARMS = {
  appointments: { timed: ['-P1D', '-PT2H'], allDay: ['-PT15H'] },
  payments: { allDay: ['-P2DT15H', 'PT9H'] },
  vaccines: { allDay: ['-P6DT15H', 'PT9H'] },
  maintenance: { allDay: ['-P6DT15H'] },
  birthdays: { allDay: ['PT9H'] },
};

function escape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Lines longer than 75 octets continue on the next line after a space
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let current = '';
  for (const ch of line) {
    if (Buffer.byteLength(current + ch, 'utf8') > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = '';
    }
    current += ch;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const compact = (date) => date.replace(/-/g, '');

function formatAmount(amount, currency) {
  if (amount == null) return '';
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: currency || 'ARS' }).format(amount);
}

function toIcs(events, { name = 'FamilySync', now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//aostore//FamilySync//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escape(name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of events) {
    const amount = formatAmount(e.amount, e.currency);
    const summary = `${e.done ? '✓ ' : ''}${e.title}${amount ? ` (${amount})` : ''}`;
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@familysync`, `DTSTAMP:${stamp}`);
    if (e.time) {
      const start = `${compact(e.date)}T${e.time.replace(':', '')}00`;
      lines.push(`DTSTART:${start}`, 'DURATION:PT1H');
    } else {
      lines.push(`DTSTART;VALUE=DATE:${compact(e.date)}`, `DTEND;VALUE=DATE:${compact(addDays(e.date, 1))}`, 'TRANSP:TRANSPARENT');
    }
    lines.push(`SUMMARY:${escape(summary)}`, `CATEGORIES:${e.module}`);
    if (e.detail) lines.push(`DESCRIPTION:${escape(e.detail)}`);
    // Finished items stay in the calendar but stop ringing
    const alarms = e.done ? [] : (ALARMS[e.module] || {})[e.time ? 'timed' : 'allDay'] || [];
    for (const trigger of alarms) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escape(summary)}`, `TRIGGER:${trigger}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { toIcs, ALARMS };
