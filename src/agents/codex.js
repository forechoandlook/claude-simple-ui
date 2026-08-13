import { spawn } from 'child_process';
import readline from 'readline';
import crypto from 'crypto';

/**
 * Run OpenAI Codex CLI via `codex exec --json` (same approach as cc-connect).
 * Multi-turn: first turn starts a thread; later turns use `exec resume <id>`.
 *
 * Emits normalized events the frontend already understands:
 *   session-created, assistant (text), tool_use-style via assistant tool blocks,
 *   result (usage), complete, error
 */

function mapPermissionToMode(permissionMode) {
  switch (permissionMode) {
    case 'acceptEdits':
    case 'auto':
      return 'full-auto';
    case 'bypassPermissions':
      return 'yolo';
    default:
      return 'suggest';
  }
}

function buildArgs(options, isResume) {
  const mode = options.mode || mapPermissionToMode(options.permissionMode);
  const args = isResume
    ? ['exec', 'resume', '--skip-git-repo-check']
    : ['exec', '--skip-git-repo-check'];

  // exec has no approval IPC → approval_policy=never; sandbox enforces safety.
  // resume does not accept --sandbox, so use -c overrides instead.
  switch (mode) {
    case 'auto-edit':
    case 'full-auto':
      if (isResume) {
        args.push('-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"');
      } else {
        args.push('--sandbox', 'workspace-write', '-c', 'approval_policy="never"');
      }
      break;
    case 'yolo':
      args.push('--dangerously-bypass-approvals-and-sandbox');
      break;
    default: // suggest
      if (isResume) {
        args.push('-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"');
      } else {
        args.push('--sandbox', 'read-only', '-c', 'approval_policy="never"');
      }
  }

  if (options.model)  args.push('--model', options.model);
  if (options.effort) args.push('-c', `model_reasoning_effort="${options.effort}"`);

  if (isResume) {
    args.push(options.sessionId, '--json', '-');
  } else {
    args.push('--json', '--cd', options.cwd || process.cwd(), '-');
  }
  return args;
}

function extractItemText(item) {
  if (typeof item.text === 'string' && item.text) return item.text;
  for (const key of ['content', 'output_text', 'summary', 'summary_text']) {
    const v = item[key];
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v)) {
      const parts = v
        .map(p => (typeof p === 'string' ? p : p?.text || p?.output_text || ''))
        .filter(Boolean);
      if (parts.length) return parts.join('\n');
    }
  }
  return '';
}

export function runCodex(command, options, send, { cliPath, activeSessions }) {
  return new Promise((resolve) => {
    const isResume = Boolean(options.sessionId);
    const sessionKey = options.sessionId || crypto.randomUUID();
    const args = buildArgs(options, isResume);
    const bin = cliPath || 'codex';

    const env = { ...process.env };
    if (options.codexHome) env.CODEX_HOME = options.codexHome;

    let child;
    try {
      child = spawn(bin, args, {
        cwd: options.cwd || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      send({ type: 'error', message: `Failed to start codex: ${e.message}`, agent: 'codex' });
      resolve();
      return;
    }

    const entry = { kind: 'codex', child, startTime: Date.now(), busy: true, key: sessionKey, sessionId: options.sessionId || null };
    activeSessions.set(sessionKey, entry);
    // Also register under thread id once known so abort-session works
    let threadId = options.sessionId || null;
    let pendingText = [];
    let aborted = false;
    let stderr = '';

    child.stdin.write(command || '');
    child.stdin.end();

    child.stderr.on('data', d => { stderr += d.toString(); });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    function flushText() {
      // Dedupe identical bodies (CLI may emit agent_message + message for one turn)
      const seen = new Set();
      for (const text of pendingText) {
        const t = text?.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        // Stream-friendly: open bubble, dump text, close (codex emits completed items, not token deltas)
        send({ type: 'assistant_stream_start', agent: 'codex', ts: Date.now() });
        send({ type: 'assistant_delta', data: t, agent: 'codex' });
        send({ type: 'assistant_stream_end', agent: 'codex' });
      }
      pendingText = [];
    }

    function handleItem(item, phase) {
      if (!item || typeof item !== 'object') return;
      const itemType = item.type;

      if (itemType === 'agent_message' || itemType === 'message') {
        if (phase === 'completed') {
          const text = extractItemText(item)?.trim();
          if (text && !pendingText.some(t => (t || '').trim() === text)) {
            pendingText.push(text);
          }
        }
        return;
      }

      if (itemType === 'reasoning') {
        const text = extractItemText(item);
        if (text && phase === 'completed') {
          send({ type: 'assistant', message: { content: [{ type: 'text', text: `💭 ${text}` }] }, agent: 'codex' });
        }
        return;
      }

      if (itemType === 'command_execution') {
        const command = item.command || '';
        if (phase === 'started') {
          send({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
            agent: 'codex',
          });
        }
        return;
      }

      if (itemType === 'function_call') {
        const name = item.name || 'function';
        let input = item.arguments;
        try { input = typeof input === 'string' ? JSON.parse(input) : input; } catch { /* keep string */ }
        if (phase === 'started' || phase === 'completed') {
          send({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name, input: input ?? {} }] },
            agent: 'codex',
          });
        }
        return;
      }

      // Other known tools
      const known = {
        web_search: 'WebSearch',
        file_search: 'FileSearch',
        code_interpreter: 'CodeInterpreter',
        mcp_tool: 'MCP',
      };
      if (known[itemType] && phase === 'completed') {
        send({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: known[itemType], input: item }] },
          agent: 'codex',
        });
      }
    }

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let raw;
      try { raw = JSON.parse(line); } catch { return; }

      const eventType = raw.type;
      switch (eventType) {
        case 'thread.started': {
          if (raw.thread_id) {
            threadId = raw.thread_id;
            activeSessions.set(threadId, entry);
            send({ type: 'session-created', sessionId: threadId, agent: 'codex' });
          }
          break;
        }
        case 'turn.started':
          pendingText = [];
          break;
        case 'item.started':
          handleItem(raw.item, 'started');
          break;
        case 'item.completed':
          handleItem(raw.item, 'completed');
          break;
        case 'turn.completed': {
          flushText();
          const u = raw.usage || {};
          send({
            type: 'result',
            is_error: false,
            usage: {
              inputTokens: u.input_tokens || 0,
              outputTokens: u.output_tokens || 0,
              cacheReadInputTokens: u.cached_input_tokens || 0,
            },
            sessionId: threadId || sessionKey,
            agent: 'codex',
          });
          break;
        }
        case 'turn.failed': {
          const msg = raw.error?.message || raw.message || 'turn failed';
          send({ type: 'error', message: msg, agent: 'codex' });
          break;
        }
        case 'error': {
          const msg = raw.message || 'codex error';
          if (!/Reconnecting|Falling back/i.test(msg)) {
            send({ type: 'error', message: msg, agent: 'codex' });
          }
          break;
        }
        default:
          break;
      }
    });

    child.on('close', (code) => {
      rl.close();
      activeSessions.delete(sessionKey);
      if (threadId) activeSessions.delete(threadId);
      if (aborted) {
        send({ type: 'complete', exitCode: 130, aborted: true, sessionId: threadId || sessionKey, agent: 'codex' });
      } else if (code !== 0 && code != null) {
        const errMsg = stderr.trim() || `codex exited with code ${code}`;
        // Avoid double-error if we already sent turn.failed
        send({ type: 'complete', exitCode: code, sessionId: threadId || sessionKey, agent: 'codex', error: errMsg });
        if (stderr.trim()) send({ type: 'error', message: errMsg, agent: 'codex' });
      } else {
        send({ type: 'complete', exitCode: 0, sessionId: threadId || sessionKey, agent: 'codex' });
      }
      resolve();
    });

    child.on('error', (e) => {
      activeSessions.delete(sessionKey);
      if (threadId) activeSessions.delete(threadId);
      send({ type: 'error', message: e.message, agent: 'codex' });
      resolve();
    });

    entry.abort = () => {
      aborted = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    };
  });
}
