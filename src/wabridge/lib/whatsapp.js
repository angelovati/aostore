// Connection to WhatsApp as a linked device (like WhatsApp Web), using
// Baileys. Keeps the database up to date and emits events for the web UI,
// webhooks and MCP clients.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  jidNormalizedUser,
  fetchLatestWaWebVersion,
} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { parseMessage, decodeRaw, toNumber } from './parse.js';
import { isGroupJid } from './db.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

// Why WhatsApp closed the connection, for the link screen
const CLOSE_REASONS = {
  405: 'WhatsApp rechazó la conexión (405). Suele pasar cuando la versión de WhatsApp Web que usa la app quedó vieja.',
  403: 'WhatsApp bloqueó la conexión (403).',
  408: 'No hubo respuesta de WhatsApp (tiempo agotado). Revisá la conexión a internet del Umbrel.',
  428: 'Se cortó la conexión con WhatsApp.',
  500: 'La sesión guardada está dañada; se genera una nueva.',
  503: 'WhatsApp no está disponible en este momento.',
};

// How the app presents itself to WhatsApp (shown in Linked devices). A
// desktop client gets more history from the phone, but WhatsApp closes the
// connection before the QR (428) for some of them: macOS Desktop with full
// history does (Baileys issue #2880), Windows Desktop does not. Before
// linking, each failed attempt moves to the next profile.
export const CLIENT_PROFILES = [
  { name: 'Windows Desktop', browser: Browsers.windows('Desktop'), syncFullHistory: true },
  { name: 'Chrome (Ubuntu)', browser: Browsers.ubuntu('Chrome'), syncFullHistory: false },
];

// WA_VERSION=2.3000.1234567890 forces a WhatsApp Web version
function parseVersion(value) {
  const parts = String(value || '').split('.').map(Number);
  return parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null;
}

function lidPair(a, b) {
  if (a?.endsWith('@lid') && b?.endsWith('@s.whatsapp.net')) return [a, b];
  if (b?.endsWith('@lid') && a?.endsWith('@s.whatsapp.net')) return [b, a];
  return null;
}

export class WhatsApp extends EventEmitter {
  constructor({ db, authDir, makeSocket = makeWASocket, fetchVersion = fetchLatestWaWebVersion }) {
    super();
    this.fetchVersion = fetchVersion;
    this.setMaxListeners(100);
    this.db = db;
    this.authDir = authDir;
    this.makeSocket = makeSocket;
    this.sock = null;
    this.state = { status: 'starting', qr: null, me: null, error: null, syncing: false };
    this.retries = 0;
    this.stopped = false;
    this.pairingPhone = null;
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('status', this.publicState());
  }

  publicState() {
    const { status, qr, me, error, syncing, pairingCode, waVersion, retryInSeconds, client } = this.state;
    return {
      status, qr, me, error, syncing: !!syncing, pairingCode: pairingCode || null,
      waVersion: waVersion || null, retryInSeconds: retryInSeconds ?? null, client: client || null,
    };
  }

  get connected() {
    return this.state.status === 'open';
  }

  // WhatsApp refuses clients that announce an old WhatsApp Web version (405,
  // and no QR), and the one bundled with Baileys ages quickly: ask
  // web.whatsapp.com for the current one, falling back to the last that worked.
  async resolveVersion() {
    const forced = parseVersion(process.env.WA_VERSION);
    if (forced) return forced;
    try {
      const { version, error } = await this.fetchVersion({ signal: AbortSignal.timeout(10000) });
      if (!error && parseVersion(version?.join('.'))) {
        this.db.setKv('waVersion', version);
        return version;
      }
      logger.warn({ error }, 'no se pudo leer la versión de WhatsApp Web');
    } catch (err) {
      logger.warn({ err }, 'no se pudo leer la versión de WhatsApp Web');
    }
    return this.db.getKv('waVersion', null) || undefined;
  }

  async start() {
    this.stopped = false;
    fs.mkdirSync(this.authDir, { recursive: true });
    const version = await this.resolveVersion();
    if (this.stopped) return;
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.registered = !!state.creds.registered;
    this.qrSeen = false;
    if (version) this.state.waVersion = version.join('.');
    const profile = CLIENT_PROFILES[this.db.getKv('clientProfile', 0) % CLIENT_PROFILES.length];
    this.state.client = profile.name;
    logger.info({ version, registered: this.registered, client: profile.name }, 'conectando con WhatsApp');
    const sock = this.makeSocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: profile.browser,
      syncFullHistory: profile.syncFullHistory,
      markOnlineOnConnect: false,
      getMessage: async (key) => decodeRaw(this.db.getRaw(key.remoteJid, key.id))?.message || undefined,
    });
    this.sock = sock;
    if (!state.creds.registered) this.setState({ status: 'connecting', me: null });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this.onConnection(sock, u).catch((err) => logger.error(err)));
    sock.ev.on('messaging-history.set', (h) => this.onHistory(h));
    sock.ev.on('messaging-history.status', (s) => {
      if (s.status === 'complete') this.setState({ syncing: false });
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => this.onMessages(messages, type));
    sock.ev.on('messages.update', (updates) => this.onMessageUpdates(updates));
    sock.ev.on('messages.reaction', (items) => {
      for (const { key, reaction } of items) {
        const chat = key.remoteJidAlt && key.remoteJid?.endsWith('@lid') ? key.remoteJidAlt : key.remoteJid;
        const reactor = reaction.key?.fromMe ? this.state.me?.jid : reaction.key?.participant || reaction.key?.remoteJid;
        if (this.db.setReaction(chat, key.id, reactor, reaction.text || '')) this.emit('change', { chatJid: this.db.canonical(chat) });
      }
    });
    sock.ev.on('chats.upsert', (chats) => this.onChats(chats));
    sock.ev.on('chats.update', (chats) => this.onChats(chats));
    sock.ev.on('chats.delete', (ids) => {
      for (const id of ids) this.db.deleteChat(id);
      this.emit('change', {});
    });
    sock.ev.on('contacts.upsert', (contacts) => this.onContacts(contacts));
    sock.ev.on('contacts.update', (contacts) => this.onContacts(contacts));
    sock.ev.on('lid-mapping.update', (m) => {
      if (this.db.addLidMapping(m.lid, m.pn)) this.emit('change', {});
    });
    sock.ev.on('groups.upsert', (groups) => this.onGroups(groups));
    sock.ev.on('groups.update', (groups) => this.onGroups(groups));
  }

  async onConnection(sock, update) {
    if (sock !== this.sock) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      this.qrSeen = true;
      if (this.pairingPhone) {
        const phone = this.pairingPhone;
        this.pairingPhone = null;
        try {
          const code = await sock.requestPairingCode(phone);
          this.setState({ status: 'qr', pairingCode: code, error: null });
        } catch (err) {
          logger.warn({ err }, 'requestPairingCode');
          this.setState({ error: `No se pudo pedir el código: ${err.message}` });
        }
      }
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      this.setState({ status: 'qr', qr: dataUrl, error: this.state.pairingCode ? this.state.error : null });
    }
    if (connection === 'open') {
      this.retries = 0;
      this.registered = true;
      const id = jidNormalizedUser(sock.user?.id);
      this.setState({
        status: 'open',
        qr: null,
        pairingCode: null,
        error: null,
        me: { jid: id, lid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null, name: sock.user?.name || sock.user?.notify || null },
      });
      if (sock.user?.lid) this.db.addLidMapping(jidNormalizedUser(sock.user.lid), id);
      this.loadGroups(sock);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (this.stopped) return;
      logger.warn({ code, message: lastDisconnect?.error?.message }, 'conexión cerrada');
      if (code === DisconnectReason.loggedOut) {
        // The device was removed from the phone: start over with a new QR
        this.reset();
        this.setState({ status: 'logged_out', qr: null, me: null, error: 'La sesión se cerró desde el teléfono.' });
        setTimeout(() => this.start().catch((err) => this.fail(err)), 1000);
        return;
      }
      // restartRequired (515) is normal right after scanning the QR
      const restart = code === DisconnectReason.restartRequired;
      // Not linked yet: someone is probably looking at the screen, retry soon
      const delay = restart ? 0 : Math.min(this.registered ? 60000 : 10000, 2000 * 2 ** this.retries++);
      let error = this.state.error;
      if (!restart && !this.registered) {
        error = CLOSE_REASONS[code] || `No se pudo conectar con WhatsApp${code ? ` (${code})` : ''}: ${lastDisconnect?.error?.message || 'error desconocido'}.`;
        // Not linked yet and WhatsApp closed before sending a QR: try the
        // next client profile, from fresh keys
        if (!this.qrSeen) {
          this.db.setKv('clientProfile', (this.db.getKv('clientProfile', 0) + 1) % CLIENT_PROFILES.length);
          this.sock = null;
          fs.rmSync(this.authDir, { recursive: true, force: true });
        }
      }
      this.setState({ status: this.state.me ? 'reconnecting' : 'connecting', qr: null, error: restart ? null : error, retryInSeconds: Math.round(delay / 1000) });
      const current = this.sock;
      setTimeout(() => {
        if (!this.stopped && this.sock === current) this.start().catch((err) => this.fail(err));
      }, delay);
    }
  }

  fail(err) {
    logger.error(err);
    this.setState({ status: 'error', error: err.message });
    setTimeout(() => this.start().catch((e) => this.fail(e)), 30000);
  }

  async loadGroups(sock) {
    try {
      const groups = await sock.groupFetchAllParticipating();
      this.onGroups(Object.values(groups));
    } catch (err) {
      logger.warn({ err }, 'no se pudieron leer los grupos');
    }
  }

  onGroups(groups) {
    for (const g of groups) if (g.id && g.subject) this.db.upsertChat({ jid: g.id, name: g.subject });
    this.emit('change', {});
  }

  onContacts(contacts) {
    this.db.transaction(() => {
      for (const c of contacts) {
        const pair = lidPair(c.lid || c.id, c.phoneNumber || c.id);
        if (pair) this.db.addLidMapping(...pair);
        const jid = c.phoneNumber && !c.phoneNumber.includes('@') ? `${c.phoneNumber}@s.whatsapp.net` : c.phoneNumber || c.id;
        if (c.name || c.notify || c.verifiedName) this.db.upsertContact({ jid, name: c.name, notify: c.notify || c.verifiedName });
      }
    });
    this.emit('change', {});
  }

  onChats(chats) {
    this.db.transaction(() => {
      for (const c of chats) {
        if (!c.id || c.id.endsWith('@broadcast') || c.id.endsWith('@newsletter')) continue;
        if (c.pnJid) {
          const pair = lidPair(c.id, c.pnJid);
          if (pair) this.db.addLidMapping(...pair);
        }
        this.db.upsertChat({
          jid: c.id,
          name: c.name || undefined,
          unread: c.unreadCount ?? undefined,
          lastTs: toNumber(c.conversationTimestamp) || c.lastMessageRecvTimestamp || undefined,
          archived: c.archived ?? undefined,
        });
      }
    });
    this.emit('change', {});
  }

  onHistory({ chats = [], contacts = [], messages = [], lidPnMappings = [], isLatest, progress }) {
    if (progress !== null && progress !== undefined && progress < 100) this.setState({ syncing: true });
    this.db.transaction(() => {
      for (const m of lidPnMappings) this.db.addLidMapping(m.lid, m.pn);
    });
    this.onContacts(contacts);
    this.onChats(chats);
    this.storeMessages(messages);
    if (isLatest || progress === 100) this.setState({ syncing: false });
    this.emit('change', {});
  }

  // Store messages; returns the new ones as stored rows
  storeMessages(messages) {
    const fresh = [];
    this.db.transaction(() => {
      for (const msg of messages) {
        const parsed = parseMessage(msg, { meJid: this.state.me?.jid });
        if (!parsed) continue;
        if (parsed.kind === 'message') {
          for (const [a, b] of parsed.mappings) {
            const pair = lidPair(a, b);
            if (pair) this.db.addLidMapping(...pair);
          }
          if (!parsed.row.fromMe && parsed.row.senderName) {
            this.db.upsertContact({ jid: parsed.row.sender, notify: parsed.row.senderName });
          }
          if (this.db.upsertMessage(parsed.row)) fresh.push(this.db.getMessage(parsed.row.chatJid, parsed.row.id));
        } else if (parsed.kind === 'reaction') {
          this.db.setReaction(parsed.chatJid, parsed.targetId, parsed.reactor, parsed.emoji);
        } else if (parsed.kind === 'revoke') {
          this.db.markDeleted(parsed.chatJid, parsed.targetId);
        } else if (parsed.kind === 'edit') {
          this.db.editMessage(parsed.chatJid, parsed.targetId, parsed.text);
        }
      }
    });
    return fresh.filter(Boolean);
  }

  onMessages(messages, type) {
    const fresh = this.storeMessages(messages);
    for (const m of fresh) {
      // "notify" = arrived now; "append" = sent from another device or history
      const live = type === 'notify';
      if (live && !m.fromMe) {
        const chat = this.db.getChat(m.chatJid);
        this.db.upsertChat({ jid: m.chatJid, unread: (chat?.unread || 0) + 1 });
      }
      this.emit('message', { message: m, chat: this.db.getChat(m.chatJid), live });
      if (live && !m.fromMe) this.emit('incoming', { message: m, chat: this.db.getChat(m.chatJid) });
    }
    if (messages.length) this.emit('change', {});
  }

  onMessageUpdates(updates) {
    for (const { key, update } of updates) {
      const chat = key.remoteJidAlt && key.remoteJid?.endsWith('@lid') ? key.remoteJidAlt : key.remoteJid;
      if (update.status !== undefined && update.status !== null) this.db.updateStatus(chat, key.id, update.status);
      if (update.message) this.storeMessages([{ key, ...update, message: update.message }]);
    }
    if (updates.length) this.emit('change', {});
  }

  reset() {
    // Forget the socket first so its close event does not schedule a reconnect
    const sock = this.sock;
    this.sock = null;
    try {
      sock?.end(undefined);
    } catch {
      /* already closed */
    }
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.db.clear();
    this.emit('change', {});
  }

  async logout() {
    this.stopped = true;
    try {
      await this.sock?.logout();
    } catch {
      /* the phone may have removed the device already */
    }
    this.reset();
    this.setState({ status: 'connecting', qr: null, me: null, error: null });
    await this.start();
  }

  // Link with an 8-character code typed on the phone instead of the QR
  async requestPairingCode(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 8) throw Object.assign(new Error('Número de teléfono inválido'), { status: 400 });
    if (this.connected) throw Object.assign(new Error('La cuenta ya está vinculada'), { status: 409 });
    if (this.state.status === 'qr' && this.sock) {
      const code = await this.sock.requestPairingCode(digits);
      this.setState({ pairingCode: code });
      return code;
    }
    this.pairingPhone = digits;
    return null;
  }

  stop() {
    this.stopped = true;
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
  }

  ensureConnected() {
    if (!this.connected || !this.sock) {
      throw Object.assign(new Error('WhatsApp no está conectado. Vinculá la cuenta desde la app.'), { status: 503 });
    }
  }

  // Accepts a jid, a phone number (with country code) or a contact/chat name
  async resolveRecipient(to) {
    const value = String(to || '').trim();
    if (!value) throw Object.assign(new Error('Falta el destinatario'), { status: 400 });
    if (value.includes('@')) return this.db.canonical(value);
    const digits = value.replace(/[\s\-()+.]/g, '');
    if (/^\d{8,15}$/.test(digits)) {
      if (this.sock && this.connected) {
        const [found] = await this.sock.onWhatsApp(digits).catch(() => []);
        if (found?.exists === false) throw Object.assign(new Error(`El número ${value} no tiene WhatsApp`), { status: 404 });
        if (found?.jid) return this.db.canonical(jidNormalizedUser(found.jid));
      }
      return `${digits}@s.whatsapp.net`;
    }
    const chats = this.db.listChats({ query: value, limit: 5 });
    const exact = chats.filter((c) => c.name?.toLowerCase() === value.toLowerCase());
    if (exact.length === 1) return exact[0].jid;
    if (chats.length === 1) return chats[0].jid;
    const contacts = this.db.searchContacts(value, 5);
    if (!chats.length && contacts.length === 1) return contacts[0].jid;
    const options = [...chats.map((c) => `${c.name} (${c.jid})`), ...contacts.map((c) => `${c.name} (${c.jid})`)];
    throw Object.assign(new Error(options.length
      ? `"${value}" coincide con varios chats; usá el jid: ${[...new Set(options)].slice(0, 8).join('; ')}`
      : `No encontré ningún chat o contacto "${value}"`), { status: options.length ? 409 : 404 });
  }

  keyFor(chatJid, id) {
    const raw = decodeRaw(this.db.getRaw(chatJid, id));
    if (raw?.key) return raw.key;
    const m = this.db.getMessage(chatJid, id);
    if (!m) throw Object.assign(new Error('No encontré ese mensaje'), { status: 404 });
    return { remoteJid: m.chatJid, id: m.id, fromMe: m.fromMe, participant: isGroupJid(m.chatJid) && !m.fromMe ? m.sender : undefined };
  }

  async afterSend(sent) {
    if (!sent) return null;
    const [stored] = this.storeMessages([sent]);
    this.emit('change', {});
    return stored || this.db.getMessage(this.db.canonical(sent.key.remoteJid), sent.key.id);
  }

  async sendText(to, text, { replyTo } = {}) {
    this.ensureConnected();
    if (!String(text || '').trim()) throw Object.assign(new Error('El mensaje está vacío'), { status: 400 });
    const jid = await this.resolveRecipient(to);
    const options = {};
    if (replyTo) {
      const raw = decodeRaw(this.db.getRaw(jid, replyTo));
      if (raw) options.quoted = raw;
    }
    const sent = await this.sock.sendMessage(jid, { text: String(text) }, options);
    return this.afterSend(sent);
  }

  async sendMedia(to, { buffer, mime, fileName, caption }) {
    this.ensureConnected();
    const jid = await this.resolveRecipient(to);
    let content;
    if (/^image\/(jpeg|png|webp)$/.test(mime)) content = { image: buffer, caption, mimetype: mime };
    else if (/^video\//.test(mime)) content = { video: buffer, caption, mimetype: mime };
    else if (/^audio\//.test(mime)) content = { audio: buffer, mimetype: mime };
    else content = { document: buffer, mimetype: mime || 'application/octet-stream', fileName: fileName || 'archivo', caption };
    const sent = await this.sock.sendMessage(jid, content);
    return this.afterSend(sent);
  }

  async react(chatJid, messageId, emoji) {
    this.ensureConnected();
    const jid = await this.resolveRecipient(chatJid);
    const key = this.keyFor(jid, messageId);
    await this.sock.sendMessage(key.remoteJid || jid, { react: { text: emoji || '', key } });
    this.db.setReaction(jid, messageId, this.state.me?.jid, emoji || '');
    this.emit('change', { chatJid: jid });
  }

  async markRead(chatJid) {
    const jid = this.db.canonical(chatJid);
    const incoming = this.db.getMessages(jid, { limit: 20 }).filter((m) => !m.fromMe);
    this.db.upsertChat({ jid, unread: 0 });
    this.emit('change', { chatJid: jid });
    if (!this.connected || !incoming.length) return;
    const keys = incoming.map((m) => {
      try {
        return this.keyFor(jid, m.id);
      } catch {
        return null;
      }
    }).filter(Boolean);
    await this.sock.readMessages(keys).catch((err) => logger.warn({ err }, 'readMessages'));
  }

  async setTyping(chatJid, typing) {
    if (!this.connected) return;
    const jid = await this.resolveRecipient(chatJid);
    await this.sock.sendPresenceUpdate(typing ? 'composing' : 'paused', jid).catch(() => {});
  }

  // { buffer, mime, fileName } of a message's photo, video, audio or document
  async downloadMedia(chatJid, id) {
    const raw = decodeRaw(this.db.getRaw(chatJid, id));
    const m = this.db.getMessage(chatJid, id);
    if (!raw || !m?.media) throw Object.assign(new Error('El mensaje no tiene archivos adjuntos'), { status: 404 });
    this.ensureConnected();
    const buffer = await downloadMediaMessage(raw, 'buffer', {}, {
      logger,
      reuploadRequest: this.sock.updateMediaMessage,
    });
    return { buffer, mime: m.media.mime || 'application/octet-stream', fileName: m.media.name };
  }

  async profilePicture(jid) {
    if (!this.connected) return null;
    return this.sock.profilePictureUrl(this.db.canonical(jid), 'preview', 5000).catch(() => null);
  }
}
