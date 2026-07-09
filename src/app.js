import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import readline from 'readline';
import path from 'path';
import os from 'os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// ─── Config ──────────────────────────────────────────────────────────────────
export const PORT = parseInt(process.env.PORT || '3000');
const CREDENTIALS_FILE  = process.env.CREDENTIALS_FILE  || path.join(rootDir, '.credentials.json');
const WORKSPACES_FILE   = process.env.WORKSPACES_FILE   || path.join(rootDir, '.workspaces.json');
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || 'claude';
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

// ─── Claude session scanning ──────────────────────────────────────────────────
async function loadHistoryNames() {
  const map = new Map();
  await Promise.all(CLAUDE_CONFIG_DIRS.map(async dir => {
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

async function readSessionMeta(filePath) {
  let sessionId = null;
  let cwd = null;
  try {
    const stream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const d = JSON.parse(line);
        if (!sessionId && d.sessionId) sessionId = d.sessionId;
        if (!cwd && d.cwd) cwd = d.cwd;
        if (sessionId && cwd) { rl.close(); stream.destroy(); break; }
      } catch {}
    }
  } catch {}
  return { sessionId, cwd };
}

async function readSessionFirstMessage(filePath) {
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

async function scanConfigDir(configDir, nameMap, filterCwd) {
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
        const [stat, meta] = await Promise.all([fs.stat(filePath), readSessionMeta(filePath)]);
        if (filterCwd && meta.cwd !== filterCwd) return;
        const sessionId = meta.sessionId || fileEntry.name.replace('.jsonl', '');
        const firstMsg = await readSessionFirstMessage(filePath);
        sessions.push({
          sessionId,
          cwd:        meta.cwd || null,
          configDir,
          display:    nameMap.get(sessionId) || firstMsg || 'Session',
          updatedAt:  stat.mtimeMs,
          hasMemory,
        });
      } catch {}
    }));
  }));
  return sessions;
}

async function scanAllSessions(filterCwd = null) {
  const nameMap = await loadHistoryNames();
  const results = await Promise.all(CLAUDE_CONFIG_DIRS.map(d => scanConfigDir(d, nameMap, filterCwd)));
  const seen = new Set();
  const sessions = results.flat().filter(s => {
    if (seen.has(s.sessionId)) return false;
    seen.add(s.sessionId); return true;
  });
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ─── Claude SDK sessions ──────────────────────────────────────────────────────
const activeSessions = new Map();

function mapOptions(options = {}) {
  const env = { ...process.env };
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir;
  const opts = {
    env,
    pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
    tools: { type: 'preset', preset: 'claude_code' },
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user', 'local'],
    model: options.model || 'claude-sonnet-4-5',
  };
  if (options.cwd)       opts.cwd    = options.cwd;
  if (options.sessionId) opts.resume = options.sessionId;
  if (options.effort)    opts.effort = options.effort;
  if (options.permissionMode && options.permissionMode !== 'default') {
    opts.permissionMode = options.permissionMode;
  }
  if (options.allowDangerouslySkipPermissions) {
    opts.allowDangerouslySkipPermissions = true;
  }
  if (options.allowedTools?.length) opts.allowedTools = options.allowedTools;
  return opts;
}

async function runClaude(command, options, send) {
  const sessionKey = options.sessionId || crypto.randomUUID();
  const controller = new AbortController();

  activeSessions.set(sessionKey, { controller, startTime: Date.now() });

  const sdkOptions = mapOptions(options);
  sdkOptions.abortSignal = controller.signal;

  let capturedSessionId = null;

  try {
    const stream = query({
      prompt: command,
      options: sdkOptions,
    });

    for await (const msg of stream) {
      if (msg.type === 'system' && msg.session_id && !capturedSessionId) {
        capturedSessionId = msg.session_id;
        send({ type: 'session-created', sessionId: capturedSessionId });
      }
      send(msg);
    }

    send({ type: 'complete', exitCode: 0, sessionId: capturedSessionId || sessionKey });
  } catch (err) {
    if (err.name === 'AbortError') {
      send({ type: 'complete', exitCode: 130, aborted: true, sessionId: capturedSessionId || sessionKey });
    } else {
      send({ type: 'error', message: err.message });
    }
  } finally {
    activeSessions.delete(sessionKey);
  }
}

function abortSession(sessionId) {
  const s = activeSessions.get(sessionId);
  if (!s) return false;
  s.controller.abort();
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
  const usesDist  = fsSync.existsSync(distDir) && process.env.NODE_ENV !== 'development';
  app.use(express.static(usesDist ? distDir : publicDir));

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

  app.get('/api/sessions', authMiddleware, async (req, res) => {
    try {
      const filterCwd = typeof req.query.cwd === 'string' ? req.query.cwd : null;
      const sessions = await scanAllSessions(filterCwd || null);
      res.json(sessions);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/sessions/:sessionId/messages', authMiddleware, async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!/^[0-9a-f-]{36}$/.test(sessionId)) return res.status(400).json({ error: 'Invalid session id' });
      const filePath = await findSessionFile(sessionId);
      if (!filePath) return res.status(404).json({ error: 'Session not found' });
      const messages = await parseSessionMessages(filePath);
      res.json(messages);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/sessions/:sessionId/memory', authMiddleware, async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!/^[0-9a-f-]{36}$/.test(sessionId)) return res.status(400).json({ error: 'Invalid session id' });
      const filePath = await findSessionFile(sessionId);
      if (!filePath) return res.status(404).json({ error: 'Session not found' });
      const memory = await readProjectMemory(path.dirname(filePath));
      res.json(memory);
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

      if (msg.type === 'claude-command') {
        await runClaude(msg.command || '', msg.options || {}, send);
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
    try {
      proc = spawn('bash', ['--norc', '--noprofile'], {
        cwd: fsSync.existsSync(cwd) ? cwd : os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color', PS1: '\\[\\033[32m\\]\\w\\[\\033[0m\\]$ ', HISTFILE: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
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
      if (msg.type === 'input' && proc.stdin.writable) proc.stdin.write(msg.data);
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
}

// ─── Helpers used by routes (defined after their deps) ────────────────────────
async function findSessionFile(sessionId) {
  for (const configDir of CLAUDE_CONFIG_DIRS) {
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

// Read the persistent memory that lives alongside a session's project dir:
//   <projectDir>/MEMORY.md         — the one-line-per-memory index
//   <projectDir>/memory/*.md       — one fact per file
async function readProjectMemory(projectDir) {
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

const INTERNAL_PREFIXES = ['<command-', '<local-command', '<system-reminder', 'Caveat:', 'This session is being continued', '[Request interrupted'];

function isInternal(text) {
  return INTERNAL_PREFIXES.some(p => text.startsWith(p));
}

async function parseSessionMessages(filePath) {
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
          pendingUsage.input_tokens               += u.input_tokens               ?? 0;
          pendingUsage.output_tokens              += u.output_tokens              ?? 0;
          pendingUsage.cache_creation_input_tokens+= u.cache_creation_input_tokens?? 0;
          pendingUsage.cache_read_input_tokens    += u.cache_read_input_tokens    ?? 0;
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
