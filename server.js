#!/usr/bin/env node
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

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || path.join(os.homedir(), 'projects');
const CREDENTIALS_FILE = process.env.CREDENTIALS_FILE || path.join(__dirname, '.credentials.json');
const CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || 'claude';
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// ─── Auth storage (file-based, no SQLite) ────────────────────────────────────
let credStore = null;

async function loadCreds() {
  if (credStore) return credStore;
  try {
    const data = await fs.readFile(CREDENTIALS_FILE, 'utf8');
    credStore = JSON.parse(data);
  } catch {
    credStore = { users: [] };
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

function makeToken(user) {
  return jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// If AUTH_USERNAME + AUTH_PASSWORD env vars set, bootstrap a user on startup
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

// Resolve the project root from a request.
// Accepts ?root=/abs/path (for external projects) or falls back to WORKSPACES_ROOT/:id.
function resolveProjectRoot(req) {
  const root = req.query.root;
  if (root) {
    const resolved = path.resolve(root);
    if (!path.isAbsolute(resolved) || resolved === '/' || resolved.includes('\0'))
      throw new Error('Invalid root path');
    return resolved;
  }
  return safePath(WORKSPACES_ROOT, req.params.id);
}

async function ensureWorkspacesRoot() {
  await fs.mkdir(WORKSPACES_ROOT, { recursive: true });
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

// Read history.jsonl → sessionId → display name map
async function loadHistoryNames() {
  const histPath = path.join(CLAUDE_CONFIG_DIR, 'history.jsonl');
  const map = new Map();
  try {
    const stream = fsSync.createReadStream(histPath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const d = JSON.parse(line);
        if (d.sessionId && d.display) map.set(d.sessionId, d.display);
      } catch {}
    }
  } catch {}
  return map;
}

// Read sessionId + cwd from first few lines of a JSONL session file
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

// Read first meaningful user text from a JSONL session file
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

// Scan ALL sessions from ~/.claude/projects/
// Returns every session with its actual cwd so the client can resume to the right directory.
async function scanAllSessions(filterCwd = null) {
  const projectsDir = path.join(CLAUDE_CONFIG_DIR, 'projects');
  const nameMap = await loadHistoryNames();
  const sessions = [];

  let projectDirs;
  try {
    projectDirs = (await fs.readdir(projectsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory());
  } catch { return []; }

  await Promise.all(projectDirs.map(async (dirEntry) => {
    const projectDir = path.join(projectsDir, dirEntry.name);
    let entries;
    try { entries = await fs.readdir(projectDir, { withFileTypes: true }); }
    catch { return; }

    const jsonlFiles = entries.filter(e =>
      e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('agent-')
    );

    await Promise.all(jsonlFiles.map(async (fileEntry) => {
      const filePath = path.join(projectDir, fileEntry.name);
      try {
        const [stat, meta] = await Promise.all([fs.stat(filePath), readSessionMeta(filePath)]);
        // Skip if filtering by cwd and it doesn't match
        if (filterCwd && meta.cwd !== filterCwd) return;

        const sessionId = meta.sessionId || fileEntry.name.replace('.jsonl', '');
        const firstMsg = await readSessionFirstMessage(filePath);
        sessions.push({
          sessionId,
          cwd: meta.cwd || null,
          projectName: meta.cwd ? path.basename(meta.cwd) : dirEntry.name,
          display: nameMap.get(sessionId) || firstMsg || 'Session',
          updatedAt: stat.mtimeMs,
        });
      } catch {}
    }));
  }));

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ─── Claude SDK sessions ──────────────────────────────────────────────────────
const activeSessions = new Map();

function mapOptions(options = {}) {
  const opts = {
    env: { ...process.env },
    pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
    tools: { type: 'preset', preset: 'claude_code' },
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user', 'local'],
    model: options.model || 'claude-sonnet-4-5',
  };
  if (options.cwd) opts.cwd = options.cwd;
  if (options.sessionId) opts.resume = options.sessionId;
  if (options.permissionMode && options.permissionMode !== 'default') {
    opts.permissionMode = options.permissionMode;
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

      // Forward all messages to client
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

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Auth routes
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

// Projects routes
app.get('/api/projects', authMiddleware, async (_req, res) => {
  try {
    await ensureWorkspacesRoot();
    const entries = await fs.readdir(WORKSPACES_ROOT, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter(e => e.isDirectory())
        .map(async e => {
          const fullPath = path.join(WORKSPACES_ROOT, e.name);
          const git = await isGitRepo(fullPath);
          return { id: e.name, name: e.name, path: fullPath, isGit: git };
        })
    );
    res.json(projects);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name))
      return res.status(400).json({ error: 'Invalid project name (alphanumeric, -, _, . only)' });
    await ensureWorkspacesRoot();
    const dir = path.join(WORKSPACES_ROOT, name);
    await fs.mkdir(dir, { recursive: true });
    res.json({ id: name, name, path: dir, isGit: false });
  } catch (e) {
    if (e.code === 'EEXIST') return res.status(409).json({ error: 'Project already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Files routes
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
    if (stat.size > 1024 * 1024) return res.status(413).json({ error: 'File too large (>1MB)' });
    const content = await fs.readFile(filePath, 'utf8');
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Git routes
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

// Sessions: global list (all ~/.claude/projects/) with optional ?cwd= filter
app.get('/api/sessions', authMiddleware, async (req, res) => {
  try {
    const filterCwd = typeof req.query.cwd === 'string' ? req.query.cwd : null;
    const sessions = await scanAllSessions(filterCwd || null);
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Find JSONL file path for a given sessionId by scanning all project dirs
async function findSessionFile(sessionId) {
  const projectsDir = path.join(CLAUDE_CONFIG_DIR, 'projects');
  let projectDirs;
  try { projectDirs = await fs.readdir(projectsDir); }
  catch { return null; }

  for (const dir of projectDirs) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    try { await fs.access(candidate); return candidate; }
    catch {}
  }
  return null;
}

const INTERNAL_PREFIXES = ['<command-', '<local-command', '<system-reminder', 'Caveat:', 'This session is being continued', '[Request interrupted'];

function isInternal(text) {
  return INTERNAL_PREFIXES.some(p => text.startsWith(p));
}

// Parse a session JSONL and return simplified messages for display
async function parseSessionMessages(filePath) {
  const messages = [];
  try {
    const stream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }

      // User message
      if (d.type === 'user' && Array.isArray(d.message?.content)) {
        for (const part of d.message.content) {
          if (part.type === 'text' && part.text?.trim() && !isInternal(part.text.trim())) {
            messages.push({ role: 'user', type: 'text', content: part.text.trim(), ts: d.timestamp });
          }
        }
        continue;
      }

      // Assistant message
      if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
        for (const part of d.message.content) {
          if (part.type === 'text' && part.text?.trim()) {
            messages.push({ role: 'assistant', type: 'text', content: part.text.trim(), ts: d.timestamp });
          } else if (part.type === 'tool_use') {
            messages.push({ role: 'tool', type: 'tool_use', name: part.name, input: part.input ?? {}, ts: d.timestamp });
          }
        }
      }
    }
  } catch {}
  return messages;
}

// Session history messages
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

app.get('/api/projects/:id/git/log', authMiddleware, async (req, res) => {
  try {
    const projectPath = resolveProjectRoot(req);
    if (!(await isGitRepo(projectPath))) return res.json({ commits: [] });
    const out = await git(['log', '--oneline', '-20'], projectPath).catch(() => '');
    const commits = out.trim().split('\n').filter(Boolean).map(line => ({
      hash: line.slice(0, 7),
      message: line.slice(8),
    }));
    res.json({ commits });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/chat' });

wss.on('connection', (ws, req) => {
  // Extract token from query or first message
  const url = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get('token');
  const decoded = verifyToken(token);
  if (!decoded) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    ws.close(1008, 'Unauthorized');
    return;
  }

  const send = (data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data));
    }
  };

  let shellProc = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    if (msg.type === 'claude-command') {
      await runClaude(msg.command || '', msg.options || {}, send);

    } else if (msg.type === 'shell-command') {
      // Kill any previous shell process
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
      shellProc.on('close', (code) => {
        send({ type: 'shell-exit', code });
        shellProc = null;
      });
      shellProc.on('error', (e) => {
        send({ type: 'shell-exit', code: 1, error: e.message });
        shellProc = null;
      });

    } else if (msg.type === 'abort-session') {
      const ok = abortSession(msg.sessionId);
      send({ type: 'abort-result', success: ok, sessionId: msg.sessionId });
    }
  });

  ws.on('close', () => {
    if (shellProc) { try { shellProc.kill(); } catch {} }
  });

  ws.on('error', (e) => console.error('[ws]', e.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────
await bootstrapEnvUser();
await ensureWorkspacesRoot();

server.listen(PORT, () => {
  console.log(`\n  Claude Simple UI running at http://localhost:${PORT}\n`);
  console.log(`  WORKSPACES_ROOT: ${WORKSPACES_ROOT}`);
  console.log(`  CREDENTIALS_FILE: ${CREDENTIALS_FILE}`);
  if (process.env.AUTH_USERNAME) console.log(`  Auth: env user "${process.env.AUTH_USERNAME}"`);
  console.log();
});
