/**
 * Typed control-plane commands + canonical runtime events.
 * Inspired by T3's orchestration/adapters split, kept intentionally thin.
 *
 * Client → server: Command
 * Server → client: RuntimeEvent (optionally wrapped in `batch`)
 */

/** @typedef {'turn.start'|'turn.interrupt'|'approval.respond'|'shell.exec'|'session.subscribe'} CommandType */

/**
 * Normalize any inbound WS message into a command, or null if not a control command.
 * Keeps legacy aliases working (agent-command, abort-session, …).
 */
export function normalizeCommand(msg) {
  if (!msg || typeof msg !== 'object') return null;

  // New shape: { type: 'command', cmd: 'turn.start', ... }
  if (msg.type === 'command' && msg.cmd) {
    return {
      cmd: msg.cmd,
      id: msg.id || null,
      agent: msg.agent || msg.options?.agent || 'claude',
      command: msg.command ?? msg.prompt ?? '',
      options: msg.options || {},
      sessionId: msg.sessionId || msg.options?.sessionId || null,
      requestId: msg.requestId || null,
      allow: msg.allow,
      always: msg.always,
      cwd: msg.cwd || msg.options?.cwd || null,
    };
  }

  if (msg.type === 'claude-command' || msg.type === 'agent-command') {
    return {
      cmd: 'turn.start',
      id: msg.id || null,
      agent: msg.agent || msg.options?.agent || 'claude',
      command: msg.command || '',
      options: msg.options || {},
      sessionId: msg.options?.sessionId || null,
      requestId: null,
      allow: undefined,
      always: false,
      cwd: msg.options?.cwd || null,
    };
  }

  if (msg.type === 'abort-session') {
    return {
      cmd: 'turn.interrupt',
      id: msg.id || null,
      agent: null,
      command: '',
      options: {},
      sessionId: msg.sessionId || null,
      requestId: null,
      allow: undefined,
      always: false,
      cwd: null,
    };
  }

  if (msg.type === 'claude-permission-response' || msg.type === 'approval.respond') {
    return {
      cmd: 'approval.respond',
      id: msg.id || null,
      agent: null,
      command: '',
      options: {},
      sessionId: msg.sessionId || null,
      requestId: msg.requestId || msg.request_id,
      allow: msg.allow !== false && msg.allow !== 0 && msg.allow !== '0',
      always: !!msg.always,
      cwd: null,
    };
  }

  if (msg.type === 'shell-command') {
    return {
      cmd: 'shell.exec',
      id: msg.id || null,
      agent: null,
      command: msg.command || '',
      options: {},
      sessionId: null,
      requestId: null,
      allow: undefined,
      always: false,
      cwd: msg.cwd || null,
    };
  }

  if (msg.type === 'subscribe') {
    return {
      cmd: 'session.subscribe',
      id: msg.id || null,
      agent: null,
      command: '',
      options: {},
      sessionId: msg.sessionId || null,
      requestId: null,
      allow: undefined,
      always: false,
      cwd: null,
    };
  }

  return null;
}

/** Event types the UI understands today (kept stable for back-compat). */
export const UI_EVENT = {
  SESSION_CREATED: 'session-created',
  ASSISTANT: 'assistant',
  ASSISTANT_STREAM_START: 'assistant_stream_start',
  ASSISTANT_DELTA: 'assistant_delta',
  ASSISTANT_STREAM_END: 'assistant_stream_end',
  THOUGHT_STREAM_START: 'thought_stream_start',
  THOUGHT_DELTA: 'thought_delta',
  THOUGHT_STREAM_END: 'thought_stream_end',
  RESULT: 'result',
  COMPLETE: 'complete',
  ERROR: 'error',
  STATUS: 'status',
  PERMISSION_REQUEST: 'permission_request',
  PERMISSION_RESOLVED: 'permission_resolved',
  SHELL_START: 'shell-start',
  SHELL_OUTPUT: 'shell-output',
  SHELL_EXIT: 'shell-exit',
  RUN_STATUS: 'run-status',
  ABORT_RESULT: 'abort-result',
  BATCH: 'batch',
  PING: 'ping',
  PONG: 'pong',
};

/**
 * Compact tool_use inputs before they hit the wire (mobile tunnel cost).
 * @param {unknown} input
 * @param {number} [max=100]
 */
export function compactToolInput(input, max = 100) {
  if (input == null) return input;
  let raw;
  try {
    raw = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    raw = String(input);
  }
  if (raw.length <= max) return input;
  return { _truncated: true, preview: raw.slice(0, max), bytes: raw.length };
}

/**
 * Map a loose agent emit into a UI event, dropping unknown SDK noise.
 * Returns null to drop the frame entirely.
 */
export function mapAgentEmit(data, { agent, compactTools = true } = {}) {
  if (!data || typeof data !== 'object') return null;
  const t = data.type;

  // Already a UI event we know
  const known = new Set([
    'session-created', 'assistant', 'assistant_stream_start', 'assistant_delta',
    'assistant_stream_end', 'thought_stream_start', 'thought_delta', 'thought_stream_end',
    'result', 'complete', 'error', 'status', 'permission_request', 'permission_resolved',
    'shell-start', 'shell-output', 'shell-exit', 'run-status', 'abort-result',
  ]);
  if (known.has(t)) {
    const out = { ...data };
    if (agent && !out.agent) out.agent = agent;
    if (compactTools && out.type === 'assistant' && Array.isArray(out.message?.content)) {
      out.message = {
        ...out.message,
        content: out.message.content.map((b) => {
          if (b?.type === 'tool_use' && b.input != null) {
            return { ...b, input: compactToolInput(b.input) };
          }
          return b;
        }),
      };
    }
    return out;
  }

  // Claude Agent SDK message shapes → UI
  if (t === 'system' && data.session_id) {
    return { type: 'session-created', sessionId: data.session_id, agent: agent || 'claude' };
  }

  if (t === 'assistant' && data.message) {
    // SDK assistant message — keep but compact tools
    return mapAgentEmit({ type: 'assistant', message: data.message, ts: data.ts }, { agent, compactTools });
  }

  if (t === 'result') {
    return {
      type: 'result',
      is_error: !!data.is_error,
      usage: data.usage || null,
      sessionId: data.session_id || data.sessionId || null,
      agent: agent || data.agent || 'claude',
      result: typeof data.result === 'string' && data.result.length > 4000
        ? data.result.slice(0, 4000) + '…'
        : data.result,
    };
  }

  // Drop high-chatter / unused SDK frames (stream_event, user, tool_progress, auth, …)
  if (
    t === 'stream_event'
    || t === 'user'
    || t === 'tool_progress'
    || t === 'auth_status'
    || t === 'rate_limit_event'
    || t === 'system' // non-session system notices
  ) {
    return null;
  }

  // Unknown — drop to cut noise (was previously forwarded wholesale from Claude)
  return null;
}
