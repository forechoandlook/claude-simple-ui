// chat.js — WebSocket, message rendering, send actions
import { watch, delegate, esc, $ } from './lib.js';
import { ctx, isProcessing, currentProject, currentTab, currentModel, currentEffort, currentPermission,
         currentAgent, setAgent, AGENT_LABELS, getDefaultModel, getModelsForAgent, getEffortsForModel,
         addCustomModel, chatDensity, wsStatus } from './state.js';
import { sendWs, api, authHeaders, flushWsQueue, clearWsQueue } from './api.js';
import { initWakeLock, setWakeLockDesired } from './wake-lock.js';

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

// ── WebSocket (auto-reconnect for mobile radio / background) ─────────────────
let wsGen = 0;
let reconnectTimer = null;
let reconnectDelay = 1000;
let lastPongAt = 0;
let heartbeatTimer = null;
let lifecycleBound = false;
let sawDisconnect = false;
let lastWsMachine = null;
let reconnectQuiet = false;
/** Queued user text to send after current turn finishes (Grok used to block forever). */
let pendingUserText = null;

function bindSocketLifecycle() {
  if (lifecycleBound) return;
  lifecycleBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reconnectDelay = 400;
      ensureChatSocket({ probe: true });
      // Re-subscribe so server can re-attach stream / clear stuck busy state
      if (ctx.ws?.readyState === WebSocket.OPEN && ctx.sessionId) {
        try { ctx.ws.send(JSON.stringify({ type: 'subscribe', sessionId: ctx.sessionId })); } catch { /* ignore */ }
      }
    }
  });
  window.addEventListener('online', () => {
    reconnectDelay = 400;
    ensureChatSocket({ force: true });
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) ensureChatSocket({ force: true });
    else ensureChatSocket({ probe: true });
  });
}

function updateConnDot() {
  const dot = $('conn-dot');
  if (!dot) return;
  const st = wsStatus.peek();
  dot.classList.remove('bg-success', 'bg-warning', 'bg-error', 'bg-base-content/30', 'animate-pulse');
  if (st === 'open') {
    dot.classList.add('bg-success');
    dot.title = '已连接';
  } else if (st === 'connecting' || st === 'reconnecting') {
    dot.classList.add('bg-warning', 'animate-pulse');
    dot.title = st === 'connecting' ? '连接中…' : '重连中…';
  } else if (st === 'offline') {
    dot.classList.add('bg-error');
    dot.title = '离线';
  } else {
    dot.classList.add('bg-base-content/30');
    dot.title = '未连接';
  }
}

function ensureChatSocket(opts = {}) {
  const st = ctx.ws?.readyState;
  if (opts.force) {
    reconnectDelay = 400;
    connectWS({ quiet: true });
    return;
  }
  if (st === WebSocket.OPEN) {
    if (opts.probe && lastPongAt && Date.now() - lastPongAt > 45_000) {
      try { ctx.ws.close(); } catch { /* reconnect via close handler */ }
    } else if (opts.probe && ctx.ws.readyState === WebSocket.OPEN) {
      try { ctx.ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
    }
    return;
  }
  if (st === WebSocket.CONNECTING) return;
  reconnectDelay = Math.min(reconnectDelay, 800);
  connectWS({ quiet: true });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  wsStatus.value = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'reconnecting';
  updateConnDot();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS({ quiet: true });
  }, reconnectDelay);
  reconnectDelay = Math.min(Math.round(reconnectDelay * 1.8), 15_000);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function startHeartbeat(sock, gen) {
  stopHeartbeat();
  // Server already pings ~35s. Client only watches for silence and pings
  // when the tab is visible — avoids double traffic + radio wake on mobile.
  heartbeatTimer = setInterval(() => {
    if (gen !== wsGen || sock.readyState !== WebSocket.OPEN) return;
    if (lastPongAt && Date.now() - lastPongAt > 70_000) {
      try { sock.close(); } catch { /* close handler reconnects */ }
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // Light client probe only if server ping seems late (tunnel stall).
    if (lastPongAt && Date.now() - lastPongAt > 40_000) {
      try { sock.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
    }
  }, 30_000);
}

function syncWakeLock() {
  // Keep screen on while a turn is running OR while a project chat is open and connected.
  const need = isProcessing.peek()
    || (!!currentProject.peek() && wsStatus.peek() === 'open');
  setWakeLockDesired(need);
}

/** Manual reconnect (toolbar / banner). Resets backoff and forces a new socket. */
export function refreshConnection() {
  reconnectDelay = 400;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectQuiet = false;
  const st = ctx.ws?.readyState;
  if (st === WebSocket.OPEN || st === WebSocket.CONNECTING) {
    try { ctx.ws?.close(); } catch { /* ignore */ }
  }
  connectWS({ quiet: false });
  appendSystemMsg('正在重新连接并同步…');
}

export function connectWS(opts = {}) {
  bindSocketLifecycle();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (opts.quiet) reconnectQuiet = true;

  const mid = ctx.machineId || (typeof localStorage !== 'undefined' ? localStorage.getItem('machineId') : null);
  if (lastWsMachine !== mid) {
    clearWsQueue();
    lastWsMachine = mid;
  }

  const gen = ++wsGen;
  try { ctx.ws?.close(); } catch { /* ignore */ }

  wsStatus.value = 'connecting';
  updateConnDot();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams();
  if (ctx.token) q.set('token', ctx.token);
  if (mid) q.set('machine', mid);
  if (ctx.sessionId) q.set('sessionId', ctx.sessionId);

  const sock = new WebSocket(`${proto}://${location.host}/ws/chat?${q}`);
  ctx.ws = sock;

  sock.addEventListener('open', () => {
    if (gen !== wsGen) return;
    reconnectDelay = 1000;
    lastPongAt = Date.now();
    wsStatus.value = 'open';
    updateConnDot();
    if (ctx.sessionId) {
      try { sock.send(JSON.stringify({ type: 'subscribe', sessionId: ctx.sessionId })); } catch { /* ignore */ }
    }
    flushWsQueue();
    startHeartbeat(sock, gen);
    syncWakeLock();
    if (sawDisconnect && !reconnectQuiet) {
      appendSystemMsg(mid ? `已重连 · ${mid}` : '已重连');
    }
    sawDisconnect = false;
    reconnectQuiet = false;
  });

  sock.addEventListener('message', e => {
    if (gen !== wsGen) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'pong') { lastPongAt = Date.now(); return; }
    if (msg.type === 'ping') {
      lastPongAt = Date.now();
      if (sock.readyState === WebSocket.OPEN) {
        try { sock.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
      }
      return;
    }
    if (msg.type === 'run-status') {
      // Only adopt "running" from server; never re-lock after we already finished a turn
      // unless the server still has a busy run (reconnect mid-stream).
      if (msg.running) {
        isProcessing.value = true;
      } else if (isProcessing.peek()) {
        // Server says idle — unlock (fixes Grok lingering process / missed complete)
        isProcessing.value = false;
        flushPendingUserText();
      }
      syncWakeLock();
      return;
    }
    handleWsMessage(msg);
  });

  sock.addEventListener('close', () => {
    if (gen !== wsGen) return;
    stopHeartbeat();
    sawDisconnect = true;
    wsStatus.value = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'reconnecting';
    updateConnDot();
    scheduleReconnect();
  });

  sock.addEventListener('error', () => {
    // close follows; avoid flipping isProcessing so an in-flight run can resume
  });
}

function flushPendingUserText() {
  if (!pendingUserText || isProcessing.peek()) return;
  const text = pendingUserText;
  pendingUserText = null;
  const input = $('chat-input');
  if (input) {
    input.value = text;
    autoResize(input);
  }
  // Defer so isProcessing watch can re-enable send button first
  setTimeout(() => sendMessage(), 0);
}

function markTurnDone() {
  isProcessing.value = false;
  syncWakeLock();
  flushPendingUserText();
}

function handleWsMessage(msg) {
  // Server outbox may pack multiple events into one frame
  if (msg.type === 'batch' && Array.isArray(msg.items)) {
    for (const item of msg.items) handleWsMessage(item);
    return;
  }
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
    const u = msg.usage;
    if (u) {
      const norm = {
        input_tokens: u.inputTokens ?? u.input_tokens,
        output_tokens: u.outputTokens ?? u.output_tokens,
        cache_read_input_tokens: u.cacheReadInputTokens ?? u.cache_read_input_tokens,
        cache_creation_input_tokens: u.cacheCreationInputTokens ?? u.cache_creation_input_tokens,
        total_tokens: u.totalTokens ?? u.total_tokens,
        reasoning_tokens: u.reasoningTokens ?? u.reasoning_tokens,
        costUSD: u.costUSD ?? u.cost_usd,
      };
      ctx.lastUsage = norm;
      if (ctx.sessionId) ctx.lastUsageSessionId = ctx.sessionId;
      appendHistoryTokenBar(norm);
    }
    if (!msg.is_error) appendSystemMsg('✓ Done');
    // Unlock immediately so the next Grok turn can be typed/sent without waiting process exit.
    markTurnDone();
    return;
  }
  if (msg.type === 'complete') {
    finalizeThoughtStream();
    finalizeAssistantStream();
    flushToolBatch();
    // result already printed "Done" for codex/grok; avoid double for those
    if (!msg.aborted && msg.agent === 'claude') appendSystemMsg('✓ Done');
    else if (!msg.aborted && msg.agent && msg.agent !== 'claude' && !msg.error) { /* result handled it */ }
    else if (!msg.aborted && !msg.agent) appendSystemMsg('✓ Done');
    else if (msg.aborted) appendSystemMsg('已停止');
    markTurnDone();
    return;
  }
  if (msg.type === 'error') {
    finalizeThoughtStream();
    finalizeAssistantStream();
    appendMsg('error', 'Error', msg.message);
    markTurnDone();
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
    markTurnDone();
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

  if (msg.type === 'permission_resolved') {
    const id = msg.requestId || msg.request_id;
    if (id) $(`perm-${id}`)?.remove();
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
        currentModel.value = getDefaultModel(a);
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
        const agent = currentAgent.peek();
        const list = getModelsForAgent(agent).map(m => m.value).join(' | ');
        appendSystemMsg(`Current model: ${currentModel.peek()} (${agent})${list ? `\nAvailable: ${list}` : ''}`);
        return true;
      }
      const resolved = MODEL_ALIASES[arg.toLowerCase()] || arg;
      const agent = currentAgent.peek() || 'claude';
      // Persist free-form ids so they stay in the model dropdown
      const known = getModelsForAgent(agent).some(m => m.value === resolved);
      if (!known) addCustomModel(agent, resolved);
      currentModel.value = resolved;
      localStorage.setItem('model', resolved);
      appendSystemMsg(`Model set to ${resolved}${known ? '' : ' (saved as custom ★)'}`);
      document.dispatchEvent(new CustomEvent('agent-changed'));
      return true;
    }
    case 'effort': {
      const levels = getEffortsForModel(currentAgent.peek(), currentModel.peek());
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
      ctx.lastUsage = null;
      appendSystemMsg('Cleared · new session');
      return true;
    case 'usage': {
      // Async fetch — return true immediately so message isn't sent to the model
      showUsageCommand();
      return true;
    }
    case 'help': {
      appendSystemMsg(`Available slash commands:\n  /agent [claude|codex|grok]\n  /model [haiku|sonnet|opus|<model-id>]\n  /effort [low|medium|high|xhigh|max]\n  /usage\n  /clear\n  /help`);
      return true;
    }
    default: {
      return false;
    }
  }
}

function fmtUsageNum(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

/** /usage — show last-turn + session context (Grok signals, etc.) */
async function showUsageCommand() {
  const agent = currentAgent.peek() || 'claude';
  const model = currentModel.peek() || '—';
  const sid = ctx.sessionId;
  const lines = [
    `Agent: ${AGENT_LABELS[agent] || agent}`,
    `Model: ${model}`,
    `Session: ${sid ? sid.slice(0, 8) + '…' : '(new — send a message first)'}`,
  ];

  // Live last-turn from this browser session
  if (ctx.lastUsage && (!sid || ctx.lastUsageSessionId === sid)) {
    const u = ctx.lastUsage;
    lines.push(
      `Last turn: ↑${fmtUsageNum(u.input_tokens)} ↓${fmtUsageNum(u.output_tokens)}`
      + (u.cache_read_input_tokens ? ` · ${fmtUsageNum(u.cache_read_input_tokens)} cached` : '')
      + (u.reasoning_tokens ? ` · ${fmtUsageNum(u.reasoning_tokens)} reason` : '')
      + (u.total_tokens ? ` · Σ${fmtUsageNum(u.total_tokens)}` : '')
      + (u.costUSD != null ? ` · $${Number(u.costUSD).toFixed(4)}` : ''),
    );
  }

  if (!sid) {
    appendSystemMsg(lines.join('\n'));
    appendTokenBar('◈ /usage · no session yet');
    return;
  }

  appendSystemMsg('Loading usage…');
  try {
    const q = new URLSearchParams({ sessionId: sid, agent });
    const data = await api('GET', `/api/usage?${q}`);
    const c = data.context || {};
    if (c.model) lines[1] = `Model: ${c.model}`;
    if (c.title) lines.push(`Title: ${c.title}`);

    if (c.tokensUsed != null || c.windowTokens != null || c.usagePercent != null) {
      const used = c.tokensUsed != null ? fmtUsageNum(c.tokensUsed) : '—';
      const win = c.windowTokens != null ? fmtUsageNum(c.windowTokens) : '—';
      const pct = c.usagePercent != null ? `${c.usagePercent}%` : '—';
      lines.push(`Context window: ${used} / ${win} (${pct})`);
    }
    if (c.turnCount != null) lines.push(`Turns: ${c.turnCount}`);
    if (c.toolCallCount != null) lines.push(`Tools: ${c.toolCallCount}`);
    if (c.sessionDurationSeconds != null) {
      const m = Math.floor(c.sessionDurationSeconds / 60);
      const s = Math.round(c.sessionDurationSeconds % 60);
      lines.push(`Duration: ${m}m ${s}s`);
    }
    if (c.sessionTotals) {
      const t = c.sessionTotals;
      lines.push(
        `Session totals: ↑${fmtUsageNum(t.input_tokens)} ↓${fmtUsageNum(t.output_tokens)}`
        + (t.cache_read_input_tokens ? ` · ${fmtUsageNum(t.cache_read_input_tokens)} cached` : '')
        + (t.total_tokens ? ` · Σ${fmtUsageNum(t.total_tokens)}` : '')
        + (t.costUSD ? ` · $${Number(t.costUSD).toFixed(4)}` : ''),
      );
    }
    if (c.lastTurn && !ctx.lastUsage) {
      const u = c.lastTurn;
      lines.push(
        `Last completed turn: ↑${fmtUsageNum(u.input_tokens)} ↓${fmtUsageNum(u.output_tokens)}`
        + (u.cache_read_input_tokens ? ` · ${fmtUsageNum(u.cache_read_input_tokens)} cached` : '')
        + (u.costUSD != null ? ` · $${Number(u.costUSD).toFixed(4)}` : ''),
      );
    }
    if (c.note) lines.push(c.note);

    // Replace "Loading usage…" with full report
    const msgs = $('messages');
    if (msgs) {
      const kids = [...msgs.children];
      for (let i = kids.length - 1; i >= 0; i--) {
        if (kids[i].textContent === 'Loading usage…') { kids[i].remove(); break; }
      }
    }
    appendSystemMsg(lines.join('\n'));

    // Visual token / context bars
    if (c.tokensUsed != null || c.windowTokens != null) {
      appendContextBar({
        tokensUsed: c.tokensUsed,
        windowTokens: c.windowTokens,
        usagePercent: c.usagePercent,
        model: c.model || model,
        turnCount: c.turnCount,
        toolCallCount: c.toolCallCount,
      });
    }
    if (c.sessionTotals) {
      appendHistoryTokenBar(c.sessionTotals);
    } else if (c.lastTurn) {
      appendHistoryTokenBar(c.lastTurn);
    } else if (ctx.lastUsage) {
      appendHistoryTokenBar(ctx.lastUsage);
    }
  } catch (e) {
    const msgs = $('messages');
    if (msgs) {
      const kids = [...msgs.children];
      for (let i = kids.length - 1; i >= 0; i--) {
        if (kids[i].textContent === 'Loading usage…') { kids[i].remove(); break; }
      }
    }
    appendSystemMsg(`${lines.join('\n')}\n(usage fetch failed: ${e.message})`);
  }
}

// ── Send / control ────────────────────────────────────────────────────────────
export function sendMessage() {
  const input = $('chat-input');
  const text  = input?.value.trim();
  if (!text || !currentProject.peek()) return;

  // While a turn is running, queue the next message (common Grok complaint).
  if (isProcessing.peek()) {
    pendingUserText = text;
    input.value = '';
    autoResize(input);
    updateInputMode('');
    clearPendingAttachments();
    appendSystemMsg(`已排队下一条，当前回复结束后发送：${text.length > 80 ? text.slice(0, 80) + '…' : text}`);
    return;
  }

  input.value = '';
  autoResize(input);
  updateInputMode('');
  clearPendingAttachments();

  if (text.startsWith('/')) {
    if (handleSlashCommand(text)) {
      return;
    }
  }

  isProcessing.value = true;
  syncWakeLock();
  const now = Date.now();
  if (isShellInput(text)) {
    appendMsg('shell', '$ Shell', text.slice(1).trim(), { ts: now });
    // Typed control plane (legacy shell-command still accepted server-side)
    const ok = sendWs({
      type: 'command',
      cmd: 'shell.exec',
      command: text.slice(1).trim(),
      cwd: currentProject.peek().path,
    });
    if (!ok) appendSystemMsg('连接未就绪，命令已入队，重连后发送');
  } else {
    flushToolBatch();
    appendMsg('user', 'You', text, { ts: now });
    const effort     = currentEffort.peek();
    const permission = currentPermission.peek();
    const agent      = currentAgent.peek() || 'claude';
    const ok = sendWs({
      type: 'command',
      cmd: 'turn.start',
      agent,
      command: text,
      sessionId: ctx.sessionId,
      options: {
        agent,
        cwd:       currentProject.peek().path,
        sessionId: ctx.sessionId,
        configDir: ctx.configDir,
        model:     currentModel.peek(),
        ...(effort     && { effort }),
        ...(permission && permission !== 'default' && { permissionMode: permission }),
        ...(permission === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),
      },
    });
    if (!ok) appendSystemMsg('连接未就绪，消息已入队，重连后发送');
  }
}

export function stopProcessing() {
  if (ctx.sessionId) {
    sendWs({ type: 'command', cmd: 'turn.interrupt', sessionId: ctx.sessionId });
  }
  pendingUserText = null;
  markTurnDone();
}

export function newSession() {
  ctx.sessionId = null;
  clearMessages();
  appendSystemMsg('New session — type to start');
}

// ── Input helpers ─────────────────────────────────────────────────────────────
function updateInputMode(value) {
  const isShell = isShellInput(value);
  const input = $('chat-input'), btn = $('send-btn');
  if (!input || !btn) return;
  input.classList.toggle('textarea-warning', isShell);
  input.style.fontFamily = isShell ? 'monospace' : '';
  btn.classList.toggle('btn-warning', isShell);
  btn.classList.toggle('btn-primary', !isShell);
  btn.textContent = isShell ? 'Run' : 'Send';
  const label = AGENT_LABELS[currentAgent.peek()] || 'agent';
  const compact = typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;
  if (isShell) {
    input.placeholder = compact ? 'Shell 命令…' : 'Shell command (without !)…';
  } else {
    input.placeholder = compact ? `问 ${label}…` : `Ask ${label}… or !cmd for shell`;
  }
}

/** `![img](path)` is an attachment reference, not a shell command. */
function isShellInput(value) {
  const text = String(value || '').trimStart();
  return text.startsWith('!') && !/^!\[[^\]]*\]\([^)]+\)/.test(text);
}

function chatInputMaxHeight() {
  // Keep in sync with #chat-input max-height in style.css (mobile vs desktop).
  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches) {
    return 72;
  }
  return 72;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, chatInputMaxHeight()) + 'px';
}

// ── Message rendering ─────────────────────────────────────────────────────────
const USER_COLLAPSE = 200;
const ASST_COLLAPSE = 500;

// Re-export shared timestamp helper (also used by shell/dashboard)
export { coerceTs } from './shell/util.js';
import { coerceTs } from './shell/util.js';

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

/** Pending chat attachments shown above the input (paths also inserted into text). */
const pendingAttachments = [];
let attachSeq = 0;
let chatDropBound = false;

async function uploadChatBlob(blob, filename) {
  const name = filename || `upload-${Date.now()}`;
  const uploadBlob = await normalizeImageBlob(blob, name);
  const headers = authHeaders({ 'x-filename': name });
  delete headers['Content-Type'];
  // Prefer file MIME so hub base64-encodes binary uploads correctly.
  if (uploadBlob?.type && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = uploadBlob.type;
  }
  const res = await fetch('/api/upload-image', {
    method: 'POST',
    headers,
    body: uploadBlob,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed: ${res.status}`);
  }
  const data = await res.json();
  if (!data?.path) throw new Error('upload returned no path');
  return data.path;
}

function imageMimeFromBytes(bytes, fallback) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a') return 'image/gif';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return fallback || 'image/png';
}

/** Some iOS share sheets provide a .png whose bytes are Base64 text. Decode it once
 * before both upload and preview, while leaving ordinary image files untouched. */
async function normalizeImageBlob(blob, filename) {
  if (!blob || !isImageFile({ type: blob.type, name: filename })) return blob;
  let head;
  try { head = (await blob.slice(0, 80).text()).trim(); } catch { return blob; }
  // Avoid reading an entire multi-megabyte ordinary photo into a JS string.
  if (!/^(?:data:image\/[a-z0-9.+-]+;base64,|iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/i.test(head)) return blob;
  let text;
  try { text = (await blob.text()).trim(); } catch { return blob; }
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(text);
  const payload = dataUrl?.[1] || text;
  if (!payload || !/^[a-z0-9+/=\s]+$/i.test(payload) || payload.length % 4 === 1) return blob;
  try {
    const binary = atob(payload.replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const mime = imageMimeFromBytes(bytes, blob.type);
    // A valid Base64 string alone is not enough: only replace it when it decodes
    // to an actual image signature.
    if (mime === (blob.type || 'image/png') && !/^(image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(mime)) return blob;
    const isImage = bytes.length >= 3 && (
      (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e)
      || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      || String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a'
      || String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
    );
    return isImage ? new Blob([bytes], { type: mime }) : blob;
  } catch {
    return blob;
  }
}

function insertAtCursor(ta, text) {
  if (!ta) return;
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  const padBefore = s > 0 && ta.value[s - 1] !== '\n' ? '\n' : '';
  const insert = padBefore + text + '\n';
  ta.value = ta.value.slice(0, s) + insert + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + insert.length;
  ta.dispatchEvent(new Event('input'));
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/i.test(file.name || '');
}

function makeAttachRef(file, path) {
  const name = file?.name || path.split('/').pop() || 'file';
  if (isImageFile(file)) {
    attachSeq += 1;
    const label = `img${attachSeq}`;
    return { ref: `![${label}](${path})`, label, kind: 'image' };
  }
  attachSeq += 1;
  const label = `file${attachSeq}`;
  return { ref: `[${label}](${path})`, label, kind: 'file' };
}

function clearPendingAttachments() {
  for (const item of pendingAttachments) {
    if (item.previewUrl) {
      try { URL.revokeObjectURL(item.previewUrl); } catch { /* ignore */ }
    }
  }
  pendingAttachments.length = 0;
  renderAttachBar();
}

function renderAttachBar() {
  const bar = $('chat-attach-bar');
  if (!bar) return;
  if (!pendingAttachments.length) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = pendingAttachments.map((item, i) => `
    <div class="chat-thumb relative" title="${esc(item.ref || item.path)}">
      ${item.previewUrl
        ? `<img src="${item.previewUrl}" alt="${esc(item.label || 'img')}">`
        : `<span class="chat-thumb-path">${esc(item.label || item.name || 'file')}</span>`}
      <span class="chat-thumb-label">${esc(item.label || item.kind || '')}</span>
      <button type="button" class="chat-thumb-x" data-rm-attach="${i}" aria-label="remove">✕</button>
    </div>`).join('');
}

async function addChatAttachment(file) {
  if (!file) return;
  const name = file.name || `upload-${Date.now()}`;
  const normalized = await normalizeImageBlob(file, name);
  const path = await uploadChatBlob(normalized, name);
  const { ref, label, kind } = makeAttachRef(file, path);
  let previewUrl = '';
  if (kind === 'image') {
    try { previewUrl = URL.createObjectURL(normalized); } catch { /* ignore */ }
  }
  pendingAttachments.push({ path, ref, label, kind, name, previewUrl });
  renderAttachBar();
  insertAtCursor($('chat-input'), ref);
  return path;
}

async function uploadFilesList(fileList) {
  const files = [...(fileList || [])].filter(Boolean);
  if (!files.length) return;
  const ta = $('chat-input');
  if (ta) ta.disabled = true;
  try {
    for (const file of files) {
      try {
        await addChatAttachment(file);
      } catch (err) {
        appendSystemMsg(`上传失败 ${file.name || 'file'}: ${err.message}`);
      }
    }
  } finally {
    if (ta) {
      ta.disabled = false;
      ta.focus();
    }
  }
}

/** Open file picker (images + any files). */
export function attachImage() {
  const input = $('chat-file-input');
  if (input) {
    input.value = '';
    input.click();
    return;
  }
  const fallback = document.createElement('input');
  fallback.type = 'file';
  fallback.accept = 'image/*,*/*';
  fallback.multiple = true;
  fallback.addEventListener('change', () => uploadFilesList(fallback.files));
  fallback.click();
}

export function initImagePaste() {
  document.addEventListener('paste', async e => {
    const ta = $('chat-input');
    if (!ta) return;
    // Accept paste when focusing input, or when composer is active
    const composer = $('chat-composer');
    const inComposer = composer && (composer.contains(document.activeElement) || document.activeElement === ta);
    if (!inComposer && document.activeElement !== ta) return;

    const items = [...(e.clipboardData?.items || [])];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    // Prefer image paste; also allow non-image files from clipboard when present
    const imageFiles = files.filter(f => isImageFile(f));
    const pick = imageFiles.length ? imageFiles : files;
    if (!pick.length) return;
    e.preventDefault();
    await uploadFilesList(pick);
  });

  if (chatDropBound) return;
  chatDropBound = true;
  document.addEventListener('dragover', e => {
    const composer = $('chat-composer');
    if (!composer || !e.dataTransfer?.types?.includes('Files')) return;
    if (!composer.contains(e.target) && e.target !== composer) return;
    e.preventDefault();
    composer.classList.add('chat-drop-active');
  });
  document.addEventListener('dragleave', e => {
    const composer = $('chat-composer');
    if (!composer) return;
    if (e.target === composer || composer.contains(e.target)) {
      // leaving to outside
      if (!composer.contains(e.relatedTarget)) composer.classList.remove('chat-drop-active');
    }
  });
  document.addEventListener('drop', async e => {
    const composer = $('chat-composer');
    if (!composer) return;
    composer.classList.remove('chat-drop-active');
    if (!composer.contains(e.target) && e.target !== composer) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    await uploadFilesList(files);
  });
}

function fmtNum(n) { return n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n); }

function appendTokenBar(text) {
  const msgs = $('messages');
  if (!msgs) return;
  msgs.insertAdjacentHTML('beforeend',
    `<div class="token-bar select-none">
       <span class="token-bar-mark">◈</span><span class="token-bar-text">${esc(text)}</span>
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
  initWakeLock();

  watch(wsStatus, st => {
    updateConnDot();
    syncWakeLock();
    const el = $('ws-banner');
    const text = $('ws-banner-text');
    if (!el) return;
    if (st === 'open' || st === 'idle') {
      el.classList.add('hidden');
      if (text) text.textContent = '';
      return;
    }
    // Show banner for reconnecting/offline; brief connecting after a drop
    if (st === 'connecting' && !sawDisconnect) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const msg = st === 'offline'
      ? '网络已断开，恢复后会自动重连'
      : st === 'connecting'
        ? '正在连接…'
        : '连接中断，正在重连…（熄屏或切网时常见）';
    if (text) text.textContent = msg;
    else el.textContent = msg;
  });

  watch(currentProject, () => syncWakeLock());

  delegate.on('click', '#btn-refresh-conn, #ws-banner-retry', e => {
    e.preventDefault();
    refreshConnection();
  });

  // Processing state → send/stop buttons + typing indicator
  // Keep the input enabled so the next message can be composed (and queued).
  watch(isProcessing, val => {
    $('send-btn')?.classList.toggle('hidden', val);
    $('stop-btn')?.classList.toggle('hidden', !val);
    const input = $('chat-input');
    if (input) {
      input.disabled = false;
      if (val) input.placeholder = '回复中… 可先写好下一条，结束后自动发送 · 或点 ■ 停止';
      else updateInputMode(input.value || '');
    }
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
    syncWakeLock();
  });

  watch(chatDensity, () => applyChatDensity());

  // Chat input: ⌘/Ctrl+Enter = send. On phones, Enter sends (Shift+Enter newline).
  delegate.on('keydown', '#chat-input', e => {
    if (e.key !== 'Enter') return;
    const combo = e.metaKey || e.ctrlKey;
    const phone = window.matchMedia('(max-width: 640px)').matches && !e.shiftKey && !combo;
    if (combo || phone) { e.preventDefault(); sendMessage(); }
  });
  delegate.on('submit', '#chat-form', e => {
    e.preventDefault();
    sendMessage();
  });
  delegate.on('input',   '#chat-input', (e, el) => { autoResize(el); updateInputMode(el.value); });

  // Attach images / files
  delegate.on('click', '#btn-attach', e => {
    e.preventDefault();
    attachImage();
  });
  delegate.on('change', '#chat-file-input', (e, el) => {
    const files = el?.files;
    if (files?.length) uploadFilesList(files);
    if (el) el.value = '';
  });
  delegate.on('click', '[data-rm-attach]', (e, el) => {
    e.preventDefault();
    e.stopPropagation();
    const i = parseInt(el.dataset.rmAttach, 10);
    if (Number.isNaN(i) || i < 0 || i >= pendingAttachments.length) return;
    const item = pendingAttachments[i];
    if (item?.previewUrl) {
      try { URL.revokeObjectURL(item.previewUrl); } catch { /* ignore */ }
    }
    const ta = $('chat-input');
    if (ta && item?.ref) {
      ta.value = ta.value.split(item.ref).join('').replace(/\n{3,}/g, '\n\n');
      ta.dispatchEvent(new Event('input'));
    }
    pendingAttachments.splice(i, 1);
    renderAttachBar();
  });

  // Permission buttons → approval.respond (typed control plane)
  delegate.on('click', '[data-perm-id]', (e, el) => {
    sendWs({
      type: 'command',
      cmd: 'approval.respond',
      requestId: el.dataset.permId,
      allow: el.dataset.permAllow === '1',
      sessionId: ctx.sessionId,
    });
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
