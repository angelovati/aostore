// Mercado Libre: the public search API now requires an OAuth token, so we read
// the regular search listing (listado.mercadolibre.com.ar) instead.
const { getHtml, parsePriceAR } = require('../http');
const { normalize } = require('../match');
const { productFromJsonLd, textLooksOutOfStock, cheerio } = require('./html');

const BASE = 'https://listado.mercadolibre.com.ar';

function slug(query) {
  return normalize(query).replace(/\./g, '').replace(/\s+/g, '-');
}

// Remove tracking fragments/params so links stay short and stable.
function cleanUrl(href) {
  try {
    const u = new URL(href, 'https://www.mercadolibre.com.ar');
    if (u.hostname.startsWith('click')) return href; // ads redirect, keep as-is
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (k !== 'pdp_filters') u.searchParams.delete(k);
    return u.toString();
  } catch {
    return href;
  }
}

function priceIn($, el) {
  const box = $(el).find('.poly-price__current, .ui-search-price__second-line, .andes-money-amount').first();
  const amount = box.is('.andes-money-amount') ? box : box.find('.andes-money-amount').first();
  const fraction = amount.find('.andes-money-amount__fraction').first().text();
  if (!fraction) return null;
  const cents = amount.find('.andes-money-amount__cents').first().text();
  return parsePriceAR(`${fraction}${cents ? `,${cents}` : ''}`);
}

function parseListing(html) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('li.ui-search-layout__item, .poly-card, .ui-search-result').each((_, el) => {
    const link = $(el).find('a.poly-component__title, a.ui-search-item__group__element, a.ui-search-link').first();
    const href = link.attr('href');
    const title = (link.text() || $(el).find('.ui-search-item__title').first().text()).trim();
    if (!href || !title) return;
    const url = cleanUrl(href);
    const id = (url.match(/MLA-?\d+/i) || [url])[0].replace('-', '').toUpperCase();
    if (seen.has(id)) return;
    seen.add(id);
    const price = priceIn($, el);
    const prev = $(el).find('s.andes-money-amount--previous .andes-money-amount__fraction, .andes-money-amount--previous .andes-money-amount__fraction').first().text();
    out.push({
      store: 'mercadolibre',
      id,
      title,
      price,
      listPrice: prev ? parsePriceAR(prev) : null,
      // Listing shows only active publications; stock is confirmed in validate()
      available: price !== null ? true : null,
      url,
      image: $(el).find('img').first().attr('data-src') || $(el).find('img').first().attr('src'),
      ref: { url },
    });
  });
  return out;
}

function parseProductPage(html) {
  const $ = cheerio.load(html);
  const ld = productFromJsonLd($);
  const main = $('.ui-pdp-container, #ui-pdp-main-container, main').first();
  const buyText = (main.length ? main : $('body')).find('.ui-pdp-buybox, .ui-pdp-stock-information, .ui-pdp-container__row--stock-information, .ui-pdp-message').text();
  const hasBuyButton = $('form.ui-pdp-actions__container, button.andes-button--loud, [data-testid="buy-now-button"]')
    .text()
    .match(/comprar|agregar al carrito/i);
  let available = ld ? ld.available : null;
  if (textLooksOutOfStock(buyText)) available = false;
  else if (available === null && hasBuyButton) available = true;
  let price = ld && ld.price;
  if (!price) {
    const meta = $('meta[itemprop="price"]').attr('content');
    price = meta ? parseFloat(meta) : priceIn($, $('.ui-pdp-price__second-line').first());
  }
  return { available, price: price || null };
}

module.exports = {
  id: 'mercadolibre',
  name: 'Mercado Libre',
  color: '#ffe600',
  searchUrl: (query) => `${BASE}/${slug(query)}`,
  async search(query) {
    const { status, html } = await getHtml(`${BASE}/${slug(query)}`);
    if (status >= 400) throw new Error(`HTTP ${status} en mercadolibre`);
    return parseListing(html);
  },
  async validate(candidate) {
    const { status, html } = await getHtml(candidate.ref.url);
    if (status === 404) return { available: false, detail: 'La publicación ya no existe' };
    if (status >= 400) throw new Error(`HTTP ${status}`);
    const page = parseProductPage(html);
    return {
      available: page.available,
      price: page.price || candidate.price,
      detail: page.available === true ? 'Stock confirmado' : page.available === false ? 'Sin stock / pausada' : 'No se pudo confirmar el stock',
    };
  },
  parseListing,
  parseProductPage,
  cleanUrl,
};
