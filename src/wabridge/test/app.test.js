import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../server.js';
import { createFakeSocketFactory, incoming } from './fake-socket.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fake = createFakeSocketFactory();
const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wabridge-')), makeSocket: fake.makeSocket, fetchVersion: async () => ({ version: [2, 3000, 1111], isLatest: true }) });
let base;
let mcpBase;
let client;
const token = () => app.settings().mcpToken;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`)));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const getJson = async (p, opts) => (await fetch(base + p, opts)).json();
const tool = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, data: r.isError ? null : JSON.parse(r.content[0].text) };
};

test.before(async () => {
  base = await listen(app.server);
  mcpBase = await listen(app.mcpServer);
  await until(() => fake.last());
  fake.last().ev.emit('connection.update', { qr: 'test-qr' });
  await until(() => app.wa.state.status === 'qr');
  fake.last().ev.emit('connection.update', { connection: 'open' });
  await until(() => app.wa.connected);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpBase}mcp/${token()}`)));
});

test.after(async () => {
  await client?.close();
  app.close();
});

test('the QR is shown as an image until the phone links', async () => {
  // (checked in before(): status went qr → open)
  const s = await getJson('api/status');
  assert.equal(s.status, 'open');
  assert.equal(s.me.jid, '5491100000000@s.whatsapp.net');
  assert.equal(s.qr, null);
});

test('history and live messages show up in the chat list', async () => {
  const sock = fake.last();
  sock.ev.emit('messaging-history.set', {
    chats: [{ id: '5491122223333@s.whatsapp.net', unreadCount: 1, conversationTimestamp: 1700000000 }],
    contacts: [{ id: '5491122223333@s.whatsapp.net', name: 'Juan Pérez' }],
    messages: [incoming({ id: 'H1', text: 'mensaje viejo', ts: 1700000000 })],
    isLatest: true,
  });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [incoming({ id: 'LIVE1', text: '¿Venís a cenar?' })] });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [incoming({ group: '123@g.us', from: '5491144445555@s.whatsapp.net', id: 'G1', text: 'hola grupo', pushName: 'Ana' })] });
  const chats = await getJson('api/chats');
  const juan = chats.find((c) => c.jid === '5491122223333@s.whatsapp.net');
  assert.equal(juan.name, 'Juan Pérez');
  assert.equal(juan.unread, 2);
  assert.equal(juan.lastMessage.text, '¿Venís a cenar?');
  assert.equal(chats.find((c) => c.jid === '123@g.us').name, 'Familia');
  const msgs = await getJson(`api/chats/${encodeURIComponent(juan.jid)}/messages`);
  assert.deepEqual(msgs.map((m) => m.id), ['H1', 'LIVE1']);
  await fetch(`${base}api/chats/${encodeURIComponent(juan.jid)}/read`, { method: 'POST' });
  assert.equal((await getJson(`api/chats/${encodeURIComponent(juan.jid)}`)).unread, 0);
  assert.ok(sock.read.some((k) => k.id === 'LIVE1'));
});

test('the web app sends messages and reactions', async () => {
  const sent = await getJson('api/send', { method: 'POST', body: JSON.stringify({ to: '5491122223333@s.whatsapp.net', text: 'Sí, voy', replyTo: 'LIVE1' }) });
  assert.match(sent.id, /^SENT/);
  assert.equal(sent.fromMe, true);
  const sock = fake.last();
  assert.deepEqual(sock.sent.at(-1).content, { text: 'Sí, voy' });
  await getJson('api/react', { method: 'POST', body: JSON.stringify({ chat: '5491122223333@s.whatsapp.net', id: 'LIVE1', emoji: '❤️' }) });
  assert.equal(sock.sent.at(-1).content.react.text, '❤️');
  assert.equal(sock.sent.at(-1).content.react.key.id, 'LIVE1');
});

test('MCP: tools are listed and need the token', async () => {
  const { tools } = await client.listTools();
  for (const name of ['list_chats', 'get_messages', 'send_message', 'react_to_message', 'wait_for_messages', 'search_messages', 'get_media']) {
    assert.ok(tools.some((t) => t.name === name), name);
  }
  const bad = await fetch(`${mcpBase}mcp/wrong`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(bad.status, 401);
  // The MCP port serves nothing else
  assert.equal((await fetch(`${mcpBase}api/chats`)).status, 404);
  assert.equal((await fetch(`${mcpBase}`)).status, 404);
  // The bearer header works too
  const viaHeader = new Client({ name: 'h', version: '1' });
  await viaHeader.connect(new StreamableHTTPClientTransport(new URL(`${mcpBase}mcp/x`), { requestInit: { headers: { Authorization: `Bearer ${token()}` } } }));
  assert.ok((await viaHeader.listTools()).tools.length);
  await viaHeader.close();
});

test('MCP: read chats and messages, by name or number', async () => {
  const chats = (await tool('list_chats')).data;
  assert.ok(chats.some((c) => c.name === 'Juan Pérez'));
  const byName = (await tool('get_messages', { chat: 'Juan Pérez' })).data;
  assert.equal(byName.chat, '5491122223333@s.whatsapp.net');
  assert.deepEqual(byName.messages.map((m) => m.text), ['mensaje viejo', '¿Venís a cenar?', 'Sí, voy']);
  assert.equal(byName.messages[1].reactions[0].startsWith('❤️'), true);
  const byNumber = (await tool('get_messages', { chat: '+54 9 11 2222-3333', limit: 1 })).data;
  assert.equal(byNumber.messages.length, 1);
  const found = (await tool('search_messages', { query: 'cenar' })).data;
  assert.equal(found[0].id, 'LIVE1');
  const missing = await tool('get_messages', { chat: 'Nadie' });
  assert.equal(missing.isError, true);
});

test('MCP: send, react and read-only mode', async () => {
  const r = (await tool('send_message', { to: 'Familia', text: 'Llego 21 hs' })).data;
  assert.equal(r.chat, '123@g.us');
  assert.equal(fake.last().sent.at(-1).jid, '123@g.us');
  assert.equal((await tool('react_to_message', { chat: '123@g.us', message_id: 'G1', emoji: '👍' })).data.ok, true);
  const noWa = await tool('send_message', { to: '0001234567', text: 'x' });
  assert.match(noWa.content[0].text, /no tiene WhatsApp/);

  app.saveSettings({ mcpReadOnly: true });
  const blocked = await tool('send_message', { to: 'Familia', text: 'x' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /solo lectura/);
  app.saveSettings({ mcpReadOnly: false });
});

test('MCP: wait_for_messages returns when a message arrives', async () => {
  const { cursor } = (await tool('wait_for_messages', { timeout_seconds: 0 })).data;
  const waiting = tool('wait_for_messages', { cursor, timeout_seconds: 10 });
  setTimeout(() => fake.last().ev.emit('messages.upsert', { type: 'notify', messages: [incoming({ id: 'W1', text: 'despertá' })] }), 100);
  const t0 = Date.now();
  const r = (await waiting).data;
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(r.messages.map((m) => m.text), ['despertá']);
  assert.equal(r.messages[0].chat, '5491122223333@s.whatsapp.net');
  assert.ok(r.cursor > cursor);
  // Nothing new: returns empty after the timeout with the same cursor
  const empty = (await tool('wait_for_messages', { cursor: r.cursor, timeout_seconds: 0 })).data;
  assert.deepEqual(empty, { cursor: r.cursor, messages: [] });
});

test('webhook: incoming messages are POSTed with an HMAC signature', async () => {
  const received = [];
  const hook = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    received.push({ body, sig: req.headers['x-wabridge-signature'] });
    res.end('ok');
  });
  const hookUrl = await listen(hook);
  const s = await getJson('api/settings', { method: 'PUT', body: JSON.stringify({ webhookUrl: `${hookUrl}hook`, webhookGroups: false }) });
  assert.equal(s.webhookUrl, `${hookUrl}hook`);
  const sock = fake.last();
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [incoming({ group: '123@g.us', id: 'G2', text: 'grupo' })] });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [incoming({ id: 'WH1', text: 'para el webhook' })] });
  await until(() => received.length >= 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.message.text, 'para el webhook');
  assert.equal(payload.chat.name, 'Juan Pérez');
  const expected = crypto.createHmac('sha256', app.settings().webhookSecret).update(received[0].body).digest('hex');
  assert.equal(received[0].sig, `sha256=${expected}`);
  const bad = await fetch(`${base}api/settings`, { method: 'PUT', body: JSON.stringify({ webhookUrl: 'ftp://x' }) });
  assert.equal(bad.status, 400);
  await getJson('api/settings', { method: 'PUT', body: JSON.stringify({ webhookUrl: '' }) });
  hook.close();
});

test('channel bridge: messages become Claude Code channel notifications and reply sends', async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'channel', 'whatsapp-channel.mjs'), `${mcpBase}mcp/${token()}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const init = await until(() => lines.find((l) => l.id === 1));
    assert.deepEqual(init.result.capabilities.experimental, { 'claude/channel': {} });
    await until(() => stderr.includes('conectado'));
    fake.last().ev.emit('messages.upsert', { type: 'notify', messages: [incoming({ id: 'CH1', text: 'hola Claude' })] });
    const n = await until(() => lines.find((l) => l.method === 'notifications/claude/channel'));
    assert.equal(n.params.content, 'hola Claude');
    assert.equal(n.params.meta.chat_id, '5491122223333@s.whatsapp.net');
    assert.equal(n.params.meta.message_id, 'CH1');
    assert.equal(n.params.meta.sender_name, 'Juan');
    for (const k of Object.keys(n.params.meta)) assert.match(k, /^\w+$/);
    send({ id: 2, method: 'tools/call', params: { name: 'reply', arguments: { chat_id: n.params.meta.chat_id, text: 'Hola Juan', reply_to: 'CH1' } } });
    const r = await until(() => lines.find((l) => l.id === 2));
    assert.match(r.result.content[0].text, /enviado/);
    assert.deepEqual(fake.last().sent.at(-1).content, { text: 'Hola Juan' });
    send({ id: 3, method: 'tools/call', params: { name: 'fetch_messages', arguments: { chat_id: n.params.meta.chat_id, limit: 3 } } });
    const f = await until(() => lines.find((l) => l.id === 3));
    assert.match(f.result.content[0].text, /hola Claude/);
  } finally {
    child.kill();
  }
});

test('the phone unlinking the device goes back to the QR and wipes the data', async () => {
  const before = fake.sockets.length;
  fake.last().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(app.wa.state.status, 'logged_out');
  assert.equal((await getJson('api/chats')).length, 0);
  await until(() => fake.sockets.length > before, 3000);
});

test('frontend files use only relative URLs', () => {
  const absolute = [
    /(?:href|src|action)\s*=\s*["']\/(?!\/)/g,
    /url\(\s*["']?\/(?!\/)/g,
    /["'`]\/(?:api|mcp|channel)\b/g,
    /\bhistory\.(?:push|replace)State\b/g,
  ];
  for (const file of fs.readdirSync(path.join(ROOT, 'public'))) {
    const text = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    for (const re of absolute) assert.equal(text.match(re), null, `${file}: ${re}`);
  }
});

test('static files and the channel script download', async () => {
  const html = await fetch(base);
  assert.match(await html.text(), /Vinculá tu WhatsApp/);
  const script = await fetch(`${base}whatsapp-channel.mjs`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-disposition'), /attachment/);
  assert.equal((await fetch(`${base}..%2fserver.js`)).status, 404);
});
