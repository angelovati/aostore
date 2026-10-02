const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  'Accept-Language': 'es-AR,es;q=0.9',
};

const TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '15000', 10);

async function request(url, { headers = {}, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    body,
    headers: { ...DEFAULT_HEADERS, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res;
}

async function getJson(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  // VTEX answers 206 Partial Content for paginated searches
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} en ${new URL(url).host}`);
  return res.json();
}

async function getHtml(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: 'text/html,application/xhtml+xml', ...opts.headers } });
  const text = await res.text();
  return { status: res.status, url: res.url || url, html: text };
}

// "$ 1.234,56" / "1.234" / "$1.23456" (cents rendered in a separate tag) -> number
function parsePriceAR(text) {
  if (typeof text === 'number') return text;
  const m = String(text || '').replace(/\s+/g, '').match(/\$?(\d[\d.]*)(?:,(\d{1,2}))?/);
  if (!m) return null;
  const groups = m[1].split('.');
  let cents = m[2] || '';
  const last = groups[groups.length - 1];
  if (groups.length > 1 && last.length > 3) {
    // "1.23456": thousands group "234" followed by glued cents "56"
    groups[groups.length - 1] = last.slice(0, 3);
    cents = cents || last.slice(3, 5);
  } else if (groups.length === 2 && last.length <= 2 && !m[2]) {
    // "1234.50" written with a decimal point
    cents = last;
    groups.pop();
  }
  const n = parseFloat(`${groups.join('')}.${cents || '0'}`);
  return Number.isFinite(n) ? n : null;
}

module.exports = { request, getJson, getHtml, parsePriceAR };
