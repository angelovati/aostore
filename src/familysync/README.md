# FamilySync

Agenda familiar para umbrelOS: turnos médicos, pagos y vencimientos, vacunas,
mantenimiento del auto y cumpleaños, en un calendario que se puede suscribir
desde el iPhone, la Mac o Google Calendar.

## Módulos

| Módulo | Estado |
|---|---|
| Turnos médicos | ✅ |
| Pagos y vencimientos (únicos, mensuales o anuales) | ✅ |
| Vacunas, con el Calendario Nacional de Vacunación como plantilla | ✅ |
| Mantenimiento de vehículos | ✅ |
| Lista de compras sincronizada con Recordatorios de iOS | Próximamente |
| Calendario deportivo (F1, Boca Juniors, Selección Argentina) | Próximamente |

## Cómo funciona

- Los datos se guardan en `DATA_DIR/familysync.json` (escritura atómica).
- `lib/agenda.js` arma una única lista de eventos con todos los módulos. Los
  pagos recurrentes se expanden por mes o año; uno del día 31 vence el último
  día de los meses más cortos. Los vencimientos anteriores a la fecha en que se
  cargó el pago no se cuentan como atrasados.
- `lib/ics.js` publica esa agenda como iCalendar en `/cal/<token>.ics`, con
  avisos: turnos un día y dos horas antes; pagos dos días antes y el mismo día;
  vacunas y services una semana antes. Lo ya hecho sigue en el calendario con
  un ✓, sin avisos.
- El token del feed se genera la primera vez y reemplaza al login de umbrelOS
  para esa ruta (`PROXY_AUTH_WHITELIST` en el `docker-compose.yml`), porque la
  app de calendario del celular no puede iniciar sesión.

## Detrás de un proxy (Home Assistant)

La app funciona servida en una subruta cualquiera por un proxy que quita ese
prefijo antes de reenviar, como el ingress de Home Assistant
(`https://mi-ha/api/ingress/<nombre>/`):

- El frontend usa solo URLs relativas (`api/…`, `styles.css`, `cal/…`) y el
  routing es por hash. `test/subpath.test.js` falla si aparece una ruta
  absoluta.
- Si se abre la subruta sin barra final, `index.html` la agrega antes de
  cargar nada.
- No se envían `X-Frame-Options` ni CSP, no hay redirects ni cookies, así que
  se puede embeber en un iframe.
- Abierta a través del proxy, la sección Familia muestra el calendario con la
  dirección directa (`FEED_BASE_URL`), porque la del proxy pide el login de
  Home Assistant y el celular no puede hacerlo.

### Configuración en Home Assistant

En umbrelOS la app escucha en dos puertos:

- `3743`: el de siempre, con el login de umbrelOS.
- `3744`: directo al contenedor, sin login, para Home Assistant. hass_ingress
  pide la app desde el servidor de HA, que no tiene la sesión de Umbrel, así
  que por `3743` recibiría la pantalla de login. Cualquiera en la red local
  puede abrir este puerto.

Con [hass_ingress](https://github.com/lovelylain/hass_ingress) instalado desde
HACS, en `configuration.yaml`:

```yaml
ingress:
  familysync:
    title: FamilySync
    icon: mdi:calendar-heart
    url: http://192.168.0.104:3744
```

Para probarlo localmente:

```sh
npm start                                                         # :3000
node scripts/subpath-proxy.js http://127.0.0.1:3000 8099 /prueba/subpath/
# http://127.0.0.1:8099/prueba/subpath/  y  http://127.0.0.1:8099/iframe.html
```

## API

- `GET|POST /api/<colección>`, `PUT|DELETE /api/<colección>/<id>` para
  `members`, `appointments`, `payments`, `vehicles`, `maintenance` y `vaccines`
  (`PUT` actualiza solo los campos enviados).
- `GET /api/agenda?from=AAAA-MM-DD&to=AAAA-MM-DD`: eventos de todos los módulos.
- `POST /api/payments/<id>/paid` `{ "date": "2026-10-10", "paid": true }`
- `POST /api/vaccines/plan` `{ "memberId": "…", "markPastApplied": true }`:
  agrega las vacunas del calendario nacional que falten.
- `GET /api/settings`: ruta relativa del feed de calendario y, si está
  configurada, su dirección directa.

## Desarrollo

```sh
npm test
npm start   # http://localhost:3000
```

Variables: `PORT`, `DATA_DIR`, `TZ` (por defecto `America/Argentina/Buenos_Aires`)
y `FEED_BASE_URL` (dirección directa de la app, por ejemplo
`http://umbrel.local:3743/`).
