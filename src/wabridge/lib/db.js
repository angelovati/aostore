// Local copy of chats, contacts and messages, kept in SQLite so the web UI and
// Claude (through MCP) can read and search them without asking WhatsApp.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,
  notify TEXT
);
-- WhatsApp identifies people either by phone (…@s.whatsapp.net) or by an
-- opaque id (…@lid). Messages of the same person can arrive with either, so
-- both are folded into the phone one when the pair is known.
CREATE TABLE IF NOT EXISTS lid_map (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  id TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  sender TEXT,
  sender_name TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  quoted_id TEXT,
  quoted_text TEXT,
  status INTEGER,
  edited INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  reactions TEXT,
  media_mime TEXT,
  media_name TEXT,
  raw BLOB,
  UNIQUE (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat_jid, ts);
CREATE INDEX IF NOT EXISTS messages_id ON messages (id);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

const MESSAGE_COLUMNS = `seq, chat_jid, id, from_me, sender, sender_name, ts, type, text, quoted_id,
  quoted_text, status, edited, deleted, reactions, media_mime, media_name`;

export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

export function phoneOf(jid) {
  const m = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(jid || '');
  return m ? m[1] : null;
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    seq: row.seq,
    chatJid: row.chat_jid,
    id: row.id,
    fromMe: !!row.from_me,
    sender: row.sender,
    senderName: row.sender_name,
    timestamp: row.ts,
    type: row.type,
    text: row.text,
    quotedId: row.quoted_id || undefined,
    quotedText: row.quoted_text || undefined,
    status: row.status,
    edited: !!row.edited,
    deleted: !!row.deleted,
    reactions: row.reactions ? JSON.parse(row.reactions) : {},
    media: row.media_mime ? { mime: row.media_mime, name: row.media_name || undefined } : undefined,
  };
}

export class Db {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
    this.db.exec(SCHEMA);
    this.lidCache = new Map(this.db.prepare('SELECT lid, pn FROM lid_map').all().map((r) => [r.lid, r.pn]));
    this.stmts = {
      getChat: this.db.prepare('SELECT * FROM chats WHERE jid = ?'),
      insertChat: this.db.prepare('INSERT OR IGNORE INTO chats (jid, is_group) VALUES (?, ?)'),
      getMsg: this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_jid = ? AND id = ?`),
      getRaw: this.db.prepare('SELECT raw FROM messages WHERE chat_jid = ? AND id = ?'),
      getRawById: this.db.prepare('SELECT raw FROM messages WHERE id = ? ORDER BY seq DESC LIMIT 1'),
    };
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- key/value settings -------------------------------------------------

  getKv(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setKv(key, value) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // ---- identities ---------------------------------------------------------

  // Phone jid for a LID when the pair is known; any other jid unchanged
  canonical(jid) {
    if (!jid) return jid;
    const bare = jid.replace(/:\d+@/, '@');
    return this.lidCache.get(bare) || bare;
  }

  addLidMapping(lid, pn) {
    if (!lid || !pn || !lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return false;
    lid = lid.replace(/:\d+@/, '@');
    pn = pn.replace(/:\d+@/, '@');
    if (this.lidCache.get(lid) === pn) return false;
    this.transaction(() => {
      this.db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?) ON CONFLICT (lid) DO UPDATE SET pn = excluded.pn').run(lid, pn);
      // Fold the LID chat into the phone one
      const lidChat = this.stmts.getChat.get(lid);
      if (lidChat) {
        this.stmts.insertChat.run(pn, 0);
        this.db.prepare(`UPDATE chats SET
            name = COALESCE(name, ?), unread = unread + ?, last_ts = MAX(last_ts, ?), archived = ?
          WHERE jid = ?`).run(lidChat.name, lidChat.unread, lidChat.last_ts, lidChat.archived, pn);
        this.db.prepare('DELETE FROM chats WHERE jid = ?').run(lid);
      }
      this.db.prepare('UPDATE OR IGNORE messages SET chat_jid = ? WHERE chat_jid = ?').run(pn, lid);
      this.db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(lid);
      this.db.prepare('UPDATE messages SET sender = ? WHERE sender = ?').run(pn, lid);
      const lidContact = this.db.prepare('SELECT * FROM contacts WHERE jid = ?').get(lid);
      if (lidContact) {
        this.upsertContact({ jid: pn, name: lidContact.name, notify: lidContact.notify });
        this.db.prepare('DELETE FROM contacts WHERE jid = ?').run(lid);
      }
    });
    this.lidCache.set(lid, pn);
    return true;
  }

  // ---- contacts -----------------------------------------------------------

  upsertContact({ jid, name, notify }) {
    jid = this.canonical(jid);
    if (!jid) return;
    this.db.prepare(`INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?)
      ON CONFLICT (jid) DO UPDATE SET name = COALESCE(excluded.name, name), notify = COALESCE(excluded.notify, notify)`)
      .run(jid, name || null, notify || null);
  }

  contactName(jid) {
    jid = this.canonical(jid);
    const c = this.db.prepare('SELECT name, notify FROM contacts WHERE jid = ?').get(jid);
    return c?.name || c?.notify || null;
  }

  searchContacts(query, limit = 20) {
    const like = `%${String(query || '').trim()}%`;
    const digits = String(query || '').replace(/\D/g, '');
    return this.db.prepare(`SELECT jid, name, notify FROM contacts
        WHERE name LIKE ? OR notify LIKE ? OR (? <> '' AND jid LIKE ?)
        ORDER BY COALESCE(name, notify) LIMIT ?`)
      .all(like, like, digits, `%${digits}%@%`, limit)
      .map((c) => ({ jid: c.jid, name: c.name || c.notify || null, phone: phoneOf(c.jid) }));
  }

  // ---- chats --------------------------------------------------------------

  upsertChat({ jid, name, unread, lastTs, archived }) {
    jid = this.canonical(jid);
    if (!jid) return;
    this.stmts.insertChat.run(jid, isGroupJid(jid) ? 1 : 0);
    if (name) this.db.prepare('UPDATE chats SET name = ? WHERE jid = ?').run(name, jid);
    if (unread !== undefined && unread !== null) this.db.prepare('UPDATE chats SET unread = ? WHERE jid = ?').run(Math.max(0, unread), jid);
    if (lastTs) this.db.prepare('UPDATE chats SET last_ts = MAX(last_ts, ?) WHERE jid = ?').run(lastTs, jid);
    if (archived !== undefined && archived !== null) this.db.prepare('UPDATE chats SET archived = ? WHERE jid = ?').run(archived ? 1 : 0, jid);
  }

  deleteChat(jid) {
    jid = this.canonical(jid);
    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
      this.db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    });
  }

  chatDisplayName(row) {
    return row.name || this.contactName(row.jid) || (phoneOf(row.jid) ? `+${phoneOf(row.jid)}` : row.jid);
  }

  getChat(jid) {
    const row = this.stmts.getChat.get(this.canonical(jid));
    return row ? this.chatSummary(row) : null;
  }

  chatSummary(row) {
    const last = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_jid = ? AND type <> 'reaction'
      ORDER BY ts DESC, seq DESC LIMIT 1`).get(row.jid);
    return {
      jid: row.jid,
      name: this.chatDisplayName(row),
      isGroup: !!row.is_group,
      phone: phoneOf(row.jid),
      unread: row.unread,
      archived: !!row.archived,
      lastTimestamp: row.last_ts || last?.ts || 0,
      lastMessage: last ? rowToMessage(last) : null,
    };
  }

  listChats({ query, limit = 50, offset = 0, includeArchived = true, unreadOnly = false } = {}) {
    const where = ["jid NOT LIKE '%@broadcast'", "jid NOT LIKE '%@newsletter'"];
    const params = [];
    if (!includeArchived) where.push('archived = 0');
    if (unreadOnly) where.push('unread > 0');
    if (query) {
      where.push(`(name LIKE ? OR jid LIKE ? OR jid IN (SELECT jid FROM contacts WHERE name LIKE ? OR notify LIKE ?))`);
      const like = `%${query}%`;
      params.push(like, `%${query.replace(/\D/g, '') || query}%`, like, like);
    }
    const rows = this.db.prepare(`SELECT * FROM chats WHERE ${where.join(' AND ')}
      ORDER BY last_ts DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return rows.map((r) => this.chatSummary(r));
  }

  // ---- messages -----------------------------------------------------------

  // msg: { chatJid, id, fromMe, sender, senderName, timestamp, type, text,
  //        quotedId, quotedText, status, mediaMime, mediaName, raw (Uint8Array) }
  // Returns true when the message is new.
  upsertMessage(msg) {
    const chatJid = this.canonical(msg.chatJid);
    const sender = this.canonical(msg.sender);
    const existing = this.stmts.getMsg.get(chatJid, msg.id);
    this.stmts.insertChat.run(chatJid, isGroupJid(chatJid) ? 1 : 0);
    if (existing) {
      this.db.prepare(`UPDATE messages SET
          text = COALESCE(?, text), status = MAX(COALESCE(status, 0), COALESCE(?, 0)),
          sender_name = COALESCE(?, sender_name), raw = COALESCE(?, raw)
        WHERE chat_jid = ? AND id = ?`)
        .run(msg.text ?? null, msg.status ?? null, msg.senderName ?? null, msg.raw ?? null, chatJid, msg.id);
      return false;
    }
    this.db.prepare(`INSERT INTO messages (chat_jid, id, from_me, sender, sender_name, ts, type, text,
        quoted_id, quoted_text, status, media_mime, media_name, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(chatJid, msg.id, msg.fromMe ? 1 : 0, sender || null, msg.senderName || null, msg.timestamp,
        msg.type, msg.text ?? null, msg.quotedId || null, msg.quotedText || null, msg.status ?? null,
        msg.mediaMime || null, msg.mediaName || null, msg.raw || null);
    this.db.prepare('UPDATE chats SET last_ts = MAX(last_ts, ?) WHERE jid = ?').run(msg.timestamp, chatJid);
    return true;
  }

  getMessage(chatJid, id) {
    return rowToMessage(this.stmts.getMsg.get(this.canonical(chatJid), id));
  }

  getRaw(chatJid, id) {
    const row = chatJid ? this.stmts.getRaw.get(this.canonical(chatJid), id) : this.stmts.getRawById.get(id);
    return row?.raw || null;
  }

  updateStatus(chatJid, id, status) {
    this.db.prepare('UPDATE messages SET status = MAX(COALESCE(status, 0), ?) WHERE chat_jid = ? AND id = ?')
      .run(status, this.canonical(chatJid), id);
  }

  editMessage(chatJid, id, text) {
    this.db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE chat_jid = ? AND id = ?')
      .run(text, this.canonical(chatJid), id);
  }

  markDeleted(chatJid, id) {
    this.db.prepare("UPDATE messages SET deleted = 1, text = NULL, raw = NULL WHERE chat_jid = ? AND id = ?")
      .run(this.canonical(chatJid), id);
  }

  // Reactions are stored on the message they react to: { senderJid: emoji }
  setReaction(chatJid, id, reactor, emoji) {
    chatJid = this.canonical(chatJid);
    const row = this.db.prepare('SELECT reactions FROM messages WHERE chat_jid = ? AND id = ?').get(chatJid, id);
    if (!row) return false;
    const reactions = row.reactions ? JSON.parse(row.reactions) : {};
    reactor = this.canonical(reactor) || 'me';
    if (emoji) reactions[reactor] = emoji;
    else delete reactions[reactor];
    this.db.prepare('UPDATE messages SET reactions = ? WHERE chat_jid = ? AND id = ?')
      .run(Object.keys(reactions).length ? JSON.stringify(reactions) : null, chatJid, id);
    return true;
  }

  // Newest `limit` messages of a chat, returned oldest first. `before` is a
  // timestamp (seconds) to page back in time.
  getMessages(chatJid, { limit = 50, before } = {}) {
    const jid = this.canonical(chatJid);
    const rows = before
      ? this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_jid = ? AND ts < ?
          ORDER BY ts DESC, seq DESC LIMIT ?`).all(jid, before, limit)
      : this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_jid = ?
          ORDER BY ts DESC, seq DESC LIMIT ?`).all(jid, limit);
    return rows.reverse().map(rowToMessage);
  }

  searchMessages(query, { chatJid, limit = 30 } = {}) {
    const params = [`%${query}%`];
    let where = "text LIKE ? AND deleted = 0";
    if (chatJid) {
      where += ' AND chat_jid = ?';
      params.push(this.canonical(chatJid));
    }
    return this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where}
      ORDER BY ts DESC LIMIT ?`).all(...params, limit).map(rowToMessage);
  }

  // Messages received after `seq` (an always-growing cursor), oldest first
  messagesAfter(seq, { chatJid, includeFromMe = false, limit = 100 } = {}) {
    const params = [seq];
    let where = "seq > ? AND type <> 'reaction'";
    if (!includeFromMe) where += ' AND from_me = 0';
    if (chatJid) {
      where += ' AND chat_jid = ?';
      params.push(this.canonical(chatJid));
    }
    return this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE ${where} ORDER BY seq LIMIT ?`)
      .all(...params, limit).map(rowToMessage);
  }

  lastSeq() {
    return this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages').get().seq;
  }

  stats() {
    return {
      chats: this.db.prepare('SELECT COUNT(*) AS n FROM chats').get().n,
      messages: this.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
      contacts: this.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
    };
  }

  // Forget everything (after unlinking the account)
  clear() {
    this.db.exec('DELETE FROM messages; DELETE FROM chats; DELETE FROM contacts; DELETE FROM lid_map;');
    this.lidCache.clear();
  }
}
