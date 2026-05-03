// chat.js — WebSocket, message rendering, send actions
import { watch, delegate, esc, $ } from './lib.js';
import { ctx, isProcessing, currentProject, currentTab, currentModel, currentEffort, currentPermission } from './state.js';
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
  if (msg.type === 'result') {
    isProcessing.value = false;
    const u = msg.usage;
    if (u) {
      const cache  = u.cacheReadInputTokens  ? ` · ${fmtNum(u.cacheReadInputTokens)} cached` : '';
      const create = u.cacheCreationInputTokens ? ` · ${fmtNum(u.cacheCreationInputTokens)} cache-write` : '';
      const cost   = u.costUSD != null ? ` · $${u.costUSD.toFixed(4)}` : '';
      appendTokenBar(`↑${fmtNum(u.inputTokens)} ↓${fmtNum(u.outputTokens)}${cache}${create}${cost}`);
    }
    if (!msg.is_error) appendSystemMsg('✓ Done');
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

// ── Slash commands (client-side) ──────────────────────────────────────────────
const MODEL_ALIASES = {
  'haiku':   'claude-haiku-4-5',
  'sonnet':  'claude-sonnet-4-6',
  'opus':    'claude-opus-4-5',
  'sonnet4': 'claude-sonnet-4-6',
  'haiku4':  'claude-haiku-4-5',
};

// Returns true if handled, false if should be sent to model
function handleSlashCommand(text) {
  const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
  const arg = args.join(' ');

  switch (cmd.toLowerCase()) {
    case 'model': {
      if (!arg) {
        appendSystemMsg(`Current model: ${currentModel.peek()}`);
        return true;
      }
      const resolved = MODEL_ALIASES[arg.toLowerCase()] || arg;
      currentModel.value = resolved;
      appendSystemMsg(`Model set to ${resolved}`);
      return true;
    }
    case 'effort': {
      const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
      if (!arg) {
        appendSystemMsg(`Current effort: ${currentEffort.peek() || '(default)'} · levels: ${levels.join(' | ')}`);
        return true;
      }
      if (!levels.includes(arg.toLowerCase())) {
        appendSystemMsg(`Unknown effort level "${arg}" · valid: ${levels.join(' | ')}`);
        return true;
      }
      currentEffort.value = arg.toLowerCase();
      appendSystemMsg(`Effort set to ${arg.toLowerCase()}`);
      return true;
    }
    case 'clear':
      clearMessages();
      ctx.sessionId = null;
      appendSystemMsg('Cleared · new session');
      return true;
    default: {
      appendSystemMsg(`Available slash commands:\n  /model [haiku|sonnet|opus|<model-id>]\n  /effort [low|medium|high|xhigh|max]\n  /clear\n\nOther Claude Code slash commands require the CLI.`);
      return true;
    }
  }
}

// ── Send / control ────────────────────────────────────────────────────────────
export function sendMessage() {
  const input = $('chat-input');
  const text  = input?.value.trim();
  if (!text || isProcessing.peek() || !currentProject.peek()) return;
  input.value = '';
  autoResize(input);
  updateInputMode('');

  if (text.startsWith('/')) {
    handleSlashCommand(text);
    return;
  }

  isProcessing.value = true;
  if (text.startsWith('!')) {
    appendMsg('shell', '$ Shell', text.slice(1).trim());
    sendWs({ type: 'shell-command', command: text.slice(1).trim(), cwd: currentProject.peek().path });
  } else {
    appendMsg('user', 'You', text);
    const effort     = currentEffort.peek();
    const permission = currentPermission.peek();
    sendWs({ type: 'claude-command', command: text, options: {
      cwd:       currentProject.peek().path,
      sessionId: ctx.sessionId,
      configDir: ctx.configDir,
      model:     currentModel.peek(),
      ...(effort     && { effort }),
      ...(permission && permission !== 'default' && { permissionMode: permission }),
      ...(permission === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),
    }});
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
const USER_COLLAPSE = 200;
const ASST_COLLAPSE = 500;

function bubbleHtml(role, text) {
  const expandBtn = `<button class="msg-expand-btn text-[10px] text-primary/70 mt-1.5 block cursor-pointer hover:text-primary">▼ Show more</button>`;
  switch (role) {
    case 'user': {
      const hasImage = /!\[.*?\]\(.*?\)/.test(text);
      const rendered = hasImage ? renderMarkdown(text) : null;
      const long  = text.length > USER_COLLAPSE;
      const inner = long
        ? `<div class="msg-body">${rendered ?? esc(text.trimEnd())}</div>${expandBtn}`
        : (rendered ?? esc(text.trimEnd()));
      const style = rendered ? '' : ' style="white-space:pre-wrap"';
      return `<div class="flex justify-end px-2"><div class="max-w-[80%] rounded-2xl rounded-tr-sm px-3 py-2 text-sm bg-primary/15 border border-primary/20 text-base-content break-words${long ? ' msg-card' : ''}${rendered ? ' md' : ''}"${style}>${inner}</div></div>`;
    }
    case 'assistant': {
      const long = text.length > ASST_COLLAPSE;
      const inner = long ? `<div class="msg-body">${renderMarkdown(text)}</div>${expandBtn}` : renderMarkdown(text);
      return `<div class="flex justify-start px-2"><div class="max-w-[88%] rounded-2xl rounded-tl-sm px-3 py-2 text-sm bg-base-200 break-words md${long ? ' msg-card' : ''}">${inner}</div></div>`;
    }
    case 'error':
      return `<div class="flex justify-start px-2">
        <div class="max-w-[88%] rounded-2xl rounded-tl-sm px-3 py-2 text-sm bg-error/10 border border-error/20 text-error break-words" style="white-space:pre-wrap">${esc(text)}</div>
      </div>`;
    case 'shell':
    case 'shell-err':
      return `<div class="mx-2 rounded-lg bg-[#0d1117] border border-base-300 px-3 py-2 text-sm font-mono ${role === 'shell-err' ? 'text-error' : 'text-[#c9d1d9]'} break-words" style="white-space:pre-wrap">${esc(text)}</div>`;
    case 'system':
      return `<div class="text-center text-[11px] text-base-content/30 py-0.5 select-none">${esc(text)}</div>`;
    default:
      return `<div class="mx-2 rounded-lg px-3 py-2 text-sm bg-base-300 break-words" style="white-space:pre-wrap">${esc(text)}</div>`;
  }
}

export function appendMsg(role, _label, text) {
  const msgs = $('messages');
  if (!msgs) return;
  msgs.insertAdjacentHTML('beforeend', bubbleHtml(role, text));
  msgs.scrollTop = msgs.scrollHeight;
}

export function appendSystemMsg(text) { appendMsg('system', '', text); }

async function uploadImageBlob(blob, filename) {
  const res = await fetch('/api/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.token}`, 'x-filename': filename },
    body: blob,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return (await res.json()).path;
}

function insertAtCursor(ta, text) {
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.dispatchEvent(new Event('input'));
}

export function initImagePaste() {
  document.addEventListener('paste', async e => {
    const ta = $('chat-input');
    if (!ta || document.activeElement !== ta) return;
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find(i => i.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const blob = imageItem.getAsFile();
    const ext  = imageItem.type.split('/')[1] || 'png';
    const name = `paste-${Date.now()}.${ext}`;
    ta.disabled = true;
    try {
      const path = await uploadImageBlob(blob, name);
      insertAtCursor(ta, `![${name}](${path})`);
    } catch (err) {
      appendSystemMsg(`Image paste failed: ${err.message}`);
    } finally {
      ta.disabled = false;
      ta.focus();
    }
  });
}

export function attachImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.addEventListener('change', async () => {
    for (const file of input.files) {
      appendSystemMsg(`Uploading ${file.name}…`);
      try {
        const res = await fetch('/api/upload-image', {
          method: 'POST',
          headers: { Authorization: `Bearer ${ctx.token}`, 'x-filename': file.name },
          body: file,
        });
        const { path } = await res.json();
        // Insert path reference into chat input
        const ta = $('chat-input');
        if (ta) {
          ta.value += (ta.value ? '\n' : '') + path;
          ta.dispatchEvent(new Event('input'));
          ta.focus();
        }
        appendSystemMsg(`📎 ${path}`);
      } catch (e) { appendSystemMsg(`Upload failed: ${e.message}`); }
    }
  });
  input.click();
}

function fmtNum(n) { return n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n); }

function appendTokenBar(text) {
  const msgs = $('messages');
  if (!msgs) return;
  msgs.insertAdjacentHTML('beforeend',
    `<div class="flex items-center gap-1.5 px-1 py-0.5 text-[10px] font-mono text-base-content/30 select-none">
       <span class="text-base-content/20">◈</span>${esc(text)}
     </div>`);
  msgs.scrollTop = msgs.scrollHeight;
}

// Called when loading history from JSONL (usage keys use snake_case from file)
export function appendHistoryTokenBar(u) {
  if (!u) return;
  const cache  = u.cache_read_input_tokens   ? ` · ${fmtNum(u.cache_read_input_tokens)} cached` : '';
  const create = u.cache_creation_input_tokens ? ` · ${fmtNum(u.cache_creation_input_tokens)} cache-write` : '';
  appendTokenBar(`↑${fmtNum(u.input_tokens || 0)} ↓${fmtNum(u.output_tokens || 0)}${cache}${create}`);
}

export function clearMessages() {
  const msgs = $('messages'), perms = $('permission-requests');
  if (msgs)  msgs.innerHTML  = '';
  if (perms) perms.innerHTML = '';
  ctx.shellBubble = null;
}

function appendStreamBubble(role) {
  const msgs = $('messages');
  if (!msgs) return null;
  const cls = role === 'shell-err'
    ? 'text-error'
    : 'text-[#c9d1d9]';
  msgs.insertAdjacentHTML('beforeend',
    `<div class="mx-2 rounded-lg bg-[#0d1117] border border-base-300 px-3 py-2 text-sm font-mono ${cls} whitespace-pre-wrap break-words"></div>`);
  msgs.scrollTop = msgs.scrollHeight;
  return msgs.lastElementChild;
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
  msgs.insertAdjacentHTML('beforeend', `<div class="flex flex-col">
    <div class="rounded border border-success/15 bg-success/5 px-2 py-1 tool-card cursor-pointer select-none">
      <div class="flex items-center gap-1.5 text-xs font-mono">
        <span class="text-warning">⚡</span>
        <span class="text-warning font-semibold">${esc(block.name)}</span>
        <span class="text-base-content/50 truncate flex-1">${esc(preview)}</span>
        <span class="tool-chevron text-[10px] text-base-content/40">▶</span>
      </div>
      <div class="tool-detail mt-1 p-2 bg-[#0d1117] rounded border border-base-300
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
        '<div id="typing-indicator" class="flex justify-start px-2"><div class="flex items-center gap-1.5 rounded-2xl rounded-tl-sm px-3 py-2 bg-base-200 text-xs text-base-content/40"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div>');
      msgs.scrollTop = msgs.scrollHeight;
    } else if (!val) existing?.remove();
  });

  // Chat input: Enter = send, auto-resize, shell mode styling
  delegate.on('keydown', '#chat-input', e => {
    const send = e.key === 'Enter' && (e.metaKey || e.ctrlKey);
    if (send) { e.preventDefault(); sendMessage(); }
  });
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

  // Long message expand/collapse
  delegate.on('click', '.msg-expand-btn', (e, el) => {
    e.stopPropagation();
    const card = el.closest('.msg-card');
    const expanded = card.classList.toggle('open');
    el.textContent = expanded ? '▲ Show less' : '▼ Show more';
  });
}
