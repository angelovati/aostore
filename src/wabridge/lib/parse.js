// Turns Baileys messages (WhatsApp protobufs) into plain rows for the database.
import { normalizeMessageContent, getContentType, proto } from 'baileys';

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  stickerMessage: 'sticker',
  ptvMessage: 'video',
};

// Message types that carry no content of their own
const IGNORED = new Set([
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'keepInChatMessage',
  'pinInChatMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'deviceSentMessage',
  'callLogMesssage',
]);

export function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value.toNumber === 'function') return value.toNumber();
  return Number(value) || 0;
}

function contextOf(content) {
  if (!content) return undefined;
  const type = getContentType(content);
  return type ? content[type]?.contextInfo : undefined;
}

function quotedText(quoted) {
  if (!quoted) return undefined;
  const { text } = describeContent(normalizeMessageContent(quoted));
  return text || undefined;
}

// { type, text, mime, fileName } for a message's content
export function describeContent(content) {
  if (!content) return { type: 'unknown' };
  const kind = Object.keys(content).find((k) => content[k] && !IGNORED.has(k)) || getContentType(content);
  if (!kind) return { type: 'unknown' };
  const body = content[kind];
  if (kind === 'conversation') return { type: 'text', text: body };
  if (kind === 'extendedTextMessage') return { type: 'text', text: body.text };
  if (MEDIA_TYPES[kind]) {
    const inner = kind === 'documentWithCaptionMessage' ? body.message?.documentMessage : body;
    const type = MEDIA_TYPES[kind] === 'audio' && inner?.ptt ? 'voice' : MEDIA_TYPES[kind];
    return {
      type,
      text: inner?.caption || undefined,
      mime: inner?.mimetype || undefined,
      fileName: inner?.fileName || undefined,
    };
  }
  if (kind === 'locationMessage' || kind === 'liveLocationMessage') {
    const label = [body.name, body.address].filter(Boolean).join(', ');
    return { type: 'location', text: `${label ? `${label} ` : ''}(${body.degreesLatitude}, ${body.degreesLongitude})` };
  }
  if (kind === 'contactMessage') return { type: 'contact', text: body.displayName };
  if (kind === 'contactsArrayMessage') return { type: 'contact', text: (body.contacts || []).map((c) => c.displayName).join(', ') };
  if (kind === 'pollCreationMessage' || kind === 'pollCreationMessageV2' || kind === 'pollCreationMessageV3') {
    return { type: 'poll', text: `${body.name}\n${(body.options || []).map((o) => `• ${o.optionName}`).join('\n')}` };
  }
  if (kind === 'reactionMessage') return { type: 'reaction', text: body.text || '' };
  if (kind === 'protocolMessage') return { type: 'protocol' };
  if (kind === 'buttonsResponseMessage') return { type: 'text', text: body.selectedDisplayText };
  // Business messages: templates, buttons and lists
  if (kind === 'templateMessage') {
    const t = body.hydratedTemplate || body.hydratedFourRowTemplate || body.fourRowTemplate;
    const text = [t?.hydratedTitleText, t?.hydratedContentText || t?.content?.namespace, t?.hydratedFooterText]
      .filter(Boolean).join('\n') || body.interactiveMessageTemplate?.body?.text;
    return { type: 'text', text: text || '[mensaje de empresa]' };
  }
  if (kind === 'interactiveMessage') {
    const text = [body.header?.title, body.body?.text, body.footer?.text].filter(Boolean).join('\n');
    return { type: 'text', text: text || '[mensaje de empresa]' };
  }
  if (kind === 'buttonsMessage') return { type: 'text', text: [body.contentText, body.footerText].filter(Boolean).join('\n') || body.text };
  if (kind === 'listMessage') return { type: 'text', text: [body.title, body.description].filter(Boolean).join('\n') };
  if (kind === 'interactiveResponseMessage') return { type: 'text', text: body.body?.text || '' };
  if (kind === 'listResponseMessage') return { type: 'text', text: body.title };
  if (kind === 'templateButtonReplyMessage') return { type: 'text', text: body.selectedDisplayText };
  if (kind === 'eventMessage') return { type: 'event', text: body.name };
  return { type: kind.replace(/Message$/, '') };
}

export function encodeRaw(msg) {
  try {
    return proto.WebMessageInfo.encode(msg).finish();
  } catch {
    return null;
  }
}

export function decodeRaw(bytes) {
  return bytes ? proto.WebMessageInfo.decode(bytes) : null;
}

// Result:
//   { kind: 'message', row }                  a message to store
//   { kind: 'reaction', chatJid, targetId, reactor, emoji }
//   { kind: 'revoke', chatJid, targetId }
//   { kind: 'edit', chatJid, targetId, text }
//   null                                       nothing to store
export function parseMessage(msg, { meJid } = {}) {
  const key = msg?.key;
  if (!key?.remoteJid || !key.id) return null;
  if (key.remoteJid === 'status@broadcast') return null;
  const content = normalizeMessageContent(msg.message);
  // The phone jid when WhatsApp sent the LID one and told us both
  const chatJid = key.remoteJidAlt && key.remoteJid.endsWith('@lid') ? key.remoteJidAlt : key.remoteJid;
  const isGroup = chatJid.endsWith('@g.us');
  const fromMe = !!key.fromMe;
  const participant = key.participantAlt && key.participant?.endsWith('@lid') ? key.participantAlt : key.participant;
  const sender = fromMe ? meJid || 'me' : (isGroup ? participant : chatJid) || chatJid;

  if (!content) {
    // A message WhatsApp could not decrypt yet, or a system notice
    if (msg.messageStubType) return null;
    return null;
  }

  if (content.protocolMessage) {
    const p = content.protocolMessage;
    const targetId = p.key?.id;
    if (!targetId) return null;
    if (p.type === proto.Message.ProtocolMessage.Type.REVOKE) return { kind: 'revoke', chatJid, targetId };
    if (p.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
      const edited = describeContent(normalizeMessageContent(p.editedMessage));
      return { kind: 'edit', chatJid, targetId, text: edited.text || '' };
    }
    return null;
  }

  if (content.reactionMessage) {
    const r = content.reactionMessage;
    if (!r.key?.id) return null;
    return { kind: 'reaction', chatJid, targetId: r.key.id, reactor: sender, emoji: r.text || '' };
  }

  const info = describeContent(content);
  if (info.type === 'unknown') return null;
  const ctx = contextOf(content);
  return {
    kind: 'message',
    row: {
      chatJid,
      id: key.id,
      fromMe,
      sender,
      senderName: fromMe ? null : msg.pushName || msg.verifiedBizName || null,
      timestamp: toNumber(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      type: info.type,
      text: info.text ?? null,
      quotedId: ctx?.stanzaId || null,
      quotedText: quotedText(ctx?.quotedMessage) || null,
      status: msg.status ?? null,
      mediaMime: info.mime || null,
      mediaName: info.fileName || null,
      raw: encodeRaw(msg),
    },
    // LID ↔ phone pairs learned from this message
    mappings: [
      [key.remoteJid, key.remoteJidAlt],
      [key.participant, key.participantAlt],
    ].filter(([a, b]) => a && b),
  };
}
