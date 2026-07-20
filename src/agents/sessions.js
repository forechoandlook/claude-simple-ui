import { promises as fs } from 'fs';
import fsSync from 'fs';
import readline from 'readline';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ─── Claude ───────────────────────────────────────────────────────────────────

async function loadClaudeHistoryNames(configDirs) {
  const map = new Map();
  await Promise.all(configDirs.map(async dir => {
    try {
      const stream = fsSync.createReadStream(path.join(dir, 'history.jsonl'));
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        try {
          const d = JSON.parse(line);
          if (d.sessionId && d.display) map.set(d.sessionId, d.display);
        } catch {}
      }
    } catch {}
  }));
  return map;
}

async function readClaudeSessionMeta(filePath) {
  let sessionId = null;
  let cwd = null;
  let totalTokens = 0;
  let turnCount = 0;
  try {
    const stream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const d = JSON.parse(line);
        if (!sessionId && d.sessionId) sessionId = d.sessionId;
        if (!cwd && d.cwd) cwd = d.cwd;
        // Count user turns (exclude tool-result only / meta noise when possible)
        if (d.type === 'user') {
          const content = d.message?.content;
          const isToolResult = Array.isArray(content)
            && content.length > 0
            && content.every(p => p?.type === 'tool_result');
          if (!isToolResult) turnCount += 1;
        }
        const u = d.message?.usage;
        if (u) {
          totalTokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
        }
      } catch {}
    }
  } catch {}
  return { sessionId, cwd, totalTokens, turnCount };
}

async function readClaudeFirstMessage(filePath) {
  const SKIP = ['<', 'Caveat:', 'This session', '[Request'];
  try {
    const stream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const d = JSON.parse(line);
        if (d.type === 'user' && Array.isArray(d.message?.content)) {
          for (const part of d.message.content) {
            if (part.type === 'text' && part.text?.trim()) {
              const text = part.text.trim();
              if (!SKIP.some(p => text.startsWith(p))) {
                rl.close(); stream.destroy();
                return text.slice(0, 100);
              }
            }
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function scanClaudeConfigDir(configDir, nameMap, filterCwd) {
  const projectsDir = path.join(configDir, 'projects');
  const sessions = [];
  let projectDirs;
  try {
    projectDirs = (await fs.readdir(projectsDir, { withFileTypes: true })).filter(e => e.isDirectory());
  } catch { return []; }

  await Promise.all(projectDirs.map(async dirEntry => {
    const projectDir = path.join(projectsDir, dirEntry.name);
    let entries;
    try { entries = await fs.readdir(projectDir, { withFileTypes: true }); }
    catch { return; }

    const hasMemory = entries.some(e =>
      (e.isFile() && e.name === 'MEMORY.md') || (e.isDirectory() && e.name === 'memory')
    );

    const jsonlFiles = entries.filter(e =>
      e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('agent-')
    );
    await Promise.all(jsonlFiles.map(async fileEntry => {
      const filePath = path.join(projectDir, fileEntry.name);
      try {
        const [stat, meta] = await Promise.all([fs.stat(filePath), readClaudeSessionMeta(filePath)]);
        if (filterCwd && meta.cwd !== filterCwd) return;
        const sessionId = meta.sessionId || fileEntry.name.replace('.jsonl', '');
        const firstMsg = await readClaudeFirstMessage(filePath);
        sessions.push({
          sessionId,
          agent: 'claude',
          cwd: meta.cwd || null,
          configDir,
          display: nameMap.get(sessionId) || firstMsg || 'Session',
          updatedAt: stat.mtimeMs,
          hasMemory,
          totalTokens: meta.totalTokens || 0,
          turnCount: meta.turnCount || 0,
        });
      } catch {}
    }));
  }));
  return sessions;
}

export async function scanClaudeSessions(configDirs, filterCwd = null) {
  const nameMap = await loadClaudeHistoryNames(configDirs);
  const results = await Promise.all(configDirs.map(d => scanClaudeConfigDir(d, nameMap, filterCwd)));
  return results.flat();
}

export async function findClaudeSessionFile(sessionId, configDirs) {
  if (!configDirs?.length) return null;
  for (const configDir of configDirs) {
    const projectsDir = path.join(configDir, 'projects');
    let projectDirs;
    try { projectDirs = await fs.readdir(projectsDir); }
    catch { continue; }
    for (const dir of projectDirs) {
      const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      try { await fs.access(candidate); return candidate; }
      catch {}
    }
  }
  return null;
}

const INTERNAL_PREFIXES = ['<command-', '<local-command', '<system-reminder', 'Caveat:', 'This session is being continued', '[Request interrupted'];

function isInternal(text) {
  return INTERNAL_PREFIXES.some(p => text.startsWith(p));
}

export async function parseClaudeMessages(filePath) {
  const messages = [];
  let pendingUsage = null;

  function flushUsage() {
    if (!pendingUsage) return;
    const u = pendingUsage;
    pendingUsage = null;
    if (u.input_tokens || u.output_tokens) messages.push({ type: 'token_usage', usage: u });
  }

  try {
    const stream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }

      if (d.type === 'user' && d.message?.content) {
        flushUsage();
        const content = d.message.content;
        const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
        for (const part of parts) {
          if (part.type === 'text' && part.text?.trim() && !isInternal(part.text.trim())) {
            messages.push({ role: 'user', type: 'text', content: part.text.trim(), ts: d.timestamp });
          }
        }
        continue;
      }

      if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
        const u = d.message.usage;
        if (u) {
          if (!pendingUsage) pendingUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
          pendingUsage.input_tokens                += u.input_tokens                ?? 0;
          pendingUsage.output_tokens               += u.output_tokens               ?? 0;
          pendingUsage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
          pendingUsage.cache_read_input_tokens     += u.cache_read_input_tokens     ?? 0;
        }
        for (const part of d.message.content) {
          if (part.type === 'text' && part.text?.trim()) {
            messages.push({ role: 'assistant', type: 'text', content: part.text.trim(), ts: d.timestamp });
          } else if (part.type === 'tool_use') {
            messages.push({ role: 'tool', type: 'tool_use', name: part.name, input: part.input ?? {}, ts: d.timestamp });
          }
        }
      }
    }
    flushUsage();
  } catch {}
  return messages;
}

// ─── Codex ────────────────────────────────────────────────────────────────────

async function loadCodexIndex(codexHome) {
  const map = new Map();
  try {
    const stream = fsSync.createReadStream(path.join(codexHome, 'session_index.jsonl'));
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const d = JSON.parse(line);
        if (d.id) map.set(d.id, d);
      } catch {}
    }
  } catch {}
  return map;
}

async function findCodexRollouts(codexHome) {
  const sessionsRoot = path.join(codexHome, 'sessions');
  const files = [];
  async function walk(dir, depth = 0) {
    if (depth > 5) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.startsWith('rollout-')) {
        files.push(p);
      }
    }
  }
  await walk(sessionsRoot);
  return files;
}

async function readCodexMeta(filePath) {
  let id = null, cwd = null, ts = null, turnCount = 0;
  try {
    // Full scan: meta is early; turnCount needs whole file
    const stream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const d = JSON.parse(line);
        if (d.type === 'session_meta' && d.payload) {
          id = d.payload.id || id;
          cwd = d.payload.cwd || cwd;
          ts = d.payload.timestamp || d.timestamp || ts;
        }
        // Codex user turns appear in a few event shapes across versions
        if (d.type === 'event_msg' && d.payload?.type === 'user_message') turnCount += 1;
        else if (d.type === 'response_item' && d.payload?.role === 'user') turnCount += 1;
        else if (d.type === 'turn_context' && d.payload?.turn_index != null) {
          // last turn_index + 1 is a better total; bump max
          const idx = Number(d.payload.turn_index) + 1;
          if (idx > turnCount) turnCount = idx;
        }
      } catch {}
    }
  } catch {}
  // Fallback: parse id from filename rollout-...-<uuid>.jsonl
  if (!id) {
    const m = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m) id = m[1];
  }
  return { id, cwd, ts, turnCount };
}

export async function scanCodexSessions(codexHome, filterCwd = null) {
  const home = codexHome || path.join(os.homedir(), '.codex');
  const index = await loadCodexIndex(home);
  const rollouts = await findCodexRollouts(home);
  const sessions = [];

  await Promise.all(rollouts.map(async filePath => {
    try {
      const [stat, meta] = await Promise.all([fs.stat(filePath), readCodexMeta(filePath)]);
      if (!meta.id) return;
      if (filterCwd && meta.cwd && meta.cwd !== filterCwd) return;
      const idx = index.get(meta.id);
      sessions.push({
        sessionId: meta.id,
        agent: 'codex',
        cwd: meta.cwd || null,
        configDir: home,
        display: idx?.thread_name || meta.id.slice(0, 8),
        updatedAt: stat.mtimeMs,
        hasMemory: false,
        filePath,
        turnCount: meta.turnCount || 0,
      });
    } catch {}
  }));
  return sessions;
}

export async function findCodexSessionFile(sessionId, codexHome) {
  const home = codexHome || path.join(os.homedir(), '.codex');
  const rollouts = await findCodexRollouts(home);
  for (const f of rollouts) {
    if (f.includes(sessionId)) return f;
  }
  // slower path: read meta
  for (const f of rollouts) {
    const meta = await readCodexMeta(f);
    if (meta.id === sessionId) return f;
  }
  return null;
}

export async function parseCodexMessages(filePath) {
  const messages = [];
  try {
    const stream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }

      if (d.type === 'response_item' && d.payload) {
        const p = d.payload;
        if (p.type === 'message' && p.role === 'user') {
          const texts = (p.content || [])
            .filter(c => c.type === 'input_text' || c.type === 'text')
            .map(c => c.text || '')
            .filter(Boolean);
          const text = texts.join('\n').trim();
          // skip huge injected system/env blobs
          if (text && !text.startsWith('# AGENTS.md') && !text.startsWith('<environment_context')
              && !text.startsWith('<permissions') && text.length < 2000) {
            messages.push({ role: 'user', type: 'text', content: text, ts: d.timestamp });
          }
        } else if (p.type === 'message' && p.role === 'assistant') {
          const texts = (p.content || [])
            .filter(c => c.type === 'output_text' || c.type === 'text')
            .map(c => c.text || '')
            .filter(Boolean);
          const text = texts.join('\n').trim();
          if (text) messages.push({ role: 'assistant', type: 'text', content: text, ts: d.timestamp });
        } else if (p.type === 'function_call') {
          let input = p.arguments;
          try { input = typeof input === 'string' ? JSON.parse(input) : input; } catch {}
          messages.push({ role: 'tool', type: 'tool_use', name: p.name || 'function', input: input ?? {}, ts: d.timestamp });
        } else if (p.type === 'command_execution' || p.type === 'custom_tool_call') {
          messages.push({
            role: 'tool',
            type: 'tool_use',
            name: p.type === 'command_execution' ? 'Bash' : (p.name || 'tool'),
            input: { command: p.command || p.input || '' },
            ts: d.timestamp,
          });
        }
      }

      if (d.type === 'event_msg' && d.payload?.type === 'agent_message') {
        const text = d.payload.message || d.payload.text;
        if (text) messages.push({ role: 'assistant', type: 'text', content: text, ts: d.timestamp });
      }
    }
  } catch {}
  return messages;
}

// ─── Grok ─────────────────────────────────────────────────────────────────────

export async function scanGrokSessions(grokHome, filterCwd = null) {
  const home = grokHome || path.join(os.homedir(), '.grok');
  const sessionsRoot = path.join(home, 'sessions');
  const sessions = [];

  let projectDirs;
  try {
    projectDirs = (await fs.readdir(sessionsRoot, { withFileTypes: true })).filter(e => e.isDirectory());
  } catch { return []; }

  await Promise.all(projectDirs.map(async dirEntry => {
    // dir name is encodeURIComponent(cwd)
    let cwd;
    try { cwd = decodeURIComponent(dirEntry.name); } catch { cwd = dirEntry.name; }
    if (filterCwd && cwd !== filterCwd) return;

    const projectDir = path.join(sessionsRoot, dirEntry.name);
    let sessionDirs;
    try {
      sessionDirs = (await fs.readdir(projectDir, { withFileTypes: true })).filter(e => e.isDirectory());
    } catch { return; }

    await Promise.all(sessionDirs.map(async sEntry => {
      const sessionId = sEntry.name;
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return;
      const sessionDir = path.join(projectDir, sessionId);
      let display = sessionId.slice(0, 8);
      let updatedAt = 0;
      let hasMemory = false;
      try {
        const summary = JSON.parse(await fs.readFile(path.join(sessionDir, 'summary.json'), 'utf8'));
        display = summary.session_summary || summary.info?.title || display;
        if (summary.updated_at) updatedAt = Date.parse(summary.updated_at) || 0;
        if (summary.info?.cwd) cwd = summary.info.cwd;
      } catch {}
      try {
        const st = await fs.stat(path.join(sessionDir, 'chat_history.jsonl'));
        if (!updatedAt) updatedAt = st.mtimeMs;
        else updatedAt = Math.max(updatedAt, st.mtimeMs);
      } catch {
        try {
          const st = await fs.stat(sessionDir);
          if (!updatedAt) updatedAt = st.mtimeMs;
        } catch { return; }
      }
      try {
        await fs.access(path.join(sessionDir, 'memory'));
        hasMemory = true;
      } catch {}

      let totalTokens = 0;
      try {
        const sig = JSON.parse(await fs.readFile(path.join(sessionDir, 'signals.json'), 'utf8'));
        totalTokens = sig.contextTokensUsed ?? 0;
      } catch {}

      let turnCount = 0;
      try {
        const stream = fsSync.createReadStream(path.join(sessionDir, 'chat_history.jsonl'));
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          try {
            const d = JSON.parse(line);
            if (d.role === 'user' || d.type === 'user') turnCount += 1;
          } catch {}
        }
      } catch {}

      sessions.push({
        sessionId,
        agent: 'grok',
        cwd: cwd || null,
        configDir: home,
        display: String(display).slice(0, 120),
        updatedAt,
        hasMemory,
        sessionDir,
        totalTokens,
        turnCount,
      });
    }));
  }));

  return sessions;
}

export async function findGrokSessionDir(sessionId, grokHome) {
  const home = grokHome || path.join(os.homedir(), '.grok');
  const sessionsRoot = path.join(home, 'sessions');
  let projectDirs;
  try {
    projectDirs = await fs.readdir(sessionsRoot);
  } catch { return null; }
  for (const dir of projectDirs) {
    const candidate = path.join(sessionsRoot, dir, sessionId);
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) return candidate;
    } catch {}
  }
  return null;
}

/**
 * Grok stores content as either a plain string or an array of blocks:
 *   [{ "type": "text", "text": "<user_query>\n...\n</user_query>" }]
 * Real user prompts are wrapped in <user_query>; env/context injections use
 * <user_info>, <git_status>, <system-reminder>, etc. and should be hidden.
 */
function extractGrokText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function unwrapGrokUserQuery(text) {
  if (!text) return text;
  // Prefer the <user_query> body when present
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m) return m[1].trim();
  return text.trim();
}

function isGrokInternalUserText(text) {
  if (!text) return true;
  const t = text.trim();
  // Whole-message system injections (often the entire content)
  if (/^<(user_info|git_status|system-reminder|system_reminder|agent_skills|available_skills|mcp_server|environment_context|permissions)\b/i.test(t)) {
    return true;
  }
  // Messages that are ONLY those tags (no real user_query)
  if (/^<[^>]+>[\s\S]*<\/[^>]+>$/.test(t) && !/<user_query>/i.test(t)) {
    // Allow short non-system tags; block known wrappers
    if (/<\/?(user_info|git_status|system-reminder|system_reminder|agent_skills|available_skills)\b/i.test(t)) {
      return true;
    }
  }
  return false;
}

function parseGrokToolInput(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return { input: raw }; }
  }
  return {};
}

function toMs(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Grok `updates.jsonl` lines look like:
 *   { "timestamp": 1784518536, "method": "session/update",
 *     "params": { "update": { "sessionUpdate": "user_message_chunk", ... } } }
 * `timestamp` is Unix **seconds** (not ms).
 */
async function loadGrokUpdates(sessionDir) {
  const updatesPath = path.join(sessionDir, 'updates.jsonl');
  const users = [];   // { ts, text }
  const assistants = []; // { ts }
  const tools = [];   // { ts, name }
  const turnUsages = []; // { ts, usage }
  let pendingAsst = null;

  const flushAsst = () => {
    if (pendingAsst) { assistants.push(pendingAsst); pendingAsst = null; }
  };

  try {
    const stream = fsSync.createReadStream(updatesPath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }

      // Prefer explicit `timestamp` field (Unix seconds)
      const ts = toMs(d.timestamp ?? d.ts);
      if (ts == null) continue;

      const update = d.params?.update || d.update || {};
      const kind = update.sessionUpdate || update.type || '';

      if (kind === 'user_message_chunk') {
        flushAsst();
        const text = update.content?.text
          || (typeof update.content === 'string' ? update.content : '')
          || extractGrokText(update.content)
          || '';
        users.push({ ts, text: text.trim() });
      } else if (kind === 'agent_message_chunk') {
        if (!pendingAsst) pendingAsst = { ts };
      } else if (kind === 'tool_call') {
        flushAsst();
        tools.push({
          ts,
          name: update.title || update.toolName || update.name || null,
        });
      } else if (kind === 'turn_completed') {
        flushAsst();
        if (update.usage) {
          turnUsages.push({ ts, usage: normalizeGrokUsage(update.usage) });
        }
      }
    }
    flushAsst();
  } catch {}

  return { users, assistants, tools, turnUsages };
}

/** Grok usage uses camelCase; normalize to snake_case used by the UI. */
function normalizeGrokUsage(u = {}) {
  const costTicks = u.costUsdTicks ?? u.cost_usd_ticks;
  const costUSD = u.costUSD ?? u.cost_usd
    ?? (typeof costTicks === 'number' ? costTicks / 1e10 : undefined);
  return {
    input_tokens: u.inputTokens ?? u.input_tokens ?? 0,
    output_tokens: u.outputTokens ?? u.output_tokens ?? 0,
    cache_read_input_tokens: u.cachedReadTokens ?? u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? 0,
    total_tokens: u.totalTokens ?? u.total_tokens ?? 0,
    reasoning_tokens: u.reasoningTokens ?? u.reasoning_tokens ?? 0,
    costUSD,
    num_turns: u.numTurns ?? u.num_turns,
  };
}

function applyGrokTimestamps(messages, { users, assistants, tools }) {
  let ui = 0, ai = 0, ti = 0;

  for (const m of messages) {
    if (m.role === 'user' && m.type === 'text') {
      // Prefer content match so filtered synthetic users don't shift the index
      let hit = -1;
      const needle = (m.content || '').trim();
      for (let j = ui; j < users.length; j++) {
        const t = (users[j].text || '').trim();
        if (!t) continue;
        if (t === needle || needle.includes(t.slice(0, 48)) || t.includes(needle.slice(0, 48))) {
          hit = j;
          break;
        }
      }
      if (hit < 0 && ui < users.length) hit = ui;
      if (hit >= 0) {
        m.ts = users[hit].ts;
        ui = hit + 1;
      }
    } else if (m.role === 'assistant' && m.type === 'text') {
      if (ai < assistants.length) m.ts = assistants[ai++].ts;
    } else if (m.type === 'tool_use') {
      if (ti < tools.length) m.ts = tools[ti++].ts;
    }
  }
}

/** Insert per-turn token_usage rows after each user turn. */
function insertTurnUsages(messages, turnUsages) {
  if (!turnUsages?.length) return messages;
  const userIdx = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.type === 'text') userIdx.push(i);
  });
  // splice from the end so earlier indices stay valid
  for (let i = turnUsages.length - 1; i >= 0; i--) {
    const start = userIdx[i];
    if (start == null) continue;
    const end = userIdx[i + 1] != null ? userIdx[i + 1] : messages.length;
    messages.splice(end, 0, {
      type: 'token_usage',
      usage: turnUsages[i].usage,
      ts: turnUsages[i].ts,
    });
  }
  return messages;
}

async function loadGrokContext(sessionDir) {
  const context = {
    tokensUsed: null,
    windowTokens: null,
    usagePercent: null,
    model: null,
    turnCount: null,
    toolCallCount: null,
    sessionDurationSeconds: null,
    lastTurn: null, // last turn_completed usage from updates.jsonl
  };
  try {
    const sig = JSON.parse(await fs.readFile(path.join(sessionDir, 'signals.json'), 'utf8'));
    context.tokensUsed = sig.contextTokensUsed ?? null;
    context.windowTokens = sig.contextWindowTokens ?? null;
    context.usagePercent = sig.contextWindowUsage ?? null;
    context.model = sig.primaryModelId ?? (sig.modelsUsed && sig.modelsUsed[0]) ?? null;
    context.turnCount = sig.turnCount ?? null;
    context.toolCallCount = sig.toolCallCount ?? null;
    context.sessionDurationSeconds = sig.sessionDurationSeconds ?? null;
  } catch {}
  try {
    const summary = JSON.parse(await fs.readFile(path.join(sessionDir, 'summary.json'), 'utf8'));
    if (!context.model) context.model = summary.current_model_id || null;
    context.createdAt = summary.created_at || null;
    context.updatedAt = summary.updated_at || summary.last_active_at || null;
    context.title = summary.session_summary || summary.generated_title || null;
  } catch {}
  // Last completed turn usage (input/output/cache/cost)
  try {
    const updates = await loadGrokUpdates(sessionDir);
    if (updates.turnUsages?.length) {
      const last = updates.turnUsages[updates.turnUsages.length - 1];
      context.lastTurn = { ...last.usage, ts: last.ts };
      // Aggregate totals across turns when available
      const sum = { input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_input_tokens: 0, costUSD: 0 };
      for (const t of updates.turnUsages) {
        sum.input_tokens += t.usage.input_tokens || 0;
        sum.output_tokens += t.usage.output_tokens || 0;
        sum.total_tokens += t.usage.total_tokens || 0;
        sum.cache_read_input_tokens += t.usage.cache_read_input_tokens || 0;
        sum.costUSD += Number(t.usage.costUSD) || 0;
      }
      context.sessionTotals = sum;
      context.completedTurns = updates.turnUsages.length;
    }
  } catch {}
  return context;
}

/** Public helper: load usage/context for any agent session. */
export async function loadSessionUsage(sessionId, agent, { claudeConfigDirs, codexHome, grokHome }) {
  const a = (agent || 'claude').toLowerCase();
  if (a === 'grok') {
    const dir = await findGrokSessionDir(sessionId, grokHome);
    if (!dir) return null;
    const context = await loadGrokContext(dir);
    return { agent: 'grok', sessionId, context };
  }
  if (a === 'codex') {
    const file = await findCodexSessionFile(sessionId, codexHome);
    if (!file) return null;
    // Codex has no signals.json equivalent here — return file meta only
    try {
      const st = await fs.stat(file);
      return {
        agent: 'codex',
        sessionId,
        context: {
          model: null,
          tokensUsed: null,
          windowTokens: null,
          usagePercent: null,
          updatedAt: new Date(st.mtimeMs).toISOString(),
          note: 'Codex per-session context window not exposed; see last-turn bar after a reply.',
        },
      };
    } catch {
      return { agent: 'codex', sessionId, context: null };
    }
  }
  // Claude — best-effort from session jsonl last usage
  const file = await findClaudeSessionFile(sessionId, claudeConfigDirs || []);
  if (!file) return null;
  let lastUsage = null;
  try {
    const stream = fsSync.createReadStream(file);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const u = d.message?.usage || d.usage;
      if (u && (u.input_tokens || u.output_tokens)) {
        lastUsage = {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        };
      }
    }
  } catch {}
  return {
    agent: 'claude',
    sessionId,
    context: {
      model: null,
      lastTurn: lastUsage,
      note: lastUsage ? null : 'No usage records in this Claude session yet.',
    },
  };
}

export async function parseGrokMessages(sessionDir) {
  const messages = [];
  const histPath = path.join(sessionDir, 'chat_history.jsonl');
  try {
    const stream = fsSync.createReadStream(histPath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }

      // Skip system prompts, reasoning blobs, tool results noise in chat view
      if (d.type === 'system' || d.type === 'reasoning' || d.type === 'tool_result') continue;
      if (d.synthetic_reason) continue;

      // chat_history rows rarely have timestamps; will be filled from updates.jsonl
      let ts = toMs(d.timestamp ?? d.ts ?? d.created_at);

      if (d.type === 'user') {
        const raw = extractGrokText(d.content);
        if (!raw.trim()) continue;
        if (isGrokInternalUserText(raw)) continue;
        const text = unwrapGrokUserQuery(raw);
        if (!text || isGrokInternalUserText(text)) continue;
        messages.push({ role: 'user', type: 'text', content: text, ts });
        continue;
      }

      if (d.type === 'assistant') {
        const text = extractGrokText(d.content).trim();
        if (text) {
          messages.push({ role: 'assistant', type: 'text', content: text, ts });
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const name = tc.name || tc.function?.name || 'tool';
            const input = parseGrokToolInput(tc.arguments ?? tc.input ?? tc.function?.arguments);
            messages.push({ role: 'tool', type: 'tool_use', name, input, ts });
          }
        }
        continue;
      }

      if (d.type === 'tool_use' || d.type === 'tool_call') {
        messages.push({
          role: 'tool',
          type: 'tool_use',
          name: d.name || 'tool',
          input: parseGrokToolInput(d.input ?? d.arguments),
          ts,
        });
      }
    }
  } catch {}

  // timestamps + per-turn usage from updates.jsonl (`timestamp` = Unix seconds)
  try {
    const updates = await loadGrokUpdates(sessionDir);
    applyGrokTimestamps(messages, updates);
    insertTurnUsages(messages, updates.turnUsages);
  } catch {}

  return messages;
}

export async function loadGrokSessionBundle(sessionDir) {
  const messages = await parseGrokMessages(sessionDir);
  const context = await loadGrokContext(sessionDir);
  return { messages, context };
}

// ─── Unified ──────────────────────────────────────────────────────────────────

/** Normalize cwd so /private/tmp and /tmp (etc.) group together on macOS. */
export function normalizeCwd(cwd) {
  if (!cwd) return null;
  let p = cwd;
  if (p.startsWith('/private/')) p = p.slice('/private'.length) || '/';
  // strip trailing slash except root
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function projectNameFromCwd(cwd) {
  if (!cwd) return '(no path)';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function publicSession(s) {
  const cwd = normalizeCwd(s.cwd) || s.cwd || null;
  return {
    sessionId: s.sessionId,
    agent: s.agent || 'claude',
    cwd,
    configDir: s.configDir || null,
    display: (s.display || s.sessionId?.slice(0, 8) || 'Session').toString().slice(0, 160),
    updatedAt: s.updatedAt || 0,
    hasMemory: Boolean(s.hasMemory),
    projectName: projectNameFromCwd(cwd),
    totalTokens: s.totalTokens || 0,
    turnCount: Number(s.turnCount) || 0,
    // keep for deep search only when needed — not sent if stripped below
    _filePath: s.filePath || null,
    _sessionDir: s.sessionDir || null,
  };
}

export async function scanAllSessions({ claudeConfigDirs, codexHome, grokHome, filterCwd, agents }) {
  const want = new Set(agents || ['claude', 'codex', 'grok']);
  const tasks = [];
  if (want.has('claude')) tasks.push(scanClaudeSessions(claudeConfigDirs, filterCwd));
  if (want.has('codex'))  tasks.push(scanCodexSessions(codexHome, filterCwd));
  if (want.has('grok'))   tasks.push(scanGrokSessions(grokHome, filterCwd));

  const results = await Promise.all(tasks);
  const seen = new Set();
  const sessions = results.flat()
    .map(publicSession)
    .filter(s => {
      const key = `${s.agent}:${s.sessionId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Strip internal-only fields before sending to clients. */
export function toClientSession(s) {
  const { _filePath, _sessionDir, ...rest } = s;
  return rest;
}

/**
 * Search / filter sessions for project-management views.
 * - metadata match: cwd, projectName, display, agent
 * - optional deep content: peek recent session files for keyword (bounded)
 */
export async function searchActivity(sessions, {
  q = '',
  days = 0,
  agent = null,
  limit = 80,
  deep = true,
} = {}) {
  const query = (q || '').trim().toLowerCase();
  const now = Date.now();
  const since = days > 0 ? now - days * 86400000 : 0;

  let list = sessions.filter(s => {
    if (agent && s.agent !== agent) return false;
    if (since && (s.updatedAt || 0) < since) return false;
    return true;
  });

  // Metadata filter first
  if (query) {
    const metaHit = [];
    const needDeep = [];
    for (const s of list) {
      const hay = [
        s.display, s.cwd, s.projectName, s.agent, s.sessionId,
      ].filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(query)) metaHit.push({ ...s, match: 'meta', snippet: s.display });
      else needDeep.push(s);
    }

    if (deep && needDeep.length) {
      // Only deep-scan the most recent candidates to stay fast
      const candidates = needDeep
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 60);
      const deepHits = await Promise.all(candidates.map(async s => {
        const snippet = await peekSessionText(s, query);
        if (!snippet) return null;
        return { ...s, match: 'content', snippet: snippet.slice(0, 180) };
      }));
      list = [...metaHit, ...deepHits.filter(Boolean)];
    } else {
      list = metaHit;
    }
  } else {
    list = list.map(s => ({ ...s, match: 'recent', snippet: s.display }));
  }

  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.slice(0, limit).map(s => {
    const client = toClientSession(s);
    return {
      ...client,
      match: s.match,
      snippet: s.snippet || s.display,
    };
  });
}

/** Read a short text sample from a session file looking for `query`. */
async function peekSessionText(s, query) {
  try {
    if (s.agent === 'grok') {
      const dir = s._sessionDir || await findGrokSessionDir(s.sessionId);
      if (!dir) return null;
      const hist = path.join(dir, 'chat_history.jsonl');
      return await scanFileForQuery(hist, query, {
        maxLines: 120,
        extract: (d) => {
          if (d.synthetic_reason || d.type === 'system' || d.type === 'reasoning') return null;
          if (d.type === 'user' && d.content) {
            const raw = extractGrokText(d.content);
            if (isGrokInternalUserText(raw)) return null;
            return unwrapGrokUserQuery(raw);
          }
          if (d.type === 'assistant' && d.content) {
            return extractGrokText(d.content) || null;
          }
          return null;
        },
      });
    }
    if (s.agent === 'codex') {
      const file = s._filePath || await findCodexSessionFile(s.sessionId);
      if (!file) return null;
      return await scanFileForQuery(file, query, {
        maxLines: 80,
        extract: (d) => {
          if (d.type === 'response_item' && d.payload?.type === 'message') {
            const p = d.payload;
            if (p.role !== 'user' && p.role !== 'assistant') return null;
            const texts = (p.content || [])
              .map(c => c.text || '')
              .filter(Boolean);
            const text = texts.join(' ').trim();
            if (!text || text.startsWith('# AGENTS.md') || text.startsWith('<')) return null;
            if (text.length > 2000) return null;
            return text;
          }
          return null;
        },
      });
    }
    // claude
    const file = await findClaudeSessionFile(s.sessionId, null);
    // findClaudeSessionFile needs config dirs — skip if we don't have path
    if (!file && !s.configDir) return null;
    const f = file || path.join(s.configDir, 'projects'); // fallback won't work well
    // Use load path via find with single configDir if present
    const claudeFile = s.configDir
      ? await findClaudeSessionFile(s.sessionId, [s.configDir])
      : file;
    if (!claudeFile) return null;
    return await scanFileForQuery(claudeFile, query, {
      maxLines: 100,
      extract: (d) => {
        if (d.type === 'user' && d.message?.content) {
          const parts = Array.isArray(d.message.content) ? d.message.content : [];
          for (const part of parts) {
            if (part.type === 'text' && part.text?.trim() && !isInternal(part.text.trim())) {
              return part.text.trim();
            }
          }
        }
        if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
          for (const part of d.message.content) {
            if (part.type === 'text' && part.text?.trim()) return part.text.trim();
          }
        }
        return null;
      },
    });
  } catch {
    return null;
  }
}

async function scanFileForQuery(filePath, query, { maxLines = 80, extract }) {
  if (!filePath || !query) return null;
  try {
    const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let n = 0;
    let lastUser = null;
    for await (const line of rl) {
      n++;
      if (n > maxLines * 3) break; // hard cap
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const text = extract(d);
      if (!text) continue;
      if (text.toLowerCase().includes(query)) {
        rl.close(); stream.destroy();
        // highlight-ish snippet around match
        const idx = text.toLowerCase().indexOf(query);
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + query.length + 80);
        return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
      }
      if (!lastUser && text.length < 300) lastUser = text;
      if (n >= maxLines && lastUser) break;
    }
  } catch {}
  return null;
}

/** Group sessions into projects for the projects API. */
export function groupByProject(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const key = s.cwd || '(no path)';
    if (!map.has(key)) {
      map.set(key, {
        cwd: s.cwd || null,
        projectName: s.projectName || projectNameFromCwd(s.cwd),
        updatedAt: 0,
        sessionCount: 0,
        agents: {},
        latest: null,
        sessions: [],
      });
    }
    const g = map.get(key);
    g.sessionCount++;
    g.agents[s.agent] = (g.agents[s.agent] || 0) + 1;
    if ((s.updatedAt || 0) > g.updatedAt) {
      g.updatedAt = s.updatedAt;
      g.latest = {
        sessionId: s.sessionId,
        agent: s.agent,
        display: s.display,
        updatedAt: s.updatedAt,
      };
    }
    g.sessions.push(s);
  }
  return [...map.values()]
    .map(g => ({
      ...g,
      sessions: g.sessions.sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Load session history. Returns { messages, context } or null.
 * `context` carries window / token usage when the agent exposes it (Grok signals.json).
 */
export async function loadSessionMessages(sessionId, agent, { claudeConfigDirs, codexHome, grokHome }) {
  const a = agent || 'claude';
  if (a === 'codex') {
    const file = await findCodexSessionFile(sessionId, codexHome);
    if (!file) return null;
    return { messages: await parseCodexMessages(file), context: null, agent: 'codex' };
  }
  if (a === 'grok') {
    const dir = await findGrokSessionDir(sessionId, grokHome);
    if (!dir) return null;
    const bundle = await loadGrokSessionBundle(dir);
    return { ...bundle, agent: 'grok' };
  }
  const file = await findClaudeSessionFile(sessionId, claudeConfigDirs);
  if (!file) return null;
  return { messages: await parseClaudeMessages(file), context: null, agent: 'claude' };
}

export async function loadSessionMemory(sessionId, agent, { claudeConfigDirs, codexHome, grokHome }) {
  if (agent === 'grok') {
    const dir = await findGrokSessionDir(sessionId, grokHome);
    if (!dir) return null;
    // Grok may store memory differently; best-effort empty
    return { index: null, files: [] };
  }
  if (agent === 'codex') {
    return { index: null, files: [] };
  }
  const file = await findClaudeSessionFile(sessionId, claudeConfigDirs);
  if (!file) return null;
  return readProjectMemory(path.dirname(file));
}

export async function readProjectMemory(projectDir) {
  const memoryDir = path.join(projectDir, 'memory');
  let index = null;
  try { index = await fs.readFile(path.join(projectDir, 'MEMORY.md'), 'utf8'); }
  catch {}

  const files = [];
  let entries = [];
  try { entries = await fs.readdir(memoryDir, { withFileTypes: true }); }
  catch {}
  await Promise.all(
    entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(async e => {
        try {
          const content = await fs.readFile(path.join(memoryDir, e.name), 'utf8');
          const stat = await fs.stat(path.join(memoryDir, e.name));
          files.push({ name: e.name, content, updatedAt: stat.mtimeMs });
        } catch {}
      })
  );
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { index, files };
}

export async function getSessionMeta(sessionId, agent, { claudeConfigDirs, codexHome, grokHome }) {
  const a = (agent || 'claude').toLowerCase();
  let cwd = null;
  let display = null;
  if (a === 'grok') {
    const dir = await findGrokSessionDir(sessionId, grokHome);
    if (dir) {
      try {
        const summary = JSON.parse(await fs.readFile(path.join(dir, 'summary.json'), 'utf8'));
        cwd = summary.info?.cwd || null;
        display = summary.session_summary || summary.info?.title || null;
      } catch {}
    }
  } else if (a === 'codex') {
    const file = await findCodexSessionFile(sessionId, codexHome);
    if (file) {
      const meta = await readCodexMeta(file);
      cwd = meta.cwd;
      const index = await loadCodexIndex(codexHome || path.join(os.homedir(), '.codex'));
      const idx = index.get(sessionId);
      display = idx?.thread_name || null;
    }
  } else {
    // claude
    const file = await findClaudeSessionFile(sessionId, claudeConfigDirs);
    if (file) {
      const meta = await readClaudeSessionMeta(file);
      cwd = meta.cwd;
      const nameMap = await loadClaudeHistoryNames(claudeConfigDirs);
      display = nameMap.get(sessionId) || await readClaudeFirstMessage(file);
    }
  }
  return { cwd, display };
}

export async function convertSession(sourceSessionId, sourceAgent, targetAgent, { claudeConfigDirs, codexHome, grokHome }) {
  // 1. Get meta and messages from source session
  const meta = await getSessionMeta(sourceSessionId, sourceAgent, { claudeConfigDirs, codexHome, grokHome });
  const cwd = meta.cwd || null;
  const display = meta.display || 'Converted Session';
  
  const bundle = await loadSessionMessages(sourceSessionId, sourceAgent, { claudeConfigDirs, codexHome, grokHome });
  const messages = bundle.messages || [];

  // 2. Generate target session ID
  const targetSessionId = crypto.randomUUID();

  // 3. Serialize messages to the target agent
  const ta = targetAgent.toLowerCase();
  
  if (ta === 'claude') {
    const configDir = claudeConfigDirs?.[0] || path.join(os.homedir(), '.claude');
    const projectsDir = path.join(configDir, 'projects');
    
    // Attempt to find existing project folder with matching cwd
    let projectDirName = null;
    try {
      const projectDirs = (await fs.readdir(projectsDir, { withFileTypes: true })).filter(e => e.isDirectory());
      for (const dirEntry of projectDirs) {
        const candidateProjDir = path.join(projectsDir, dirEntry.name);
        const entries = await fs.readdir(candidateProjDir);
        const jsonlFiles = entries.filter(e => e.endsWith('.jsonl') && !e.startsWith('agent-'));
        for (const file of jsonlFiles) {
          const m = await readClaudeSessionMeta(path.join(candidateProjDir, file));
          if (m.cwd === cwd) {
            projectDirName = dirEntry.name;
            break;
          }
        }
        if (projectDirName) break;
      }
    } catch {}
    
    if (!projectDirName) {
      if (cwd) {
        projectDirName = '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
      } else {
        projectDirName = 'default-project';
      }
    }
    
    const targetDir = path.join(projectsDir, projectDirName);
    await fs.mkdir(targetDir, { recursive: true });
    
    const targetFile = path.join(targetDir, `${targetSessionId}.jsonl`);
    const lines = [];
    let parentUuid = null;
    let lastPromptText = '';
    let lastLeafUuid = null;

    for (const msg of messages) {
      const ts = msg.ts ? new Date(msg.ts).toISOString() : new Date().toISOString();
      const currentUuid = crypto.randomUUID();

      if (msg.role === 'user') {
        lastPromptText = msg.content || '';
        lines.push(JSON.stringify({
          parentUuid,
          isSidechain: false,
          promptId: crypto.randomUUID(),
          type: 'user',
          message: { role: 'user', content: msg.content },
          uuid: currentUuid,
          timestamp: ts,
          permissionMode: 'default',
          promptSource: 'sdk',
          userType: 'external',
          entrypoint: 'sdk-cli',
          cwd,
          sessionId: targetSessionId,
          version: '2.1.177',
          gitBranch: 'main'
        }));
        parentUuid = currentUuid;
      } else if (msg.role === 'assistant') {
        lines.push(JSON.stringify({
          parentUuid,
          isSidechain: false,
          message: {
            id: crypto.randomBytes(16).toString('hex'),
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: msg.content || '' }],
            model: 'claude-3-5-sonnet',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          },
          type: 'assistant',
          uuid: currentUuid,
          timestamp: ts,
          userType: 'external',
          entrypoint: 'sdk-cli',
          cwd,
          sessionId: targetSessionId,
          version: '2.1.177',
          gitBranch: 'main'
        }));
        parentUuid = currentUuid;
        lastLeafUuid = currentUuid;
      } else if (msg.role === 'tool' && msg.type === 'tool_use') {
        lines.push(JSON.stringify({
          parentUuid,
          isSidechain: false,
          message: {
            id: crypto.randomBytes(16).toString('hex'),
            type: 'message',
            role: 'assistant',
            content: [{ type: 'tool_use', name: msg.name, input: msg.input || {} }],
            model: 'claude-3-5-sonnet',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          },
          type: 'assistant',
          uuid: currentUuid,
          timestamp: ts,
          userType: 'external',
          entrypoint: 'sdk-cli',
          cwd,
          sessionId: targetSessionId,
          version: '2.1.177',
          gitBranch: 'main'
        }));
        parentUuid = currentUuid;
        lastLeafUuid = currentUuid;
      }
    }

    if (lastPromptText && lastLeafUuid) {
      lines.push(JSON.stringify({
        type: 'last-prompt',
        lastPrompt: lastPromptText,
        leafUuid: lastLeafUuid,
        sessionId: targetSessionId
      }));
    }

    await fs.writeFile(targetFile, lines.join('\n') + '\n', 'utf8');
    
    // Also save history mapping
    try {
      const historyFile = path.join(configDir, 'history.jsonl');
      await fs.appendFile(historyFile, JSON.stringify({
        display,
        pastedContents: {},
        timestamp: Date.now(),
        project: cwd,
        sessionId: targetSessionId
      }) + '\n', 'utf8');
    } catch {}

  } else if (ta === 'codex') {
    const home = codexHome || path.join(os.homedir(), '.codex');
    const targetDir = path.join(home, 'sessions');
    await fs.mkdir(targetDir, { recursive: true });
    
    const targetFile = path.join(targetDir, `rollout-converted-${targetSessionId}.jsonl`);
    const lines = [];
    const baseTs = Date.now();
    lines.push(JSON.stringify({
      type: 'session_meta',
      timestamp: baseTs,
      payload: { id: targetSessionId, cwd }
    }));
    
    for (const msg of messages) {
      const ts = msg.ts || Date.now();
      if (msg.role === 'user') {
        lines.push(JSON.stringify({
          type: 'response_item',
          timestamp: ts,
          payload: { type: 'message', role: 'user', content: [{ type: 'text', text: msg.content }] }
        }));
      } else if (msg.role === 'assistant') {
        lines.push(JSON.stringify({
          type: 'response_item',
          timestamp: ts,
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: msg.content }] }
        }));
      } else if (msg.role === 'tool' && msg.type === 'tool_use') {
        lines.push(JSON.stringify({
          type: 'response_item',
          timestamp: ts,
          payload: { type: 'function_call', name: msg.name, arguments: JSON.stringify(msg.input || {}) }
        }));
      }
    }
    await fs.writeFile(targetFile, lines.join('\n') + '\n', 'utf8');
    
    // Write index
    try {
      const indexFile = path.join(home, 'session_index.jsonl');
      await fs.appendFile(indexFile, JSON.stringify({ id: targetSessionId, thread_name: display }) + '\n', 'utf8');
    } catch {}

  } else if (ta === 'grok') {
    const home = grokHome || path.join(os.homedir(), '.grok');
    const folderName = cwd ? encodeURIComponent(cwd) : 'default';
    const targetDir = path.join(home, 'sessions', folderName, targetSessionId);
    await fs.mkdir(targetDir, { recursive: true });
    
    const targetFile = path.join(targetDir, 'chat_history.jsonl');
    const lines = [];
    for (const msg of messages) {
      const ts = msg.ts || Date.now();
      if (msg.role === 'user') {
        lines.push(JSON.stringify({
          type: 'user',
          content: msg.content,
          timestamp: ts
        }));
      } else if (msg.role === 'assistant') {
        lines.push(JSON.stringify({
          type: 'assistant',
          content: msg.content,
          timestamp: ts
        }));
      } else if (msg.role === 'tool' && msg.type === 'tool_use') {
        lines.push(JSON.stringify({
          type: 'assistant',
          content: '',
          tool_calls: [{ name: msg.name, arguments: JSON.stringify(msg.input || {}) }],
          timestamp: ts
        }));
      }
    }
    await fs.writeFile(targetFile, lines.join('\n') + '\n', 'utf8');
    
    const summaryFile = path.join(targetDir, 'summary.json');
    await fs.writeFile(summaryFile, JSON.stringify({
      session_summary: display,
      info: {
        cwd,
        title: display
      },
      updated_at: new Date().toISOString()
    }, null, 2), 'utf8');
  }

  return { targetSessionId };
}

