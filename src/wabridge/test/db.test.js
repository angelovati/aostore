import test from 'node:test';
import assert from 'node:assert';
import { Db } from '../lib/db.js';

const msg = (o) => ({ chatJid: '5491122223333@s.whatsapp.net', id: 'M1', fromMe: false, sender: '5491122223333@s.whatsapp.net', timestamp: 100, type: 'text', text: 'hola', ...o });

test('messages are stored once and listed oldest first', () => {
  const db = new Db(':memory:');
  assert.equal(db.upsertMessage(msg()), true);
  assert.equal(db.upsertMessage(msg()), false);
  db.upsertMessage(msg({ id: 'M2', timestamp: 200, text: 'chau' }));
  assert.deepEqual(db.getMessages('5491122223333@s.whatsapp.net').map((m) => m.text), ['hola', 'chau']);
  assert.deepEqual(db.getMessages('5491122223333@s.whatsapp.net', { before: 200 }).map((m) => m.id), ['M1']);
  assert.equal(db.listChats()[0].lastMessage.text, 'chau');
  assert.equal(db.searchMessages('cha')[0].id, 'M2');
});

test('a LID chat is folded into the phone chat once the pair is known', () => {
  const db = new Db(':memory:');
  db.upsertMessage(msg({ chatJid: '777@lid', sender: '777@lid', id: 'A' }));
  db.upsertContact({ jid: '777@lid', notify: 'Juan' });
  db.upsertMessage(msg({ id: 'B', timestamp: 150 }));
  db.addLidMapping('777@lid', '5491122223333@s.whatsapp.net');
  const chats = db.listChats();
  assert.equal(chats.length, 1);
  assert.equal(chats[0].jid, '5491122223333@s.whatsapp.net');
  assert.equal(chats[0].name, 'Juan');
  assert.deepEqual(db.getMessages('777@lid').map((m) => m.id), ['A', 'B']);
  assert.equal(db.canonical('777:3@lid'), '5491122223333@s.whatsapp.net');
});

test('reactions, edits and deletions', () => {
  const db = new Db(':memory:');
  db.upsertMessage(msg());
  db.setReaction(msg().chatJid, 'M1', 'a@s.whatsapp.net', '👍');
  db.setReaction(msg().chatJid, 'M1', 'b@s.whatsapp.net', '❤️');
  db.setReaction(msg().chatJid, 'M1', 'a@s.whatsapp.net', '');
  assert.deepEqual(db.getMessage(msg().chatJid, 'M1').reactions, { 'b@s.whatsapp.net': '❤️' });
  db.editMessage(msg().chatJid, 'M1', 'hola!');
  assert.equal(db.getMessage(msg().chatJid, 'M1').edited, true);
  db.markDeleted(msg().chatJid, 'M1');
  assert.equal(db.getMessage(msg().chatJid, 'M1').text, null);
});

test('messagesAfter is a cursor over incoming messages', () => {
  const db = new Db(':memory:');
  const start = db.lastSeq();
  db.upsertMessage(msg());
  db.upsertMessage(msg({ id: 'MINE', fromMe: true }));
  db.upsertMessage(msg({ id: 'M3', chatJid: 'x@s.whatsapp.net' }));
  assert.deepEqual(db.messagesAfter(start).map((m) => m.id), ['M1', 'M3']);
  assert.deepEqual(db.messagesAfter(start, { chatJid: 'x@s.whatsapp.net' }).map((m) => m.id), ['M3']);
  assert.deepEqual(db.messagesAfter(db.lastSeq()), []);
});

test('transactions nest (a LID pair learned while storing a batch)', () => {
  const db = new Db(':memory:');
  db.transaction(() => {
    db.upsertMessage(msg({ chatJid: '777@lid', sender: '777@lid', id: 'A' }));
    db.addLidMapping('777@lid', '5491122223333@s.whatsapp.net');
    db.upsertContact({ jid: '777@lid', name: 'Juan' });
  });
  assert.equal(db.listChats()[0].jid, '5491122223333@s.whatsapp.net');
  assert.equal(db.listChats()[0].name, 'Juan');
  // An inner failure rolls back only the inner part
  db.transaction(() => {
    db.upsertContact({ jid: 'x@s.whatsapp.net', name: 'X' });
    assert.throws(() => db.transaction(() => {
      db.upsertContact({ jid: 'y@s.whatsapp.net', name: 'Y' });
      throw new Error('boom');
    }));
  });
  assert.deepEqual(db.searchContacts('').map((c) => c.name).sort(), ['Juan', 'X']);
});

test('chat names: pushed name, the WhatsApp account and unknown LIDs', () => {
  const db = new Db(':memory:');
  db.upsertMessage(msg({ chatJid: '1@lid', sender: '1@lid', id: 'A', senderName: 'Pedro' }));
  db.upsertMessage(msg({ chatJid: '2@lid', sender: 'me', fromMe: true, id: 'B' }));
  db.upsertMessage(msg({ chatJid: '0@s.whatsapp.net', sender: '0@s.whatsapp.net', id: 'C' }));
  const names = Object.fromEntries(db.listChats().map((c) => [c.jid, c.name]));
  assert.equal(names['1@lid'], 'Pedro');
  assert.equal(names['2@lid'], 'Contacto sin nombre');
  assert.equal(names['0@s.whatsapp.net'], 'WhatsApp');
  assert.deepEqual(db.unmappedLids().sort(), ['1@lid', '2@lid']);
});
