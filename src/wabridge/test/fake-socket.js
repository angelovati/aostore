// Stand-in for a Baileys socket, to drive the app without WhatsApp
import { EventEmitter } from 'node:events';
import { proto } from 'baileys';

export function createFakeSocketFactory() {
  const sockets = [];
  const makeSocket = (config) => {
    const ev = new EventEmitter();
    let counter = 0;
    const sock = {
      config,
      ev,
      sent: [],
      read: [],
      user: { id: '5491100000000:12@s.whatsapp.net', lid: '99999@lid', name: 'Yo' },
      async sendMessage(jid, content) {
        sock.sent.push({ jid, content });
        if (content.react) return proto.WebMessageInfo.fromObject({ key: { remoteJid: jid, fromMe: true, id: `R${++counter}` }, message: { reactionMessage: content.react }, messageTimestamp: Math.floor(Date.now() / 1000) });
        return proto.WebMessageInfo.fromObject({
          key: { remoteJid: jid, fromMe: true, id: `SENT${++counter}` },
          message: content.text ? { conversation: content.text } : { documentMessage: { mimetype: content.mimetype, fileName: content.fileName } },
          messageTimestamp: Math.floor(Date.now() / 1000),
          status: 2,
        });
      },
      async readMessages(keys) { sock.read.push(...keys); },
      async onWhatsApp(...numbers) { return numbers.map((n) => ({ jid: `${n}@s.whatsapp.net`, exists: !n.startsWith('000') })); },
      async groupFetchAllParticipating() { return { '123@g.us': { id: '123@g.us', subject: 'Familia' } }; },
      async sendPresenceUpdate() {},
      async requestPairingCode() { return 'ABCD1234'; },
      async profilePictureUrl() { return null; },
      async logout() {},
      end() { ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } }); },
      updateMediaMessage: async (m) => m,
    };
    sockets.push(sock);
    return sock;
  };
  return { makeSocket, sockets, last: () => sockets[sockets.length - 1] };
}

let n = 0;
export function incoming({ from = '5491122223333@s.whatsapp.net', text = 'hola', id = `IN${++n}`, pushName = 'Juan', group, ts, extra = {} } = {}) {
  return {
    key: group ? { remoteJid: group, fromMe: false, id, participant: from } : { remoteJid: from, fromMe: false, id, ...extra },
    message: { conversation: text },
    messageTimestamp: ts || Math.floor(Date.now() / 1000),
    pushName,
  };
}
