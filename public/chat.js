// chat.js — WebSocket, message rendering, send actions
import { watch, delegate, esc, $ } from './lib.js';
import { ctx, isProcessing, currentProject, currentTab } from './state.js';
import { sendWs } from './api.js';

// ── WebSocket ─────────────────────────────────────────────────────────────────
export function connectWS() {
  ctx.ws?.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ctx.ws = new WebSocket(`${proto}://${location.host}/ws/chat?token=${ctx.token}`);
  ctx.ws.addEventListener('open',    () => appendSystemMsg('Connected'));
  ctx.ws.addEventListener('message', e  => handleWsMessage(JSON.parse(e.data)));
  ctx.ws.addEventListener('close',   () => { if (isProcessing.peek()) { appendSystemMsg('Connection closed'); isProcessing.value = false; } });
  ctx.ws.addEventListener('error',   () => { appendSystemMsg('WebSocket error'); isProcessing.value = false; });
}

function handleWsMessage(msg) {
  if (msg.type === 'session-created') {
    ctx.sessionId = msg.sessionId;
    // Notify shell to refresh session list — use custom event to avoid circular import
    document.dispatchEvent(new CustomEvent('sessions-changed'));
    return;
  }
  if (msg.type === 'complete')    { isProcessing.value = false; if (!msg.aborted) appendSystemMsg('✓ Done'); return; }
  if (msg.type === 'error')       { appendMsg('error', 'Error', msg.message); isProcessing.value = false; return; }
  if (msg.type === 'shell-start') { ctx.shellBubble = null; return; }
  if (msg.type === 'shell-output') {
    if (!ctx.shellBubble) ctx.shellBubble = appendStreamBubble(msg.stream === 'stderr' ? 'shell-err' : 'shell');
    appendToStreamBubble(ctx.shellBubble, msg.data);
    return;
  }
  if (msg.type === 'shell-exit') {
    ctx.shellBubble = null;
    appendSystemMsg(msg.code === 0 ? '✓ Exit 0' : `✗ Exit ${msg.code}${msg.error ? ': ' + msg.error : ''}`);
    isProcessing.value = false;
    return;
  }
  if (msg.type === 'assistant') {
    for (const block of (msg.message?.content || [])) {
      if (block.type === 'text' && block.text) appendMsg('assistant', 'Claude', block.text);
      else if (block.type === 'tool_use')      renderToolUse(block);
    }
    return;
  }
  if (msg.type === 'permission_request' || (msg.request_id && msg.tool_name))
    renderPermissionRequest(msg);
}

// ── Send / control ────────────────────────────────────────────────────────────
export function sendMessage() {
  const input = $('chat-input');
  const text  = input?.value.trim();
  if (!text || isProcessing.peek() || !currentProject.peek()) return;
  input.value = '';
  autoResize(input);
  updateInputMode('');
  isProcessing.value = true;
  if (text.startsWith('!')) {
    appendMsg('shell', '$ Shell', text.slice(1).trim());
    sendWs({ type: 'shell-command', command: text.slice(1).trim(), cwd: currentProject.peek().path });
  } else {
    appendMsg('user', 'You', text);
    sendWs({ type: 'claude-command', command: text, options: { cwd: currentProject.peek().path, sessionId: ctx.sessionId } });
  }
}

export function stopProcessing() {
  if (ctx.sessionId) sendWs({ type: 'abort-session', sessionId: ctx.sessionId });
  isProcessing.value = false;
}

export function newSession() {
  ctx.sessionId = null;
  clearMessages();
  appendSystemMsg('New session — type to start');
}

// ── Input helpers ─────────────────────────────────────────────────────────────
function updateInputMode(value) {
  const isShell = value.startsWith('!');
  const input = $('chat-input'), btn = $('send-btn');
  if (!input || !btn) return;
  input.classList.toggle('textarea-warning', isShell);
  input.style.fontFamily = isShell ? 'monospace' : '';
  btn.classList.toggle('btn-warning', isShell);
  btn.classList.toggle('btn-primary', !isShell);
  btn.textContent = isShell ? 'Run' : 'Send';
  input.placeholder = isShell ? 'Shell command (without !)…' : 'Ask Claude… or !cmd for shell';
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

// ── Message rendering ─────────────────────────────────────────────────────────
const MSG_CLS = {
  user:        'bg-primary/10 border border-primary/20',
  assistant:   'bg-base-300',
  shell:       'bg-[#0d1117] border border-base-300 font-mono text-[#c9d1d9]',
  'shell-err': 'bg-[#0d1117] border border-base-300 font-mono text-error',
  error:       'bg-error/8 border border-error/20 text-error',
  system:      '!bg-transparent !border-0 !px-0 !py-0.5 text-base-content/40',
};

export function appendMsg(role, label, text) {
  const msgs = $('messages');
  if (!msgs) return;
  const labelHtml = role !== 'system'
    ? `<div class="text-[10px] uppercase tracking-wider text-base-content/40">${esc(label || role)}</div>` : '';
  const cls = `rounded-lg px-3 py-2 text-sm leading-relaxed break-words ${MSG_CLS[role] || 'bg-base-300'}`;
  const body = role === 'assistant'
    ? `<div class="${cls} md">${renderMarkdown(text)}</div>`
    : `<div class="${cls}" style="white-space:pre-wrap">${esc(text)}</div>`;
  msgs.insertAdjacentHTML('beforeend', `<div class="flex flex-col gap-1">${labelHtml}${body}</div>`);
  msgs.scrollTop = msgs.scrollHeight;
}

export function appendSystemMsg(text) { appendMsg('system', '', text); }

export function clearMessages() {
  const msgs = $('messages'), perms = $('permission-requests');
  if (msgs)  msgs.innerHTML  = '';
  if (perms) perms.innerHTML = '';
  ctx.shellBubble = null;
}

function appendStreamBubble(role) {
  const msgs = $('messages');
  if (!msgs) return null;
  msgs.insertAdjacentHTML('beforeend', `<div class="flex flex-col gap-1">
    <div class="text-[10px] uppercase tracking-wider text-base-content/40">${role === 'shell-err' ? 'stderr' : 'stdout'}</div>
    <div class="rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${MSG_CLS[role] || 'bg-base-300'}"></div>
  </div>`);
  msgs.scrollTop = msgs.scrollHeight;
  return msgs.lastElementChild.querySelector('div:last-child');
}

function appendToStreamBubble(el, text) {
  if (!el) return;
  el.textContent += text;
  el.closest('#messages').scrollTop = 999999;
}

export function renderToolUse(block) {
  const msgs = $('messages');
  if (!msgs) return;
  const inputStr = typeof block.input === 'object' ? JSON.stringify(block.input, null, 2) : String(block.input || '');
  const first    = typeof block.input === 'object' ? Object.values(block.input).find(v => typeof v === 'string' && v.trim()) : inputStr;
  const preview  = (first || '').replace(/\n/g, ' ').slice(0, 80);
  msgs.insertAdjacentHTML('beforeend', `<div class="flex flex-col gap-1">
    <div class="rounded-lg border border-success/15 bg-success/5 px-3 py-2 tool-card cursor-pointer select-none">
      <div class="flex items-center gap-2 text-xs font-mono">
        <span class="text-warning">⚡</span>
        <span class="text-warning font-semibold">${esc(block.name)}</span>
        <span class="text-base-content/50 truncate flex-1">${esc(preview)}</span>
        <span class="tool-chevron text-[10px] text-base-content/40">▶</span>
      </div>
      <div class="tool-detail mt-2 p-2 bg-[#0d1117] rounded border border-base-300
                  font-mono text-[11px] text-[#c9d1d9] overflow-x-auto whitespace-pre max-h-72 overflow-y-auto">${esc(inputStr)}</div>
    </div>
  </div>`);
  msgs.scrollTop = msgs.scrollHeight;
}

function renderPermissionRequest(msg) {
  const id = msg.request_id || msg.requestId;
  if (!id || $(`perm-${id}`)) return;
  const inputStr = msg.tool_input ? JSON.stringify(msg.tool_input).slice(0, 200) : '';
  $('permission-requests')?.insertAdjacentHTML('beforeend', `
    <div id="perm-${id}" class="perm-banner mx-3 mb-2 rounded-lg border border-warning/25 bg-warning/8 p-3">
      <div class="text-xs text-warning font-semibold mb-1">⚠️ Permission Required</div>
      <div class="font-mono text-xs text-base-content/60 break-all mb-2">
        <strong class="text-base-content">${esc(msg.tool_name || '')}</strong> ${esc(inputStr)}
      </div>
      <div class="flex gap-2">
        <button class="btn btn-success btn-xs" data-perm-id="${id}" data-perm-allow="1">Allow</button>
        <button class="btn btn-error btn-xs"   data-perm-id="${id}" data-perm-allow="0">Deny</button>
      </div>
    </div>`);
  $('messages').scrollTop = 999999;
}

function renderMarkdown(text) {
  if (typeof marked === 'undefined') return esc(text);
  try { return marked.parse(text, { breaks: true, gfm: true }); } catch { return esc(text); }
}

// ── Init (called after HTML is in DOM) ────────────────────────────────────────
export function initChat() {
  // Processing state → send/stop buttons + typing indicator
  watch(isProcessing, val => {
    $('send-btn')?.classList.toggle('hidden', val);
    $('stop-btn')?.classList.toggle('hidden', !val);
    const input = $('chat-input');
    if (input) input.disabled = val;
    const msgs = $('messages');
    if (!msgs) return;
    const existing = $('typing-indicator');
    if (val && !existing) {
      msgs.insertAdjacentHTML('beforeend',
        '<div id="typing-indicator" class="flex items-center gap-2 text-xs text-base-content/40 px-1 py-1"><span class="dot"></span><span class="dot"></span><span class="dot"></span> Processing…</div>');
      msgs.scrollTop = msgs.scrollHeight;
    } else if (!val) existing?.remove();
  });

  // Chat input: Enter = send, auto-resize, shell mode styling
  delegate.on('keydown', '#chat-input', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  delegate.on('input',   '#chat-input', (e, el) => { autoResize(el); updateInputMode(el.value); });

  // Permission buttons
  delegate.on('click', '[data-perm-id]', (e, el) => {
    sendWs({ type: 'claude-permission-response', requestId: el.dataset.permId, allow: el.dataset.permAllow === '1' });
    el.closest('.perm-banner')?.remove();
  });

  // Tool card expand/collapse
  delegate.on('click', '.tool-card', (e, el) => {
    el.classList.toggle('open');
    $('messages')?.scrollTo({ top: 999999 });
  });
}
