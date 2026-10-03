// Helpers for stores without a public API: read product data from the
// schema.org JSON-LD that product pages embed for search engines.
const cheerio = require('cheerio');

function jsonLdNodes($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const n = stack.shift();
        if (!n || typeof n !== 'object') continue;
        nodes.push(n);
        if (Array.isArray(n['@graph'])) stack.push(...n['@graph']);
      }
    } catch {
      // ignore malformed blocks
    }
  });
  return nodes;
}

function isType(node, type) {
  const t = node['@type'];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

// Returns { name, price, available } from the Product JSON-LD, or null.
function productFromJsonLd(html) {
  const $ = typeof html === 'string' ? cheerio.load(html) : html;
  const product = jsonLdNodes($).find((n) => isType(n, 'Product'));
  if (!product) return null;
  let offers = product.offers;
  if (Array.isArray(offers)) offers = offers[0];
  if (offers && isType(offers, 'AggregateOffer') && offers.offers) {
    offers = Array.isArray(offers.offers) ? offers.offers[0] : offers.offers;
  }
  const availability = offers && String(offers.availability || '');
  const price = offers && parseFloat(offers.price ?? offers.lowPrice);
  return {
    name: product.name,
    price: Number.isFinite(price) ? price : null,
    available: availability ? /InStock|LimitedAvailability|OnlineOnly/i.test(availability) : null,
  };
}

const OUT_OF_STOCK_PATTERNS = [
  /sin stock/i,
  /agotado/i,
  /no (?:hay|tenemos) stock/i,
  /publicaci[oó]n pausada/i,
  /producto no disponible/i,
  /no est[aá] disponible/i,
];

function textLooksOutOfStock(text) {
  return OUT_OF_STOCK_PATTERNS.some((re) => re.test(text));
}

module.exports = { productFromJsonLd, textLooksOutOfStock, cheerio };
