# Compras del Hogar

Busca cada producto de una lista en Mercado Libre, Día, Vea, La Anónima y
Masonline (Chango Más), identifica el mismo producto en cada tienda, vuelve a
verificar el stock y recomienda la opción más barata disponible.

## Cómo funciona

1. **Búsqueda.** Cada línea se busca en todas las tiendas, primero con el texto
   completo y después con versiones más cortas si la tienda no devuelve nada.
   - Día, Vea y Masonline: API pública de catálogo de VTEX.
   - Mercado Libre: página de resultados `listado.mercadolibre.com.ar` (la API
     de búsqueda ahora exige un token OAuth).
   - La Anónima: página `/buscar?clave=…`.
2. **Mismo producto.** `lib/match.js` compara marca y palabras clave (aceptando
   errores de tipeo como "hgienico"), descarta variantes incompatibles
   (simple / doble hoja, entera / descremada…) y exige la misma presentación
   (4 rollos, 100 m, 1 l, 500 g…).
3. **Stock.** Antes de recomendar, se vuelve a consultar cada producto: SKU en
   VTEX, y la página de la publicación (JSON-LD y mensajes como "sin stock" o
   "publicación pausada") en Mercado Libre y La Anónima. Si una opción no tiene
   stock se prueba la siguiente coincidencia de esa tienda. Solo se recomiendan
   productos con stock confirmado.
4. **Plan.** Con la opción más barata de cada producto se arma un carrito por
   supermercado, con su total.

## API

- `POST /api/compare-item` `{ "query": "2 x Leche entera 1 l", "stores": ["dia", "vea"] }`
- `POST /api/compare` `{ "text": "una línea por producto" }` → resultados y carritos
- `GET/PUT /api/list`: lista guardada en `DATA_DIR/list.json`

## Desarrollo

```sh
npm install
npm test
npm start   # http://localhost:3000
```

Variables: `PORT`, `DATA_DIR`, `HTTP_TIMEOUT_MS`, `MATCH_THRESHOLD` (0 a 1,
por defecto 0.7) y `LAANONIMA_COOKIE` (cookie de la sucursal elegida en
laanonima.com.ar, para ver los precios de esa sucursal).
