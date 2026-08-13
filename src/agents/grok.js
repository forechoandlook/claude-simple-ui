import { spawn } from 'child_process';
import readline from 'readline';
import crypto from 'crypto';
import { createDeltaBatcher } from './stream-batch.js';

/**
 * Run Grok CLI headlessly with streaming-json over WebSocket (not HTTP SSE).
 *
 * New turn:
 *   grok -p <prompt> --output-format streaming-json --cwd <dir> ...
 * Resume:
 *   grok --resume <sessionId> -p <prompt> --output-format streaming-json ...
 *
 * Stream events (line-delimited JSON):
 *   { type: "thought", data: "..." }
 *   { type: "text",    data: "..." }
 *   { type: "tool_*",  ... }   // when CLI emits them
 *   { type: "end", sessionId, usage, ... }
 *
 * We forward deltas immediately so the UI updates live instead of dumping at end.
 */

function mapPermission(permissionMode, allowBypass) {
  if (allowBypass || permissionMode === 'bypassPermissions') return 'bypassPermissions';
  if (permissionMode && permissionMode !== 'default') return permissionMode;
  return null;
}

function buildArgs(command, options) {
  const args = [];

  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }

  // -p = headless single-turn (required for non-TTY streaming-json)
  args.push('-p', command || '');
  args.push('--output-format', 'streaming-json');

  if (options.cwd) args.push('--cwd', options.cwd);
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--reasoning-effort', options.effort);

  const perm = mapPermission(options.permissionMode, options.allowDangerouslySkipPermissions);
  if (perm) args.push('--permission-mode', perm);
  if (options.allowDangerouslySkipPermissions || options.permissionMode === 'bypassPermissions') {
    args.push('--always-approve');
  }

  if (options.newSessionId && !options.sessionId) {
    args.push('--session-id', options.newSessionId);
  }

  return args;
}

function parseMaybeJson(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return { input: v }; }
  }
  return { value: v };
}

export function runGrok(command, options, send, { cliPath, activeSessions }) {
  return new Promise((resolve) => {
    const sessionKey = options.sessionId || crypto.randomUUID();
    const bin = cliPath || 'grok';
    const args = buildArgs(command, options);

    const env = { ...process.env };
    env.CI = env.CI || '1';
    // Reduce pipe buffering if the runtime honors it
    env.PYTHONUNBUFFERED = '1';

    let child;
    try {
      child = spawn(bin, args, {
        cwd: options.cwd || process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      send({ type: 'error', message: `Failed to start grok: ${e.message}`, agent: 'grok' });
      resolve();
      return;
    }

    // Unbuffer stdout as much as possible
    if (child.stdout?.setEncoding) child.stdout.setEncoding('utf8');

    const entry = { kind: 'grok', child, startTime: Date.now(), busy: true, key: sessionKey, sessionId: options.sessionId || null };
    activeSessions.set(sessionKey, entry);

    let sessionId = options.sessionId || null;
    let aborted = false;
    let stderr = '';
    let gotEnd = false;
    let streamOpen = false; // live assistant bubble on the client
    let thoughtOpen = false;
    let textChars = 0;
    let thoughtChars = 0;

    const textBatch = createDeltaBatcher(send, 'assistant_delta', { agent: 'grok' }, { maxWait: 48, maxSize: 480 });
    const thoughtBatch = createDeltaBatcher(send, 'thought_delta', { agent: 'grok' }, { maxWait: 140, maxSize: 600 });

    child.stderr.on('data', d => { stderr += d.toString(); });

    // Use 'readable' + line split for lower latency than waiting for large chunks
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    function ensureStream() {
      if (!streamOpen) {
        send({ type: 'assistant_stream_start', agent: 'grok', ts: Date.now() });
        streamOpen = true;
      }
    }

    function endStream() {
      textBatch.flush();
      if (streamOpen) {
        send({ type: 'assistant_stream_end', agent: 'grok' });
        streamOpen = false;
      }
    }

    function flushThought() {
      if (!thoughtBatch.pending()) return;
      if (!thoughtOpen) {
        send({ type: 'thought_stream_start', agent: 'grok' });
        thoughtOpen = true;
      }
      const n = thoughtBatch.pending();
      thoughtBatch.flush();
      thoughtChars += n;
    }

    function emitTool(raw) {
      // Finalize any open text/thought before tool card
      flushThought();
      if (thoughtOpen) {
        send({ type: 'thought_stream_end', agent: 'grok' });
        thoughtOpen = false;
      }
      endStream();

      const name = raw.name || raw.tool || raw.toolName || raw.tool_name
        || raw.title || raw.data?.name || 'tool';
      let input = raw.input ?? raw.arguments ?? raw.args ?? raw.rawInput
        ?? raw.data?.input ?? raw.data?.arguments ?? raw.data ?? {};
      input = parseMaybeJson(input);

      send({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name, input }] },
        agent: 'grok',
        ts: Date.now(),
      });
    }

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let raw;
      try { raw = JSON.parse(line); } catch {
        // Non-JSON progress line — surface lightly
        send({ type: 'status', message: line.slice(0, 200), agent: 'grok' });
        return;
      }

      const t = String(raw.type || '').toLowerCase();

      // ── Text tokens (batched ~50ms) ──────────────────────────────────────
      if ((t === 'text' || t === 'message' || t === 'output_text') && raw.data != null) {
        flushThought();
        if (thoughtOpen) {
          send({ type: 'thought_stream_end', agent: 'grok' });
          thoughtOpen = false;
        }
        const chunk = String(raw.data);
        if (!chunk) return;
        ensureStream();
        textChars += chunk.length;
        textBatch.push(chunk);
        return;
      }

      // ── Thinking tokens (batched stream) ────────────────────────────────
      if ((t === 'thought' || t === 'thinking' || t === 'reasoning') && raw.data != null) {
        if (!thoughtOpen) {
          send({ type: 'thought_stream_start', agent: 'grok' });
          thoughtOpen = true;
        }
        thoughtBatch.push(String(raw.data));
        return;
      }

      // ── Tools ───────────────────────────────────────────────────────────
      if (
        t === 'tool_use' || t === 'tool_call' || t === 'tool_start'
        || t === 'tool' || t === 'function_call' || t === 'tool_call_start'
        || t.startsWith('tool_')
      ) {
        // Avoid treating tool_result as a new call
        if (t === 'tool_result' || t === 'tool_call_update' || t === 'tool_end' || t === 'tool_call_end') {
          return;
        }
        emitTool(raw);
        return;
      }

      // ── Session id early (some builds emit before end) ───────────────────
      if ((t === 'session' || t === 'session_started') && (raw.sessionId || raw.session_id)) {
        sessionId = raw.sessionId || raw.session_id;
        entry.sessionId = sessionId;
        activeSessions.set(sessionId, entry);
        if (!options.sessionId) {
          send({ type: 'session-created', sessionId, agent: 'grok' });
        }
        return;
      }

      // ── End of turn ─────────────────────────────────────────────────────
      if (t === 'end' || t === 'result' || t === 'done') {
        gotEnd = true;
        flushThought();
        if (thoughtOpen) {
          send({ type: 'thought_stream_end', agent: 'grok' });
          thoughtOpen = false;
        }
        endStream();

        if (raw.sessionId || raw.session_id) {
          sessionId = raw.sessionId || raw.session_id;
          entry.sessionId = sessionId;
          activeSessions.set(sessionId, entry);
          if (!options.sessionId) {
            send({ type: 'session-created', sessionId, agent: 'grok' });
          }
        }

        // Unlock UI immediately — process may linger after the turn ends.
        entry.busy = false;

        const u = raw.usage || {};
        const costTicks = raw.total_cost_usd_ticks ?? u.cost_usd_ticks ?? u.costUsdTicks;
        const costUSD = raw.total_cost_usd ?? u.cost_usd ?? u.costUSD
          ?? (typeof costTicks === 'number' ? costTicks / 1e10 : undefined);

        const sid = sessionId || sessionKey;
        send({
          type: 'result',
          is_error: false,
          usage: {
            inputTokens: u.input_tokens || u.inputTokens || 0,
            outputTokens: u.output_tokens || u.outputTokens || 0,
            cacheReadInputTokens: u.cache_read_input_tokens || u.cachedReadTokens || 0,
            totalTokens: u.total_tokens || u.totalTokens
              || ((u.input_tokens || u.inputTokens || 0) + (u.output_tokens || u.outputTokens || 0)),
            reasoningTokens: u.reasoning_tokens || u.reasoningTokens || 0,
            costUSD,
          },
          sessionId: sid,
          agent: 'grok',
          stats: { textChars, thoughtChars },
        });
        // Early complete so client can send next turn without waiting for process exit.
        send({ type: 'complete', exitCode: 0, sessionId: sid, agent: 'grok' });
        return;
      }

      if (t === 'error') {
        entry.busy = false;
        send({ type: 'error', message: raw.message || raw.data || 'grok error', agent: 'grok' });
      }
    });

    child.on('close', (code) => {
      flushThought();
      if (thoughtOpen) send({ type: 'thought_stream_end', agent: 'grok' });
      endStream();
      rl.close();
      entry.busy = false;
      activeSessions.delete(sessionKey);
      if (sessionId) activeSessions.delete(sessionId);

      // Skip duplicate complete if turn already finished via streaming-json "end".
      if (gotEnd && !aborted) {
        resolve();
        return;
      }

      if (aborted) {
        send({ type: 'complete', exitCode: 130, aborted: true, sessionId: sessionId || sessionKey, agent: 'grok' });
      } else if (code !== 0 && code != null && !gotEnd) {
        const errMsg = stderr.trim().split('\n').filter(l => !/stdin is not a terminal/i.test(l)).join('\n')
          || `grok exited with code ${code}`;
        send({ type: 'error', message: errMsg, agent: 'grok' });
        send({ type: 'complete', exitCode: code, sessionId: sessionId || sessionKey, agent: 'grok' });
      } else {
        if (sessionId && !options.sessionId && !gotEnd) {
          send({ type: 'session-created', sessionId, agent: 'grok' });
        }
        send({ type: 'complete', exitCode: code ?? 0, sessionId: sessionId || sessionKey, agent: 'grok' });
      }
      resolve();
    });

    child.on('error', (e) => {
      entry.busy = false;
      activeSessions.delete(sessionKey);
      if (sessionId) activeSessions.delete(sessionId);
      send({ type: 'error', message: e.message, agent: 'grok' });
      resolve();
    });

    entry.abort = () => {
      aborted = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    };

    // Tell UI a run started (typing indicator already on; optional status)
    send({ type: 'status', message: 'Grok running…', agent: 'grok' });
  });
}
