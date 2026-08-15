import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { spawn, execSync } from 'child_process';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { runClaude } from './agents/claude.js';
import { runCodex } from './agents/codex.js';
import { runGrok } from './agents/grok.js';
import {
  scanAllSessions,
  loadSessionMessages,
  loadSessionMemory,
  readSessionMemoryFile,
  loadSessionJsonl,
  loadSessionUsage,
  searchActivity,
  groupByProject,
  toClientSession,
  convertSession,
} from './agents/sessions.js';
import { createMetaAgent } from './agents/meta-agent.js';
import { discoverAllAgentModels } from './agents/models.js';
import { createTextBatcher } from './agents/stream-batch.js';
import { normalizeCommand, mapAgentEmit } from './runtime/protocol.js';
import { createOutbox } from './runtime/outbox.js';
import { resolveApproval, cancelApprovalsForSession } from './runtime/approvals.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// ─── Config ──────────────────────────────────────────────────────────────────
export const PORT = parseInt(process.env.PORT || '3000');
const CREDENTIALS_FILE  = process.env.CREDENTIALS_FILE  || path.join(rootDir, '.credentials.json');
const WORKSPACES_FILE   = process.env.WORKSPACES_FILE   || path.join(rootDir, '.workspaces.json');
const PROJECT_NOTES_FILE = process.env.PROJECT_NOTES_FILE || path.join(rootDir, '.project_notes.json');
const SESSION_META_FILE  = process.env.SESSION_META_FILE  || path.join(rootDir, '.session_meta.json');
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || 'claude';
const CODEX_CLI_PATH  = process.env.CODEX_CLI_PATH  || 'codex';
const GROK_CLI_PATH   = process.env.GROK_CLI_PATH   || 'grok';
const CODEX_HOME = (process.env.CODEX_HOME || path.join(os.homedir(), '.codex')).replace(/^~/, os.homedir());
const GROK_HOME  = (process.env.GROK_HOME  || path.join(os.homedir(), '.grok')).replace(/^~/, os.homedir());
const ENABLED_AGENTS = (() => {
  const raw = (process.env.AGENTS || 'claude,codex,grok')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set(raw.length ? raw : ['claude', 'codex', 'grok'])];
})();
const CLAUDE_CONFIG_DIRS = (() => {
  const dirs = (process.env.CLAUDE_CONFIG_DIRS || '')
    .split(',').map(s => s.trim().replace(/^~/, os.homedir())).filter(Boolean);
  return [...new Set(dirs.length ? dirs : [path.join(os.homedir(), '.claude')])];
})();

// ─── Auth storage ─────────────────────────────────────────────────────────────
let credStore = null;

async function loadCreds() {
  if (credStore) return credStore;
  try {
    credStore = JSON.parse(await fs.readFile(CREDENTIALS_FILE, 'utf8'));
  } catch {
    credStore = { users: [] };
  }
  if (!credStore.jwtSecret) {
    credStore.jwtSecret = crypto.randomBytes(32).toString('hex');
    await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(credStore, null, 2));
  }
  return credStore;
}

async function saveCreds(store) {
  credStore = store;
  await fs.writeFile(CREDENTIALS_FILE, JSON.stringify(store, null, 2));
}

async function hasUsers() {
  const store = await loadCreds();
  return store.users.length > 0;
}

// ─── Workspace storage ────────────────────────────────────────────────────────
let wsStore = null;

async function loadWorkspacesStore() {
  if (wsStore) return wsStore;
  try {
    wsStore = JSON.parse(await fs.readFile(WORKSPACES_FILE, 'utf8'));
  } catch {
    wsStore = { workspaces: CLAUDE_CONFIG_DIRS.map((d, i) => ({
      id:        crypto.randomUUID(),
      name:      i === 0 ? 'default' : path.basename(d),
      configDir: d,
    })) };
  }
  return wsStore;
}

async function saveWorkspacesStore() {
  await fs.writeFile(WORKSPACES_FILE, JSON.stringify(wsStore, null, 2));
}

let projectNotesCache = null;
let sessionMetaCache = null;

/** Normalize project entry: old { notes } was the goal line. */
function normalizeProjectEntry(entry) {
  if (!entry || typeof entry !== 'object') return { goal: '', notes: '', updatedAt: 0 };
  const hasGoalKey = Object.prototype.hasOwnProperty.call(entry, 'goal');
  if (!hasGoalKey && entry.notes != null) {
    // legacy: single notes field = Project Goal
    return { goal: String(entry.notes || ''), notes: '', updatedAt: entry.updatedAt || 0 };
  }
  return {
    goal: String(entry.goal || ''),
    notes: String(entry.notes || ''),
    updatedAt: entry.updatedAt || 0,
  };
}

async function loadProjectNotes() {
  if (projectNotesCache) return projectNotesCache;
  try {
    projectNotesCache = JSON.parse(await fs.readFile(PROJECT_NOTES_FILE, 'utf8'));
  } catch {
    projectNotesCache = {};
  }
  return projectNotesCache;
}

async function saveProjectNotes() {
  if (!projectNotesCache) return;
  await fs.writeFile(PROJECT_NOTES_FILE, JSON.stringify(projectNotesCache, null, 2), 'utf8');
}

function sessionMetaKey(agent, sessionId) {
  return `${agent || 'claude'}:${sessionId}`;
}

async function loadSessionMeta() {
  if (sessionMetaCache) return sessionMetaCache;
  try {
    sessionMetaCache = JSON.parse(await fs.readFile(SESSION_META_FILE, 'utf8'));
  } catch {
    sessionMetaCache = {};
  }
  return sessionMetaCache;
}

async function saveSessionMeta() {
  if (!sessionMetaCache) return;
  await fs.writeFile(SESSION_META_FILE, JSON.stringify(sessionMetaCache, null, 2), 'utf8');
}

async function getWorkspaces() {
  return (await loadWorkspacesStore()).workspaces;
}

async function syncConfigDirs() {
  const wss = await getWorkspaces();
  const dirs = [...new Set(wss.map(w => w.configDir))];
  CLAUDE_CONFIG_DIRS.splice(0, CLAUDE_CONFIG_DIRS.length, ...dirs);
}

async function findUser(username) {
  const store = await loadCreds();
  return store.users.find(u => u.username === username) || null;
}

async function createUser(username, passwordHash) {
  const store = await loadCreds();
  const user = { id: Date.now(), username, passwordHash };
  store.users.push(user);
  await saveCreds(store);
  return user;
}

function jwtSecret() { return credStore?.jwtSecret; }

function makeToken(user) {
  return jwt.sign({ userId: user.id, username: user.username }, jwtSecret(), { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, jwtSecret()); }
  catch { return null; }
}

async function bootstrapEnvUser() {
  const u = process.env.AUTH_USERNAME;
  const p = process.env.AUTH_PASSWORD;
  if (!u || !p) return;
  if (await hasUsers()) return;
  const hash = await bcrypt.hash(p, 12);
  await createUser(u, hash);
  console.log(`[auth] Bootstrapped user "${u}" from environment`);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
// When this process is an edge worker (client.js), the hub authenticates users
// and forwards with X-Hub-Token: MACHINE_TOKEN. JWT still works for standalone UI.
function authMiddleware(req, res, next) {
  const hubSecret = process.env.MACHINE_TOKEN;
  const hubHeader = req.headers['x-hub-token'];
  if (hubSecret && hubHeader && hubHeader === hubSecret) {
    req.user = {
      userId: 0,
      username: req.headers['x-hub-user'] || 'hub',
      viaHub: true,
    };
    return next();
  }

  const header = req.headers['authorization'];
  let token = header && header.split(' ')[1];
  if (!token && req.query.token) token = req.query.token;
  // Hub also tunnels WS with ?token=MACHINE_TOKEN&hub=1
  if (hubSecret && token && token === hubSecret) {
    req.user = { userId: 0, username: 'hub', viaHub: true };
    return next();
  }
  if (!token) return res.status(401).json({ error: 'No token' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(403).json({ error: 'Invalid token' });
  req.user = decoded;
  next();
}

// ─── Path helpers ─────────────────────────────────────────────────────────────
function safePath(base, rel) {
  const resolved = path.resolve(base, rel || '');
  if (!resolved.startsWith(path.resolve(base))) throw new Error('Path traversal');
  return resolved;
}

function expandPath(p) {
  if (!p) return p;
  return p.replace(/^~/, os.homedir());
}

function resolveProjectRoot(req) {
  const root = req.query.root || req.body?.root;
  if (root) {
    const resolved = path.resolve(expandPath(root));
    if (!path.isAbsolute(resolved) || resolved === '/' || resolved.includes('\0'))
      throw new Error('Invalid root path');
    return resolved;
  }
  throw new Error('root path required');
}

// ─── Git helpers ──────────────────────────────────────────────────────────────
function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(err || `git exit ${code}`));
    });
    child.on('error', reject);
  });
}

async function isGitRepo(dir) {
  try { await git(['rev-parse', '--git-dir'], dir); return true; }
  catch { return false; }
}

// ─── Active agent sessions ────────────────────────────────────────────────────
const activeSessions = new Map();
/** Live chat sockets so a mobile reconnect can resume an in-flight run. */
const chatClients = new Set();

function sendJson(ws, data) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch { /* ignore */ }
  }
}

function broadcastChat(sessionId, data, fallbackWs) {
  let n = 0;
  if (sessionId) {
    for (const c of chatClients) {
      if (c.sessionId === sessionId) {
        sendJson(c.ws, data);
        n++;
      }
    }
  }
  if (n === 0 && fallbackWs) sendJson(fallbackWs, data);
}

async function listSessions(filterCwd = null, agentFilter = null) {
  const agents = agentFilter
    ? [agentFilter]
    : ENABLED_AGENTS;
  return scanAllSessions({
    claudeConfigDirs: CLAUDE_CONFIG_DIRS,
    codexHome: CODEX_HOME,
    grokHome: GROK_HOME,
    filterCwd,
    agents,
  });
}

/**
 * Wrap agent emit → map/filter → outbox (delta coalesce + batch frames).
 * Agents may still call send() with UI-shaped events; unknown noise is dropped.
 */
function createAgentSend(outbox, agent) {
  return (data) => {
    const mapped = mapAgentEmit(data, { agent, compactTools: true });
    // permission_request / already-mapped events: mapAgentEmit keeps known types
    if (mapped) outbox.send(mapped);
    else if (data?.type === 'permission_request' || data?.type === 'permission_resolved') {
      outbox.send(data);
    }
  };
}

async function dispatchAgent(agent, command, options, send) {
  const a = (agent || 'claude').toLowerCase();
  if (!ENABLED_AGENTS.includes(a)) {
    send({ type: 'error', message: `Agent "${a}" is not enabled. Enabled: ${ENABLED_AGENTS.join(', ')}` });
    return;
  }
  const ctx = { activeSessions };
  if (a === 'codex') {
    await runCodex(command, options, send, { ...ctx, cliPath: CODEX_CLI_PATH });
  } else if (a === 'grok') {
    await runGrok(command, options, send, { ...ctx, cliPath: GROK_CLI_PATH });
  } else {
    await runClaude(command, options, send, { ...ctx, cliPath: CLAUDE_CLI_PATH });
  }
}

function abortSession(sessionId) {
  if (!sessionId) return false;
  let ok = false;
  cancelApprovalsForSession(sessionId);
  // Grok/Codex may register under temp key + real sessionId — abort every match.
  for (const [key, s] of activeSessions) {
    if (key !== sessionId && s?.sessionId !== sessionId && s?.key !== sessionId) continue;
    if (s.controller) s.controller.abort();
    if (typeof s.abort === 'function') s.abort();
    else if (s.child) {
      try { s.child.kill('SIGTERM'); } catch {}
    }
    s.busy = false;
    ok = true;
  }
  return ok;
}

/** Whether a session still has an in-flight UI-blocking run. */
function isSessionBusy(sessionId) {
  if (!sessionId) return false;
  for (const [key, s] of activeSessions) {
    if (key !== sessionId && s?.sessionId !== sessionId) continue;
    if (s && s.busy !== false) return true;
  }
  return false;
}

/** True if any agent turn is in flight (used by auto-update before restart). */
export function hasBusyAgent() {
  for (const s of activeSessions.values()) {
    if (s && s.busy !== false) return true;
  }
  return false;
}

function markSessionIdle(sessionId, tempKey) {
  for (const key of [sessionId, tempKey].filter(Boolean)) {
    const s = activeSessions.get(key);
    if (s) s.busy = false;
  }
}

/** Max JSON chars kept per tool_use input in history payloads (traffic). */
const HISTORY_TOOL_INPUT_MAX = 100;

/** Shrink history payloads: tool inputs dominate mobile / hub transfers. */
function compactHistoryMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    if (m.type === 'tool_use' && m.input != null) {
      let raw;
      try { raw = typeof m.input === 'string' ? m.input : JSON.stringify(m.input); }
      catch { raw = String(m.input); }
      if (raw.length > HISTORY_TOOL_INPUT_MAX) {
        return {
          ...m,
          input: {
            _truncated: true,
            preview: raw.slice(0, HISTORY_TOOL_INPUT_MAX),
            bytes: raw.length,
          },
        };
      }
    }
    if (m.type === 'text' && typeof m.content === 'string' && m.content.length > 48_000) {
      return { ...m, content: `${m.content.slice(0, 48_000)}\n…` };
    }
    return m;
  });
}

// ─── App factory ──────────────────────────────────────────────────────────────
export function createApp() {
  const app = express();

  // Gzip JSON/text API responses when client accepts it (mobile / direct browser).
  // Skip for hub-proxied edge traffic: Node fetch auto-decompresses gzip while
  // still advertising Content-Encoding, which breaks the browser after tunnel
  // re-delivery. Control WS already uses perMessageDeflate.
  app.use((req, res, next) => {
    if (req.headers['x-hub-token']) return next();
    const ae = req.headers['accept-encoding'] || '';
    if (!/\bgzip\b/i.test(ae) || req.method === 'HEAD') return next();
    const origJson = res.json.bind(res);
    res.json = (body) => {
      let buf;
      try { buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); }
      catch { return origJson(body); }
      if (buf.length < 900) return origJson(body);
      zlib.gzip(buf, { level: 6 }, (err, zipped) => {
        if (err || !zipped || zipped.length >= buf.length * 0.95) return origJson(body);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', zipped.length);
        res.status(res.statusCode || 200).end(zipped);
      });
    };
    next();
  });

  app.post('/api/upload-image', authMiddleware, (req, res) => {
    (async () => {
      const ext  = (req.headers['x-filename'] || 'image.png').split('.').pop().replace(/[^a-z0-9]/gi, '') || 'png';
      const name = `claude-upload-${Date.now()}.${ext}`;
      const dest = path.join(os.tmpdir(), name);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = Buffer.concat(chunks);
      // Tolerate mobile share sheets that label Base64 text as a PNG. Only
      // decode when the result has a real image signature.
      const text = body.toString('utf8').trim();
      const m = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(text);
      const encoded = (m?.[1] || text).replace(/\s/g, '');
      if (/^[a-z0-9+/=]+$/i.test(encoded) && encoded.length % 4 !== 1) {
        try {
          const decoded = Buffer.from(encoded, 'base64');
          const image = decoded.length >= 3 && (
            (decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e)
            || (decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff)
            || decoded.subarray(0, 6).toString() === 'GIF87a'
            || decoded.subarray(8, 12).toString() === 'WEBP'
          );
          if (image) body = decoded;
        } catch { /* preserve the original upload */ }
      }
      await fs.writeFile(dest, body);
      res.json({ path: dest });
    })().catch(e => res.status(500).json({ error: e.message }));
  });

  app.post('/api/projects/:id/file', authMiddleware, (req, res) => {
    (async () => {
      const projectPath = resolveProjectRoot(req);
      const rel = req.query.path;
      if (!rel) return res.status(400).json({ error: 'path required' });
      const filePath = safePath(projectPath, rel);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const writer = fsSync.createWriteStream(filePath);
      req.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        req.on('error', reject);
      });
      const stat = await fs.stat(filePath);
      res.json({ ok: true, size: stat.size });
    })().catch(e => res.status(500).json({ error: e.message }));
  });

  app.use(express.json({ limit: '10mb' }));

  const distDir   = path.join(rootDir, 'dist');
  const publicDir = path.join(rootDir, 'public');
  // Only ship the built bundle in production. Local `node server.js` serves
  // public/ so new modules (shell.js, state.js, …) are not 404s against stale dist/.
  const usesDist  = process.env.NODE_ENV === 'production' && fsSync.existsSync(distDir);
  const staticDir = usesDist ? distDir : publicDir;
  console.log(`[static] serving ${usesDist ? 'dist/' : 'public/'} (NODE_ENV=${process.env.NODE_ENV || 'unset'})`);
  app.use(express.static(staticDir));

  // Standalone: report "not a hub" with 200 so browser probe isn't a red 404
  app.get('/api/hub', (_req, res) => {
    res.json({ hub: false });
  });

  // Avoid noisy favicon 404s in the browser console
  app.get('/favicon.ico', (_req, res) => {
    res.type('image/svg+xml').send(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1d4ed8"/><text x="16" y="22" text-anchor="middle" font-size="16" fill="white" font-family="system-ui">A</text></svg>`
    );
  });

  app.get('/api/auth/status', async (_req, res) => {
    res.json({ needsSetup: !(await hasUsers()) });
  });

  app.post('/api/auth/register', async (req, res) => {
    try {
      if (await hasUsers()) return res.status(403).json({ error: 'User already exists' });
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
      if (username.length < 3 || password.length < 6)
        return res.status(400).json({ error: 'Username ≥3 chars, password ≥6 chars' });
      const hash = await bcrypt.hash(password, 12);
      const user = await createUser(username, hash);
      res.json({ token: makeToken(user), user: { id: user.id, username: user.username } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
      const user = await findUser(username);
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      res.json({ token: makeToken(user), user: { id: user.id, username: user.username } });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/projects/:id/files', authMiddleware, async (req, res) => {
    try {
      const projectPath = resolveProjectRoot(req);
      const rel = req.query.path || '';
      const dir = rel ? safePath(projectPath, rel) : projectPath;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = entries
        .filter(e => !e.name.startsWith('.') || e.name === '.env')
        .map(e => ({
          name: e.name,
          path: rel ? `${rel}/${e.name}` : e.name,
          isDir: e.isDirectory(),
        }));
      res.json(files);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/projects/:id/file', authMiddleware, async (req, res) => {
    try {
      const projectPath = resolveProjectRoot(req);
      const rel = req.query.path;
      if (!rel) return res.status(400).json({ error: 'path required' });
      const filePath = safePath(projectPath, rel);
      const stat = await fs.stat(filePath);
      if (req.query.download === 'true') {
        const name = path.basename(filePath);
        // ASCII fallback + RFC 5987 so Chinese / spaces filenames download correctly.
        const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
        const star = encodeURIComponent(name).replace(/['()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        res.setHeader('Content-Disposition', `attachment; filename="${ascii || 'download'}"; filename*=UTF-8''${star}`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        return fsSync.createReadStream(filePath).pipe(res);
      }
      // Office / PDF / binary previews need more headroom than plain text
      const isOffice = /\.(docx|pptx|xlsx|pdf)$/i.test(rel);
      const maxBytes = isOffice ? 15 * 1024 * 1024 : 2 * 1024 * 1024;
      if (stat.size > maxBytes) {
        return res.status(413).json({
          error: isOffice ? 'File too large (>15MB)' : 'File too large (>2MB)',
        });
      }
      const buf = await fs.readFile(filePath);
      // NUL in first 512 bytes ⇒ binary (ZIP-based Office formats, images, …)
      const head = buf.subarray(0, Math.min(512, buf.length));
      const binary = isOffice || head.includes(0);
      if (binary) {
        return res.json({
          content: buf.toString('base64'),
          encoding: 'base64',
          size: stat.size,
        });
      }
      res.json({ content: buf.toString('utf8'), encoding: 'utf8', size: stat.size });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/projects/:id/file', authMiddleware, async (req, res) => {
    try {
      const projectPath = resolveProjectRoot(req);
      const rel = req.query.path;
      if (!rel) return res.status(400).json({ error: 'path required' });
      const filePath = safePath(projectPath, rel);
      await fs.rm(filePath, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/projects/:id/git/status', authMiddleware, async (req, res) => {
    try {
      const projectPath = resolveProjectRoot(req);
      if (!(await isGitRepo(projectPath))) return res.json({ isGit: false, files: [] });
      const out = await git(['status', '--porcelain'], projectPath);
      const branch = await git(['branch', '--show-current'], projectPath).catch(() => 'unknown');
      const files = out.trim().split('\n').filter(Boolean).map(line => ({
        status: line.slice(0, 2).trim(),
        file: line.slice(3),
      }));
      res.json({ isGit: true, branch: branch.trim(), files });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/projects/:id/git/diff', authMiddleware, async (req, res) => {
    try {
      const projectPath = resolveProjectRoot(req);
      if (!(await isGitRepo(projectPath))) return res.json({ diff: '' });
      const staged = req.query.staged === 'true';
      const args = staged ? ['diff', '--cached'] : ['diff'];
      const diff = await git(args, projectPath).catch(() => '');
      res.json({ diff });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/resolve-path', authMiddleware, async (req, res) => {
    try {
      const { path: rawPath } = req.body;
      if (!rawPath?.trim()) return res.status(400).json({ error: 'path required' });
      const resolved = path.resolve(expandPath(rawPath.trim()));
      if (resolved === '/' || resolved.includes('\0'))
        return res.status(400).json({ error: 'Invalid path' });
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat) return res.status(404).json({ error: `Path not found: ${resolved}` });
      res.json({ path: resolved, isDir: stat.isDirectory(), isGit: await isGitRepo(resolved).catch(() => false) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/workspaces', authMiddleware, async (req, res) => {
    res.json(await getWorkspaces());
  });

  app.post('/api/workspaces', authMiddleware, async (req, res) => {
    try {
      const { name, configDir } = req.body;
      if (!name?.trim() || !configDir?.trim()) return res.status(400).json({ error: 'name and configDir required' });
      const dir = configDir.trim().replace(/^~/, os.homedir());
      const store = await loadWorkspacesStore();
      if (store.workspaces.some(w => w.configDir === dir))
        return res.status(409).json({ error: 'Workspace with this path already exists' });
      const ws = { id: crypto.randomUUID(), name: name.trim(), configDir: dir };
      store.workspaces.push(ws);
      await saveWorkspacesStore();
      await syncConfigDirs();
      res.json(ws);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/workspaces/:id', authMiddleware, async (req, res) => {
    try {
      const store = await loadWorkspacesStore();
      const idx = store.workspaces.findIndex(w => w.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      if (store.workspaces.length === 1) return res.status(400).json({ error: 'Cannot remove the last workspace' });
      store.workspaces.splice(idx, 1);
      await saveWorkspacesStore();
      await syncConfigDirs();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/workspaces/:id', authMiddleware, async (req, res) => {
    try {
      const store = await loadWorkspacesStore();
      const ws = store.workspaces.find(w => w.id === req.params.id);
      if (!ws) return res.status(404).json({ error: 'Not found' });
      if (req.body.name) ws.name = req.body.name.trim();
      await saveWorkspacesStore();
      res.json(ws);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/agents', authMiddleware, async (_req, res) => {
    try {
      const defaults = await discoverAllAgentModels({
        claudeConfigDirs: CLAUDE_CONFIG_DIRS,
        codexHome: CODEX_HOME,
        grokHome: GROK_HOME,
        agents: ENABLED_AGENTS,
      });
      res.json({
        enabled: ENABLED_AGENTS,
        defaults,
        homes: {
          claude: CLAUDE_CONFIG_DIRS,
          codex: CODEX_HOME,
          grok: GROK_HOME,
        },
        paths: {
          claude: CLAUDE_CLI_PATH,
          codex: CODEX_CLI_PATH,
          grok: GROK_CLI_PATH,
        },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/projects/notes', authMiddleware, async (req, res) => {
    try {
      const root = req.query.root;
      if (!root) return res.status(400).json({ error: 'root parameter required' });
      const resolved = path.resolve(expandPath(root));
      const db = await loadProjectNotes();
      res.json(normalizeProjectEntry(db[resolved]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/projects/notes', authMiddleware, async (req, res) => {
    try {
      const { root, goal, notes } = req.body || {};
      if (!root) return res.status(400).json({ error: 'root required' });
      const resolved = path.resolve(expandPath(root));
      const db = await loadProjectNotes();
      const prev = normalizeProjectEntry(db[resolved]);
      // Allow partial updates: omit field → keep previous
      const next = {
        goal: goal !== undefined ? String(goal || '') : prev.goal,
        notes: notes !== undefined ? String(notes || '') : prev.notes,
        updatedAt: Date.now(),
      };
      db[resolved] = next;
      await saveProjectNotes();
      res.json({ success: true, ...next });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/projects/notes', authMiddleware, async (req, res) => {
    try {
      const root = req.query.root;
      if (!root) return res.status(400).json({ error: 'root parameter required' });
      const resolved = path.resolve(expandPath(root));
      const db = await loadProjectNotes();
      if (db[resolved]) {
        delete db[resolved];
        await saveProjectNotes();
      }
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Session meta: favorites + notes + title (rename map) ─────────────────
  app.get('/api/sessions/meta', authMiddleware, async (_req, res) => {
    try {
      const db = await loadSessionMeta();
      res.json(db);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/sessions/meta', authMiddleware, async (req, res) => {
    try {
      const { sessionId, agent, favorite, notes, title, hidden } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
      const key = sessionMetaKey(agent || 'claude', sessionId);
      const db = await loadSessionMeta();
      const prev = db[key] || { favorite: false, notes: '', title: '', hidden: false, updatedAt: 0 };
      const next = {
        favorite: favorite !== undefined ? Boolean(favorite) : Boolean(prev.favorite),
        notes: notes !== undefined ? String(notes || '') : String(prev.notes || ''),
        // Custom display name mapping; empty string clears rename
        title: title !== undefined
          ? String(title || '').trim().slice(0, 200)
          : String(prev.title || '').trim(),
        hidden: hidden !== undefined ? Boolean(hidden) : Boolean(prev.hidden),
        updatedAt: Date.now(),
      };
      // Drop empty entries to keep file small
      if (!next.favorite && !next.notes && !next.title && !next.hidden) {
        delete db[key];
      } else {
        db[key] = next;
      }
      await saveSessionMeta();
      res.json({
        success: true,
        key,
        ...(db[key] || { favorite: false, notes: '', title: '', hidden: false, updatedAt: Date.now() }),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Session / context usage (Grok signals + turn totals; Claude last usage; Codex meta)
  // GET /api/usage?sessionId=...&agent=grok
  app.get('/api/usage', authMiddleware, async (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
      const preferred = typeof req.query.agent === 'string' ? req.query.agent : null;
      if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        return res.status(400).json({ error: 'sessionId (uuid) required' });
      }
      const opts = {
        claudeConfigDirs: CLAUDE_CONFIG_DIRS,
        codexHome: CODEX_HOME,
        grokHome: GROK_HOME,
      };
      const order = [...new Set([preferred, ...ENABLED_AGENTS, 'claude', 'codex', 'grok'].filter(Boolean))];
      let data = null;
      for (const a of order) {
        data = await loadSessionUsage(sessionId, a, opts);
        if (data) break;
      }
      if (!data) return res.status(404).json({ error: 'Session not found' });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/sessions', authMiddleware, async (req, res) => {
    try {
      const filterCwd = typeof req.query.cwd === 'string' ? req.query.cwd : null;
      const agent = typeof req.query.agent === 'string' ? req.query.agent : null;
      const days = parseInt(req.query.days || '0', 10) || 0;
      let limit = parseInt(req.query.limit || '0', 10) || 0;
      if (limit < 0) limit = 0;
      if (limit > 800) limit = 800;
      let sessions = (await listSessions(filterCwd || null, agent)).map(toClientSession);
      if (days > 0) {
        const since = Date.now() - days * 86400000;
        sessions = sessions.filter(s => (s.updatedAt || 0) >= since);
      }
      if (limit > 0 && sessions.length > limit) sessions = sessions.slice(0, limit);
      const etag = `"s${crypto.createHash('sha1').update(JSON.stringify(sessions)).digest('base64url').slice(0, 20)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=15');
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.json(sessions);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Project-centric listing: groups sessions by cwd with latest activity
  app.get('/api/projects', authMiddleware, async (req, res) => {
    try {
      const agent = typeof req.query.agent === 'string' ? req.query.agent : null;
      const days = parseInt(req.query.days || '0', 10) || 0;
      let sessions = await listSessions(null, agent);
      if (days > 0) {
        const since = Date.now() - days * 86400000;
        sessions = sessions.filter(s => (s.updatedAt || 0) >= since);
      }
      res.json(groupByProject(sessions.map(toClientSession)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Recent activity + keyword search (metadata + light content peek)
  // GET /api/activity?q=fix&days=7&agent=grok&limit=50&deep=1
  app.get('/api/activity', authMiddleware, async (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const agent = typeof req.query.agent === 'string' ? req.query.agent : null;
      const days = parseInt(req.query.days || '14', 10) || 0;
      const limit = Math.min(parseInt(req.query.limit || '60', 10) || 60, 200);
      const deep = req.query.deep !== '0' && req.query.deep !== 'false';
      const sessions = await listSessions(null, agent);
      const results = await searchActivity(sessions, { q, days, agent, limit, deep });
      res.json({
        q,
        days,
        agent,
        count: results.length,
        results,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/sessions/:sessionId/messages', authMiddleware, async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(400).json({ error: 'Invalid session id' });
      const preferred = typeof req.query.agent === 'string' ? req.query.agent : null;
      // tail=0 → full history (default). Positive = last N messages only.
      let tail = parseInt(req.query.tail ?? '0', 10);
      if (Number.isNaN(tail)) tail = 0;
      if (tail < 0) tail = 0;
      if (tail > 50_000) tail = 50_000;
      const compact = req.query.compact !== '0' && req.query.compact !== 'false';
      const opts = {
        claudeConfigDirs: CLAUDE_CONFIG_DIRS,
        codexHome: CODEX_HOME,
        grokHome: GROK_HOME,
      };
      // Prefer stated agent; only fall back if not found (avoids scanning all agents every time)
      const order = preferred
        ? [preferred, ...ENABLED_AGENTS.filter(a => a !== preferred)]
        : [...ENABLED_AGENTS];
      let bundle = null;
      for (const a of order) {
        bundle = await loadSessionMessages(sessionId, a, opts);
        if (bundle) break;
      }
      if (!bundle) return res.status(404).json({ error: 'Session not found' });
      // Normalize: always { messages, context, agent }
      let messages = Array.isArray(bundle)
        ? bundle
        : (bundle.messages || []);
      const total = messages.length;
      let truncated = false;
      if (tail > 0 && messages.length > tail) {
        messages = messages.slice(-tail);
        truncated = true;
      }
      if (compact) messages = compactHistoryMessages(messages);
      const payload = {
        messages,
        context: Array.isArray(bundle) ? null : (bundle.context || null),
        agent: Array.isArray(bundle) ? (preferred || 'claude') : (bundle.agent || preferred || 'claude'),
        total,
        truncated,
        tail: truncated ? tail : total,
        compact,
      };
      res.setHeader('X-Session-Agent', payload.agent);
      res.setHeader('Cache-Control', 'private, max-age=30');
      res.json(payload);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/sessions/:sessionId/convert', authMiddleware, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { targetAgent, sourceAgent } = req.body;
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(400).json({ error: 'Invalid session id' });
      if (!targetAgent) return res.status(400).json({ error: 'targetAgent required' });

      const opts = {
        claudeConfigDirs: CLAUDE_CONFIG_DIRS,
        codexHome: CODEX_HOME,
        grokHome: GROK_HOME,
      };

      let detectedSourceAgent = sourceAgent;
      if (!detectedSourceAgent) {
        const order = [...new Set([...ENABLED_AGENTS, 'claude', 'codex', 'grok'])];
        for (const a of order) {
          const bundle = await loadSessionMessages(sessionId, a, opts);
          if (bundle) {
            detectedSourceAgent = a;
            break;
          }
        }
      }

      if (!detectedSourceAgent) {
        return res.status(404).json({ error: 'Source session not found' });
      }

      const { targetSessionId } = await convertSession(sessionId, detectedSourceAgent, targetAgent, opts);
      res.json({ success: true, targetSessionId, targetAgent });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/sessions/:sessionId/memory', authMiddleware, async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(400).json({ error: 'Invalid session id' });
      const preferred = typeof req.query.agent === 'string' ? req.query.agent : null;
      const opts = {
        claudeConfigDirs: CLAUDE_CONFIG_DIRS,
        codexHome: CODEX_HOME,
        grokHome: GROK_HOME,
      };
      // A selected session already knows its agent. Do not fall back to another
      // agent's account-level memory (especially Codex) when that session has none.
      const order = preferred
        ? [preferred]
        : [...new Set([...ENABLED_AGENTS, 'claude', 'codex', 'grok'])];
      let memory = null;
      for (const a of order) {
        memory = await loadSessionMemory(sessionId, a, opts);
        if (memory) break;
      }
      res.json(memory || { agent: preferred || null, files: [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/sessions/:sessionId/memory/file', authMiddleware, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const agent = typeof req.query.agent === 'string' ? req.query.agent : 'claude';
      const file = typeof req.query.file === 'string' ? req.query.file : '';
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return res.status(400).json({ error: 'Invalid session id' });
      const row = await readSessionMemoryFile(sessionId, agent, file, {
        claudeConfigDirs: CLAUDE_CONFIG_DIRS, codexHome: CODEX_HOME, grokHome: GROK_HOME,
      });
      if (!row) return res.status(404).json({ error: 'Memory file not found' });
      res.setHeader('Cache-Control', 'private, max-age=30');
      res.json(row);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/projects/:id/git/log', authMiddleware, async (req, res) => {
    try {
      const projectPath = resolveProjectRoot(req);
      if (!(await isGitRepo(projectPath))) return res.json({ graph: '', commits: [] });
      const graph = await git(
        ['log', '--graph', '--oneline', '--all', '--decorate', '-30'],
        projectPath
      ).catch(() => '');
      const commits = (await git(['log', '--oneline', '-20'], projectPath).catch(() => ''))
        .trim().split('\n').filter(Boolean)
        .map(line => ({ hash: line.slice(0, 7), message: line.slice(8) }));
      res.json({ graph, commits });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Meta Agent (built-in AI: reports, Q&A, VLM, code run) ───────────────────
  const meta = createMetaAgent({
    rootDir,
    listSessions,
    searchActivity,
    loadSessionMessages,
    loadSessionJsonl,
    groupByProject,
    toClientSession,
    getProjectNotesStore: loadProjectNotes,
    saveProjectNotesStore: saveProjectNotes,
    getSessionMetaStore: loadSessionMeta,
    normalizeProjectEntry,
    git,
    isGitRepo,
    claudeConfigDirs: () => CLAUDE_CONFIG_DIRS,
    codexHome: () => CODEX_HOME,
    grokHome: () => GROK_HOME,
  });

  /** Write SSE event */
  function sseWrite(res, event, data) {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  app.get('/api/ai/config', authMiddleware, async (_req, res) => {
    try {
      const c = await meta.loadConfig();
      res.json(meta.publicConfig(c));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/ai/config', authMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      for (const k of [
        'url', 'model', 'key', 'vlm_url', 'vlm_key', 'vlm_model',
        'temperature', 'system', 'auto_report', 'auto_report_hour', 'auto_report_days',
      ]) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      // empty key string = keep existing
      if (patch.key === '' || patch.key === '***') delete patch.key;
      if (patch.vlm_key === '' || patch.vlm_key === '***') delete patch.vlm_key;
      const pub = await meta.saveConfig(patch);
      res.json(pub);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/ai/reports', authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 100);
      res.json({ reports: await meta.listReports(limit) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/ai/reports/:day', authMiddleware, async (req, res) => {
    try {
      const r = await meta.getReport(req.params.day);
      if (!r) return res.status(404).json({ error: 'not found' });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/ai/digest', authMiddleware, async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days || '1', 10) || 1, 30);
      const agent = typeof req.query.agent === 'string' ? req.query.agent : null;
      const includeMessages = req.query.messages !== '0';
      const digest = await meta.buildDigest({ days, agent, includeMessages });
      res.json(digest);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/ai/notes', authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 200);
      const scope = typeof req.query.scope === 'string' ? req.query.scope : 'all';
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
      const agent = typeof req.query.agent === 'string' ? req.query.agent : '';
      res.json({
        notes: await meta.listMetaNotes({ limit, scope, q, cwd, sessionId, agent }),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/ai/notes/:id', authMiddleware, async (req, res) => {
    try {
      const note = await meta.getMetaNote(req.params.id);
      if (!note) return res.status(404).json({ error: 'not found' });
      res.json(note);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/ai/notes', authMiddleware, async (req, res) => {
    try {
      const note = await meta.saveMetaNote(req.body || {});
      res.json(note);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/ai/notes/:id', authMiddleware, async (req, res) => {
    try {
      const result = await meta.deleteMetaNote(req.params.id);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // SSE: generate work report
  app.post('/api/ai/report', authMiddleware, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const days = Math.min(parseInt(req.body?.days || '1', 10) || 1, 14);
    try {
      const result = await meta.generateReport({
        days,
        onContent: (content) => sseWrite(res, 'content', { content }),
        onTool: (name, args, phase, result, id) => {
          sseWrite(res, 'tool', { name, args, phase, result: phase === 'start' ? undefined : result, id });
        },
      });
      sseWrite(res, 'done', {
        content: result.content,
        digest: result.digest?.totals,
      });
    } catch (e) {
      sseWrite(res, 'error', { message: String(e.message || e) });
    } finally {
      res.end();
    }
  });

  app.get('/api/ai/sessions', authMiddleware, async (_req, res) => {
    try {
      res.json({ sessions: await meta.listChatSessions() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/ai/sessions/:id', authMiddleware, async (req, res) => {
    try {
      const s = await meta.getChatSession(req.params.id);
      if (!s) return res.status(404).json({ error: 'not found' });
      res.json(s);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/ai/sessions/:id', authMiddleware, async (req, res) => {
    try {
      await meta.deleteChatSession(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // SSE: multi-turn agent chat (text only; images arrive as [imgN](path) refs → analyze_images)
  app.post('/api/ai/chat', authMiddleware, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      const {
        message,
        sessionId,
        newSession = false,
      } = req.body || {};

      const text = String(message || '').trim();
      if (!text) {
        sseWrite(res, 'error', { message: 'message required（图片请先粘贴为 [imgN](路径) 再发送）' });
        return res.end();
      }

      const cfg = await meta.loadConfig();

      let session = null;
      if (sessionId && !newSession) {
        session = await meta.getChatSession(sessionId);
      }
      if (!session) {
        session = {
          id: crypto.randomUUID(),
          title: text.replace(/\s+/g, ' ').trim().slice(0, 40) || '对话',
          messages: [],
          createdAt: Date.now(),
        };
      }

      session.messages.push({ role: 'user', content: text });
      // Track VLM threads used in this chat for resume/debug
      if (!Array.isArray(session.vlmThreadIds)) session.vlmThreadIds = [];
      const msgs = [
        { role: 'system', content: cfg.system || meta.DEFAULT_SYSTEM },
        ...session.messages.filter((m) => m.role !== 'system'),
      ];

      sseWrite(res, 'session', { id: session.id, title: session.title });

      const result = await meta.runLoop(msgs, {
        chatSessionId: session.id,
        onContent: (content) => sseWrite(res, 'content', { content }),
        onApproval: ({ id, name, args }) => sseWrite(res, 'approval', { id, name, args }),
        onTool: (name, args, phase, toolResult, id) => {
          if (name === 'analyze_images' && phase === 'done' && toolResult?.thread_id) {
            if (!session.vlmThreadIds.includes(toolResult.thread_id)) {
              session.vlmThreadIds.push(toolResult.thread_id);
            }
          }
          sseWrite(res, 'tool', {
            name,
            args,
            phase,
            id,
            result: phase === 'start' ? undefined : toolResult,
          });
        },
        cfg,
      });

      session.messages = result.messages.filter((m) => m.role !== 'system');
      // keep first-user-message title stable unless still default
      if (!session.title || session.title === '对话') {
        session.title = text.replace(/\s+/g, ' ').trim().slice(0, 40) || session.title;
      }
      await meta.saveChatSession(session);

      sseWrite(res, 'done', {
        content: result.content,
        sessionId: session.id,
        title: session.title,
      });
    } catch (e) {
      sseWrite(res, 'error', { message: String(e.message || e) });
    } finally {
      res.end();
    }
  });

  // User approves/denies a pending sensitive tool call (e.g. run_command) from /api/ai/chat.
  app.post('/api/ai/approve', authMiddleware, async (req, res) => {
    const { id, approved } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const ok = meta.resolveApproval(id, !!approved);
    if (!ok) return res.status(404).json({ error: 'no pending approval for id (may have timed out)' });
    res.json({ ok: true });
  });

  // ─── HTTP + WebSocket server ─────────────────────────────────────────────────
  const server = http.createServer(app);
  const wssOpts = {
    noServer: true,
    perMessageDeflate: {
      zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
      zlibInflateOptions: { chunkSize: 10 * 1024 },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      serverMaxWindowBits: 10,
      concurrencyLimit: 8,
      threshold: 256,
    },
  };
  const wssChat  = new WebSocketServer(wssOpts);
  const wssShell = new WebSocketServer(wssOpts);

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/ws/chat') {
      wssChat.handleUpgrade(req, socket, head, ws => wssChat.emit('connection', ws, req));
    } else if (pathname === '/ws/shell') {
      wssShell.handleUpgrade(req, socket, head, ws => wssShell.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  wssChat.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost`);
    const token = url.searchParams.get('token');
    const hubSecret = process.env.MACHINE_TOKEN;
    let decoded = null;
    if (hubSecret && token === hubSecret) {
      decoded = { userId: 0, username: 'hub', viaHub: true };
    } else {
      decoded = verifyToken(token);
    }
    if (!decoded) {
      ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      ws.close(1008, 'Unauthorized');
      return;
    }

    const client = { ws, sessionId: url.searchParams.get('sessionId') || null };
    chatClients.add(client);

    // Broadcast to every chat socket on the same session (mobile reconnect / multi-tab).
    const deliver = (data) => {
      if (data?.sessionId) client.sessionId = data.sessionId;
      broadcastChat(client.sessionId, data, ws);
    };

    let shellProc = null;
    let shellOut = null;
    let shellErr = null;
    // App-level ping only (JSON survives hub tunnel). Interval kept modest for mobile radio.
    const heartbeat = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      sendJson(ws, { type: 'ping' });
    }, 35_000);

    // Low-pressure outbox: coalesce deltas + optional multi-event batch frames
    const outbox = createOutbox(deliver, {
      maxWait: 48,
      maxDeltaChars: 720,
      maxBatchItems: 10,
      maxBatchBytes: 10_000,
    });
    const wireSend = (data) => outbox.send(data);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

      if (msg.type === 'ping') {
        sendJson(ws, { type: 'pong' });
        return;
      }
      if (msg.type === 'pong') return;

      const cmd = normalizeCommand(msg);
      if (!cmd) return;

      if (cmd.cmd === 'session.subscribe') {
        client.sessionId = cmd.sessionId || client.sessionId || null;
        wireSend({
          type: 'run-status',
          sessionId: client.sessionId,
          running: isSessionBusy(client.sessionId),
        });
        outbox.flush();
        return;
      }

      if (cmd.cmd === 'approval.respond') {
        const ok = resolveApproval(cmd.requestId, { allow: cmd.allow, always: cmd.always });
        if (cmd.requestId) {
          const elHint = { type: 'permission_resolved', requestId: cmd.requestId, allow: !!cmd.allow };
          wireSend(elHint);
        }
        if (!ok) {
          wireSend({ type: 'status', message: 'permission request expired or unknown' });
        }
        outbox.flush();
        return;
      }

      if (cmd.cmd === 'turn.interrupt') {
        const sid = cmd.sessionId;
        const ok = abortSession(sid);
        wireSend({ type: 'abort-result', success: ok, sessionId: sid });
        outbox.flush();
        return;
      }

      if (cmd.cmd === 'turn.start') {
        const agent = cmd.agent || 'claude';
        const options = { ...cmd.options };
        if (cmd.sessionId) options.sessionId = cmd.sessionId;
        if (cmd.cwd) options.cwd = cmd.cwd;
        if (options.sessionId) client.sessionId = options.sessionId;
        // A socket may subscribe to another session while this agent is still
        // streaming. Keep this run's delivery target in its own closure rather
        // than consulting mutable client.sessionId in the shared socket outbox.
        let runSessionId = options.sessionId || client.sessionId || null;
        const runOutbox = createOutbox((data) => {
          broadcastChat(runSessionId, data, ws);
        }, {
          maxWait: 48,
          maxDeltaChars: 720,
          maxBatchItems: 10,
          maxBatchBytes: 10_000,
        });
        const agentSend = createAgentSend(runOutbox, agent);
        const runSend = (data) => {
          if (data?.sessionId) runSessionId = data.sessionId;
          if (data?.type === 'result' || data?.type === 'complete' || data?.type === 'error') {
            markSessionIdle(data.sessionId || runSessionId, options.sessionId);
            runOutbox.flush();
          }
          // permission_request bypasses map filter double-pass carefully
          if (data?.type === 'permission_request' || data?.type === 'permission_resolved') {
            runOutbox.send(data);
            runOutbox.flush();
            return;
          }
          agentSend(data);
        };
        await dispatchAgent(agent, cmd.command || '', options, runSend);
        runOutbox.flush();
        return;
      }

      if (cmd.cmd === 'shell.exec') {
        if (shellProc) { try { shellProc.kill(); } catch {} shellProc = null; }
        shellOut?.flush();
        shellErr?.flush();
        const shellCmd = cmd.command || '';
        const cwd = cmd.cwd || os.homedir();
        wireSend({ type: 'shell-start', command: shellCmd });
        shellProc = spawn(process.env.SHELL || 'bash', ['-c', shellCmd], {
          cwd,
          env: { ...process.env },
          shell: false,
        });
        shellOut = createTextBatcher(
          (data) => wireSend({ type: 'shell-output', stream: 'stdout', data }),
          { maxWait: 48, maxSize: 3072 },
        );
        shellErr = createTextBatcher(
          (data) => wireSend({ type: 'shell-output', stream: 'stderr', data }),
          { maxWait: 48, maxSize: 3072 },
        );
        shellProc.stdout.on('data', d => shellOut.push(d.toString()));
        shellProc.stderr.on('data', d => shellErr.push(d.toString()));
        shellProc.on('close', (code) => {
          shellOut?.flush();
          shellErr?.flush();
          wireSend({ type: 'shell-exit', code });
          outbox.flush();
          shellProc = null;
        });
        shellProc.on('error', (e) => {
          shellOut?.flush();
          shellErr?.flush();
          wireSend({ type: 'shell-exit', code: 1, error: e.message });
          outbox.flush();
          shellProc = null;
        });
        return;
      }
    });

    ws.on('close', () => {
      chatClients.delete(client);
      clearInterval(heartbeat);
      outbox.flush();
      shellOut?.flush();
      shellErr?.flush();
      if (shellProc) { try { shellProc.kill(); } catch {} }
    });
    ws.on('error', (e) => console.error('[ws]', e.message));
  });

  wssShell.on('connection', (ws, req) => {
    const url     = new URL(req.url, 'http://localhost');
    const token   = url.searchParams.get('token');
    const hubSecret = process.env.MACHINE_TOKEN;
    let decoded = null;
    if (hubSecret && token === hubSecret) {
      decoded = { userId: 0, username: 'hub', viaHub: true };
    } else {
      decoded = verifyToken(token);
    }
    if (!decoded) { ws.close(1008, 'Unauthorized'); return; }

    const cwd  = url.searchParams.get('cwd') || os.homedir();
    const send = d => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(d)); };

    let proc;
    let hasPython = false;
    try {
      execSync('python3 --version', { stdio: 'ignore' });
      hasPython = true;
    } catch {}

    const cols = parseInt(url.searchParams.get('cols') || '80', 10);
    const rows = parseInt(url.searchParams.get('rows') || '24', 10);

    try {
      const shellBin = process.env.SHELL || 'zsh';
      if (hasPython) {
        const pythonScript = `
import os, pty, sys, termios, fcntl, struct, select
shell = '${shellBin}'
cols, rows = ${cols}, ${rows}
pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell, [shell])
else:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except:
        pass
    while True:
        try:
            r, w, x = select.select([0, fd], [], [])
            if 0 in r:
                data = os.read(0, 1024)
                if not data: break
                if data.startswith(b'\\x00resize:'):
                    try:
                        _, c, r = data.split(b':')
                        cols, rows = int(c), int(r)
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                    except:
                        pass
                else:
                    os.write(fd, data)
            if fd in r:
                data = os.read(fd, 1024)
                if not data: break
                os.write(1, data)
        except:
            break
`;
        proc = spawn('python3', ['-c', pythonScript], {
          cwd: fsSync.existsSync(cwd) ? cwd : os.homedir(),
          env: { ...process.env, TERM: 'xterm-256color' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        const args = ['-i'];
        if (shellBin.includes('bash')) {
          args.push('--norc', '--noprofile');
        }
        proc = spawn(shellBin, args, {
          cwd: fsSync.existsSync(cwd) ? cwd : os.homedir(),
          env: { ...process.env, TERM: 'xterm-256color', PS1: '\\[\\033[32m\\]\\w\\[\\033[0m\\]$ ', HISTFILE: '' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    } catch (e) {
      send({ type: 'error', data: e.message });
      ws.close();
      return;
    }

    const outBatch = createTextBatcher(
      (data) => send({ type: 'output', data }),
      { maxWait: 28, maxSize: 3072 },
    );
    proc.stdout.on('data', d => outBatch.push(d.toString()));
    proc.stderr.on('data', d => outBatch.push(d.toString()));
    proc.on('exit',  (code) => { outBatch.flush(); send({ type: 'exit', code }); ws.close(); });
    proc.on('error', (e)    => { outBatch.flush(); send({ type: 'error', data: e.message }); });

    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'input' && proc.stdin.writable) {
        proc.stdin.write(msg.data);
      } else if (msg.type === 'resize' && proc.stdin.writable && hasPython) {
        proc.stdin.write(`\x00resize:${msg.cols}:${msg.rows}`);
      }
    });

    ws.on('close', () => { outBatch.flush(); try { proc.kill('SIGHUP'); } catch {} });
    ws.on('error', e => console.error('[ws/shell]', e.message));
  });

  return { app, server };
}

// ─── Init (call before listen) ────────────────────────────────────────────────
export async function init() {
  await loadCreds();
  await bootstrapEnvUser();
  await syncConfigDirs();
  console.log(`[agents] enabled: ${ENABLED_AGENTS.join(', ')}`);
  console.log(`[agents] claude=${CLAUDE_CLI_PATH}  codex=${CODEX_CLI_PATH}  grok=${GROK_CLI_PATH}`);
}

// (session helpers live in ./agents/sessions.js)
