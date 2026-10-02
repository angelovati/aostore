// End-to-end comparison with every store's HTTP responses faked, shaped like
// what each site returns.
const test = require('node:test');
const assert = require('node:assert');
const { compareItem } = require('../lib/compare');
const ml = require('../lib/stores/mercadolibre');
const la = require('../lib/stores/laanonima');

const QUERY = 'Papel Higiénico Higienol de hoja simple en pack de 4 rollos x 100 m';

function vtexProduct({ id, name, linkText, price, list, qty }) {
  return {
    productId: `p${id}`,
    productName: name,
    brand: 'Higienol',
    linkText,
    link: `https://example/${linkText}/p`,
    items: [
      {
        itemId: String(id),
        nameComplete: name,
        images: [{ imageUrl: `https://img/${id}.jpg` }],
        sellers: [{ sellerId: '1', commertialOffer: { Price: price, ListPrice: list || price, AvailableQuantity: qty, IsAvailable: qty > 0 } }],
      },
    ],
  };
}

const VTEX = {
  'diaonline.supermercadosdia.com.ar': [
    vtexProduct({ id: 297892, name: 'Papel Higiénico Higienol Max Hoja Simple 100 M 4 Ud.', linkText: 'papel-higienico-higienol-max-hoja-simple-100-m-4-ud-297892', price: 3150, qty: 50 }),
    vtexProduct({ id: 297893, name: 'Papel Higiénico Higienol Max Doble Hoja 30 M 4 Ud.', linkText: 'papel-doble', price: 2100, qty: 50 }),
  ],
  'www.vea.com.ar': [
    // In stock in the search index, but sold out when re-checked
    vtexProduct({ id: 111, name: 'Papel Higiénico Higienol Max Hoja Simple 4 Rollos 100 Mts', linkText: 'papel-higienico-higienol-vea', price: 2500, qty: 3 }),
  ],
  'www.masonline.com.ar': [
    vtexProduct({ id: 222, name: 'Papel Hgienico Higienol Hoja Simple 100m 4u', linkText: 'papel-hgienico-higienol-hoja-simple-100m-4u-2', price: 3399, list: 3800, qty: 12 }),
  ],
};

const ML_LISTING = `
<ol>
  <li class="ui-search-layout__item"><div class="poly-card">
    <img data-src="https://http2.mlstatic.com/a.jpg">
    <a class="poly-component__title" href="https://www.mercadolibre.com.ar/papel-higienico-higienol-max-simple-hoja-pack-4-rollos-x-100-m/p/MLA16009085?pdp_filters=shipping%3Afulfillment#polycard_client=search-desktop&amp;position=2">Papel Higiénico Higienol Max Simple Hoja Pack 4 Rollos X 100 M</a>
    <div class="poly-price__current"><span class="andes-money-amount"><span class="andes-money-amount__fraction">3.290</span><span class="andes-money-amount__cents">50</span></span></div>
  </div></li>
  <li class="ui-search-layout__item"><div class="poly-card">
    <a class="poly-component__title" href="https://articulo.mercadolibre.com.ar/MLA-999-papel-higienico-higienol-x-48">Papel Higiénico Higienol Max Hoja Simple 48 Rollos X 30 M</a>
    <div class="poly-price__current"><span class="andes-money-amount"><span class="andes-money-amount__fraction">25.000</span></span></div>
  </div></li>
</ol>`;

const ML_PRODUCT = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Papel Higiénico Higienol","offers":{"@type":"Offer","price":3290.5,"availability":"https://schema.org/InStock"}}</script></head><body><main class="ui-pdp-container"><div class="ui-pdp-buybox">Stock disponible</div></main></body></html>`;

const LA_LISTING = `
<div class="listado">
  <div class="producto">
    <a href="/papel-higienico-higienol-max-hoja-simple-100-m-4-un/art_3060779/" title="Papel Higiénico Higienol Max Hoja Simple 100 m 4 un"><img src="/img/3060779.jpg" alt="Papel Higiénico Higienol Max Hoja Simple 100 m 4 un"></a>
    <div class="precio-anterior">$ 3.500,00</div>
    <div class="precio">$ 2.990<span class="decimales">00</span></div>
  </div>
  <div class="producto">
    <a href="/servilletas-higienol/art_123/">Servilletas Higienol x 70</a>
    <div class="precio">$ 1.200,00</div>
  </div>
</div>`;

const LA_PRODUCT = `<html><body><div id="detalle_producto"><h1>Papel Higiénico Higienol</h1><div class="precio">$ 2.990,00</div><button>Agregar al carrito</button></div><div class="relacionados">Otro producto agotado</div></body></html>`;

function fakeFetch(url) {
  const u = new URL(url);
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const html = (text, status = 200) => new Response(text, { status, headers: { 'Content-Type': 'text/html' } });
  if (VTEX[u.host]) {
    const fq = u.searchParams.get('fq');
    if (fq) {
      const sku = fq.split(':')[1];
      const p = structuredClone(VTEX[u.host].filter((x) => x.items[0].itemId === sku));
      if (u.host === 'www.vea.com.ar') p.forEach((x) => (x.items[0].sellers[0].commertialOffer.AvailableQuantity = 0));
      return json(p);
    }
    return json(VTEX[u.host]);
  }
  if (u.host === 'listado.mercadolibre.com.ar') return html(ML_LISTING);
  if (u.host === 'www.mercadolibre.com.ar') return html(ML_PRODUCT);
  if (u.host === 'www.laanonima.com.ar') return html(u.pathname.startsWith('/buscar') ? LA_LISTING : LA_PRODUCT);
  return html('not found', 404);
}

test('parses Mercado Libre listing and strips tracking', () => {
  const items = ml.parseListing(ML_LISTING);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].id, 'MLA16009085');
  assert.strictEqual(items[0].price, 3290.5);
  assert.strictEqual(
    items[0].url,
    'https://www.mercadolibre.com.ar/papel-higienico-higienol-max-simple-hoja-pack-4-rollos-x-100-m/p/MLA16009085?pdp_filters=shipping%3Afulfillment'
  );
  assert.deepStrictEqual(ml.parseProductPage(ML_PRODUCT), { available: true, price: 3290.5 });
  assert.strictEqual(ml.parseProductPage('<main class="ui-pdp-container"><div class="ui-pdp-buybox">Publicación pausada</div></main>').available, false);
});

test('parses La Anónima listing and product page', () => {
  const items = la.parseListing(LA_LISTING);
  assert.strictEqual(items.length, 2);
  const [p] = items;
  assert.strictEqual(p.id, '3060779');
  assert.strictEqual(p.price, 2990);
  assert.strictEqual(p.listPrice, 3500);
  assert.strictEqual(p.url, 'https://www.laanonima.com.ar/papel-higienico-higienol-max-hoja-simple-100-m-4-un/art_3060779/');
  assert.deepStrictEqual(la.parseProductPage(LA_PRODUCT), { available: true, price: 2990 });
  assert.strictEqual(la.parseProductPage('<div id="detalle_producto">Producto sin stock</div>').available, false);
});

test('recommends the cheapest store with confirmed stock', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => fakeFetch(url));
  const r = await compareItem(QUERY);
  const by = Object.fromEntries(r.results.map((x) => [x.store, x]));

  assert.strictEqual(by.dia.status, 'ok');
  assert.strictEqual(by.dia.match.url, 'https://diaonline.supermercadosdia.com.ar/papel-higienico-higienol-max-hoja-simple-100-m-4-ud-297892/p');
  assert.strictEqual(by.masonline.match.url, 'https://www.masonline.com.ar/papel-hgienico-higienol-hoja-simple-100m-4u-2/p');
  assert.strictEqual(by.mercadolibre.match.id, 'MLA16009085');
  assert.strictEqual(by.laanonima.match.id, '3060779');

  // Vea was the cheapest in the search index but has no stock when re-checked
  assert.strictEqual(by.vea.status, 'out_of_stock');
  assert.match(by.vea.searchUrl, /^https:\/\/www\.vea\.com\.ar\/Papel%20Higi%C3%A9nico.*\?_q=.*&map=ft$/);

  assert.strictEqual(r.best.store, 'laanonima');
  assert.strictEqual(r.best.price, 2990);
  assert.strictEqual(r.saving, 3399 - 2990);
  assert.strictEqual(r.results[0].store, 'laanonima');
});
