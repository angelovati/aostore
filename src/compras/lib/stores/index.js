const { createVtexStore } = require('./vtex');
const mercadolibre = require('./mercadolibre');
const laanonima = require('./laanonima');

const stores = [
  mercadolibre,
  createVtexStore({ id: 'dia', name: 'Día', baseUrl: 'https://diaonline.supermercadosdia.com.ar', color: '#e2001a' }),
  createVtexStore({ id: 'vea', name: 'Vea', baseUrl: 'https://www.vea.com.ar', color: '#0a5fa8' }),
  laanonima,
  createVtexStore({ id: 'masonline', name: 'Masonline (Chango Más)', baseUrl: 'https://www.masonline.com.ar', color: '#00953a' }),
];

module.exports = { stores, byId: Object.fromEntries(stores.map((s) => [s.id, s])) };
