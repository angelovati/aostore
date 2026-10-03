const { stores: allStores } = require('./stores');
const { scoreTitle, searchVariants, extractMeasures } = require('./match');

const MATCH_THRESHOLD = parseFloat(process.env.MATCH_THRESHOLD || '0.7');
const MAX_VALIDATIONS = 3;
const SEARCH_TTL_MS = 10 * 60 * 1000;

const searchCache = new Map();

async function cachedSearch(store, query) {
  const key = `${store.id}|${query}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.value;
  const value = await store.search(query);
  searchCache.set(key, { at: Date.now(), value });
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
  return value;
}

function unitPrice(query, candidate) {
  // Price per base unit of the query's main measure, for display only
  const m = extractMeasures(candidate.title);
  if (!candidate.price) return null;
  for (const key of ['weight', 'volume', 'length']) {
    if (m[key]) {
      const total = m[key] * (m.count || 1);
      const per = key === 'length' ? 1 : 1000;
      const label = { weight: 'kg', volume: 'l', length: 'm' }[key];
      return { value: (candidate.price / total) * per, label };
    }
  }
  return null;
}

async function findInStore(store, query) {
  const found = new Map();
  const errors = [];
  for (const variant of searchVariants(query)) {
    try {
      for (const c of await cachedSearch(store, variant)) {
        if (found.has(c.id)) continue;
        found.set(c.id, { ...c, ...scoreTitle(query, c.title) });
      }
    } catch (err) {
      errors.push(err.message);
    }
    if ([...found.values()].some((c) => c.score >= MATCH_THRESHOLD)) break;
  }

  const result = { store: store.id, storeName: store.name, color: store.color, searchUrl: store.searchUrl(query) };
  if (!found.size && errors.length) return { ...result, status: 'error', error: errors[0] };

  const matches = [...found.values()]
    .filter((c) => c.score >= MATCH_THRESHOLD && c.price)
    .sort((a, b) => b.score - a.score || a.price - b.price);
  if (!matches.length) return { ...result, status: 'no_match' };

  // Among equally good matches prefer the cheapest; then confirm stock live.
  const top = matches.filter((c) => c.score >= matches[0].score - 0.05).sort((a, b) => a.price - b.price);
  const queue = [...top, ...matches.filter((c) => !top.includes(c))].filter((c) => c.available !== false);
  const checked = [];
  for (const c of queue.slice(0, MAX_VALIDATIONS)) {
    let v;
    try {
      v = await store.validate(c);
    } catch (err) {
      v = { available: null, detail: `No se pudo verificar: ${err.message}` };
    }
    const item = {
      ...c,
      price: v.price || c.price,
      listPrice: v.listPrice !== undefined ? v.listPrice : c.listPrice,
      stock: v.available === true ? 'in' : v.available === false ? 'out' : 'unknown',
      stockDetail: v.detail,
    };
    item.unitPrice = unitPrice(query, item);
    delete item.ref;
    checked.push(item);
    if (item.stock === 'in') break;
  }
  const outOfStockInSearch = matches.filter((c) => c.available === false).length;
  const best = checked.find((c) => c.stock === 'in') || checked.find((c) => c.stock === 'unknown') || checked[0];
  if (!best) {
    return { ...result, status: 'out_of_stock', detail: `${outOfStockInSearch} coincidencia(s), todas sin stock` };
  }
  return {
    ...result,
    status: best.stock === 'in' ? 'ok' : best.stock === 'out' ? 'out_of_stock' : 'unverified',
    match: best,
    discarded: checked.filter((c) => c !== best).map(({ title, url, stockDetail }) => ({ title, url, stockDetail })),
  };
}

async function compareItem(query, { storeIds } = {}) {
  const stores = allStores.filter((s) => !storeIds || storeIds.includes(s.id));
  const results = await Promise.all(stores.map((s) => findInStore(s, query)));
  // Only products with confirmed stock can be recommended.
  const buyable = results.filter((r) => r.status === 'ok').sort((a, b) => a.match.price - b.match.price);
  const best = buyable[0] || null;
  const worst = buyable[buyable.length - 1];
  return {
    query,
    results: results.sort((a, b) => rank(a) - rank(b)),
    best: best && { store: best.store, storeName: best.storeName, price: best.match.price, url: best.match.url, title: best.match.title },
    saving: best && worst && worst !== best ? worst.match.price - best.match.price : 0,
  };
}

function rank(r) {
  const order = { ok: 0, unverified: 1, out_of_stock: 2, no_match: 3, error: 4 };
  return order[r.status] * 1e12 + (r.match ? r.match.price : 0);
}

// Builds one cart per store from the cheapest in-stock option of each item.
function buildPlan(items) {
  const carts = {};
  const missing = [];
  let total = 0;
  for (const it of items) {
    if (!it.best) {
      missing.push(it.query);
      continue;
    }
    const cart = (carts[it.best.store] ||= { store: it.best.store, storeName: it.best.storeName, items: [], subtotal: 0 });
    const line = { query: it.query, title: it.best.title, url: it.best.url, quantity: it.quantity, price: it.best.price };
    line.total = line.price * line.quantity;
    cart.items.push(line);
    cart.subtotal += line.total;
    total += line.total;
  }
  return { carts: Object.values(carts).sort((a, b) => b.subtotal - a.subtotal), total, missing };
}

module.exports = { compareItem, buildPlan, findInStore, MATCH_THRESHOLD };
