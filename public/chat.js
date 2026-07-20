// chat.js — WebSocket, message rendering, send actions
import { watch, delegate, esc, $ } from './lib.js';
import { ctx, isProcessing, currentProject, currentTab, currentModel, currentEffort, currentPermission,
         currentAgent, setAgent, AGENT_LABELS, AGENT_DEFAULT_MODEL, chatDensity } from './state.js';
import { sendWs } from './api.js';

function assistantLabel() {
  return AGENT_LABELS[currentAgent.peek()] || 'Assistant';
}

// ── Scroll helpers ────────────────────────────────────────────────────────────
// True when the user is at (or near) the bottom of the message list.
function atBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
// Scroll to bottom only if the user was already following along; otherwise leave
// their scroll position untouched so reading history isn't interrupted.
function stickBottom(el, force) {
  if (!el) return;
  if (force || atBottom(el)) el.scrollTop = el.scrollHeight;
}

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
    if (msg.agent) setAgent(msg.agent);
    // Notify shell to refresh session list — use custom event to avoid circular import
    document.dispatchEvent(new CustomEvent('sessions-changed'));
    return;
  }
  if (msg.type === 'result') {
    finalizeThoughtStream();
    finalizeAssistantStream();
    flushToolBatch();
    isProcessing.value = false;
    const u = msg.usage;
    if (u) {
      appendHistoryTokenBar({
        input_tokens: u.inputTokens ?? u.input_tokens,
        output_tokens: u.outputTokens ?? u.output_tokens,
        cache_read_input_tokens: u.cacheReadInputTokens ?? u.cache_read_input_tokens,
        cache_creation_input_tokens: u.cacheCreationInputTokens ?? u.cache_creation_input_tokens,
        total_tokens: u.totalTokens ?? u.total_tokens,
        reasoning_tokens: u.reasoningTokens ?? u.reasoning_tokens,
        costUSD: u.costUSD ?? u.cost_usd,
      });
    }
    if (!msg.is_error) appendSystemMsg('✓ Done');
    return;
  }
  if (msg.type === 'complete') {
    finalizeThoughtStream();
    finalizeAssistantStream();
    flushToolBatch();
    isProcessing.value = false;
    // result already printed "Done" for codex/grok; avoid double for those
    if (!msg.aborted && msg.agent === 'claude') appendSystemMsg('✓ Done');
    else if (!msg.aborted && msg.agent && msg.agent !== 'claude' && !msg.error) { /* result handled it */ }
    else if (!msg.aborted && !msg.agent) appendSystemMsg('✓ Done');
    return;
  }
  if (msg.type === 'error') {
    finalizeThoughtStream();
    finalizeAssistantStream();
    appendMsg('error', 'Error', msg.message);
    isProcessing.value = false;
    return;
  }
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
    // Finalize any live stream before a discrete assistant block
    finalizeAssistantStream();
    for (const block of (msg.message?.content || [])) {
      if (block.type === 'text' && block.text) {
        flushToolBatch();
        appendMsg('assistant', assistantLabel(), block.text, { ts: msg.ts || Date.now() });
      } else if (block.type === 'tool_use') {
        renderToolUse(block, { ts: msg.ts || Date.now() });
      }
    }
    return;
  }

  // ── Live streaming (Grok / future agents) ─────────────────────────────────
  if (msg.type === 'assistant_stream_start') {
    ensureAssistantStream(msg.ts);
    return;
  }
  if (msg.type === 'assistant_delta') {
    appendAssistantDelta(msg.data || '');
    return;
  }
  if (msg.type === 'assistant_stream_end') {
    finalizeAssistantStream();
    return;
  }
  if (msg.type === 'thought_stream_start') {
    ensureThoughtStream();
    return;
  }
  if (msg.type === 'thought_delta') {
    appendThoughtDelta(msg.data || '');
    return;
  }
  if (msg.type === 'thought_stream_end') {
    finalizeThoughtStream();
    return;
  }
  if (msg.type === 'status') {
    // Lightweight status line under typing indicator
    const el = $('stream-status');
    if (el) el.textContent = msg.message || '';
    else {
      const msgs = $('messages');
      if (msgs && msg.message) {
        msgs.insertAdjacentHTML('beforeend',
          `<div id="stream-status" class="text-center text-[10px] text-base-content/35 py-0.5">${esc(msg.message)}</div>`);
        stickBottom(msgs);
      }
    }
    return;
  }

  if (msg.type === 'permission_request' || (msg.request_id && msg.tool_name))
    renderPermissionRequest(msg);
}

// ── Live stream bubbles ───────────────────────────────────────────────────────
/** @type {HTMLElement | null} */
let liveAsstEl = null;
/** @type {HTMLElement | null} */
let liveAsstBody = null;
/** @type {HTMLElement | null} */
let liveThoughtEl = null;
/** @type {HTMLElement | null} */
let liveThoughtBody = null;

function ensureAssistantStream(ts) {
  const msgs = $('messages');
  if (!msgs) return;
  flushToolBatch();
  finalizeThoughtStream();
  if (liveAsstEl && msgs.contains(liveAsstEl)) return;

  const t = formatMsgTime(ts || Date.now());
  const title = tsAttr(ts || Date.now());
  msgs.insertAdjacentHTML('beforeend', `
    <div class="msg-row assistant px-2 live-stream" data-ts="${esc(title)}">
      <div class="max-w-[88%] rounded-2xl rounded-tl-sm px-3 py-2 text-sm bg-base-200 break-words md">
        <div class="msg-stream-body whitespace-pre-wrap"></div>
      </div>
      ${t ? `<div class="msg-ts" title="${esc(title)}">${esc(t)}</div>` : ''}
    </div>`);
  liveAsstEl = msgs.lastElementChild;
  liveAsstBody = liveAsstEl.querySelector('.msg-stream-body');
  $('stream-status')?.remove();
  stickBottom(msgs, true);
}

function appendAssistantDelta(chunk) {
  if (!chunk) return;
  if (!liveAsstBody) ensureAssistantStream(Date.now());
  if (!liveAsstBody) return;
  // Keep raw text while streaming; re-render markdown on finalize
  liveAsstBody.textContent += chunk;
  stickBottom($('messages'), true);
}

function finalizeAssistantStream() {
  if (!liveAsstEl || !liveAsstBody) {
    liveAsstEl = null;
    liveAsstBody = null;
    return;
  }
  const text = liveAsstBody.textContent || '';
  if (text.trim()) {
    // Upgrade plain text to markdown rendering
    liveAsstBody.classList.remove('whitespace-pre-wrap');
    liveAsstBody.classList.add('md');
    liveAsstBody.innerHTML = renderMarkdown(text);
    highlightCode(liveAsstEl);
  } else {
    liveAsstEl.remove();
  }
  liveAsstEl = null;
  liveAsstBody = null;
  $('stream-status')?.remove();
}

function ensureThoughtStream() {
  const msgs = $('messages');
  if (!msgs) return;
  if (liveThoughtEl && msgs.contains(liveThoughtEl)) return;
  msgs.insertAdjacentHTML('beforeend', `
    <div class="msg-row assistant px-2 thought-stream">
      <div class="max-w-[88%] rounded-lg border border-base-300/60 bg-base-200/50 px-2.5 py-1.5 text-[11px] text-base-content/45">
        <div class="font-medium text-base-content/35 mb-0.5">thinking…</div>
        <div class="thought-body font-mono whitespace-pre-wrap max-h-24 overflow-y-auto opacity-80"></div>
      </div>
    </div>`);
  liveThoughtEl = msgs.lastElementChild;
  liveThoughtBody = liveThoughtEl.querySelector('.thought-body');
  stickBottom(msgs, true);
}

function appendThoughtDelta(chunk) {
  if (!chunk) return;
  if (!liveThoughtBody) ensureThoughtStream();
  if (!liveThoughtBody) return;
  liveThoughtBody.textContent += chunk;
  // Keep thought panel scrolled to end
  liveThoughtBody.scrollTop = liveThoughtBody.scrollHeight;
  stickBottom($('messages'), true);
}

function finalizeThoughtStream() {
  // Collapse finished thoughts to a one-liner so the chat stays clean
  if (liveThoughtEl && liveThoughtBody) {
    const n = (liveThoughtBody.textContent || '').length;
    liveThoughtEl.innerHTML = `
      <div class="text-[10px] text-base-content/30 px-1 select-none">💭 thought ${n ? `(${n} chars)` : ''}</div>`;
  }
  liveThoughtEl = null;
  liveThoughtBody = null;
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
    case 'agent': {
      if (!arg) {
        appendSystemMsg(`Current agent: ${currentAgent.peek()} · agents: claude | codex | grok`);
        return true;
      }
      const a = arg.toLowerCase();
      if (!['claude', 'codex', 'grok'].includes(a)) {
        appendSystemMsg(`Unknown agent "${arg}" · valid: claude | codex | grok`);
        return true;
      }
      // Switching agent starts a fresh conversation
      if (a !== currentAgent.peek()) {
        ctx.sessionId = null;
        setAgent(a);
        currentModel.value = AGENT_DEFAULT_MODEL[a];
        localStorage.setItem('model', currentModel.peek());
        document.dispatchEvent(new CustomEvent('agent-changed'));
        appendSystemMsg(`Agent → ${AGENT_LABELS[a]} · model ${currentModel.peek()} · new session`);
      } else {
        appendSystemMsg(`Agent already ${AGENT_LABELS[a]}`);
      }
      return true;
    }
    case 'model': {
      if (!arg) {
        appendSystemMsg(`Current model: ${currentModel.peek()} (${currentAgent.peek()})`);
        return true;
      }
      const resolved = MODEL_ALIASES[arg.toLowerCase()] || arg;
      currentModel.value = resolved;
      localStorage.setItem('model', resolved);
      appendSystemMsg(`Model set to ${resolved}`);
      document.dispatchEvent(new CustomEvent('agent-changed'));
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
      appendSystemMsg(`Available slash commands:\n  /agent [claude|codex|grok]\n  /model [haiku|sonnet|opus|<model-id>]\n  /effort [low|medium|high|xhigh|max]\n  /clear`);
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
  const now = Date.now();
  if (text.startsWith('!')) {
    appendMsg('shell', '$ Shell', text.slice(1).trim(), { ts: now });
    sendWs({ type: 'shell-command', command: text.slice(1).trim(), cwd: currentProject.peek().path });
  } else {
    flushToolBatch();
    appendMsg('user', 'You', text, { ts: now });
    const effort     = currentEffort.peek();
    const permission = currentPermission.peek();
    const agent      = currentAgent.peek() || 'claude';
    sendWs({ type: 'agent-command', agent, command: text, options: {
      agent,
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
  const label = AGENT_LABELS[currentAgent.peek()] || 'agent';
  input.placeholder = isShell ? 'Shell command (without !)…' : `Ask ${label}… or !cmd for shell`;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

// ── Message rendering ─────────────────────────────────────────────────────────
const USER_COLLAPSE = 200;
const ASST_COLLAPSE = 500;

/** Coerce history/live timestamps to epoch milliseconds. */
export function coerceTs(ts) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts) || ts <= 0) return null;
    // Unix seconds (~1e9–1e10) → ms; already-ms is ~1e12–1e13
    return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts);
  }
  if (typeof ts === 'string') {
    const trimmed = ts.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return coerceTs(n);
    }
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Format a timestamp for chat (local time).
 * Today → HH:mm:ss ; other day → M/D HH:mm:ss
 */
export function formatMsgTime(ts) {
  const ms = coerceTs(ts);
  if (ms == null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hms = d.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  if (sameDay) return hms;
  const md = d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  return `${md} ${hms}`;
}

function tsAttr(ts) {
  const ms = coerceTs(ts);
  if (ms == null) return '';
  return new Date(ms).toISOString();
}

function wrapMsgRow(role, bubbleInner, ts) {
  if (role === 'system') return bubbleInner;
  const t = formatMsgTime(ts);
  const title = tsAttr(ts);
  const tsHtml = t
    ? `<div class="msg-ts" title="${esc(title)}">${esc(t)}</div>`
    : '';
  // user / assistant alignment
  const align = role === 'user' ? 'user' : (role === 'shell' || role === 'shell-err' ? 'assistant' : role);
  return `<div class="msg-row ${align} px-2" data-ts="${esc(title)}">${bubbleInner}${tsHtml}</div>`;
}

function bubbleHtml(role, text, ts) {
  const expandBtn = `<button class="msg-expand-btn text-[10px] text-primary/70 mt-1.5 block cursor-pointer hover:text-primary">▼ Show more</button>`;
  let bubble;
  switch (role) {
    case 'user': {
      const hasImage = /!\[.*?\]\(.*?\)/.test(text);
      const rendered = hasImage ? renderMarkdown(text) : null;
      const long  = text.length > USER_COLLAPSE;
      const inner = long
        ? `<div class="msg-body">${rendered ?? esc(text.trimEnd())}</div>${expandBtn}`
        : (rendered ?? esc(text.trimEnd()));
      const style = rendered ? '' : ' style="white-space:pre-wrap"';
      bubble = `<div class="max-w-[80%] rounded-2xl rounded-tr-sm px-3 py-2 text-sm bg-primary/15 border border-primary/20 text-base-content break-words${long ? ' msg-card' : ''}${rendered ? ' md' : ''}"${style}>${inner}</div>`;
      break;
    }
    case 'assistant': {
      const long = text.length > ASST_COLLAPSE;
      const inner = long ? `<div class="msg-body">${renderMarkdown(text)}</div>${expandBtn}` : renderMarkdown(text);
      bubble = `<div class="max-w-[min(92%,52rem)] rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-sm bg-base-200 border border-base-300/40 break-words md leading-relaxed${long ? ' msg-card' : ''}">${inner}</div>`;
      break;
    }
    case 'error':
      bubble = `<div class="max-w-[88%] rounded-2xl rounded-tl-sm px-3 py-2 text-sm bg-error/10 border border-error/20 text-error break-words" style="white-space:pre-wrap">${esc(text)}</div>`;
      break;
    case 'shell':
    case 'shell-err':
      bubble = `<div class="w-full max-w-[96%] rounded-lg code-surface px-3 py-2 text-sm font-mono ${role === 'shell-err' ? 'text-error' : ''} break-words" style="white-space:pre-wrap">${esc(text)}</div>`;
      break;
    case 'system':
      return `<div class="text-center text-[11px] text-base-content/30 py-0.5 select-none">${esc(text)}</div>`;
    default:
      bubble = `<div class="rounded-lg px-3 py-2 text-sm bg-base-300 break-words" style="white-space:pre-wrap">${esc(text)}</div>`;
  }
  return wrapMsgRow(role, bubble, ts);
}

/**
 * @param {string} role
 * @param {string} _label
 * @param {string} text
 * @param {{ ts?: number|string }} [opts]
 */
export function appendMsg(role, _label, text, opts = {}) {
  const msgs = $('messages');
  if (!msgs) return;
  const ts = coerceTs(opts.ts) ?? (role === 'system' ? null : Date.now());
  msgs.insertAdjacentHTML('beforeend', bubbleHtml(role, text, ts));
  highlightCode(msgs.lastElementChild);
  stickBottom(msgs, role === 'user');
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
  stickBottom(msgs);
}

// Called when loading history from JSONL (usage keys use snake_case from file)
export function appendHistoryTokenBar(u) {
  if (!u) return;
  const input  = u.input_tokens ?? u.inputTokens ?? 0;
  const output = u.output_tokens ?? u.outputTokens ?? 0;
  const total  = u.total_tokens ?? u.totalTokens ?? (input + output);
  const cache  = (u.cache_read_input_tokens ?? u.cachedReadTokens)
    ? ` · ${fmtNum(u.cache_read_input_tokens ?? u.cachedReadTokens)} cached` : '';
  const create = (u.cache_creation_input_tokens ?? u.cacheCreationInputTokens)
    ? ` · ${fmtNum(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens)} cache-write` : '';
  const reason = (u.reasoning_tokens ?? u.reasoningTokens)
    ? ` · ${fmtNum(u.reasoning_tokens ?? u.reasoningTokens)} reason` : '';
  const costVal = u.costUSD ?? u.cost_usd;
  const cost   = costVal != null ? ` · $${Number(costVal).toFixed(4)}` : '';
  const tot    = total ? ` · Σ${fmtNum(total)}` : '';
  appendTokenBar(`↑${fmtNum(input)} ↓${fmtNum(output)}${cache}${create}${reason}${tot}${cost}`);
}

/** Session-level context window footer (Grok signals.json etc.) */
export function appendContextBar(ctxInfo) {
  if (!ctxInfo) return;
  const used = ctxInfo.tokensUsed ?? ctxInfo.contextTokensUsed;
  const win  = ctxInfo.windowTokens ?? ctxInfo.contextWindowTokens;
  const pct  = ctxInfo.usagePercent ?? ctxInfo.contextWindowUsage;
  if (used == null && win == null && pct == null) return;
  const parts = [];
  if (used != null && win != null) parts.push(`context ${fmtNum(used)} / ${fmtNum(win)}`);
  else if (used != null) parts.push(`context ${fmtNum(used)}`);
  if (pct != null) parts.push(`${pct}%`);
  if (ctxInfo.model) parts.push(ctxInfo.model);
  if (ctxInfo.turnCount != null) parts.push(`${ctxInfo.turnCount} turns`);
  if (ctxInfo.toolCallCount != null) parts.push(`${ctxInfo.toolCallCount} tools`);
  appendTokenBar(`▣ ${parts.join(' · ')}`);
}

export function clearMessages() {
  const msgs = $('messages'), perms = $('permission-requests');
  if (msgs)  msgs.innerHTML  = '';
  if (perms) perms.innerHTML = '';
  ctx.shellBubble = null;
  toolBatch = null;
  liveAsstEl = liveAsstBody = null;
  liveThoughtEl = liveThoughtBody = null;
}

function appendStreamBubble(role) {
  const msgs = $('messages');
  if (!msgs) return null;
  const err = role === 'shell-err' ? ' text-error' : '';
  msgs.insertAdjacentHTML('beforeend',
    `<div class="mx-2 rounded-lg code-surface px-3 py-2 text-sm font-mono${err} whitespace-pre-wrap break-words"></div>`);
  stickBottom(msgs);
  return msgs.lastElementChild;
}

function appendToStreamBubble(el, text) {
  if (!el) return;
  el.textContent += text;
  stickBottom(el.closest('#messages'));
}

// ── Tool rendering + density ──────────────────────────────────────────────────
/** @type {{ el: HTMLElement, names: string[], count: number } | null} */
let toolBatch = null;

function toolPreview(block) {
  const inputStr = typeof block.input === 'object'
    ? JSON.stringify(block.input, null, 2)
    : String(block.input || '');
  const first = typeof block.input === 'object'
    ? Object.values(block.input).find(v => typeof v === 'string' && v.trim())
    : inputStr;
  const preview = (first || '').replace(/\n/g, ' ').slice(0, chatDensity.peek() === 'full' ? 120 : 80);
  return { inputStr, preview };
}

function toolCardHtml(block, { inBatch = false } = {}) {
  const { inputStr, preview } = toolPreview(block);
  return `<div class="tool-card${inBatch ? ' tool-batch-item' : ''} cursor-pointer select-none px-2 py-1">
    <div class="flex items-center gap-1.5 text-xs font-mono">
      <span class="text-warning">⚡</span>
      <span class="text-warning font-semibold">${esc(block.name || 'tool')}</span>
      <span class="text-base-content/50 truncate flex-1">${esc(preview)}</span>
      <span class="tool-chevron text-[10px] text-base-content/40">▶</span>
    </div>
    <div class="tool-detail">${esc(inputStr)}</div>
  </div>`;
}

function updateBatchHeader(batch) {
  const uniq = [...new Set(batch.names)];
  const sample = uniq.slice(0, 4).join(', ') + (uniq.length > 4 ? '…' : '');
  const summary = batch.el.querySelector('.tool-batch-summary');
  if (summary) {
    summary.innerHTML =
      `<span class="text-warning">⚡</span>
       <span class="font-semibold text-base-content/70">${batch.count} tool${batch.count === 1 ? '' : 's'}</span>
       <span class="text-base-content/40 truncate flex-1">${esc(sample)}</span>
       <span class="tool-chevron text-[10px] text-base-content/40">▶</span>`;
  }
}

/** Flush open tool batch (e.g. before user/assistant text). */
export function flushToolBatch() {
  toolBatch = null;
}

/**
 * Render a tool_use block, respecting chat density.
 * clean  → collapse consecutive tools into one expandable batch
 * normal → one-line cards
 * full   → one-line cards (longer preview)
 */
export function renderToolUse(block, opts = {}) {
  const msgs = $('messages');
  if (!msgs) return;
  const density = chatDensity.peek() || 'normal';
  const ts = coerceTs(opts.ts);

  if (density === 'clean') {
    // Append into current batch or start a new one
    if (!toolBatch || !msgs.contains(toolBatch.el)) {
      const t = formatMsgTime(ts);
      const title = tsAttr(ts);
      msgs.insertAdjacentHTML('beforeend', `
        <div class="msg-row assistant px-2" data-ts="${esc(title)}">
          <div class="tool-batch w-full max-w-[96%] px-2 py-1.5">
            <div class="tool-batch-summary flex items-center gap-1.5 text-xs font-mono"></div>
            <div class="tool-batch-list"></div>
          </div>
          ${t ? `<div class="msg-ts" title="${esc(title)}">${esc(t)}</div>` : ''}
        </div>`);
      const row = msgs.lastElementChild;
      toolBatch = {
        el: row.querySelector('.tool-batch'),
        names: [],
        count: 0,
      };
    }
    toolBatch.names.push(block.name || 'tool');
    toolBatch.count++;
    const list = toolBatch.el.querySelector('.tool-batch-list');
    list?.insertAdjacentHTML('beforeend', toolCardHtml(block, { inBatch: true }));
    updateBatchHeader(toolBatch);
    stickBottom(msgs);
    return;
  }

  // normal / full — individual cards
  toolBatch = null;
  const t = formatMsgTime(ts);
  const title = tsAttr(ts);
  msgs.insertAdjacentHTML('beforeend', `
    <div class="msg-row assistant px-2" data-ts="${esc(title)}">
      <div class="w-full max-w-[96%]">${toolCardHtml(block)}</div>
      ${t ? `<div class="msg-ts" title="${esc(title)}">${esc(t)}</div>` : ''}
    </div>`);
  stickBottom(msgs);
}

/** Apply density attribute on the messages container. */
export function applyChatDensity() {
  const el = $('messages');
  if (el) el.setAttribute('data-density', chatDensity.peek() || 'normal');
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

/** Configure marked once: GFM + code chrome + table wrap. */
let _markedReady = false;
function ensureMarked() {
  if (_markedReady || typeof marked === 'undefined') return;

  const escapeCode = (raw) => String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const renderCode = (body, infostring) => {
    const lang = String(infostring || '').trim().split(/\s+/)[0] || '';
    const langLabel = lang || 'text';
    const langClass = lang ? `language-${esc(lang)}` : '';
    return `<div class="code-block">
      <div class="code-block-header">
        <span class="code-block-lang">${esc(langLabel)}</span>
        <button type="button" class="code-copy" data-copy="1" title="Copy code">Copy</button>
      </div>
      <pre><code class="hljs ${langClass}">${escapeCode(body)}</code></pre>
    </div>`;
  };

  // marked@9 still calls classic renderer signatures: code(code, lang, escaped), table(header, body)
  const renderer = {
    code(code, infostring) {
      // Support both classic (string) and token-object if a future build passes it
      if (code && typeof code === 'object' && code.text != null) {
        return renderCode(code.text, code.lang || infostring);
      }
      return renderCode(code, infostring);
    },
    table(header, body) {
      if (header && typeof header === 'object' && !Array.isArray(header) && header.header) {
        // unexpected token form — let default handle by returning false if supported
        return false;
      }
      return `<div class="table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
    },
  };

  try {
    if (typeof marked.use === 'function') {
      marked.use({ gfm: true, breaks: true, renderer });
    } else if (typeof marked.setOptions === 'function') {
      const r = new marked.Renderer();
      r.code = renderer.code;
      r.table = renderer.table;
      marked.setOptions({ gfm: true, breaks: true, renderer: r });
    }
  } catch (e) {
    console.warn('[md] marked setup failed', e);
  }
  _markedReady = true;
}

function renderMarkdown(text) {
  if (typeof marked === 'undefined') return esc(text);
  try {
    ensureMarked();
    return marked.parse(String(text ?? ''), { breaks: true, gfm: true });
  } catch {
    return esc(text);
  }
}

// Syntax-highlight any code blocks inside a freshly-inserted element.
function highlightCode(root) {
  if (!root || typeof hljs === 'undefined') return;
  root.querySelectorAll('pre code:not(.hljs)').forEach(el => {
    try { hljs.highlightElement(el); } catch {}
  });
  // hljs may strip class list — keep language-* for CSS hooks
  root.querySelectorAll('pre code.hljs').forEach(el => {
    el.classList.add('hljs');
  });
}

// ── Init (called after HTML is in DOM) ────────────────────────────────────────
export function initChat() {
  applyChatDensity();

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
      stickBottom(msgs);
    } else if (!val) {
      existing?.remove();
      flushToolBatch();
    }
  });

  watch(chatDensity, () => applyChatDensity());

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

  // Tool card expand/collapse — keep the clicked card anchored, don't jump to bottom
  delegate.on('click', '.tool-card', (e, el) => {
    // If click is on a card inside a closed batch, let batch handler open first
    const batch = el.closest('.tool-batch');
    if (batch && !batch.classList.contains('open') && !el.classList.contains('tool-batch-item')) return;
    e.stopPropagation();
    const msgs = $('messages');
    const before = el.getBoundingClientRect().top;
    el.classList.toggle('open');
    if (msgs) {
      const after = el.getBoundingClientRect().top;
      msgs.scrollTop += after - before;
    }
  });

  // Tool batch expand (clean density)
  delegate.on('click', '.tool-batch', (e, el) => {
    if (e.target.closest('.tool-card') && el.classList.contains('open')) return;
    const msgs = $('messages');
    const before = el.getBoundingClientRect().top;
    el.classList.toggle('open');
    if (msgs) {
      const after = el.getBoundingClientRect().top;
      msgs.scrollTop += after - before;
    }
  });

  // Floating jump-to-top / jump-to-bottom buttons
  const msgsEl = $('messages');
  const topBtn = $('scroll-top-btn'), botBtn = $('scroll-bottom-btn');
  if (msgsEl && topBtn && botBtn) {
    const updateNav = () => {
      const canScroll = msgsEl.scrollHeight - msgsEl.clientHeight > 200;
      topBtn.classList.toggle('hidden', !canScroll || msgsEl.scrollTop < 200);
      botBtn.classList.toggle('hidden', !canScroll || atBottom(msgsEl));
    };
    msgsEl.addEventListener('scroll', updateNav, { passive: true });
    new ResizeObserver(updateNav).observe(msgsEl);
    new MutationObserver(updateNav).observe(msgsEl, { childList: true, subtree: true });
    topBtn.addEventListener('click', () => msgsEl.scrollTo({ top: 0, behavior: 'smooth' }));
    botBtn.addEventListener('click', () => msgsEl.scrollTo({ top: msgsEl.scrollHeight, behavior: 'smooth' }));
    updateNav();
  }

  // Long message expand/collapse
  delegate.on('click', '.msg-expand-btn', (e, el) => {
    e.stopPropagation();
    const card = el.closest('.msg-card');
    const expanded = card.classList.toggle('open');
    el.textContent = expanded ? '▲ Show less' : '▼ Show more';
  });

  // Copy code from fenced blocks
  delegate.on('click', '.code-copy', async (e, el) => {
    e.preventDefault();
    e.stopPropagation();
    const block = el.closest('.code-block');
    const code = block?.querySelector('pre code');
    const text = code?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      el.textContent = 'Copied';
      el.classList.add('copied');
      setTimeout(() => {
        el.textContent = 'Copy';
        el.classList.remove('copied');
      }, 1400);
    } catch {
      el.textContent = 'Failed';
      setTimeout(() => { el.textContent = 'Copy'; }, 1400);
    }
  });
}
