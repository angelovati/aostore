// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

// URLs are relative ("api/…"): they resolve against the page's address, so the
// app also works behind a proxy that serves it under a subpath (HA ingress)
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// Dates are "YYYY-MM-DD" strings; Date objects only in UTC to format them
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parse = (s) => new Date(`${s}T00:00:00Z`);
function todayIso() {
  const d = new Date();
  return iso(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(s, n) {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dateFmt = new Intl.DateTimeFormat('es-AR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const longFmt = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtMonth = (s) => monthFmt.format(parse(s)).replace(/^./, (c) => c.toUpperCase());
const fmtDate = (s) => (s ? dateFmt.format(parse(s)) : '');
const fmtLong = (s) => (s ? longFmt.format(parse(s)) : '');
const money = (n, currency = 'ARS') =>
  n == null ? '' : new Intl.NumberFormat('es-AR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
const km = (n) => (n == null ? '' : `${n.toLocaleString('es-AR')} km`);

function relative(s) {
  const days = Math.round((parse(s) - parse(todayIso())) / 864e5);
  if (days === 0) return 'hoy';
  if (days === 1) return 'mañana';
  if (days === -1) return 'ayer';
  const abs = Math.abs(days);
  const span = abs >= 730 ? `${Math.floor(abs / 365)} años` : abs >= 60 ? `${Math.floor(abs / 30)} meses` : `${abs} días`;
  return days > 0 ? `en ${span}` : `hace ${span}`;
}

// ---------- data ----------
const COLLECTIONS = ['members', 'appointments', 'payments', 'vehicles', 'maintenance', 'vaccines'];
const db = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
const ui = { month: todayIso().slice(0, 7), selectedDay: null, payMonth: todayIso().slice(0, 7), memberFilter: '', vaccineMember: '' };

async function load(names = COLLECTIONS) {
  const lists = await Promise.all(names.map((n) => api('GET', `api/${n}`)));
  names.forEach((n, i) => (db[n] = lists[i]));
}
const byId = (name, id) => db[name].find((x) => x.id === id);
const memberName = (id) => byId('members', id)?.name || '—';

const MODULES = {
  appointments: 'Turnos médicos',
  payments: 'Pagos',
  vaccines: 'Vacunas',
  maintenance: 'Vehículos',
  birthdays: 'Cumpleaños',
};

const LABELS = {
  category: { escuela: 'Escuela', servicios: 'Servicios', vivienda: 'Vivienda / alquiler', impuestos: 'Impuestos', seguros: 'Seguros', tarjetas: 'Tarjetas', otros: 'Otros' },
  recurrence: { monthly: 'Todos los meses', yearly: 'Todos los años', once: 'Una sola vez' },
  status: { pendiente: 'Pendiente', realizado: 'Realizado', cancelado: 'Cancelado' },
  kind: { service: 'Service', reparacion: 'Reparación', neumaticos: 'Neumáticos', vtv: 'VTV', otro: 'Otro' },
  currency: { ARS: 'Pesos', USD: 'Dólares' },
};
const options = (key) => Object.entries(LABELS[key]).map(([value, label]) => ({ value, label }));
const refOptions = (name) => () => db[name].map((x) => ({ value: x.id, label: x.name }));

// ---------- forms ----------
const FORMS = {
  members: {
    title: 'integrante',
    fields: [
      { name: 'name', label: 'Nombre', required: true },
      { name: 'birthDate', label: 'Fecha de nacimiento', type: 'date' },
      { name: 'color', label: 'Color', type: 'color' },
      { name: 'notes', label: 'Notas (obra social, grupo sanguíneo…)', type: 'textarea' },
    ],
  },
  appointments: {
    title: 'turno médico',
    fields: [
      { name: 'memberId', label: 'Paciente', type: 'select', options: refOptions('members'), required: true },
      { name: 'specialty', label: 'Especialidad', required: true, list: ['Pediatría', 'Clínica médica', 'Odontología', 'Oftalmología', 'Dermatología', 'Ginecología', 'Cardiología', 'Traumatología', 'Otorrinolaringología', 'Fonoaudiología', 'Análisis clínicos'] },
      { name: 'date', label: 'Fecha', type: 'date', required: true },
      { name: 'time', label: 'Hora', type: 'time' },
      { name: 'doctor', label: 'Profesional' },
      { name: 'place', label: 'Lugar' },
      { name: 'status', label: 'Estado', type: 'select', options: () => options('status'), required: true },
      { name: 'notes', label: 'Notas', type: 'textarea' },
    ],
  },
  payments: {
    title: 'pago',
    fields: [
      { name: 'name', label: 'Concepto', required: true, wide: true, list: ['Cuota escolar', 'Alquiler', 'Expensas', 'Luz', 'Gas', 'Agua', 'Internet', 'Celular', 'Prepaga', 'Seguro del auto', 'Patente', 'ABL', 'Tarjeta de crédito'] },
      { name: 'category', label: 'Categoría', type: 'select', options: () => options('category'), required: true },
      { name: 'amount', label: 'Monto', type: 'number' },
      { name: 'currency', label: 'Moneda', type: 'select', options: () => options('currency'), required: true },
      { name: 'recurrence', label: 'Se repite', type: 'select', options: () => options('recurrence'), required: true },
      { name: 'date', label: 'Primer vencimiento', type: 'date', required: true },
      { name: 'until', label: 'Hasta (opcional)', type: 'date' },
      { name: 'notes', label: 'Notas (medio de pago, CBU…)', type: 'textarea' },
    ],
  },
  vehicles: {
    title: 'vehículo',
    fields: [
      { name: 'name', label: 'Nombre', required: true, placeholder: 'Ej.: Toyota Corolla' },
      { name: 'plate', label: 'Patente' },
      { name: 'year', label: 'Año', type: 'number' },
      { name: 'notes', label: 'Notas', type: 'textarea' },
    ],
  },
  maintenance: {
    title: 'visita al taller',
    fields: [
      { name: 'vehicleId', label: 'Vehículo', type: 'select', options: refOptions('vehicles'), required: true },
      { name: 'kind', label: 'Tipo', type: 'select', options: () => options('kind'), required: true },
      { name: 'date', label: 'Fecha', type: 'date', required: true },
      { name: 'km', label: 'Kilometraje', type: 'number' },
      { name: 'workshop', label: 'Taller' },
      { name: 'cost', label: 'Costo ($)', type: 'number' },
      { name: 'description', label: 'Qué se hizo', type: 'textarea' },
      { name: 'nextDate', label: 'Próxima visita (fecha)', type: 'date' },
      { name: 'nextKm', label: 'Próxima visita (km)', type: 'number' },
    ],
  },
  vaccines: {
    title: 'vacuna',
    fields: [
      { name: 'memberId', label: 'Para', type: 'select', options: refOptions('members'), required: true },
      { name: 'name', label: 'Vacuna', required: true },
      { name: 'dose', label: 'Dosis' },
      { name: 'dueDate', label: 'Fecha prevista', type: 'date' },
      { name: 'appliedDate', label: 'Fecha de aplicación', type: 'date' },
      { name: 'place', label: 'Vacunatorio' },
      { name: 'notes', label: 'Notas (lote, reacciones…)', type: 'textarea' },
    ],
  },
};

function fieldInput(f, value) {
  const id = `f-${f.name}`;
  let input;
  if (f.type === 'select') {
    const opts = f.options();
    input = el('select', { id, name: f.name, required: f.required },
      f.required ? null : el('option', { value: '' }, '—'),
      opts.map((o) => el('option', { value: o.value, selected: o.value === value }, o.label)));
  } else if (f.type === 'textarea') {
    input = el('textarea', { id, name: f.name, rows: 2 });
    input.value = value ?? '';
  } else {
    input = el('input', { id, name: f.name, type: f.type || 'text', required: f.required, placeholder: f.placeholder, list: f.list ? `${id}-list` : null, step: f.type === 'number' ? 'any' : null });
    input.value = value ?? (f.type === 'color' ? '#3559c7' : '');
  }
  return el('div', { class: `field${f.wide || f.type === 'textarea' ? ' wide' : ''}` },
    el('label', { for: id }, f.label),
    input,
    f.list ? el('datalist', { id: `${id}-list` }, f.list.map((v) => el('option', { value: v }))) : null);
}

// Opens the add/edit dialog. Resolves when the dialog closes.
function openForm(name, item = null, defaults = {}) {
  const spec = FORMS[name];
  const dialog = $('#dialog');
  const form = $('#form');
  const values = { ...defaults, ...(item || {}) };
  $('#form-title').textContent = `${item ? 'Editar' : 'Nuevo'} ${spec.title}`;
  $('#form-fields').replaceChildren(...spec.fields.map((f) => fieldInput(f, values[f.name])));
  $('#form-error').hidden = true;
  $('#form-delete').hidden = !item;

  return new Promise((resolve) => {
    const fail = (err) => {
      $('#form-error').textContent = err.message;
      $('#form-error').hidden = false;
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = {};
      for (const f of spec.fields) {
        const v = form.elements[f.name].value.trim();
        body[f.name] = v === '' ? null : f.type === 'number' ? Number(v) : v;
      }
      try {
        await api(item ? 'PUT' : 'POST', item ? `api/${name}/${item.id}` : `api/${name}`, body);
        dialog.close();
      } catch (err) {
        fail(err);
      }
    };
    $('#form-delete').onclick = async () => {
      if (!confirm('¿Borrar este registro?')) return;
      try {
        await api('DELETE', `api/${name}/${item.id}`);
        dialog.close();
      } catch (err) {
        fail(err);
      }
    };
    $('#form-cancel').onclick = () => dialog.close();
    dialog.onclose = async () => {
      await load();
      render();
      resolve();
    };
    dialog.showModal();
  });
}

// ---------- shared pieces ----------
function header(title, ...buttons) {
  return el('div', { class: 'head' }, el('h1', {}, title), buttons);
}
const addButton = (label, name, defaults) =>
  el('button', { class: 'primary', onclick: () => openForm(name, null, typeof defaults === 'function' ? defaults() : defaults) }, `+ ${label}`);

function needsMembers() {
  return el('p', { class: 'empty' }, 'Primero cargá a los integrantes de la familia en ', el('a', { href: '#familia' }, 'Familia'), '.');
}

// Quick action for an agenda event: mark paid / done / applied
function eventAction(e) {
  const toggle = (label, onLabel, fn) =>
    el('button', { class: `small toggle${e.done ? ' on' : ''}`, onclick: async () => { await fn(); await load(); render(); } }, e.done ? `✓ ${onLabel}` : label);
  switch (e.module) {
    case 'payments':
      return toggle('Marcar pagado', 'Pagado', () => api('POST', `api/payments/${e.ref}/paid`, { date: e.date, paid: !e.done }));
    case 'appointments':
      return toggle('Marcar realizado', 'Realizado', () => api('PUT', `api/appointments/${e.ref}`, { status: e.done ? 'pendiente' : 'realizado' }));
    case 'vaccines':
      return toggle('Marcar aplicada', 'Aplicada', () => api('PUT', `api/vaccines/${e.ref}`, { appliedDate: e.done ? null : todayIso() }));
    default:
      return null;
  }
}

function openEvent(e) {
  if (e.module === 'birthdays') return openForm('members', byId('members', e.ref));
  return openForm(e.module, byId(e.module, e.ref));
}

function eventItem(e, { showDate = true } = {}) {
  const late = !e.done && e.date < todayIso() && e.module !== 'appointments' && e.module !== 'birthdays';
  return el('li', { class: `${e.done ? 'done' : ''}${late ? ' late' : ''}` },
    el('span', { class: `dot m-${e.module}`, title: MODULES[e.module] }),
    el('div', {},
      el('button', { class: 'title', onclick: () => openEvent(e) }, e.title),
      el('div', { class: 'when' }, [showDate ? `${fmtDate(e.date)} (${relative(e.date)})` : '', e.time ? ` · ${e.time} h` : ''].join('')),
      e.detail ? el('div', { class: 'detail' }, e.detail) : null),
    el('div', { class: 'right' },
      e.amount != null ? el('span', { class: 'amount' }, money(e.amount, e.currency)) : null,
      eventAction(e)));
}

function eventList(events, empty, opts) {
  return events.length ? el('ul', { class: 'list' }, events.map((e) => eventItem(e, opts))) : el('p', { class: 'empty' }, empty);
}

// ---------- views ----------
async function viewHome() {
  const today = todayIso();
  const [y, m] = ui.month.split('-').map(Number);
  const first = iso(y, m - 1, 1);
  // Grid starts on Monday
  const start = addDays(first, -((parse(first).getUTCDay() + 6) % 7));
  const end = addDays(start, 41);
  const [monthEvents, around] = await Promise.all([
    api('GET', `api/agenda?from=${start}&to=${end}`),
    api('GET', `api/agenda?from=${addDays(today, -365)}&to=${addDays(today, 30)}`),
  ]);
  const late = around.filter((e) => e.date < today && !e.done && ['payments', 'vaccines', 'maintenance'].includes(e.module));
  const upcoming = around.filter((e) => e.date >= today);

  const byDay = new Map();
  for (const e of monthEvents) byDay.set(e.date, [...(byDay.get(e.date) || []), e]);

  const shift = (n) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    ui.month = d.toISOString().slice(0, 7);
    ui.selectedDay = null;
    render();
  };
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i);
    const events = byDay.get(d) || [];
    const cls = ['day', d.slice(0, 7) !== ui.month && 'out', d === today && 'today', d === ui.selectedDay && 'selected'].filter(Boolean).join(' ');
    return el('button', { class: cls, 'aria-label': `${fmtLong(d)}: ${events.length} eventos`, onclick: () => { ui.selectedDay = ui.selectedDay === d ? null : d; render(); } },
      el('span', { class: 'n' }, String(parse(d).getUTCDate())),
      events.slice(0, 3).map((e) => el('span', { class: `chip m-${e.module}${e.done ? ' done' : ''}` }, e.title)),
      events.length > 3 ? el('span', { class: 'more' }, `+${events.length - 3} más`) : null,
      el('span', { class: 'dots' }, events.map((e) => el('span', { class: `dot m-${e.module}` }))));
  });

  const selected = ui.selectedDay
    ? el('section', { class: 'panel' },
        el('h2', {}, fmtLong(ui.selectedDay)),
        eventList(byDay.get(ui.selectedDay) || [], 'Nada para este día.', { showDate: false }))
    : null;

  return [
    el('section', { class: 'panel' },
      el('div', { class: 'cal-head' },
        el('button', { onclick: () => shift(-1), 'aria-label': 'Mes anterior' }, '‹'),
        el('h2', {}, fmtMonth(first)),
        el('button', { onclick: () => { ui.month = today.slice(0, 7); ui.selectedDay = today; render(); } }, 'Hoy'),
        el('button', { onclick: () => shift(1), 'aria-label': 'Mes siguiente' }, '›')),
      el('div', { class: 'cal' },
        ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'].map((d) => el('div', { class: 'dow' }, d)),
        days),
      el('div', { class: 'legend' }, Object.entries(MODULES).map(([k, v]) => el('span', {}, el('span', { class: `dot m-${k}` }), v)))),
    selected,
    el('div', { class: 'grid2' },
      el('section', { class: 'panel' }, el('h2', {}, 'Próximos 30 días'), eventList(upcoming, 'No hay nada agendado.')),
      el('section', { class: 'panel' }, el('h2', {}, 'Atrasado'), eventList(late, 'Todo al día 🎉'))),
  ];
}

function viewAppointments() {
  const today = todayIso();
  const list = db.appointments
    .filter((a) => !ui.memberFilter || a.memberId === ui.memberFilter)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const upcoming = list.filter((a) => a.date >= today && a.status === 'pendiente');
  const past = list.filter((a) => !upcoming.includes(a)).reverse();
  const toEvent = (a) => ({
    module: 'appointments', ref: a.id, date: a.date, time: a.time,
    title: `${a.specialty} — ${memberName(a.memberId)}${a.status === 'cancelado' ? ' (cancelado)' : ''}`,
    detail: [a.doctor, a.place, a.notes].filter(Boolean).join(' · '),
    done: a.status !== 'pendiente',
  });
  const filter = el('select', { onchange: (e) => { ui.memberFilter = e.target.value; render(); }, 'aria-label': 'Filtrar por integrante' },
    el('option', { value: '' }, 'Toda la familia'),
    db.members.map((m) => el('option', { value: m.id, selected: m.id === ui.memberFilter }, m.name)));
  return [
    header('Turnos médicos', db.members.length ? filter : null, db.members.length ? addButton('Nuevo turno', 'appointments', () => ({ memberId: ui.memberFilter, date: today })) : null),
    db.members.length ? null : needsMembers(),
    el('section', { class: 'panel' }, el('h2', {}, 'Próximos'), eventList(upcoming.map(toEvent), 'No hay turnos pendientes.')),
    el('section', { class: 'panel' }, el('h2', {}, 'Anteriores'), eventList(past.map(toEvent), 'Todavía no hay historial.')),
  ];
}

async function viewPayments() {
  const [y, m] = ui.payMonth.split('-').map(Number);
  const first = iso(y, m - 1, 1);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const events = (await api('GET', `api/agenda?from=${first}&to=${last}`)).filter((e) => e.module === 'payments');
  const shift = (n) => {
    ui.payMonth = new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
    render();
  };
  const totals = {};
  for (const e of events) {
    if (e.amount == null) continue;
    const t = (totals[e.currency] ||= { pending: 0, paid: 0 });
    t[e.done ? 'paid' : 'pending'] += e.amount;
  }
  const recurrenceText = (p) => {
    const day = parse(p.date).getUTCDate();
    if (p.recurrence === 'monthly') return `Todos los meses, día ${day}`;
    if (p.recurrence === 'yearly') return `Todos los años, ${fmtLong(p.date).replace(/ de \d{4}$|\s\d{4}$/, '')}`;
    return `Una vez, ${fmtLong(p.date)}`;
  };
  const payments = [...db.payments].sort((a, b) => a.name.localeCompare(b.name));
  return [
    header('Pagos y vencimientos', addButton('Nuevo pago', 'payments', { date: todayIso(), recurrence: 'monthly', currency: 'ARS', category: 'otros' })),
    el('section', { class: 'panel' },
      el('div', { class: 'cal-head' },
        el('button', { onclick: () => shift(-1), 'aria-label': 'Mes anterior' }, '‹'),
        el('h2', {}, fmtMonth(first)),
        el('button', { onclick: () => shift(1), 'aria-label': 'Mes siguiente' }, '›')),
      Object.keys(totals).length
        ? el('div', { class: 'totals' }, Object.entries(totals).flatMap(([cur, t]) => [
            el('div', {}, el('span', { class: 'muted' }, `Falta pagar (${cur})`), el('strong', {}, money(t.pending, cur))),
            el('div', {}, el('span', { class: 'muted' }, `Pagado (${cur})`), el('strong', {}, money(t.paid, cur))),
          ]))
        : null,
      eventList(events, 'No hay vencimientos este mes.')),
    el('section', { class: 'panel' },
      el('h2', {}, 'Pagos configurados'),
      payments.length
        ? el('div', { class: 'scroll' }, el('table', {},
            el('thead', {}, el('tr', {}, el('th', {}, 'Concepto'), el('th', {}, 'Categoría'), el('th', {}, 'Vence'), el('th', { class: 'num' }, 'Monto'))),
            el('tbody', {}, payments.map((p) => el('tr', { class: 'click', onclick: () => openForm('payments', p) },
              el('td', {}, p.name, p.until ? el('div', { class: 'detail' }, `hasta ${fmtLong(p.until)}`) : null),
              el('td', {}, LABELS.category[p.category]),
              el('td', {}, recurrenceText(p)),
              el('td', { class: 'num' }, money(p.amount, p.currency)))))))
        : el('p', { class: 'empty' }, 'Cargá cuotas escolares, servicios, alquiler… y te avisamos antes de cada vencimiento.')),
  ];
}

function viewVaccines() {
  if (!db.members.length) return [header('Vacunas'), needsMembers()];
  if (!byId('members', ui.vaccineMember)) ui.vaccineMember = db.members[0].id;
  const member = byId('members', ui.vaccineMember);
  const today = todayIso();
  const mine = db.vaccines.filter((v) => v.memberId === member.id);
  const pending = mine.filter((v) => !v.appliedDate).sort((a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9'));
  const applied = mine.filter((v) => v.appliedDate).sort((a, b) => b.appliedDate.localeCompare(a.appliedDate));

  const loadPlan = async () => {
    if (!member.birthDate) {
      alert(`Cargá la fecha de nacimiento de ${member.name} en Familia primero.`);
      return;
    }
    const markPastApplied = confirm(
      'Se agregan las vacunas del Calendario Nacional que falten, con la fecha según la edad.\n\n' +
      '¿Marcar como aplicadas las que ya deberían estar dadas? (Aceptar = sí, Cancelar = dejarlas pendientes)');
    try {
      const added = await api('POST', 'api/vaccines/plan', { memberId: member.id, markPastApplied });
      await load(['vaccines']);
      render();
      if (!added.length) alert('Ya estaban todas cargadas.');
    } catch (err) {
      alert(err.message);
    }
  };

  const row = (v) => {
    const late = !v.appliedDate && v.dueDate && v.dueDate < today;
    return el('tr', { class: 'click', onclick: () => openForm('vaccines', v) },
      el('td', {}, el('strong', {}, v.name), v.dose ? el('div', { class: 'detail' }, v.dose) : null),
      el('td', {}, v.appliedDate
        ? `Aplicada ${fmtLong(v.appliedDate)}`
        : v.dueDate ? [fmtLong(v.dueDate), ' ', el('span', { class: `badge${late ? ' late' : ''}` }, relative(v.dueDate))] : 'Sin fecha'),
      el('td', { class: 'num' }, v.appliedDate ? null : el('button', {
        class: 'small',
        onclick: async (e) => {
          e.stopPropagation();
          await api('PUT', `api/vaccines/${v.id}`, { appliedDate: today });
          await load(['vaccines']);
          render();
        },
      }, 'Aplicada hoy')));
  };
  const table = (items, empty) => items.length
    ? el('div', { class: 'scroll' }, el('table', {}, el('tbody', {}, items.map(row))))
    : el('p', { class: 'empty' }, empty);

  return [
    header('Vacunas',
      el('select', { onchange: (e) => { ui.vaccineMember = e.target.value; render(); }, 'aria-label': 'Integrante' },
        db.members.map((m) => el('option', { value: m.id, selected: m.id === member.id }, m.name))),
      el('button', { onclick: loadPlan }, 'Cargar calendario nacional'),
      addButton('Agregar vacuna', 'vaccines', () => ({ memberId: member.id }))),
    el('section', { class: 'panel' }, el('h2', {}, `Pendientes de ${member.name}`), table(pending, 'No hay vacunas pendientes.'),
      el('p', { class: 'note' }, 'El calendario nacional se carga como guía: verificalo con la libreta de vacunación y el pediatra, y ajustá fechas o dosis si hace falta. Fiebre amarilla (solo zonas de riesgo) y otras vacunas indicadas se agregan a mano.')),
    el('section', { class: 'panel' }, el('h2', {}, 'Aplicadas'), table(applied, 'Todavía no hay vacunas registradas.')),
  ];
}

function viewVehicles() {
  if (!db.vehicles.length) {
    return [header('Vehículos', addButton('Nuevo vehículo', 'vehicles')),
      el('p', { class: 'empty' }, 'Cargá el auto de la familia para llevar el registro de services y reparaciones.')];
  }
  return [
    header('Vehículos', addButton('Nuevo vehículo', 'vehicles')),
    db.vehicles.map((v) => {
      const records = db.maintenance.filter((r) => r.vehicleId === v.id).sort((a, b) => b.date.localeCompare(a.date));
      const lastKm = Math.max(0, ...records.map((r) => r.km || 0));
      const spent = records.reduce((s, r) => s + (r.cost || 0), 0);
      const next = records.find((r) => r.nextDate || r.nextKm);
      return el('section', { class: 'panel' },
        el('div', { class: 'head' },
          el('h2', {}, el('button', { class: 'title', onclick: () => openForm('vehicles', v) }, v.name), v.plate ? ` · ${v.plate}` : '', v.year ? ` · ${v.year}` : ''),
          addButton('Registrar visita', 'maintenance', { vehicleId: v.id, date: todayIso() })),
        el('div', { class: 'totals' },
          el('div', {}, el('span', { class: 'muted' }, 'Último kilometraje'), el('strong', {}, lastKm ? km(lastKm) : '—')),
          el('div', {}, el('span', { class: 'muted' }, 'Gastado en total'), el('strong', {}, money(spent))),
          next ? el('div', {}, el('span', { class: 'muted' }, `Próximo ${LABELS.kind[next.kind].toLowerCase()}`),
            el('strong', {}, [next.nextDate ? fmtLong(next.nextDate) : '', next.nextDate && next.nextKm ? ' o ' : '', km(next.nextKm)].join(''))) : null),
        records.length
          ? el('div', { class: 'scroll' }, el('table', {},
              el('thead', {}, el('tr', {}, el('th', {}, 'Fecha'), el('th', {}, 'Tipo'), el('th', {}, 'Detalle'), el('th', { class: 'num' }, 'Km'), el('th', { class: 'num' }, 'Costo'))),
              el('tbody', {}, records.map((r) => el('tr', { class: 'click', onclick: () => openForm('maintenance', r) },
                el('td', {}, fmtLong(r.date)),
                el('td', {}, LABELS.kind[r.kind]),
                el('td', {}, r.description || '', r.workshop ? el('div', { class: 'detail' }, r.workshop) : null),
                el('td', { class: 'num' }, km(r.km)),
                el('td', { class: 'num' }, money(r.cost)))))))
          : el('p', { class: 'empty' }, 'Sin visitas al taller registradas.'));
    }),
  ];
}

async function viewFamily() {
  const settings = await api('GET', 'api/settings');
  // Under a subpath (Home Assistant ingress) the page's own address needs a
  // Home Assistant login, which a phone calendar cannot do: use the direct one
  const proxied = location.pathname !== '/';
  // A public HTTPS address (Cloudflare) also works for iCloud, which fetches
  // subscriptions from Apple's servers: prefer it when there is one
  const href = settings.publicFeedUrl || (proxied && settings.directFeedUrl) || settings.feedPath;
  const url = new URL(href, document.baseURI);
  const webcal = `webcal://${url.host}${url.pathname}`;
  const input = el('input', { readonly: true, value: url.href, onclick: (e) => e.target.select(), 'aria-label': 'Dirección del calendario' });

  const baseInput = el('input', { type: 'url', value: settings.publicFeedBase, placeholder: 'https://familysync.tudominio.com', 'aria-label': 'Dirección pública' });
  const baseError = el('p', { class: 'note error', hidden: true });
  const saveBase = async () => {
    try {
      await api('PUT', 'api/settings', { publicFeedBase: baseInput.value });
      render();
    } catch (err) {
      baseError.textContent = err.message;
      baseError.hidden = false;
    }
  };
  const newToken = async () => {
    if (!confirm('Se genera una dirección nueva y las suscripciones actuales dejan de actualizarse: hay que volver a suscribirse en cada dispositivo. ¿Continuar?')) return;
    await api('POST', 'api/settings/feed-token');
    render();
  };

  return [
    header('Familia', addButton('Agregar integrante', 'members')),
    el('section', { class: 'panel' },
      db.members.length
        ? el('ul', { class: 'list' }, db.members.map((m) => el('li', {},
            el('span', { class: 'dot', style: `background:${m.color || '#3559c7'}` }),
            el('div', {},
              el('button', { class: 'title', onclick: () => openForm('members', m) }, m.name),
              m.birthDate ? el('div', { class: 'when' }, `Nació el ${fmtLong(m.birthDate)}`) : null,
              m.notes ? el('div', { class: 'detail' }, m.notes) : null))))
        : el('p', { class: 'empty' }, 'Agregá a cada integrante de la familia: se usan en turnos médicos y vacunas.')),
    el('section', { class: 'panel' },
      el('h2', {}, 'Recordatorios en el celular'),
      el('p', {}, 'Suscribite a este calendario desde el iPhone, la Mac o Google Calendar: vas a ver todos los turnos, vencimientos, vacunas y services con sus avisos, y se actualiza solo.'),
      el('div', { class: 'feed' },
        input,
        el('button', { onclick: () => copy(input) }, 'Copiar'),
        el('a', { class: 'btn primary', href: webcal }, 'Abrir en Calendario')),
      settings.publicFeedUrl
        ? [
            el('h3', {}, 'En la Mac'),
            el('p', {}, 'Calendario → Archivo → Nueva suscripción a calendario, pegá la dirección y elegí iCloud como ubicación: aparece sola en todos tus dispositivos.'),
            el('h3', {}, 'En el iPhone'),
            el('p', {}, 'Si ya está en iCloud desde la Mac, no hace falta nada. Si no: Ajustes → Apps → Calendario → Cuentas → Agregar cuenta → Otra → Agregar calendario suscrito.'),
            el('p', { class: 'note' }, 'Esta dirección es pública: cualquiera que la tenga puede ver la agenda. Compartila solo con tu familia.'),
          ]
        : [
            el('h3', {}, 'En el iPhone'),
            el('ol', { class: 'steps' },
              el('li', {}, 'Ajustes → Apps → Calendario → Cuentas → Agregar cuenta → Otra.'),
              el('li', {}, 'Elegí "Agregar calendario suscrito" y pegá la dirección.')),
            el('p', { class: 'note' }, 'Funciona mientras el celular llegue a tu Umbrel (en tu casa, o desde afuera con Tailscale). Esta dirección no pide usuario: compartila solo con tu familia.'),
            el('p', { class: 'note' }, 'La Mac guarda las suscripciones en iCloud y las descargan los servidores de Apple, que no llegan a tu Umbrel: para eso configurá una dirección pública abajo.'),
            proxied && !settings.directFeedUrl
              ? el('p', { class: 'note error' }, 'Estás viendo FamilySync a través de otro sitio (por ejemplo Home Assistant): esta dirección pasa por ese sitio y puede pedir login. Para suscribirte, abrí FamilySync directo desde tu Umbrel y copiala desde ahí.')
              : null,
          ]),
    el('section', { class: 'panel' },
      el('h2', {}, 'Dirección pública del calendario'),
      el('p', {}, 'Si publicaste el calendario en internet (por ejemplo con un túnel de Cloudflare al puerto 3745 de tu Umbrel, que solo muestra el calendario), escribí acá su dirección. Así iCloud puede actualizarlo en todos tus dispositivos.'),
      el('div', { class: 'feed' },
        baseInput,
        el('button', { class: 'primary', onclick: saveBase }, 'Guardar')),
      baseError,
      el('p', { class: 'note' }, 'Si la dirección se filtra, generá una nueva: la anterior deja de funcionar.'),
      el('button', { class: 'danger', onclick: newToken }, 'Cambiar dirección secreta')),
  ];
}

// The Clipboard API is blocked inside a cross-origin iframe (Home Assistant)
// and logs an error there, so copy the selected text first and use it only as
// a fallback
async function copy(input) {
  input.select();
  if (document.execCommand('copy')) return;
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    // Left selected for the user to copy by hand
  }
}

function viewSoon(title, text) {
  return [header(title), el('section', { class: 'panel' }, el('p', {}, text), el('p', { class: 'note' }, 'Próximamente.'))];
}

const VIEWS = {
  inicio: { label: 'Inicio', render: viewHome },
  turnos: { label: 'Turnos médicos', render: viewAppointments },
  pagos: { label: 'Pagos', render: viewPayments },
  vacunas: { label: 'Vacunas', render: viewVaccines },
  vehiculos: { label: 'Vehículos', render: viewVehicles },
  compras: { label: 'Compras', soon: true, render: () => viewSoon('Lista de compras', 'La lista de compras se va a sincronizar con una lista de Recordatorios de iOS, para que cualquiera de la familia la complete desde el iPhone.') },
  deportes: { label: 'Deportes', soon: true, render: () => viewSoon('Calendario deportivo', 'Carreras de Fórmula 1 y partidos de Boca Juniors y de la Selección Argentina, con el horario de Argentina.') },
  familia: { label: 'Familia', render: viewFamily },
};

// ---------- router ----------
let renderSeq = 0;
async function render() {
  const key = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'inicio';
  $('#nav').replaceChildren(...Object.entries(VIEWS).map(([k, v]) =>
    el('a', { href: `#${k}`, 'aria-current': k === key ? 'page' : null }, v.label, v.soon ? el('span', { class: 'soon' }, ' pronto') : null)));
  const seq = ++renderSeq;
  try {
    const nodes = await VIEWS[key].render();
    if (seq !== renderSeq) return; // a newer render started meanwhile
    $('#view').replaceChildren(...[nodes].flat(2).filter(Boolean));
  } catch (err) {
    $('#view').replaceChildren(el('p', { class: 'error' }, `No se pudo cargar: ${err.message}`));
  }
}

window.addEventListener('hashchange', () => {
  render();
  $('#view').focus();
});
load().then(render, (err) => $('#view').replaceChildren(el('p', { class: 'error' }, `No se pudo conectar: ${err.message}`)));
