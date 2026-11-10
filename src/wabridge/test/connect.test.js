// Linking: the socket must announce a current WhatsApp Web version, and
// connection failures before the QR must be visible on the link screen.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../lib/db.js';
import { WhatsApp } from '../lib/whatsapp.js';
import { createFakeSocketFactory } from './fake-socket.js';

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function setup(fetchVersion) {
  const fake = createFakeSocketFactory();
  const db = new Db(':memory:');
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabridge-auth-'));
  const wa = new WhatsApp({ db, authDir, makeSocket: fake.makeSocket, fetchVersion });
  return { fake, db, wa, authDir };
}

const close = (sock, statusCode) => sock.ev.emit('connection.update', {
  connection: 'close', lastDisconnect: { error: { message: 'Connection Failure', output: { statusCode } } },
});

test('the socket uses the current WhatsApp Web version and remembers it', async () => {
  const { fake, db, wa } = setup(async () => ({ version: [2, 3000, 1234567], isLatest: true }));
  await wa.start();
  assert.deepEqual(fake.last().config.version, [2, 3000, 1234567]);
  assert.equal(wa.publicState().waVersion, '2.3000.1234567');
  wa.stop();

  // web.whatsapp.com unreachable: the last version that worked
  const offline = new WhatsApp({ db, authDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wb-')), makeSocket: fake.makeSocket, fetchVersion: async () => { throw new Error('offline'); } });
  await offline.start();
  assert.deepEqual(fake.last().config.version, [2, 3000, 1234567]);
  offline.stop();

  process.env.WA_VERSION = '2.3000.42';
  const forced = new WhatsApp({ db, authDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wb-')), makeSocket: fake.makeSocket, fetchVersion: async () => ({ version: [2, 3000, 1], isLatest: true }) });
  await forced.start();
  assert.deepEqual(fake.last().config.version, [2, 3000, 42]);
  delete process.env.WA_VERSION;
  forced.stop();
});

test('without any known version Baileys uses its bundled one', async () => {
  const { fake, wa } = setup(async () => ({ version: [2, 3000, 1], isLatest: false, error: { message: 'x' } }));
  await wa.start();
  assert.equal('version' in fake.last().config, false);
  wa.stop();
});

test('a connection closed before the QR is shown and retried with the next client profile and fresh keys', async () => {
  const { fake, wa, db, authDir } = setup(async () => ({ version: [2, 3000, 9], isLatest: true }));
  wa.retries = -20; // retry immediately (2000 * 2^-20 ms)
  await wa.start();
  assert.equal(fake.last().config.browser[0], 'Windows');
  assert.equal(fake.last().config.syncFullHistory, true);
  assert.equal(wa.publicState().client, 'Windows Desktop');
  fs.writeFileSync(path.join(authDir, 'marker'), 'x');
  close(fake.last(), 428);
  assert.equal(wa.state.status, 'connecting');
  assert.match(wa.state.error, /cortó/);
  assert.equal(fs.existsSync(path.join(authDir, 'marker')), false);
  await until(() => fake.sockets.length === 2);
  assert.equal(fake.last().config.browser[1], 'Chrome');
  assert.equal(fake.last().config.syncFullHistory, false);
  close(fake.last(), 405);
  assert.match(wa.state.error, /405/);
  await until(() => fake.sockets.length === 3);
  assert.equal(fake.last().config.browser[0], 'Windows');

  // The QR arrives: the error goes away and the profile is kept
  fake.last().ev.emit('connection.update', { qr: 'abc' });
  await until(() => wa.state.status === 'qr');
  assert.equal(wa.state.error, null);
  assert.ok(wa.state.qr.startsWith('data:image/png'));
  const kept = db.getKv('clientProfile');
  close(fake.last(), 408); // QR expired
  assert.equal(db.getKv('clientProfile'), kept);
  wa.stop();
});

test('a pairing code asked before the QR is requested as soon as WhatsApp is ready', async () => {
  const { fake, wa } = setup(async () => ({ version: [2, 3000, 9], isLatest: true }));
  await wa.start();
  assert.equal(await wa.requestPairingCode('+54 9 11 2222-3333'), null);
  fake.last().ev.emit('connection.update', { qr: 'abc' });
  await until(() => wa.state.pairingCode);
  assert.equal(wa.publicState().pairingCode, 'ABCD1234');
  assert.equal(await wa.requestPairingCode('5491122223333'), 'ABCD1234');
  wa.stop();
});

test('history with LID pairs and contacts is stored, and unknown LIDs are asked to Baileys', async () => {
  const { fake, db, wa } = setup(async () => ({ version: [2, 3000, 9], isLatest: true }));
  await wa.start();
  const sock = fake.last();
  sock.signalRepository = { lidMapping: { getPNsForLIDs: async (lids) => lids.filter((l) => l === '555@lid').map((lid) => ({ lid, pn: '5491155556666:3@s.whatsapp.net' })) } };
  sock.ev.emit('connection.update', { connection: 'open' });
  sock.ev.emit('messaging-history.set', {
    chats: [{ id: '444@lid', name: undefined }, { id: '555@lid' }],
    contacts: [{ id: '5491144440000@s.whatsapp.net', lid: '444@lid', name: 'Ana López' }, { id: '5491155556666@s.whatsapp.net', name: 'Beto' }],
    messages: [
      { key: { remoteJid: '444@lid', remoteJidAlt: '5491144440000@s.whatsapp.net', fromMe: true, id: 'M1' }, message: { conversation: 'hola Ana' }, messageTimestamp: 100 },
      { key: { remoteJid: '555@lid', fromMe: false, id: 'M2' }, message: { conversation: 'soy Beto' }, messageTimestamp: 200 },
    ],
    lidPnMappings: [{ lid: '444@lid', pn: '5491144440000@s.whatsapp.net' }],
    isLatest: true,
  });
  assert.equal(db.getChat('444@lid').name, 'Ana López');
  assert.equal(db.getMessages('5491144440000@s.whatsapp.net')[0].text, 'hola Ana');
  await wa.resolveLids();
  const beto = db.listChats().find((c) => c.name === 'Beto');
  assert.equal(beto.jid, '5491155556666@s.whatsapp.net');
  assert.equal(db.getMessages(beto.jid)[0].text, 'soy Beto');
  assert.deepEqual(db.unmappedLids(), []);
  wa.stop();
});
