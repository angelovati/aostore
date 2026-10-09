const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDate, today } = require('./dates');

// Field specs: type, required, allowed values, and references to other collections
const SCHEMAS = {
  members: {
    name: { type: 'string', required: true },
    birthDate: { type: 'date' },
    color: { type: 'string' },
    notes: { type: 'string' },
  },
  appointments: {
    memberId: { type: 'ref', ref: 'members', required: true },
    date: { type: 'date', required: true },
    time: { type: 'time' },
    specialty: { type: 'string', required: true },
    doctor: { type: 'string' },
    place: { type: 'string' },
    notes: { type: 'string' },
    status: { type: 'enum', values: ['pendiente', 'realizado', 'cancelado'], default: 'pendiente' },
  },
  payments: {
    name: { type: 'string', required: true },
    category: { type: 'enum', values: ['escuela', 'servicios', 'vivienda', 'impuestos', 'seguros', 'tarjetas', 'otros'], default: 'otros' },
    amount: { type: 'number' },
    currency: { type: 'enum', values: ['ARS', 'USD'], default: 'ARS' },
    date: { type: 'date', required: true },
    recurrence: { type: 'enum', values: ['once', 'monthly', 'yearly'], default: 'monthly' },
    until: { type: 'date' },
    notes: { type: 'string' },
    paid: { type: 'dates', default: [] },
  },
  vehicles: {
    name: { type: 'string', required: true },
    plate: { type: 'string' },
    year: { type: 'number' },
    notes: { type: 'string' },
  },
  maintenance: {
    vehicleId: { type: 'ref', ref: 'vehicles', required: true },
    date: { type: 'date', required: true },
    kind: { type: 'enum', values: ['service', 'reparacion', 'neumaticos', 'vtv', 'otro'], default: 'service' },
    km: { type: 'number' },
    workshop: { type: 'string' },
    cost: { type: 'number' },
    description: { type: 'string' },
    nextDate: { type: 'date' },
    nextKm: { type: 'number' },
  },
  vaccines: {
    memberId: { type: 'ref', ref: 'members', required: true },
    name: { type: 'string', required: true },
    dose: { type: 'string' },
    dueDate: { type: 'date' },
    appliedDate: { type: 'date' },
    place: { type: 'string' },
    notes: { type: 'string' },
  },
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function coerce(field, spec, value) {
  if (value == null || value === '') return undefined;
  switch (spec.type) {
    case 'string':
    case 'ref':
      return String(value).trim().slice(0, 2000) || undefined;
    case 'number': {
      const n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
      if (!Number.isFinite(n)) throw badRequest(`"${field}" debe ser un número`);
      return n;
    }
    case 'date':
      if (!isDate(value)) throw badRequest(`"${field}" debe ser una fecha AAAA-MM-DD`);
      return value;
    case 'time':
      if (!TIME_RE.test(value)) throw badRequest(`"${field}" debe ser una hora HH:MM`);
      return value;
    case 'enum':
      if (!spec.values.includes(value)) throw badRequest(`"${field}" no admite el valor "${value}"`);
      return value;
    case 'dates':
      if (!Array.isArray(value) || !value.every(isDate)) throw badRequest(`"${field}" debe ser una lista de fechas`);
      return [...new Set(value)].sort();
    default:
      throw new Error(`Tipo desconocido ${spec.type}`);
  }
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'familysync.json');
    this.dir = dir;
    this.data = this.load();
  }

  load() {
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const name of Object.keys(SCHEMAS)) data[name] = Array.isArray(data[name]) ? data[name] : [];
    data.settings = data.settings || {};
    // Secret part of the calendar feed URL, which skips the umbrelOS login
    if (!data.settings.feedToken) {
      data.settings.feedToken = crypto.randomBytes(18).toString('base64url');
      this.data = data;
      this.save();
    }
    return data;
  }

  // Write to a temp file and rename, so a crash never leaves half a file
  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  collection(name) {
    if (!SCHEMAS[name]) throw Object.assign(new Error('Colección desconocida'), { status: 404 });
    return this.data[name];
  }

  get(name, id) {
    const item = this.collection(name).find((x) => x.id === id);
    if (!item) throw Object.assign(new Error('No encontrado'), { status: 404 });
    return item;
  }

  validate(name, input, base = {}) {
    const schema = SCHEMAS[name];
    const out = { id: base.id, createdAt: base.createdAt };
    for (const [field, spec] of Object.entries(schema)) {
      const raw = Object.hasOwn(input, field) ? input[field] : base[field];
      let value = coerce(field, spec, raw);
      if (value === undefined && spec.default !== undefined) value = structuredClone(spec.default);
      if (value === undefined) {
        if (spec.required) throw badRequest(`Falta "${field}"`);
        continue;
      }
      if (spec.type === 'ref' && !this.data[spec.ref].some((x) => x.id === value)) {
        throw badRequest(`"${field}" apunta a un registro que no existe`);
      }
      out[field] = value;
    }
    return out;
  }

  create(name, input) {
    const item = this.validate(name, input, { id: crypto.randomUUID(), createdAt: today() });
    this.collection(name).push(item);
    this.save();
    return item;
  }

  // Partial update: fields not sent keep their value
  update(name, id, input) {
    const list = this.collection(name);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw Object.assign(new Error('No encontrado'), { status: 404 });
    list[i] = this.validate(name, input, list[i]);
    this.save();
    return list[i];
  }

  remove(name, id) {
    this.get(name, id);
    for (const [other, schema] of Object.entries(SCHEMAS)) {
      for (const [field, spec] of Object.entries(schema)) {
        if (spec.ref === name && this.data[other].some((x) => x[field] === id)) {
          throw Object.assign(new Error('Tiene registros asociados; borralos primero'), { status: 409 });
        }
      }
    }
    this.data[name] = this.data[name].filter((x) => x.id !== id);
    this.save();
  }
}

module.exports = { Store, SCHEMAS };
