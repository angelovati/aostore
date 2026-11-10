# WaBridge

Cliente de WhatsApp Web para umbrelOS, con servidor MCP para que Claude lea,
busque y envíe mensajes, y reaccione a los que llegan.

Se vincula a la cuenta como un dispositivo más (igual que WhatsApp Web) usando
[Baileys](https://github.com/WhiskeySockets/Baileys), que habla el protocolo de
WhatsApp Web directamente: no hay un navegador corriendo en el Umbrel.

## Vincular la cuenta

Abrí la app en umbrelOS y escaneá el QR desde el teléfono, en
**WhatsApp → Dispositivos vinculados → Vincular un dispositivo**. También se
puede vincular con el número de teléfono: la app muestra un código de 8
caracteres para ingresar en el teléfono.

El código de vinculación no llega por SMS: aparece en la app y se ingresa en
el teléfono en *Dispositivos vinculados → Vincular un dispositivo → Vincular
con el número de teléfono*.

Si el QR no aparece, la pantalla muestra por qué WhatsApp cerró la conexión.
WhatsApp rechaza (error 405) a los clientes que anuncian una versión vieja de
WhatsApp Web, así que al conectar la app lee la versión actual de
`web.whatsapp.com` y recuerda la última que funcionó. Con `WA_VERSION`
(por ejemplo `2.3000.1234567890`) se puede forzar una.

Después de vincular, el teléfono envía el historial reciente; los chats van
apareciendo a medida que llega. La sesión queda guardada en `DATA_DIR/auth` y
los mensajes en `DATA_DIR/wabridge.db` (SQLite). Si el dispositivo se quita
desde el teléfono, la app borra todo y vuelve a mostrar el QR.

## Conectar Claude (MCP)

En **⚙ Ajustes** está la dirección del servidor MCP, con un token secreto:

```
http://umbrel.local:3751/mcp/<token>
```

El puerto `3751` responde solo a `/mcp/<token>` y `/channel/<token>/…`, sin el
login de umbrelOS. Quien tenga la dirección puede usar tu WhatsApp; si se
filtra, generá otra desde Ajustes. El token también se acepta como
`Authorization: Bearer <token>`.

- **Claude Code**:

  ```bash
  claude mcp add --transport http whatsapp http://umbrel.local:3751/mcp/<token>
  ```

- **Claude Desktop**: con [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)
  en `claude_desktop_config.json` (la app muestra el bloque para copiar).
- **claude.ai** (web y celular): necesita una dirección pública con https.
  Publicá el puerto 3751 con un túnel (Cloudflare Tunnel, Tailscale Funnel) y
  agregalo en *Ajustes → Conectores → Agregar conector personalizado* como
  `https://<tu-túnel>/mcp/<token>`.

### Herramientas

| Herramienta | Qué hace |
|---|---|
| `whatsapp_status` | Si la cuenta está conectada, con qué número, cuántos chats y mensajes hay guardados |
| `list_chats` | Chats del más reciente al más viejo, con no leídos; filtro por nombre o número |
| `get_messages` | Mensajes de un chat; `before` para ir más atrás |
| `search_messages` | Busca texto en todos los chats o en uno |
| `search_contacts` | Busca contactos por nombre o número |
| `send_message` | Envía un texto, opcionalmente citando otro mensaje |
| `react_to_message` | Pone o quita una reacción con emoji |
| `mark_as_read` | Marca un chat como leído |
| `wait_for_messages` | Espera mensajes nuevos (long polling con cursor) |
| `get_media` | Descarga la foto, audio o documento de un mensaje; las imágenes las ve Claude |

En `chat`/`to` se puede pasar el jid (`5491122334455@s.whatsapp.net`,
`…@g.us`), un número con código de país o el nombre de un contacto o grupo.

Con **Solo lectura** en Ajustes, Claude no puede enviar mensajes, reacciones
ni marcar como leído.

### Reaccionar a los mensajes que llegan

Hay tres formas:

1. **`wait_for_messages`**: Claude la llama en un bucle y recibe cada mensaje
   nuevo cuando llega. Sirve con cualquier cliente MCP, por ejemplo pidiéndole
   a Claude Code *"esperá mensajes de WhatsApp y respondé los de Juan"*.

2. **Channel de Claude Code**: los mensajes entran solos en la sesión abierta
   de Claude Code, sin que Claude tenga que preguntar. Los channels son una
   función en vista previa de Claude Code y solo funcionan por stdio, así que
   se usa un puente: [`channel/whatsapp-channel.mjs`](channel/whatsapp-channel.mjs),
   un archivo sin dependencias (Node 18+) que también se descarga desde Ajustes.
   En el `.mcp.json` del proyecto:

   ```json
   {
     "mcpServers": {
       "whatsapp": {
         "command": "node",
         "args": ["/ruta/a/whatsapp-channel.mjs", "http://umbrel.local:3751/channel/<token>"]
       }
     }
   }
   ```

   y se inicia Claude Code con:

   ```bash
   claude --dangerously-load-development-channels server:whatsapp
   ```

   Cada mensaje llega como `<channel source="whatsapp" chat_id="…" sender="…"
   sender_name="…" message_id="…">texto</channel>` y Claude responde con las
   herramientas `reply`, `react`, `mark_read` y `fetch_messages`. Opciones del
   puente: `--no-groups` ignora los grupos y `--only 5491122334455,…@g.us`
   escucha solo esos números o grupos. Conviene usar `--only`: cualquiera que
   te escriba le estaría escribiendo a Claude.

3. **Webhook**: cada mensaje recibido se envía por POST en JSON a la URL
   configurada en Ajustes (n8n, Home Assistant, un script que lance
   `claude -p`…). El cuerpo se firma con HMAC-SHA256 y la firma va en
   `X-WaBridge-Signature: sha256=<hex>`.

   ```json
   {
     "event": "message",
     "chat": { "jid": "5491122334455@s.whatsapp.net", "name": "Juan", "isGroup": false },
     "message": { "id": "3EB0…", "fromMe": false, "sender": "5491122334455@s.whatsapp.net",
                  "senderName": "Juan", "timestamp": 1794271610, "time": "2026-11-10 12:26:50",
                  "type": "text", "text": "¿Venís a cenar?" }
   }
   ```

## Cómo funciona

- `lib/whatsapp.js`: conexión con Baileys, QR / código de vinculación,
  reconexión, y los eventos de WhatsApp (historial, mensajes, reacciones,
  ediciones, borrados, chats, contactos, grupos).
- `lib/parse.js`: convierte los mensajes de WhatsApp en filas para la base.
- `lib/db.js`: SQLite (`node:sqlite`). WhatsApp identifica a una persona por
  su teléfono o por un id opaco (`…@lid`); cuando se conoce el par, los chats
  se unifican bajo el teléfono. El mensaje original se guarda para poder
  citarlo, reaccionar y descargar sus archivos después.
- `lib/mcp.js`: servidor MCP (Streamable HTTP, sin estado).
- `server.js`: API para la interfaz web, eventos en vivo (SSE), webhook,
  puerto MCP y las rutas `/channel/<token>/…` del puente.
- `public/`: interfaz web; usa solo URLs relativas.

## Desarrollo

```bash
npm install
npm start          # http://localhost:3000, MCP_PORT para el puerto MCP aparte
npm test
```

Los tests simulan el socket de WhatsApp (`test/fake-socket.js`) y prueban la
API, el servidor MCP con el cliente oficial, el webhook y el puente del
channel.

Variables: `PORT` (3000), `MCP_PORT` (sin definir: no abre el segundo puerto),
`MCP_PUBLIC_PORT` (puerto publicado en el host, para la dirección que muestra
Ajustes), `DATA_DIR`, `TZ`, `BAILEYS_LOG_LEVEL` (`warn`), `WA_VERSION`.

## Aviso

WaBridge no es una app oficial de WhatsApp. Enviar mensajes masivos o spam
puede hacer que WhatsApp bloquee el número.
