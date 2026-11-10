import test from 'node:test';
import assert from 'node:assert';
import { parseMessage, describeContent, decodeRaw } from '../lib/parse.js';

const key = { remoteJid: '5491122223333@s.whatsapp.net', fromMe: false, id: 'A1' };

test('plain and extended text', () => {
  const r = parseMessage({ key, message: { conversation: 'hola' }, messageTimestamp: 1700000000, pushName: 'Juan' });
  assert.equal(r.kind, 'message');
  assert.equal(r.row.text, 'hola');
  assert.equal(r.row.type, 'text');
  assert.equal(r.row.senderName, 'Juan');
  assert.equal(r.row.timestamp, 1700000000);
  assert.equal(decodeRaw(r.row.raw).key.id, 'A1');

  const q = parseMessage({
    key,
    message: { extendedTextMessage: { text: 'sí', contextInfo: { stanzaId: 'Q1', quotedMessage: { conversation: '¿venís?' } } } },
    messageTimestamp: 1,
  });
  assert.equal(q.row.text, 'sí');
  assert.equal(q.row.quotedId, 'Q1');
  assert.equal(q.row.quotedText, '¿venís?');
});

test('media with caption, voice notes and documents', () => {
  assert.deepEqual(describeContent({ imageMessage: { caption: 'mirá', mimetype: 'image/jpeg' } }), { type: 'image', text: 'mirá', mime: 'image/jpeg', fileName: undefined });
  assert.equal(describeContent({ audioMessage: { ptt: true, mimetype: 'audio/ogg' } }).type, 'voice');
  const doc = describeContent({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf', caption: 'factura' } } } });
  assert.equal(doc.type, 'document');
  assert.equal(doc.fileName, 'a.pdf');
  assert.equal(doc.text, 'factura');
  assert.match(describeContent({ locationMessage: { degreesLatitude: -34.6, degreesLongitude: -58.4, name: 'Obelisco' } }).text, /Obelisco.*-34.6/);
});

test('reactions, deletions and edits target another message', () => {
  const r = parseMessage({ key, message: { reactionMessage: { key: { id: 'T1' }, text: '👍' } } });
  assert.deepEqual(r, { kind: 'reaction', chatJid: key.remoteJid, targetId: 'T1', reactor: key.remoteJid, emoji: '👍' });
  const d = parseMessage({ key, message: { protocolMessage: { type: 0, key: { id: 'T1' } } } });
  assert.deepEqual(d, { kind: 'revoke', chatJid: key.remoteJid, targetId: 'T1' });
  const e = parseMessage({ key, message: { protocolMessage: { type: 14, key: { id: 'T1' }, editedMessage: { conversation: 'corregido' } } } });
  assert.deepEqual(e, { kind: 'edit', chatJid: key.remoteJid, targetId: 'T1', text: 'corregido' });
});

test('LID chats use the phone jid when WhatsApp sends both', () => {
  const r = parseMessage({ key: { remoteJid: '111@lid', remoteJidAlt: '5491122223333@s.whatsapp.net', id: 'L1' }, message: { conversation: 'x' } });
  assert.equal(r.row.chatJid, '5491122223333@s.whatsapp.net');
  assert.deepEqual(r.mappings, [['111@lid', '5491122223333@s.whatsapp.net']]);
  const g = parseMessage({ key: { remoteJid: '1@g.us', participant: '222@lid', participantAlt: '549113@s.whatsapp.net', id: 'G1' }, message: { conversation: 'x' } });
  assert.equal(g.row.sender, '549113@s.whatsapp.net');
});

test('status updates and empty messages are skipped', () => {
  assert.equal(parseMessage({ key: { remoteJid: 'status@broadcast', id: 'S' }, message: { conversation: 'x' } }), null);
  assert.equal(parseMessage({ key, message: null, messageStubType: 1 }), null);
  assert.equal(parseMessage({ key, message: { senderKeyDistributionMessage: {} } }), null);
});
