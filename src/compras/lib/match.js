// Text normalization and "same product" matching between a free-text query
// (e.g. "Papel Higiénico Higienol de hoja simple en pack de 4 rollos x 100 m")
// and the product titles each store returns.

const STOPWORDS = new Set([
  'de', 'del', 'en', 'el', 'la', 'los', 'las', 'con', 'sin', 'para', 'por', 'y',
  'a', 'al', 'x', 'pack', 'paquete', 'un', 'una', 'unidad', 'unidades', 'u', 'ud',
  'uds', 'un', 'unid', 'rollo', 'rollos', 'hoja', 'hojas', 'max', 'tipo', 'marca',
]);

// Words that cannot both be true for the same product. If the query says one
// and the title says another from the same group, it is a different product.
const EXCLUSIVE = [
  ['simple', 'doble', 'triple'],
  ['entera', 'descremada', 'semidescremada'],
  ['light', 'regular', 'clasica', 'clasico'],
  ['sin', 'con'],
];

const UNIT_ALIASES = [
  // [regex for the unit, measure key, multiplier to base unit]
  [/^(m|mt|mts|metro|metros)$/, 'length', 1],
  [/^(cm)$/, 'length', 0.01],
  [/^(g|gr|grs|gramo|gramos)$/, 'weight', 1],
  [/^(kg|kgs|kilo|kilos)$/, 'weight', 1000],
  [/^(ml|cc|cm3)$/, 'volume', 1],
  [/^(l|lt|lts|litro|litros)$/, 'volume', 1000],
  [/^(u|un|und|ud|uds|unid|unidad|unidades|rollo|rollos|sobres?|saquitos?|pañales|panales|capsulas?)$/, 'count', 1],
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/(\d)\.(?!\d)/g, '$1')
    .replace(/(^|\s)\.+|\.+(\s|$)/g, ' ')
    // split "100m", "4u", "x4", "1.5l" into number + unit
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function unitOf(word) {
  for (const [re, key, mult] of UNIT_ALIASES) if (re.test(word)) return { key, mult };
  return null;
}

// Extracts quantities like "4 rollos", "pack x 4", "100 m", "1.5 l" into
// { count: 4, length: 100, volume: 1500, ... } in base units.
function extractMeasures(text) {
  const words = normalize(text).split(' ');
  const measures = {};
  for (let i = 0; i < words.length; i++) {
    if (!/^\d+(\.\d+)?$/.test(words[i])) continue;
    const value = parseFloat(words[i]);
    const next = words[i + 1];
    const unit = next && unitOf(next);
    if (unit) {
      if (measures[unit.key] === undefined) measures[unit.key] = round(value * unit.mult);
      continue;
    }
    // "pack x 4", "pack de 4", "x 4" followed by nothing measurable
    const prev = words[i - 1];
    const prev2 = words[i - 2];
    if (prev === 'x' || prev === 'pack' || (prev === 'de' && prev2 === 'pack')) {
      if (measures.count === undefined) measures.count = value;
    }
  }
  return measures;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function significantTokens(text) {
  const tokens = normalize(text).split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d/.test(t)) continue;
    if (STOPWORDS.has(t) && !EXCLUSIVE.some((g) => g.includes(t))) continue;
    if (unitOf(t) && /^\d/.test(tokens[i - 1] || '')) continue;
    if (t.length < 2) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function tokenMatches(q, t) {
  if (q === t) return true;
  // plural / singular
  if (q.replace(/e?s$/, '') === t.replace(/e?s$/, '')) return true;
  // typos like "hgienico" vs "higienico"
  if (q.length >= 5 && t.length >= 5 && levenshtein(q, t) <= 1) return true;
  return false;
}

// Returns { score: 0..1, reasons: [] }. Score 0 means "definitely a different product".
function scoreTitle(query, title) {
  const qTokens = significantTokens(query);
  const tTokens = significantTokens(title);
  const reasons = [];

  for (const group of EXCLUSIVE) {
    const inQ = group.filter((w) => qTokens.includes(w));
    const inT = group.filter((w) => tTokens.includes(w));
    if (inQ.length && inT.length && !inQ.some((w) => inT.includes(w))) {
      return { score: 0, reasons: [`"${inQ[0]}" ≠ "${inT[0]}"`] };
    }
  }

  const qm = extractMeasures(query);
  const tm = extractMeasures(title);
  let measurePenalty = 0;
  for (const key of Object.keys(qm)) {
    if (tm[key] === undefined) {
      measurePenalty += 0.1;
      reasons.push(`sin ${key}`);
    } else if (Math.abs(tm[key] - qm[key]) > qm[key] * 0.02) {
      return { score: 0, reasons: [`${key} ${tm[key]} ≠ ${qm[key]}`] };
    }
  }

  if (!qTokens.length) return { score: 0, reasons: ['consulta vacía'] };
  let hits = 0;
  for (const q of qTokens) {
    if (tTokens.some((t) => tokenMatches(q, t))) hits++;
    else reasons.push(`falta "${q}"`);
  }
  const recall = hits / qTokens.length;
  // Titles stuffed with many extra words are usually a different product/combo.
  const extra = tTokens.filter((t) => !qTokens.some((q) => tokenMatches(q, t))).length;
  const extraPenalty = Math.min(0.15, extra * 0.02);
  const score = Math.max(0, recall - measurePenalty - extraPenalty);
  return { score: round(score), reasons };
}

// Queries to send to store search engines, from most to least specific.
// Store search boxes often return nothing for long natural-language phrases.
function searchVariants(query) {
  const tokens = significantTokens(query).filter((t) => !EXCLUSIVE.some((g) => g.includes(t)));
  const variants = [];
  const full = normalize(query);
  variants.push(full);
  if (tokens.length) variants.push(tokens.join(' '));
  if (tokens.length > 3) variants.push(tokens.slice(0, 3).join(' '));
  return [...new Set(variants)];
}

// Parse "2 x Leche entera 1 l" / "3 Yerba..." into { quantity, query }.
function parseListLine(line) {
  const trimmed = String(line || '').trim();
  const m = trimmed.match(/^(\d{1,2})\s*(?:x\s+|\s+)(\D.*)$/i);
  // Don't eat a leading size like "1 l de leche" or "500 g de yerba"
  if (m && !unitOf(normalize(m[2]).split(' ')[0])) {
    return { quantity: parseInt(m[1], 10), query: m[2].trim() };
  }
  return { quantity: 1, query: trimmed };
}

module.exports = {
  normalize,
  extractMeasures,
  significantTokens,
  scoreTitle,
  searchVariants,
  parseListLine,
};
