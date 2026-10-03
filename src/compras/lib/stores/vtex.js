// Día, Vea and Masonline (Chango Más) run on VTEX, which exposes a public
// catalog API with price and stock per SKU and seller.
const { getJson } = require('../http');

function bestOffer(item) {
  const offers = (item.sellers || []).map((s) => ({ seller: s, offer: s.commertialOffer || {} }));
  const available = offers.filter((o) => o.offer.AvailableQuantity > 0 && o.offer.Price > 0);
  const pool = available.length ? available : offers;
  pool.sort((a, b) => (a.offer.Price || Infinity) - (b.offer.Price || Infinity));
  return pool[0];
}

function toCandidates(store, products) {
  const out = [];
  for (const p of products || []) {
    for (const item of p.items || []) {
      const best = bestOffer(item);
      if (!best) continue;
      const { offer } = best;
      out.push({
        store: store.id,
        id: String(item.itemId),
        title: item.nameComplete || p.productName || item.name,
        brand: p.brand,
        price: offer.Price || null,
        listPrice: offer.ListPrice && offer.ListPrice > offer.Price ? offer.ListPrice : null,
        available: offer.AvailableQuantity > 0 && offer.IsAvailable !== false && offer.Price > 0,
        url: p.linkText ? `${store.baseUrl}/${p.linkText}/p` : p.link,
        image: item.images && item.images[0] && item.images[0].imageUrl,
        ref: { skuId: String(item.itemId), productId: String(p.productId) },
      });
    }
  }
  return out;
}

function createVtexStore({ id, name, baseUrl, color }) {
  const store = { id, name, baseUrl, color };

  store.searchUrl = (query) => `${baseUrl}/${encodeURIComponent(query)}?_q=${encodeURIComponent(query)}&map=ft`;

  store.search = async (query) => {
    const url = `${baseUrl}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(query)}&_from=0&_to=29`;
    let products;
    try {
      products = await getJson(url);
    } catch (err) {
      // Some VTEX IO stores only answer the intelligent-search endpoint
      const is = await getJson(
        `${baseUrl}/api/io/_v/api/intelligent-search/product_search/?query=${encodeURIComponent(query)}&count=30&locale=es-AR`
      ).catch(() => null);
      if (!is) throw err;
      products = is.products;
    }
    return toCandidates(store, products);
  };

  // Re-read the SKU right before recommending it: search indexes lag behind stock.
  store.validate = async (candidate) => {
    const url = `${baseUrl}/api/catalog_system/pub/products/search?fq=skuId:${encodeURIComponent(candidate.ref.skuId)}`;
    const products = await getJson(url);
    const fresh = toCandidates(store, products).find((c) => c.id === candidate.ref.skuId);
    if (!fresh) return { available: false, detail: 'El producto ya no está publicado' };
    return {
      available: fresh.available,
      price: fresh.price,
      listPrice: fresh.listPrice,
      detail: fresh.available ? 'Stock confirmado' : 'Sin stock',
    };
  };

  return store;
}

module.exports = { createVtexStore, toCandidates };
