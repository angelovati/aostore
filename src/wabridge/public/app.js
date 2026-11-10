'use strict';
// WaBridge web client. Every URL is relative so the app also works under a
// subpath (umbrelOS, Home Assistant ingress).

const $ = (id) => document.getElementById(id);
const state = {
  status: null,
  chats: [],
  current: null, // jid
  messages: [],
  replyTo: null,
  settings: null,
  loadingOlder: false,
  noMoreOlder: false,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body && !(options.body instanceof Blob) ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(text, isError) {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// WhatsApp formatting: *bold* _italic_ ~strike~ ```mono``` and links
function formatText(text) {
  let html = esc(text);
  html = html.replace(/```([\s\S]+?)```/g, '<code>$1</code>');
  html = html.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=[\s).,!?:;]|$)/g, '$1<b>$2</b>');
  html = html.replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
  html = html.replace(/(^|[\s(])~(\S(?:[^~\n]*\S)?)~(?=[\s).,!?:;]|$)/g, '$1<s>$2</s>');
  html = html.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  return html.replace(/\n/g, '<br>');
}

const dayFmt = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' });
const shortFmt = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });

function chatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'ayer';
  return shortFmt.format(d);
}

const TYPE_LABEL = {
  image: '📷 Foto', video: '🎥 Video', audio: '🎵 Audio', voice: '🎤 Mensaje de voz', document: '📄 Documento',
  sticker: '💟 Sticker', location: '📍 Ubicación', contact: '👤 Contacto', poll: '📊 Encuesta', event: '📅 Evento',
};

function preview(m) {
  if (!m) return '';
  if (m.deleted) return '🚫 Mensaje eliminado';
  const label = TYPE_LABEL[m.type];
  if (label && m.text && m.type !== 'location' && m.type !== 'poll') return `${label.split(' ')[0]} ${m.text}`;
  return m.text || label || `[${m.type}]`;
}

function initials(name) {
  const parts = String(name || '?').replace(/^\+/, '').split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (/^\d/.test(parts[0])) return '#';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

function hue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// ---- connection status ------------------------------------------------------

const STATUS_TEXT = {
  starting: 'iniciando…', connecting: 'conectando…', reconnecting: 'reconectando…', qr: 'sin vincular',
  open: 'conectado', logged_out: 'sesión cerrada', error: 'error',
};

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const linked = s.status === 'open' || ((s.status === 'reconnecting' || s.status === 'connecting') && s.me);
  $('link-screen').hidden = linked;
  $('app').hidden = !linked;
  if (!linked) {
    $('qr').hidden = !s.qr;
    if (s.qr) $('qr').src = s.qr;
    $('qr-wait').hidden = !!s.qr;
    $('qr-wait').textContent = s.status === 'error' ? 'No se pudo conectar con WhatsApp. Reintentando…' : 'Generando código…';
    $('link-error').hidden = !s.error;
    $('link-error').textContent = s.error || '';
    $('pairing-code').hidden = !s.pairingCode;
    $('pairing-code').textContent = s.pairingCode ? s.pairingCode.replace(/(.{4})(.{4})/, '$1-$2') : '';
  }
  $('me-name').textContent = s.me?.name || (s.me?.jid ? `+${s.me.jid.split('@')[0]}` : 'WhatsApp');
  $('conn-status').textContent = STATUS_TEXT[s.status] || s.status;
  $('conn-status').className = s.status === 'open' ? 'ok' : 'warn';
  $('sync-note').hidden = !s.syncing;
  $('account-info').textContent = s.me ? `Vinculado como ${s.me.name || ''} +${s.me.jid.split('@')[0]}.` : 'Sin vincular.';
}

// ---- chat list ----------------------------------------------------------------

async function loadChats() {
  const q = $('search').value.trim();
  state.chats = await api(`api/chats?limit=150${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  renderChats();
}

function renderChats() {
  const list = $('chat-list');
  const q = $('search').value.trim();
  const digits = q.replace(/[\s\-()+]/g, '');
  let html = '';
  if (/^\d{8,15}$/.test(digits) && !state.chats.some((c) => c.phone === digits)) {
    html += `<li class="chat-item new" data-jid="${esc(digits)}@s.whatsapp.net">
      <div class="avatar" style="--h:140">+</div>
      <div class="chat-main"><div class="chat-row"><b>Escribir a +${esc(digits)}</b></div></div></li>`;
  }
  html += state.chats.map((c) => `
    <li class="chat-item${c.jid === state.current ? ' active' : ''}" data-jid="${esc(c.jid)}">
      <div class="avatar" style="--h:${hue(c.jid)}">${c.isGroup ? '👥' : esc(initials(c.name))}</div>
      <div class="chat-main">
        <div class="chat-row"><b class="ellipsis">${esc(c.name)}</b><small class="${c.unread ? 'unread-time' : ''}">${chatTime(c.lastTimestamp)}</small></div>
        <div class="chat-row"><span class="ellipsis last">${c.lastMessage?.fromMe ? '<span class="ticks">✓</span> ' : ''}${esc(preview(c.lastMessage))}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
      </div>
    </li>`).join('');
  if (!html) html = `<li class="list-empty">${q ? 'No hay chats que coincidan.' : 'Todavía no hay chats. Los mensajes del teléfono aparecen a medida que se sincronizan.'}</li>`;
  list.innerHTML = html;
}

$('chat-list').addEventListener('click', (e) => {
  const li = e.target.closest('.chat-item');
  if (li) location.hash = `chat=${encodeURIComponent(li.dataset.jid)}`;
});

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadChats().catch((err) => toast(err.message, true)), 200);
});

$('new-chat').addEventListener('click', () => {
  $('search').value = '';
  $('search').placeholder = 'Número con código de país, p. ej. 5491122334455';
  $('search').focus();
  loadChats();
});

// ---- conversation -------------------------------------------------------------

function statusTicks(m) {
  if (!m.fromMe) return '';
  // 1 pending, 2 sent, 3 delivered, 4 read, 5 played
  if (m.status >= 4) return '<span class="ticks read">✓✓</span>';
  if (m.status === 3) return '<span class="ticks">✓✓</span>';
  if (m.status === 2) return '<span class="ticks">✓</span>';
  return '<span class="ticks">🕓</span>';
}

function mediaHtml(m) {
  if (!m.media || m.deleted) return '';
  const src = `api/media/${encodeURIComponent(m.chatJid)}/${encodeURIComponent(m.id)}`;
  if (m.type === 'image' || m.type === 'sticker') {
    return `<a href="${src}" target="_blank" rel="noopener"><img class="media-img${m.type === 'sticker' ? ' sticker' : ''}" loading="lazy" src="${src}" alt="${esc(TYPE_LABEL[m.type])}"></a>`;
  }
  if (m.type === 'video') return `<video class="media-img" controls preload="none" src="${src}"></video>`;
  if (m.type === 'audio' || m.type === 'voice') return `<audio controls preload="none" src="${src}"></audio>`;
  return `<a class="doc" href="${src}" target="_blank" rel="noopener">📄 ${esc(m.media.name || 'Documento')}</a>`;
}

function messageHtml(m, chat) {
  const reactions = Object.values(m.reactions || {});
  const text = m.deleted
    ? '<i class="muted">🚫 Se eliminó este mensaje</i>'
    : m.text
      ? formatText(m.text)
      : m.media ? '' : `<i class="muted">${esc(TYPE_LABEL[m.type] || `[${m.type}]`)}</i>`;
  return `<div class="msg ${m.fromMe ? 'out' : 'in'}" data-id="${esc(m.id)}">
    <div class="bubble">
      ${chat?.isGroup && !m.fromMe ? `<div class="sender" style="--h:${hue(m.sender)}">${esc(m.senderLabel || (m.sender || '').split('@')[0])}</div>` : ''}
      ${m.quotedId ? `<div class="quoted">${esc(m.quotedText || 'Mensaje')}</div>` : ''}
      ${mediaHtml(m)}
      ${text ? `<div class="text">${text}</div>` : ''}
      <div class="meta">${m.edited ? 'editado · ' : ''}${timeFmt.format(new Date(m.timestamp * 1000))} ${statusTicks(m)}</div>
      ${reactions.length ? `<div class="reactions">${esc([...new Set(reactions)].join(''))}${reactions.length > 1 ? ` ${reactions.length}` : ''}</div>` : ''}
      <div class="actions">
        <button type="button" data-act="reply" title="Responder">↩</button>
        <button type="button" data-act="react" data-emoji="👍" title="Reaccionar">👍</button>
        <button type="button" data-act="react" data-emoji="❤️">❤️</button>
        <button type="button" data-act="react" data-emoji="😂">😂</button>
      </div>
    </div>
  </div>`;
}

function renderMessages({ keepScroll } = {}) {
  const box = $('messages');
  const chat = state.chats.find((c) => c.jid === state.current) || state.chatInfo;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  let lastDay = '';
  box.innerHTML = state.messages.map((m) => {
    const day = dayFmt.format(new Date(m.timestamp * 1000));
    const sep = day !== lastDay ? `<div class="day"><span>${esc(day)}</span></div>` : '';
    lastDay = day;
    return sep + messageHtml(m, chat);
  }).join('') || '<div class="day"><span>No hay mensajes guardados en este chat</span></div>';
  if (keepScroll === 'older') box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  else if (keepScroll && !nearBottom) box.scrollTop = prevTop;
  else box.scrollTop = box.scrollHeight;
}

async function openChat(jid) {
  state.current = jid;
  state.replyTo = null;
  state.noMoreOlder = false;
  $('reply-preview').hidden = true;
  document.body.classList.toggle('in-chat', !!jid);
  $('empty').hidden = !!jid;
  $('chat').hidden = !jid;
  renderChats();
  if (!jid) return;
  const info = await api(`api/chats/${encodeURIComponent(jid)}`);
  state.chatInfo = info;
  $('chat-name').textContent = info.name;
  $('chat-sub').textContent = info.isGroup ? 'grupo' : info.phone ? `+${info.phone}` : '';
  state.messages = await api(`api/chats/${encodeURIComponent(jid)}/messages?limit=80`);
  renderMessages();
  $('text').focus();
  if (info.unread) api(`api/chats/${encodeURIComponent(jid)}/read`, { method: 'POST' }).then(loadChats).catch(() => {});
}

async function refreshMessages() {
  if (!state.current) return;
  const jid = state.current;
  const count = Math.max(80, state.messages.length);
  const messages = await api(`api/chats/${encodeURIComponent(jid)}/messages?limit=${Math.min(500, count)}`);
  if (jid !== state.current) return;
  state.messages = messages;
  renderMessages({ keepScroll: true });
}

$('messages').addEventListener('scroll', async () => {
  const box = $('messages');
  if (box.scrollTop > 60 || state.loadingOlder || state.noMoreOlder || !state.messages.length) return;
  state.loadingOlder = true;
  try {
    const older = await api(`api/chats/${encodeURIComponent(state.current)}/messages?limit=80&before=${state.messages[0].timestamp}`);
    if (!older.length) state.noMoreOlder = true;
    const ids = new Set(state.messages.map((m) => m.id));
    state.messages = [...older.filter((m) => !ids.has(m.id)), ...state.messages];
    if (older.length) renderMessages({ keepScroll: 'older' });
  } finally {
    state.loadingOlder = false;
  }
});

$('messages').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.msg').dataset.id;
  const m = state.messages.find((x) => x.id === id);
  if (btn.dataset.act === 'reply') {
    state.replyTo = id;
    $('reply-text').textContent = preview(m);
    $('reply-preview').hidden = false;
    $('text').focus();
  } else {
    const mine = state.status?.me?.jid;
    const current = mine && m.reactions?.[mine];
    const emoji = current === btn.dataset.emoji ? '' : btn.dataset.emoji;
    try {
      await api('api/react', { method: 'POST', body: JSON.stringify({ chat: state.current, id, emoji }) });
      refreshMessages();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

$('reply-cancel').addEventListener('click', () => {
  state.replyTo = null;
  $('reply-preview').hidden = true;
});

$('back').addEventListener('click', () => { location.hash = ''; });

const textarea = $('text');
textarea.addEventListener('input', () => {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
});
textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = textarea.value;
  if (!text.trim() || !state.current) return;
  textarea.value = '';
  textarea.style.height = 'auto';
  const replyTo = state.replyTo;
  state.replyTo = null;
  $('reply-preview').hidden = true;
  try {
    const sent = await api('api/send', { method: 'POST', body: JSON.stringify({ to: state.current, text, replyTo }) });
    if (sent?.chatJid && sent.chatJid !== state.current) location.hash = `chat=${encodeURIComponent(sent.chatJid)}`;
    else await refreshMessages();
    loadChats();
  } catch (err) {
    textarea.value = text;
    toast(err.message, true);
  }
});

$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  $('file').value = '';
  if (!file || !state.current) return;
  const caption = textarea.value.trim();
  toast(`Enviando ${file.name}…`);
  try {
    await api(`api/send-media?to=${encodeURIComponent(state.current)}&name=${encodeURIComponent(file.name)}${caption ? `&caption=${encodeURIComponent(caption)}` : ''}`, {
      method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
    textarea.value = '';
    await refreshMessages();
    loadChats();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- settings -------------------------------------------------------------------

function appBase() {
  return new URL('.', location.href).href;
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  const direct = s.mcpPublicPort ? `${location.protocol === 'https:' ? 'http:' : location.protocol}//${location.hostname}:${s.mcpPublicPort}/` : appBase();
  const mcpUrl = `${direct}mcp/${s.mcpToken}`;
  const channelUrl = `${direct}channel/${s.mcpToken}`;
  $('mcp-url').value = mcpUrl;
  $('mcp-cmd').value = `claude mcp add --transport http whatsapp ${mcpUrl}`;
  $('desktop-config').textContent = JSON.stringify({ mcpServers: { whatsapp: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--allow-http'] } } }, null, 2);
  $('channel-config').textContent = JSON.stringify({ mcpServers: { whatsapp: { command: 'node', args: ['/ruta/a/whatsapp-channel.mjs', channelUrl] } } }, null, 2);
  $('read-only').checked = s.mcpReadOnly;
  $('webhook-url').value = s.webhookUrl || '';
  $('webhook-secret').value = s.webhookSecret || '';
  $('webhook-groups').checked = s.webhookGroups;
}

async function saveSettings(patch) {
  try {
    state.settings = await api('api/settings', { method: 'PUT', body: JSON.stringify(patch) });
    renderSettings();
    toast('Guardado');
  } catch (err) {
    toast(err.message, true);
  }
}

$('open-settings').addEventListener('click', async () => {
  state.settings = await api('api/settings');
  renderSettings();
  $('settings').showModal();
});
$('read-only').addEventListener('change', () => saveSettings({ mcpReadOnly: $('read-only').checked }));
$('webhook-groups').addEventListener('change', () => saveSettings({ webhookGroups: $('webhook-groups').checked }));
$('webhook-save').addEventListener('click', () => saveSettings({ webhookUrl: $('webhook-url').value }));
$('webhook-test').addEventListener('click', () => api('api/settings/webhook-test', { method: 'POST' })
  .then(() => toast('Mensaje de prueba enviado')).catch((err) => toast(err.message, true)));
$('new-token').addEventListener('click', async () => {
  if (!confirm('Los clientes MCP configurados con la dirección actual van a dejar de funcionar. ¿Seguir?')) return;
  state.settings = await api('api/settings/mcp-token', { method: 'POST' });
  renderSettings();
});
$('logout').addEventListener('click', async () => {
  if (!confirm('Se desvincula este dispositivo de tu WhatsApp y se borran los mensajes guardados en el Umbrel. ¿Seguir?')) return;
  $('settings').close();
  try {
    await api('api/logout', { method: 'POST' });
  } catch (err) {
    toast(err.message, true);
  }
});
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-copy]');
  if (!btn) return;
  const input = $(btn.dataset.copy);
  input.select();
  (navigator.clipboard?.writeText(input.value) || Promise.reject()).catch(() => document.execCommand('copy'));
  toast('Copiado');
});

$('pairing-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { code } = await api('api/pairing-code', { method: 'POST', body: JSON.stringify({ phone: $('pairing-phone').value }) });
    if (!code) toast('Pidiendo el código…');
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- live updates ---------------------------------------------------------------

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!$('app').hidden) {
      loadChats().catch(() => {});
      refreshMessages().catch(() => {});
    }
  }, 150);
}

function connectEvents() {
  const es = new EventSource('api/events');
  es.addEventListener('status', (e) => {
    const wasHidden = $('app').hidden;
    state.status = JSON.parse(e.data);
    renderStatus();
    if (wasHidden && !$('app').hidden) {
      loadChats().catch(() => {});
      route();
    }
  });
  es.addEventListener('message', (e) => {
    const { message, live } = JSON.parse(e.data);
    if (live && !message.fromMe && document.hidden && Notification?.permission === 'granted') {
      const chat = state.chats.find((c) => c.jid === message.chatJid);
      new Notification(chat?.name || message.senderName || 'WhatsApp', { body: preview(message), icon: 'icon.svg', tag: message.chatJid });
    }
    if (live && message.chatJid === state.current && !message.fromMe && !document.hidden) {
      api(`api/chats/${encodeURIComponent(state.current)}/read`, { method: 'POST' }).catch(() => {});
    }
    scheduleRefresh();
  });
  es.addEventListener('change', scheduleRefresh);
}

function route() {
  const m = /chat=([^&]+)/.exec(location.hash);
  openChat(m ? decodeURIComponent(m[1]) : null).catch((err) => toast(err.message, true));
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.current && state.chatInfo?.unread) {
    api(`api/chats/${encodeURIComponent(state.current)}/read`, { method: 'POST' }).then(loadChats).catch(() => {});
  }
});
document.addEventListener('click', () => {
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
}, { once: true });

connectEvents();
