// WaBridge: WhatsApp Web client for umbrelOS with an MCP server for Claude.
//
// PORT      web app + API (behind the umbrelOS login) and /mcp/<token>
// MCP_PORT  only /mcp/<token> and /channel/<token>/… for MCP clients on the
//           local network or behind a tunnel; everything else is 404
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from './lib/db.js';
import { WhatsApp } from './lib/whatsapp.js';
import { handleMcpRequest, waitForMessages, formatTime } from './lib/mcp.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = parseInt(process.env.PORT || '3000', 10);
const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : null;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
// Port MCP_PORT is published at on the host, for the address shown in the app
const MCP_PUBLIC_PORT = process.env.MCP_PUBLIC_PORT || '';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readBuffer(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw httpError(413, 'Pedido demasiado grande');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const data = (await readBuffer(req, 1e6)).toString('utf8');
  try {
    return data ? JSON.parse(data) : {};
  } catch {
    throw httpError(400, 'JSON inválido');
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function createApp({ dataDir = DATA_DIR, makeSocket, fetchVersion, autoStart = true } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Db(path.join(dataDir, 'wabridge.db'));
  const wa = new WhatsApp({ db, authDir: path.join(dataDir, 'auth'), makeSocket, fetchVersion });

  const DEFAULTS = { mcpToken: null, mcpReadOnly: false, webhookUrl: '', webhookSecret: '', webhookGroups: true };
  const settings = () => ({ ...DEFAULTS, ...db.getKv('settings', {}) });
  const saveSettings = (patch) => db.setKv('settings', { ...settings(), ...patch });
  if (!settings().mcpToken) saveSettings({ mcpToken: crypto.randomBytes(24).toString('base64url') });
  if (!settings().webhookSecret) saveSettings({ webhookSecret: crypto.randomBytes(18).toString('base64url') });

  const publicSettings = () => {
    const s = settings();
    return {
      mcpToken: s.mcpToken,
      mcpReadOnly: s.mcpReadOnly,
      mcpPublicPort: MCP_PUBLIC_PORT,
      webhookUrl: s.webhookUrl,
      webhookSecret: s.webhookSecret,
      webhookGroups: s.webhookGroups,
    };
  };

  // ---- webhook ------------------------------------------------------------

  wa.on('incoming', ({ message, chat }) => {
    const { webhookUrl, webhookSecret, webhookGroups } = settings();
    if (!webhookUrl || (!webhookGroups && chat?.isGroup)) return;
    const body = JSON.stringify({
      event: 'message',
      chat: { jid: chat?.jid || message.chatJid, name: chat?.name, isGroup: !!chat?.isGroup },
      message: { ...message, time: formatTime(message.timestamp) },
    });
    const signature = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WaBridge-Signature': `sha256=${signature}` },
      body,
      signal: AbortSignal.timeout(10000),
    }).catch((err) => console.warn(`Webhook ${webhookUrl}: ${err.message}`));
  });

  // ---- live updates for the web UI (Server-Sent Events) -------------------

  const uiClients = new Set();
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of uiClients) res.write(frame);
  };
  let changeTimer = null;
  wa.on('status', (s) => broadcast('status', s));
  wa.on('message', ({ message, live }) => broadcast('message', { message, live }));
  wa.on('change', () => {
    // History sync fires thousands of these: coalesce
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      broadcast('change', {});
    }, 500);
  });
  const ping = setInterval(() => {
    for (const res of uiClients) res.write(': ping\n\n');
  }, 25000);

  function openUiStream(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: status\ndata: ${JSON.stringify(wa.publicState())}\n\n`);
    uiClients.add(res);
    req.on('close', () => uiClients.delete(res));
  }

  // ---- channel bridge (for Claude Code channels, see channel/) ------------

  function openChannelStream(req, res, url) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const groups = url.searchParams.get('groups') !== '0';
    const onIncoming = ({ message, chat }) => {
      if (!groups && chat?.isGroup) return;
      res.write(`event: message\ndata: ${JSON.stringify({
        chat: { jid: chat?.jid || message.chatJid, name: chat?.name, isGroup: !!chat?.isGroup },
        message: { ...message, senderName: message.senderName || db.contactName(message.sender), time: formatTime(message.timestamp) },
      })}\n\n`);
    };
    wa.on('incoming', onIncoming);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
    res.write(': connected\n\n');
    req.on('close', () => {
      clearInterval(keepAlive);
      wa.off('incoming', onIncoming);
    });
  }

  // ---- routes -------------------------------------------------------------

  const ensureWritable = () => {
    if (settings().mcpReadOnly) throw httpError(403, 'Modo solo lectura activado en Ajustes');
  };

  // [method, pattern, handler(req, res, params, url)]; returning undefined
  // means the handler already answered
  const api = [
    ['GET', /^\/api\/status$/, () => ({ ...wa.publicState(), ...db.stats() })],
    ['GET', /^\/api\/events$/, (req, res) => openUiStream(req, res)],
    ['POST', /^\/api\/logout$/, async () => {
      await wa.logout();
      return { ok: true };
    }],
    ['POST', /^\/api\/pairing-code$/, async (req) => {
      const { phone } = await readJson(req);
      return { code: await wa.requestPairingCode(phone) };
    }],
    ['GET', /^\/api\/chats$/, (req, res, p, url) => db.listChats({
      query: url.searchParams.get('q') || undefined,
      limit: Math.min(200, parseInt(url.searchParams.get('limit') || '60', 10)),
      offset: parseInt(url.searchParams.get('offset') || '0', 10),
    })],
    ['GET', /^\/api\/chats\/([^/]+)$/, (req, res, [jid]) => db.getChat(jid) || { jid, name: jid, unread: 0 }],
    ['GET', /^\/api\/chats\/([^/]+)\/messages$/, (req, res, [jid], url) => db.getMessages(jid, {
      limit: Math.min(500, parseInt(url.searchParams.get('limit') || '60', 10)),
      before: url.searchParams.get('before') ? parseInt(url.searchParams.get('before'), 10) : undefined,
    }).filter((m) => m.type !== 'reaction').map((m) => ({ ...m, senderLabel: m.fromMe ? null : m.senderName || db.contactName(m.sender) }))],
    ['POST', /^\/api\/chats\/([^/]+)\/read$/, async (req, res, [jid]) => {
      await wa.markRead(jid);
      return { ok: true };
    }],
    ['POST', /^\/api\/send$/, async (req) => {
      const { to, text, replyTo } = await readJson(req);
      return wa.sendText(to, text, { replyTo });
    }],
    ['POST', /^\/api\/send-media$/, async (req, res, p, url) => {
      const buffer = await readBuffer(req, 60 * 1024 * 1024);
      if (!buffer.length) throw httpError(400, 'Archivo vacío');
      return wa.sendMedia(url.searchParams.get('to'), {
        buffer,
        mime: (req.headers['content-type'] || 'application/octet-stream').split(';')[0],
        fileName: url.searchParams.get('name') || undefined,
        caption: url.searchParams.get('caption') || undefined,
      });
    }],
    ['POST', /^\/api\/react$/, async (req) => {
      const { chat, id, emoji } = await readJson(req);
      await wa.react(chat, id, emoji);
      return { ok: true };
    }],
    ['GET', /^\/api\/media\/([^/]+)\/([^/]+)$/, async (req, res, [jid, id]) => {
      const { buffer, mime, fileName } = await wa.downloadMedia(jid, id);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': buffer.length,
        'Cache-Control': 'private, max-age=86400',
        ...(fileName ? { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}` } : {}),
      });
      res.end(buffer);
    }],
    ['GET', /^\/api\/settings$/, () => publicSettings()],
    ['PUT', /^\/api\/settings$/, async (req) => {
      const body = await readJson(req);
      const patch = {};
      if ('mcpReadOnly' in body) patch.mcpReadOnly = !!body.mcpReadOnly;
      if ('webhookGroups' in body) patch.webhookGroups = !!body.webhookGroups;
      if ('webhookUrl' in body) {
        const value = String(body.webhookUrl || '').trim();
        if (value) {
          let u;
          try {
            u = new URL(value);
          } catch {
            throw httpError(400, 'La URL del webhook no es válida');
          }
          if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'El webhook tiene que ser http o https');
        }
        patch.webhookUrl = value;
      }
      saveSettings(patch);
      return publicSettings();
    }],
    // New secret: MCP clients and the channel bridge with the old one stop working
    ['POST', /^\/api\/settings\/mcp-token$/, () => {
      saveSettings({ mcpToken: crypto.randomBytes(24).toString('base64url') });
      return publicSettings();
    }],
    ['POST', /^\/api\/settings\/webhook-test$/, async () => {
      const { webhookUrl } = settings();
      if (!webhookUrl) throw httpError(400, 'No hay webhook configurado');
      wa.emit('incoming', {
        message: { chatJid: 'test@s.whatsapp.net', id: 'TEST', fromMe: false, sender: 'test@s.whatsapp.net', senderName: 'Prueba', timestamp: Math.floor(Date.now() / 1000), type: 'text', text: 'Mensaje de prueba de WaBridge' },
        chat: { jid: 'test@s.whatsapp.net', name: 'Prueba', isGroup: false },
      });
      return { ok: true };
    }],
  ];

  // Endpoints for the channel bridge, authenticated by the token in the path
  const channelApi = [
    ['GET', /^\/events$/, (req, res, p, url) => openChannelStream(req, res, url)],
    ['GET', /^\/status$/, () => ({ ...wa.publicState(), qr: undefined, readOnly: settings().mcpReadOnly })],
    ['POST', /^\/send$/, async (req) => {
      ensureWritable();
      const { to, text, replyTo } = await readJson(req);
      const m = await wa.sendText(to, text, { replyTo });
      return { chat: m?.chatJid, id: m?.id };
    }],
    ['POST', /^\/react$/, async (req) => {
      ensureWritable();
      const { chat, id, emoji } = await readJson(req);
      await wa.react(chat, id, emoji);
      return { ok: true };
    }],
    ['POST', /^\/read$/, async (req) => {
      ensureWritable();
      const { chat } = await readJson(req);
      await wa.markRead(await wa.resolveRecipient(chat));
      return { ok: true };
    }],
    ['GET', /^\/messages$/, async (req, res, p, url) => {
      const chat = await wa.resolveRecipient(url.searchParams.get('chat'));
      return db.getMessages(chat, { limit: Math.min(200, parseInt(url.searchParams.get('limit') || '20', 10)) })
        .filter((m) => m.type !== 'reaction')
        .map((m) => ({ ...m, senderName: m.fromMe ? 'yo' : m.senderName || db.contactName(m.sender), time: formatTime(m.timestamp) }));
    }],
    ['GET', /^\/wait$/, async (req, res, p, url) => {
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      const cursor = parseInt(url.searchParams.get('cursor') || String(db.lastSeq()), 10);
      const messages = await waitForMessages({ wa, db, cursor, timeoutMs: 25000, signal: ac.signal });
      return { cursor: messages.length ? messages[messages.length - 1].seq : cursor, messages };
    }],
  ];

  async function dispatch(routes, req, res, pathname, url) {
    for (const [method, pattern, handler] of routes) {
      const m = pattern.exec(pathname);
      if (!m) continue;
      if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) continue;
      const params = m.slice(1).map(decodeURIComponent);
      const result = await handler(req, res, params, url);
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
      return true;
    }
    return false;
  }

  // /mcp/<token> and /channel/<token>/…: true when handled
  async function handleTokenRoutes(req, res, url) {
    const m = /^\/(mcp|channel)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return false;
    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!safeEqual(decodeURIComponent(m[2]), settings().mcpToken) && !safeEqual(auth, settings().mcpToken)) {
      sendJson(res, 401, { error: 'Token inválido' });
      return true;
    }
    if (m[1] === 'mcp') {
      if (m[3] && m[3] !== '/') return false;
      await handleMcpRequest(req, res, { wa, db, settings });
      return true;
    }
    if (await dispatch(channelApi, req, res, m[3] || '/', url)) return true;
    sendJson(res, 404, { error: 'No encontrado' });
    return true;
  }

  function serveStatic(req, res, pathname) {
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    let file;
    if (pathname === '/whatsapp-channel.mjs') file = path.join(ROOT, 'channel', 'whatsapp-channel.mjs');
    else file = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR) && !file.startsWith(path.join(ROOT, 'channel'))) return false;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (file.endsWith('.mjs')) headers['Content-Disposition'] = 'attachment; filename="whatsapp-channel.mjs"';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
    return true;
  }

  function wrapHandler(fn) {
    return async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      try {
        if (!(await fn(req, res, url)) && !res.headersSent) sendJson(res, 404, { error: 'No encontrado' });
      } catch (err) {
        if (!err.status) console.error(err);
        if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || 'Error interno' });
        else res.end();
      }
    };
  }

  const appHandler = wrapHandler(async (req, res, url) => {
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true }) || true;
    if (await handleTokenRoutes(req, res, url)) return true;
    if (url.pathname.startsWith('/api/')) return dispatch(api, req, res, url.pathname, url);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    return false;
  });

  const mcpHandler = wrapHandler(async (req, res, url) => {
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true }) || true;
    return handleTokenRoutes(req, res, url);
  });

  const server = http.createServer(appHandler);
  const mcpServer = http.createServer(mcpHandler);
  // Long-polling tools (wait_for_messages) keep requests open for minutes
  for (const s of [server, mcpServer]) {
    s.requestTimeout = 0;
    s.headersTimeout = 60000;
  }

  if (autoStart) wa.start().catch((err) => wa.fail(err));

  const close = () => {
    clearInterval(ping);
    wa.stop();
    for (const res of uiClients) res.end();
    server.close();
    mcpServer.close();
    db.close();
  };

  return { server, mcpServer, wa, db, settings, saveSettings, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const app = createApp();
  app.server.listen(PORT, () => console.log(`WaBridge en http://localhost:${PORT}`));
  if (MCP_PORT) app.mcpServer.listen(MCP_PORT, () => console.log(`MCP en el puerto ${MCP_PORT}`));
  const shutdown = () => {
    app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
