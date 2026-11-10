// MCP server (Streamable HTTP, stateless) with the tools Claude uses to read
// and send WhatsApp messages.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const TZ = process.env.TZ || 'UTC';
const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function formatTime(seconds) {
  return seconds ? timeFormat.format(new Date(seconds * 1000)) : null;
}

export const INSTRUCTIONS = `Acceso a la cuenta de WhatsApp del usuario, vinculada como dispositivo (como WhatsApp Web).
- Los chats se identifican por jid: personas "<número>@s.whatsapp.net", grupos "…@g.us". En "to"/"chat" también podés pasar un número con código de país (5491122334455) o el nombre de un contacto o grupo.
- Para reaccionar cuando llegan mensajes usá wait_for_messages en un bucle: devuelve un cursor que tenés que pasar en la siguiente llamada.
- Los mensajes salen desde la cuenta real del usuario: no envíes nada que no te haya pedido o autorizado.
- Horarios en zona ${TZ}.`;

function compactMessage(db, m) {
  if (!m) return null;
  const out = {
    id: m.id,
    time: formatTime(m.timestamp),
    from: m.fromMe ? 'yo' : m.senderName || db.contactName(m.sender) || m.sender,
  };
  if (!m.fromMe && m.sender && m.sender !== m.chatJid) out.sender_jid = m.sender;
  out.type = m.type;
  if (m.deleted) out.deleted = true;
  else if (m.text) out.text = m.text;
  if (m.media) out.media = m.media.name ? `${m.media.mime} ${m.media.name}` : m.media.mime;
  if (m.quotedId) out.reply_to = { id: m.quotedId, text: m.quotedText };
  if (m.edited) out.edited = true;
  if (m.reactions && Object.keys(m.reactions).length) {
    out.reactions = Object.entries(m.reactions).map(([who, emoji]) => `${emoji} ${who === m.chatJid || !db.contactName(who) ? who : db.contactName(who)}`);
  }
  return out;
}

function compactChat(db, c) {
  return {
    chat: c.jid,
    name: c.name,
    group: c.isGroup || undefined,
    unread: c.unread || undefined,
    last_time: formatTime(c.lastTimestamp),
    last_message: c.lastMessage ? (c.lastMessage.fromMe ? 'yo: ' : '') + (c.lastMessage.text || `[${c.lastMessage.type}]`) : undefined,
  };
}

function json(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
}

function fail(err) {
  return { isError: true, content: [{ type: 'text', text: err.message || String(err) }] };
}

function wrap(fn) {
  return async (args) => {
    try {
      return await fn(args || {});
    } catch (err) {
      return fail(err);
    }
  };
}

// Waits until messages newer than `cursor` arrive, or `timeoutMs` passes
export function waitForMessages({ wa, db, cursor, chatJid, timeoutMs, signal }) {
  const pending = db.messagesAfter(cursor, { chatJid });
  if (pending.length) return Promise.resolve(pending);
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      wa.off('incoming', onIncoming);
      signal?.removeEventListener('abort', done);
      resolve(db.messagesAfter(cursor, { chatJid }));
    };
    const onIncoming = ({ message }) => {
      if (!chatJid || message.chatJid === db.canonical(chatJid)) setTimeout(done, 300); // let a burst arrive together
    };
    wa.on('incoming', onIncoming);
    signal?.addEventListener('abort', done);
    timer = setTimeout(done, timeoutMs);
  });
}

export function createMcpServer({ wa, db, settings }) {
  const server = new McpServer(
    { name: 'whatsapp', title: 'WhatsApp (WaBridge)', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  const ensureWritable = () => {
    if (settings().mcpReadOnly) throw new Error('La app está en modo solo lectura para MCP: no se pueden enviar mensajes ni reacciones. Se cambia en Ajustes de WaBridge.');
  };
  const chatJidOf = async (chat) => wa.resolveRecipient(chat);

  server.registerTool('whatsapp_status', {
    title: 'Estado de WhatsApp',
    description: 'Indica si la cuenta está vinculada y conectada, y con qué número.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, wrap(async () => json({
    ...wa.publicState(),
    qr: undefined,
    read_only: !!settings().mcpReadOnly,
    cursor: db.lastSeq(),
    ...db.stats(),
  })));

  server.registerTool('list_chats', {
    title: 'Listar chats',
    description: 'Chats ordenados del más reciente al más viejo, con el último mensaje y los no leídos.',
    inputSchema: {
      query: z.string().optional().describe('Filtra por nombre del chat/contacto o número'),
      unread_only: z.boolean().optional().describe('Solo chats con mensajes sin leer'),
      limit: z.number().int().min(1).max(200).optional().describe('Máximo de chats (20 por defecto)'),
      offset: z.number().int().min(0).optional(),
    },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ query, unread_only: unreadOnly, limit = 20, offset = 0 }) => json(
    db.listChats({ query, unreadOnly, limit, offset }).map((c) => compactChat(db, c)),
  )));

  server.registerTool('get_messages', {
    title: 'Leer mensajes de un chat',
    description: 'Últimos mensajes de un chat, del más viejo al más nuevo. Para ver más atrás, pasá en "before" el campo "time" del mensaje más viejo recibido.',
    inputSchema: {
      chat: z.string().describe('jid, número o nombre del chat'),
      limit: z.number().int().min(1).max(500).optional().describe('Cantidad de mensajes (30 por defecto)'),
      before: z.string().optional().describe('Solo mensajes anteriores a esta fecha/hora (ISO, p. ej. 2026-11-10 14:30)'),
    },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ chat, limit = 30, before }) => {
    const jid = await chatJidOf(chat);
    let beforeTs;
    if (before) {
      const t = Date.parse(before.includes('T') || /[zZ]|[+-]\d\d:?\d\d$/.test(before) ? before : before.replace(' ', 'T'));
      if (Number.isNaN(t)) throw new Error('Fecha inválida en "before"');
      beforeTs = Math.floor(t / 1000);
    }
    const info = db.getChat(jid);
    return json({
      chat: jid,
      name: info?.name || jid,
      messages: db.getMessages(jid, { limit, before: beforeTs }).filter((m) => m.type !== 'reaction').map((m) => compactMessage(db, m)),
    });
  }));

  server.registerTool('search_messages', {
    title: 'Buscar mensajes',
    description: 'Busca texto en los mensajes guardados (todos los chats o uno).',
    inputSchema: {
      query: z.string().min(1),
      chat: z.string().optional().describe('Limitar la búsqueda a este chat'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ query, chat, limit = 30 }) => {
    const jid = chat ? await chatJidOf(chat) : undefined;
    return json(db.searchMessages(query, { chatJid: jid, limit }).map((m) => ({
      chat: m.chatJid, chat_name: db.getChat(m.chatJid)?.name, ...compactMessage(db, m),
    })));
  }));

  server.registerTool('search_contacts', {
    title: 'Buscar contactos',
    description: 'Busca contactos por nombre o número y devuelve su jid.',
    inputSchema: { query: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ query }) => json(db.searchContacts(query, 30))));

  server.registerTool('send_message', {
    title: 'Enviar mensaje',
    description: 'Envía un mensaje de texto desde la cuenta del usuario. Admite *negrita*, _cursiva_ y ~tachado~ de WhatsApp.',
    inputSchema: {
      to: z.string().describe('jid, número con código de país o nombre exacto del chat'),
      text: z.string().min(1),
      reply_to_message_id: z.string().optional().describe('id del mensaje a citar/responder'),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, wrap(async ({ to, text, reply_to_message_id: replyTo }) => {
    ensureWritable();
    const sent = await wa.sendText(to, text, { replyTo });
    return json({ sent: true, chat: sent?.chatJid, id: sent?.id, time: formatTime(sent?.timestamp) });
  }));

  server.registerTool('react_to_message', {
    title: 'Reaccionar a un mensaje',
    description: 'Pone una reacción con emoji a un mensaje. Con emoji vacío la quita.',
    inputSchema: {
      chat: z.string(),
      message_id: z.string(),
      emoji: z.string().describe('Un emoji, p. ej. 👍 ❤️ 😂; vacío para quitar la reacción'),
    },
    annotations: { openWorldHint: true },
  }, wrap(async ({ chat, message_id: id, emoji }) => {
    ensureWritable();
    await wa.react(chat, id, emoji);
    return json({ ok: true });
  }));

  server.registerTool('mark_as_read', {
    title: 'Marcar como leído',
    description: 'Marca como leídos los mensajes de un chat (se ven los tildes azules).',
    inputSchema: { chat: z.string() },
    annotations: { openWorldHint: true },
  }, wrap(async ({ chat }) => {
    ensureWritable();
    await wa.markRead(await chatJidOf(chat));
    return json({ ok: true });
  }));

  server.registerTool('wait_for_messages', {
    title: 'Esperar mensajes nuevos',
    description: 'Devuelve los mensajes recibidos después de "cursor"; si no hay, espera hasta que llegue alguno o pase el tiempo. Sin cursor arranca desde ahora. Pasá el "cursor" devuelto en la siguiente llamada para no perder ni repetir mensajes.',
    inputSchema: {
      cursor: z.number().int().min(0).optional(),
      chat: z.string().optional().describe('Solo mensajes de este chat'),
      timeout_seconds: z.number().int().min(0).max(600).optional().describe('Cuánto esperar (60 por defecto, máximo 600)'),
    },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ cursor, chat, timeout_seconds: timeout = 60 }, extra) => {
    const jid = chat ? await chatJidOf(chat) : undefined;
    const from = cursor ?? db.lastSeq();
    const messages = await waitForMessages({ wa, db, cursor: from, chatJid: jid, timeoutMs: timeout * 1000, signal: extra?.signal });
    const next = messages.length ? messages[messages.length - 1].seq : from;
    return json({
      cursor: next,
      messages: messages.map((m) => ({ chat: m.chatJid, chat_name: db.getChat(m.chatJid)?.name, ...compactMessage(db, m) })),
    });
  }));

  server.registerTool('get_media', {
    title: 'Ver foto o archivo',
    description: 'Descarga la foto, sticker, audio, video o documento de un mensaje. Las imágenes se devuelven para que las puedas ver.',
    inputSchema: { chat: z.string(), message_id: z.string() },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ chat, message_id: id }) => {
    const jid = await chatJidOf(chat);
    const { buffer, mime, fileName } = await wa.downloadMedia(jid, id);
    if (buffer.length > 15 * 1024 * 1024) throw new Error(`El archivo pesa ${(buffer.length / 1048576).toFixed(1)} MB, demasiado para devolverlo`);
    const base = mime.split(';')[0];
    if (/^image\/(jpeg|png|webp|gif)$/.test(base)) {
      return { content: [{ type: 'image', data: buffer.toString('base64'), mimeType: base }] };
    }
    if (base.startsWith('audio/')) {
      return { content: [{ type: 'audio', data: buffer.toString('base64'), mimeType: base }] };
    }
    return {
      content: [{
        type: 'resource',
        resource: { uri: `whatsapp://media/${encodeURIComponent(jid)}/${encodeURIComponent(id)}${fileName ? `/${encodeURIComponent(fileName)}` : ''}`, mimeType: base, blob: buffer.toString('base64') },
      }],
    };
  }));

  return server;
}

// Handles one HTTP request to the MCP endpoint
export async function handleMcpRequest(req, res, deps) {
  const server = createMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
