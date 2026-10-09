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

## API

- `GET|POST /api/<colección>`, `PUT|DELETE /api/<colección>/<id>` para
  `members`, `appointments`, `payments`, `vehicles`, `maintenance` y `vaccines`
  (`PUT` actualiza solo los campos enviados).
- `GET /api/agenda?from=AAAA-MM-DD&to=AAAA-MM-DD`: eventos de todos los módulos.
- `POST /api/payments/<id>/paid` `{ "date": "2026-10-10", "paid": true }`
- `POST /api/vaccines/plan` `{ "memberId": "…", "markPastApplied": true }`:
  agrega las vacunas del calendario nacional que falten.
- `GET /api/settings`: ruta del feed de calendario.

## Desarrollo

```sh
npm test
npm start   # http://localhost:3000
```

Variables: `PORT`, `DATA_DIR` y `TZ` (por defecto `America/Argentina/Buenos_Aires`).
