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
import { fileURLToPath } from 'url';
import { runClaude } from './agents/claude.js';
import { runCodex } from './agents/codex.js';
import { runGrok } from './agents/grok.js';
import {
  scanAllSessions,
  loadSessionMessages,
  loadSessionMemory,
  loadSessionUsage,
  searchActivity,
  groupByProject,
  toClientSession,
} from './agents/sessions.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// ─── Config ──────────────────────────────────────────────────────────────────
export const PORT = parseInt(process.env.PORT || '3000');
const CREDENTIALS_FILE  = process.env.CREDENTIALS_FILE  || path.join(rootDir, '.credentials.json');
const WORKSPACES_FILE   = process.env.WORKSPACES_FILE   || path.join(rootDir, '.workspaces.json');
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
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  let token = header && header.split(' ')[1];
  if (!token && req.query.token) token = req.query.token;
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
  const s = activeSessions.get(sessionId);
  if (!s) return false;
  if (s.controller) s.controller.abort();
  if (typeof s.abort === 'function') s.abort();
  else if (s.child) {
    try { s.child.kill('SIGTERM'); } catch {}
  }
  return true;
}

// ─── App factory ──────────────────────────────────────────────────────────────
export function createApp() {
  const app = express();

  app.post('/api/upload-image', authMiddleware, (req, res) => {
    (async () => {
      const ext  = (req.headers['x-filename'] || 'image.png').split('.').pop().replace(/[^a-z0-9]/gi, '') || 'png';
      const name = `claude-upload-${Date.now()}.${ext}`;
      const dest = path.join(os.tmpdir(), name);
      const writer = fsSync.createWriteStream(dest);
      req.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        req.on('error', reject);
      });
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
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        return fsSync.createReadStream(filePath).pipe(res);
      }
      if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'File too large (>2MB)' });
      const content = await fs.readFile(filePath, 'utf8');
      res.json({ content, size: stat.size });
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
    res.json({
      enabled: ENABLED_AGENTS,
      defaults: {
        claude: { model: 'claude-sonnet-4-5', models: ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-haiku-4-5'] },
        codex:  { model: 'gpt-5.4', models: ['gpt-5.4', 'gpt-5.3', 'gpt-5.2', 'o3', 'o4-mini', 'codex-mini-latest'] },
        grok:   { model: 'grok-4.5', models: ['grok-4.5', 'grok-4', 'grok-3', 'grok-3-mini'] },
      },
      paths: {
        claude: CLAUDE_CLI_PATH,
        codex: CODEX_CLI_PATH,
        grok: GROK_CLI_PATH,
      },
    });
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
      const sessions = await listSessions(filterCwd || null, agent);
      res.json(sessions.map(toClientSession));
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
      const opts = {
        claudeConfigDirs: CLAUDE_CONFIG_DIRS,
        codexHome: CODEX_HOME,
        grokHome: GROK_HOME,
      };
      // Try preferred agent first, then fall back across all agents (stale cache / missing ?agent=)
      const order = [...new Set([preferred, ...ENABLED_AGENTS, 'claude', 'codex', 'grok'].filter(Boolean))];
      let bundle = null;
      for (const a of order) {
        bundle = await loadSessionMessages(sessionId, a, opts);
        if (bundle) break;
      }
      if (!bundle) return res.status(404).json({ error: 'Session not found' });
      // Normalize: always { messages, context, agent }
      const payload = Array.isArray(bundle)
        ? { messages: bundle, context: null, agent: preferred || 'claude' }
        : {
            messages: bundle.messages || [],
            context: bundle.context || null,
            agent: bundle.agent || preferred || 'claude',
          };
      res.setHeader('X-Session-Agent', payload.agent);
      res.json(payload);
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
      const order = [...new Set([preferred, ...ENABLED_AGENTS, 'claude', 'codex', 'grok'].filter(Boolean))];
      let memory = null;
      for (const a of order) {
        memory = await loadSessionMemory(sessionId, a, opts);
        if (memory) break;
      }
      // Memory is Claude-centric; return empty instead of 404 so the tab doesn't hard-fail
      res.json(memory || { index: null, files: [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
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

  // ─── HTTP + WebSocket server ─────────────────────────────────────────────────
  const server = http.createServer(app);
  const wssChat  = new WebSocketServer({ noServer: true });
  const wssShell = new WebSocketServer({ noServer: true });

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
    const decoded = verifyToken(token);
    if (!decoded) {
      ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      ws.close(1008, 'Unauthorized');
      return;
    }

    const send = (data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
    };

    let shellProc = null;

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

      if (msg.type === 'claude-command' || msg.type === 'agent-command') {
        const agent = msg.agent || msg.options?.agent || 'claude';
        await dispatchAgent(agent, msg.command || '', msg.options || {}, send);
      } else if (msg.type === 'shell-command') {
        if (shellProc) { try { shellProc.kill(); } catch {} shellProc = null; }
        const cmd = msg.command || '';
        const cwd = msg.cwd || os.homedir();
        send({ type: 'shell-start', command: cmd });
        shellProc = spawn(process.env.SHELL || 'bash', ['-c', cmd], {
          cwd,
          env: { ...process.env },
          shell: false,
        });
        shellProc.stdout.on('data', d => send({ type: 'shell-output', stream: 'stdout', data: d.toString() }));
        shellProc.stderr.on('data', d => send({ type: 'shell-output', stream: 'stderr', data: d.toString() }));
        shellProc.on('close', (code) => { send({ type: 'shell-exit', code }); shellProc = null; });
        shellProc.on('error', (e) => { send({ type: 'shell-exit', code: 1, error: e.message }); shellProc = null; });
      } else if (msg.type === 'abort-session') {
        const ok = abortSession(msg.sessionId);
        send({ type: 'abort-result', success: ok, sessionId: msg.sessionId });
      }
    });

    ws.on('close', () => { if (shellProc) { try { shellProc.kill(); } catch {} } });
    ws.on('error', (e) => console.error('[ws]', e.message));
  });

  wssShell.on('connection', (ws, req) => {
    const url     = new URL(req.url, 'http://localhost');
    const token   = url.searchParams.get('token');
    const decoded = verifyToken(token);
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

    proc.stdout.on('data', d => send({ type: 'output', data: d.toString() }));
    proc.stderr.on('data', d => send({ type: 'output', data: d.toString() }));
    proc.on('exit',  (code) => { send({ type: 'exit', code }); ws.close(); });
    proc.on('error', (e)    => { send({ type: 'error', data: e.message }); });

    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'input' && proc.stdin.writable) {
        proc.stdin.write(msg.data);
      } else if (msg.type === 'resize' && proc.stdin.writable && hasPython) {
        proc.stdin.write(`\x00resize:${msg.cols}:${msg.rows}`);
      }
    });

    ws.on('close', () => { try { proc.kill('SIGHUP'); } catch {} });
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
