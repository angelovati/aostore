const $ = (sel, el = document) => el.querySelector(sel);
const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
const fmt = (n) => (n == null ? '—' : money.format(n));

const state = { stores: [], items: [] };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function selectedStores() {
  return [...document.querySelectorAll('#stores input:checked')].map((i) => i.value);
}

async function init() {
  const [stores, list] = await Promise.all([api('GET', '/api/stores'), api('GET', '/api/list')]);
  state.stores = stores;
  $('#list').value = list.text || '';
  const enabled = list.stores || stores.map((s) => s.id);
  for (const s of stores) {
    $('#stores').append(
      el('label', {}, el('input', { type: 'checkbox', value: s.id, checked: enabled.includes(s.id) }), s.name)
    );
  }
  $('#compare').addEventListener('click', run);
}

const STATUS = {
  ok: ['stock-in', '✔ En stock'],
  unverified: ['stock-unknown', '? Stock sin confirmar'],
  out_of_stock: ['stock-out', '✖ Sin stock'],
  no_match: ['stock-out', 'No se encontró el mismo producto'],
  error: ['stock-error', 'No se pudo consultar'],
};

function renderRow(r, isBest) {
  const m = r.match;
  const [cls, label] = STATUS[r.status];
  const usable = r.status === 'ok' || r.status === 'unverified';
  const title = m
    ? el('div', { class: 'title' },
        el('a', { href: m.url, target: '_blank', rel: 'noopener' }, m.title),
        el('small', { class: cls }, `${label}${m.stockDetail && r.status !== 'ok' && !label.includes(m.stockDetail) ? ` — ${m.stockDetail}` : ''}`))
    : el('div', { class: 'title' }, el('small', { class: cls }, r.status === 'error' ? `${label}: ${r.error}` : r.detail || label));
  const price = el('div', { class: 'price' },
    m && usable ? [
      m.listPrice ? el('s', {}, fmt(m.listPrice)) : null,
      el('strong', {}, fmt(m.price)),
      m.unitPrice ? el('small', {}, `${fmt(m.unitPrice.value)} / ${m.unitPrice.label}`) : null,
    ] : '');
  const button = m
    ? el('a', { class: `btn${isBest ? ' primary' : ''}`, href: m.url, target: '_blank', rel: 'noopener' }, 'Ver publicación')
    : el('a', { class: 'btn', href: r.searchUrl, target: '_blank', rel: 'noopener' }, 'Buscar en la tienda');
  return el('div', { class: `row${isBest ? ' best' : ''}${usable ? '' : ' muted'}` },
    el('div', { class: 'store' }, el('span', { class: 'dot', style: `background:${r.color}` }), r.storeName),
    title, price, button);
}

function renderItem(item) {
  const node = $('#item-tpl').content.firstElementChild.cloneNode(true);
  $('h2', node).textContent = item.quantity > 1 ? `${item.quantity} × ${item.query}` : item.query;
  const badge = $('.badge', node);
  if (item.best) {
    badge.hidden = false;
    badge.textContent = `Comprar en ${item.best.storeName}${item.saving ? ` · ahorrás ${fmt(item.saving)}` : ''}`;
  }
  for (const r of item.results) $('.rows', node).append(renderRow(r, item.best && r.store === item.best.store));
  return node;
}

function renderPlan() {
  const carts = {};
  const missing = [];
  let total = 0;
  for (const it of state.items) {
    if (!it.best) { missing.push(it.query); continue; }
    const c = (carts[it.best.store] ||= { name: it.best.storeName, lines: [], subtotal: 0 });
    const lineTotal = it.best.price * it.quantity;
    c.lines.push({ ...it.best, quantity: it.quantity, total: lineTotal });
    c.subtotal += lineTotal;
    total += lineTotal;
  }
  const plan = $('#plan');
  plan.replaceChildren(el('h2', {}, 'Dónde armar cada carrito'));
  for (const c of Object.values(carts).sort((a, b) => b.subtotal - a.subtotal)) {
    plan.append(el('div', { class: 'cart' },
      el('h3', {}, el('span', {}, c.name), el('span', {}, fmt(c.subtotal))),
      el('ul', {}, c.lines.map((l) => el('li', {},
        `${l.quantity} × `, el('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.title), ` — ${fmt(l.total)}`)))));
  }
  plan.append(el('div', { class: 'total' }, el('span', {}, 'Total'), el('span', {}, fmt(total))));
  if (missing.length) {
    plan.append(el('p', { class: 'missing' }, `Sin opción con stock confirmado: ${missing.join(', ')}`));
  }
  plan.hidden = false;
}

async function run() {
  const text = $('#list').value;
  const stores = selectedStores();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const btn = $('#compare');
  btn.disabled = true;
  state.items = [];
  $('#results').replaceChildren();
  $('#plan').hidden = true;
  api('PUT', '/api/list', { text, stores }).catch(() => {});

  let done = 0;
  const status = $('#status');
  status.textContent = `Buscando 0 de ${lines.length}…`;
  const slots = lines.map(() => $('#results').appendChild(el('div')));
  let next = 0;
  async function worker() {
    while (next < lines.length) {
      const i = next++;
      try {
        const item = await api('POST', '/api/compare-item', { query: lines[i], stores });
        state.items[i] = item;
        slots[i].replaceWith(renderItem(item));
      } catch (err) {
        slots[i].replaceWith(el('article', { class: 'item' }, el('h2', {}, lines[i]), el('p', { class: 'stock-error' }, err.message)));
      }
      status.textContent = `Buscando ${++done} de ${lines.length}…`;
    }
  }
  await Promise.all([worker(), worker()]);
  state.items = state.items.filter(Boolean);
  renderPlan();
  status.textContent = `Listo · ${new Date().toLocaleTimeString('es-AR')}`;
  btn.disabled = false;
}

init().catch((err) => { $('#status').textContent = err.message; });
