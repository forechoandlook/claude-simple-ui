import { spawn } from 'child_process';
import readline from 'readline';
import crypto from 'crypto';

// Grok's ACP transport is a long-lived JSON-RPC process.  Keeping it alive is
// important: it owns the real Grok session and lets the edge, rather than an
// individual browser tab, serialize follow-up prompts.
const clients = new Map();
const queues = new Map();
const queueAliases = new Map();

function profileKey(options) {
  return `${options.model || ''}\u001f${options.effort || ''}`;
}

class GrokACPClient {
  constructor({ cliPath, model, effort }) {
    const args = ['agent', '--always-approve'];
    if (model) args.push('--model', model);
    if (effort) args.push('--reasoning-effort', effort);
    args.push('stdio');
    this.child = spawn(cliPath || 'grok', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.listeners = new Map();
    this.nextID = 1;
    this.ready = this.initialize();
    this.child.stderr.on('data', d => console.warn(`[grok acp] ${String(d).trim()}`));
    this.child.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Grok ACP process stopped'));
      this.pending.clear();
      for (const fn of this.listeners.values()) fn({ type: 'error', message: 'Grok ACP process stopped', agent: 'grok' });
      this.listeners.clear();
    });
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', line => this.receive(line));
  }

  async initialize() {
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'claude-simple-ui', version: '0.2.7' },
    });
    const methods = new Set((init.authMethods || []).map(x => x?.id));
    const methodId = process.env.XAI_API_KEY && methods.has('xai.api_key')
      ? 'xai.api_key'
      : (methods.has('cached_token') ? 'cached_token' : null);
    if (methodId) await this.request('authenticate', { methodId, _meta: { headless: true } });
  }

  receive(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || 'Grok ACP request failed'));
      else pending.resolve(msg.result || {});
      return;
    }
    // Grok's documented ACP client sample does not need client-side tool RPC.
    // Return a structured error for optional extension calls instead of leaving
    // an agent request hanging forever.
    if (msg.id != null && msg.method) {
      this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unsupported client method: ${msg.method}` } });
      return;
    }
    if (msg.method === 'session/update') {
      const sid = msg.params?.sessionId;
      const fn = sid && this.listeners.get(sid);
      if (fn) fn(msg.params?.update || {});
    }
  }

  write(data) {
    if (!this.child.stdin?.writable) throw new Error('Grok ACP stdin is unavailable');
    this.child.stdin.write(JSON.stringify(data) + '\n');
  }

  request(method, params) {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  async ensureSession(options) {
    await this.ready;
    if (options.sessionId) {
      try {
        await this.request('session/load', { sessionId: options.sessionId, cwd: options.cwd, mcpServers: [] });
      } catch {
        await this.request('session/resume', { sessionId: options.sessionId, cwd: options.cwd, mcpServers: [] });
      }
      return options.sessionId;
    }
    const result = await this.request('session/new', {
      cwd: options.cwd || process.cwd(),
      mcpServers: [],
      _meta: { yoloMode: true },
    });
    if (!result.sessionId) throw new Error('Grok ACP did not return a session id');
    return result.sessionId;
  }
}

function clientFor(options, cliPath) {
  const key = profileKey(options);
  let client = clients.get(key);
  if (!client || client.child.exitCode != null) {
    client = new GrokACPClient({ cliPath, model: options.model, effort: options.effort });
    clients.set(key, client);
  }
  return client;
}

function emitUpdate(update, send, sessionId, state) {
  const kind = update?.sessionUpdate;
  if (kind === 'agent_message_chunk' && update.content?.text) {
    if (!state.textOpen) { send({ type: 'assistant_stream_start', agent: 'grok', ts: Date.now() }); state.textOpen = true; }
    send({ type: 'assistant_delta', data: update.content.text, agent: 'grok' });
  } else if (kind === 'agent_thought_chunk' && update.content?.text) {
    if (!state.thoughtOpen) { send({ type: 'thought_stream_start', agent: 'grok' }); state.thoughtOpen = true; }
    send({ type: 'thought_delta', data: update.content.text, agent: 'grok' });
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    if (state.textOpen) { send({ type: 'assistant_stream_end', agent: 'grok' }); state.textOpen = false; }
    if (state.thoughtOpen) { send({ type: 'thought_stream_end', agent: 'grok' }); state.thoughtOpen = false; }
    if (kind === 'tool_call') {
      send({ type: 'assistant', agent: 'grok', message: { content: [{
        type: 'tool_use', name: update.title || update.kind || 'tool', input: update.rawInput || update.input || {},
      }] } });
    }
  }
}

async function runOne(item, { cliPath, activeSessions, queueKey }) {
  const { command, options, send } = item;
  const client = clientFor(options, cliPath);
  const localKey = options.sessionId || crypto.randomUUID();
  const entry = { kind: 'grok-acp', startTime: Date.now(), busy: true, key: localKey, sessionId: options.sessionId || null };
  activeSessions.set(localKey, entry);
  const state = { textOpen: false, thoughtOpen: false };
  let sessionId = options.sessionId;
  try {
    sessionId = await client.ensureSession(options);
    queueAliases.set(sessionId, queueKey);
    entry.sessionId = sessionId;
    activeSessions.set(sessionId, entry);
    entry.abort = () => { client.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }); };
    if (!options.sessionId) send({ type: 'session-created', sessionId, agent: 'grok' });
    client.listeners.set(sessionId, update => emitUpdate(update, send, sessionId, state));
    const result = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: command }],
    });
    if (state.textOpen) send({ type: 'assistant_stream_end', agent: 'grok' });
    if (state.thoughtOpen) send({ type: 'thought_stream_end', agent: 'grok' });
    entry.busy = false;
    send({ type: 'result', is_error: result.stopReason === 'error', usage: result._meta?.usage || null, sessionId, agent: 'grok' });
    send({ type: 'complete', exitCode: result.stopReason === 'cancelled' ? 130 : 0, aborted: result.stopReason === 'cancelled', sessionId, agent: 'grok' });
  } catch (e) {
    entry.busy = false;
    send({ type: 'error', message: e.message, sessionId, agent: 'grok' });
    send({ type: 'complete', exitCode: 1, sessionId, agent: 'grok' });
  } finally {
    if (sessionId) client.listeners.delete(sessionId);
    activeSessions.delete(localKey);
    if (sessionId) activeSessions.delete(sessionId);
  }
}

/** Queue all Grok follow-ups at the edge. The promise resolves after this item runs. */
export function runGrok(command, options, send, { cliPath, activeSessions }) {
  const key = (options.sessionId && queueAliases.get(options.sessionId)) || options.sessionId || `new:${options.cwd || ''}`;
  const queue = queues.get(key) || { items: [], running: false };
  queues.set(key, queue);
  return new Promise(resolve => {
    queue.items.push({ command, options, send, resolve });
    if (queue.running) {
      send({ type: 'status', message: `Grok follow-up queued (${queue.items.length - 1} ahead)`, sessionId: options.sessionId, agent: 'grok' });
      return;
    }
    queue.running = true;
    const drain = async () => {
      while (queue.items.length) {
        const item = queue.items.shift();
        await runOne(item, { cliPath, activeSessions, queueKey: key });
        item.resolve();
      }
      queue.running = false;
      queues.delete(key);
      for (const [sid, alias] of queueAliases) if (alias === key) queueAliases.delete(sid);
    };
    void drain();
  });
}

export async function interruptGrok(sessionId) {
  for (const client of clients.values()) {
    if (client.listeners.has(sessionId)) {
      client.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      return true;
    }
  }
  return false;
}
