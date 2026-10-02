const test = require('node:test');
const assert = require('node:assert');
const { scoreTitle, extractMeasures, parseListLine, searchVariants } = require('../lib/match');
const { parsePriceAR } = require('../lib/http');
const { MATCH_THRESHOLD } = require('../lib/compare');

const QUERY = 'Papel Higiénico Higienol de hoja simple en pack de 4 rollos x 100 m';

test('matches the same product across all stores', () => {
  const titles = [
    'Papel Higiénico Higienol Max Simple Hoja Pack 4 Rollos X 100 M', // Mercado Libre
    'Papel Higiénico Higienol Max Hoja Simple 100 M 4 Ud.', // Día
    'Papel Higienico Higienol Max Hoja Simple 100 m 4 un', // La Anónima
    'Papel Hgienico Higienol Hoja Simple 100m 4u', // Masonline (typo included)
    'Papel Higiénico Higienol Max Hoja Simple 4 Rollos 100 Mts', // Vea
  ];
  for (const t of titles) {
    const { score, reasons } = scoreTitle(QUERY, t);
    assert.ok(score >= MATCH_THRESHOLD, `${t} → ${score} ${reasons}`);
  }
});

test('rejects different presentations or variants', () => {
  const titles = [
    'Papel Higiénico Higienol Max Doble Hoja Pack 4 Rollos X 100 M',
    'Papel Higiénico Higienol Max Hoja Simple 30 M 4 Ud.',
    'Papel Higiénico Higienol Max Hoja Simple 100 M 8 Ud.',
    'Rollo de cocina Higienol 3 x 50 paños',
  ];
  for (const t of titles) assert.ok(scoreTitle(QUERY, t).score < MATCH_THRESHOLD, t);
});

test('extracts measures in base units', () => {
  assert.deepStrictEqual(extractMeasures(QUERY), { count: 4, length: 100 });
  assert.deepStrictEqual(extractMeasures('Leche entera 1,5 L'), { volume: 1500 });
  assert.deepStrictEqual(extractMeasures('Yerba Playadito 500g'), { weight: 500 });
  assert.deepStrictEqual(extractMeasures('Detergente pack x 3'), { count: 3 });
});

test('parses quantities in list lines', () => {
  assert.deepStrictEqual(parseListLine('2 x Leche entera 1 l'), { quantity: 2, query: 'Leche entera 1 l' });
  assert.deepStrictEqual(parseListLine('3 Yerba Playadito 1 kg'), { quantity: 3, query: 'Yerba Playadito 1 kg' });
  assert.deepStrictEqual(parseListLine('1 l de leche'), { quantity: 1, query: '1 l de leche' });
  assert.deepStrictEqual(parseListLine('500 g de yerba'), { quantity: 1, query: '500 g de yerba' });
});

test('search variants go from specific to broad', () => {
  const v = searchVariants(QUERY);
  assert.strictEqual(v[0], 'papel higienico higienol de hoja simple en pack de 4 rollos x 100 m');
  assert.ok(v.includes('papel higienico higienol'));
});

test('parses Argentine prices', () => {
  assert.strictEqual(parsePriceAR('$ 1.234,56'), 1234.56);
  assert.strictEqual(parsePriceAR('$2.899'), 2899);
  assert.strictEqual(parsePriceAR('$ 1.23456'), 1234.56);
  assert.strictEqual(parsePriceAR('899,90'), 899.9);
  assert.strictEqual(parsePriceAR('sin precio'), null);
});
