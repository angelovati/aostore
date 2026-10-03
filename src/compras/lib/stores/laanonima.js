// La Anónima runs its own e-commerce platform. Product URLs look like
// /papel-higienico-higienol-max-hoja-simple-100-m-4-un/art_3060779/
// Prices depend on the selected branch (sucursal); set LAANONIMA_COOKIE with
// the cookie your browser gets after choosing one to see that branch's prices.
const { getHtml, parsePriceAR } = require('../http');
const { productFromJsonLd, textLooksOutOfStock, cheerio } = require('./html');

const BASE = 'https://www.laanonima.com.ar';
const ART_RE = /\/art_(\d+)\/?/;

function headers() {
  return process.env.LAANONIMA_COOKIE ? { Cookie: process.env.LAANONIMA_COOKIE } : {};
}

function slugTitle(href) {
  const m = href.match(/\/([^/]+)\/art_\d+/);
  return m ? m[1].replace(/-/g, ' ') : '';
}

// The listing markup is not documented, so find every product link and read
// name and price from the smallest surrounding block that shows a price.
function parseListing(html) {
  const $ = cheerio.load(html);
  const byId = new Map();
  $('a[href*="/art_"]').each((_, a) => {
    const href = $(a).attr('href');
    const m = href && href.match(ART_RE);
    if (!m) return;
    const id = m[1];
    let box = $(a);
    for (let i = 0; i < 6 && box.length; i++) {
      if (/\$\s*\d/.test(box.text())) break;
      box = box.parent();
    }
    // If the block grew to contain several products, it's a list wrapper: skip price
    const ids = new Set(box.find('a[href*="/art_"]').map((_, x) => ($(x).attr('href').match(ART_RE) || [])[1]).get());
    const own = ids.size <= 1;
    const title =
      $(a).attr('title') || $(a).find('img').attr('alt') || $(a).text().trim() || slugTitle(href);
    const prev = byId.get(id) || { id };
    if (!prev.title || title.length > prev.title.length) prev.title = title.replace(/\s+/g, ' ').trim();
    prev.url = new URL(href, BASE).toString().replace(/[?#].*$/, '');
    if (own) {
      const text = box.text().replace(/\s+/g, ' ');
      const prices = [...text.matchAll(/\$\s*\d[\d.]*(?:,\d{1,2})?(?:\s\d{2}\b)?/g)].map((p) =>
        parsePriceAR(p[0].replace(/\s(\d{2})$/, ',$1'))
      );
      const valid = prices.filter((p) => p && p > 0);
      if (valid.length && !prev.price) {
        // Promo blocks show the old price first; the lowest is what you pay
        prev.price = Math.min(...valid);
        prev.listPrice = valid.length > 1 ? Math.max(...valid) : null;
      }
      if (prev.available === undefined) prev.available = textLooksOutOfStock(text) ? false : prev.price ? true : null;
      const img = box.find('img').first();
      prev.image = prev.image || img.attr('data-src') || img.attr('src');
    }
    byId.set(id, prev);
  });
  return [...byId.values()]
    .filter((c) => c.title)
    .map((c) => ({
      store: 'laanonima',
      id: c.id,
      title: c.title,
      price: c.price || null,
      listPrice: c.listPrice && c.listPrice > c.price ? c.listPrice : null,
      available: c.available ?? null,
      url: c.url,
      image: c.image && new URL(c.image, BASE).toString(),
      ref: { url: c.url },
    }));
}

function parseProductPage(html) {
  const $ = cheerio.load(html);
  const ld = productFromJsonLd($);
  const detail = $('#detalle_producto, .detalle-producto, .producto-detalle, main').first();
  const scope = detail.length ? detail : $('body');
  // Ignore "related products" carousels when looking for stock messages
  const text = scope.clone().find('[class*="relacionad"], [class*="carrusel"], [class*="carousel"]').remove().end().text();
  let available = ld ? ld.available : null;
  if (textLooksOutOfStock(text)) available = false;
  else if (available === null && /agregar|comprar|añadir/i.test(scope.find('button, a.btn, input[type=submit]').text())) {
    available = true;
  }
  let price = ld && ld.price;
  if (!price) {
    const meta = $('meta[itemprop="price"], meta[property="product:price:amount"]').attr('content');
    price = meta ? parseFloat(meta) : parsePriceAR((text.match(/\$\s*\d[\d.]*(?:,\d{1,2})?/) || [])[0]);
  }
  return { available, price: price || null };
}

module.exports = {
  id: 'laanonima',
  name: 'La Anónima',
  color: '#e30613',
  searchUrl: (query) => `${BASE}/buscar?pag=1&clave=${encodeURIComponent(query)}`,
  async search(query) {
    const { status, html } = await getHtml(`${BASE}/buscar?pag=1&clave=${encodeURIComponent(query)}`, { headers: headers() });
    if (status >= 400) throw new Error(`HTTP ${status} en laanonima`);
    return parseListing(html);
  },
  async validate(candidate) {
    const { status, html } = await getHtml(candidate.ref.url, { headers: headers() });
    if (status === 404) return { available: false, detail: 'El producto ya no está publicado' };
    if (status >= 400) throw new Error(`HTTP ${status}`);
    const page = parseProductPage(html);
    return {
      available: page.available,
      price: page.price || candidate.price,
      detail: page.available === true ? 'Stock confirmado' : page.available === false ? 'Sin stock' : 'No se pudo confirmar el stock',
    };
  },
  parseListing,
  parseProductPage,
};
