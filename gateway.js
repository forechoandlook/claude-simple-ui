#!/usr/bin/env node
/**
 * gateway.js — public-facing relay server
 *
 * Machines (client.js) connect via WS to /machine-connect and register themselves.
 * Browser users visit the gateway, pick a machine, and all traffic is forwarded
 * transparently through the machine's control WebSocket.
 *
 * Control channel message protocol (gateway ↔ client):
 *
 *   register:   client → gateway   { type:'register', machineId, meta }
 *   ping/pong:  gateway ↔ client   { type:'ping' } / { type:'pong' }
 *
 *   HTTP proxy:
 *     gateway → client  { type:'http-req', reqId, method, path, headers, body }
 *     client → gateway  { type:'http-res', reqId, status, headers, body }
 *
 *   WS tunnel:
 *     gateway → client  { type:'ws-open',  tunnelId, path, query }
 *     client → gateway  { type:'ws-ready', tunnelId }
 *     client → gateway  { type:'ws-error', tunnelId, message }
 *     gateway ↔ client  { type:'ws-msg',   tunnelId, data }
 *     gateway ↔ client  { type:'ws-close', tunnelId }
 */

import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

const PORT         = parseInt(process.env.GATEWAY_PORT || '8080');
const MACHINE_TOKEN = process.env.MACHINE_TOKEN; // shared secret all clients must send
if (!MACHINE_TOKEN) { console.error('MACHINE_TOKEN is required'); process.exit(1); }

// ─── Machine registry ─────────────────────────────────────────────────────────
// machineId → { ws, meta, connectedAt, lastPong }
const machines = new Map();

// Pending HTTP responses: reqId → { resolve, reject, timer }
const pendingHttp = new Map();

// Pending WS tunnel handshakes: tunnelId → { resolve, reject, timer }
const pendingTunnels = new Map();

// Active WS tunnels: tunnelId → browser WebSocket
const activeTunnels = new Map();

function getMachine(machineId) {
  const m = machines.get(machineId);
  if (!m || m.ws.readyState !== WebSocket.OPEN) return null;
  return m;
}

function sendToMachine(machineId, msg) {
  const m = getMachine(machineId);
  if (!m) throw new Error(`Machine "${machineId}" not connected`);
  m.ws.send(JSON.stringify(msg));
}

// ─── HTTP forwarding ──────────────────────────────────────────────────────────
function forwardHttp(machineId, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const reqId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingHttp.delete(reqId);
      reject(new Error('Machine request timed out'));
    }, 30_000);
    pendingHttp.set(reqId, { resolve, reject, timer });
    try {
      sendToMachine(machineId, { type: 'http-req', reqId, method, path, headers, body });
    } catch (e) {
      clearTimeout(timer);
      pendingHttp.delete(reqId);
      reject(e);
    }
  });
}

// ─── WS tunnel handshake ──────────────────────────────────────────────────────
function openTunnel(machineId, tunnelId, path, query) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTunnels.delete(tunnelId);
      reject(new Error('Tunnel open timed out'));
    }, 10_000);
    pendingTunnels.set(tunnelId, { resolve, reject, timer });
    try {
      sendToMachine(machineId, { type: 'ws-open', tunnelId, path, query });
    } catch (e) {
      clearTimeout(timer);
      pendingTunnels.delete(tunnelId);
      reject(e);
    }
  });
}

// ─── Handle messages from a machine's control WS ─────────────────────────────
function handleMachineMessage(msg) {
  if (msg.type === 'pong') return;

  if (msg.type === 'http-res') {
    const pending = pendingHttp.get(msg.reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingHttp.delete(msg.reqId);
    pending.resolve(msg);
    return;
  }

  if (msg.type === 'ws-ready') {
    const pending = pendingTunnels.get(msg.tunnelId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingTunnels.delete(msg.tunnelId);
    pending.resolve();
    return;
  }

  if (msg.type === 'ws-error') {
    const pending = pendingTunnels.get(msg.tunnelId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingTunnels.delete(msg.tunnelId);
      pending.reject(new Error(msg.message || 'Tunnel error'));
    }
    return;
  }

  if (msg.type === 'ws-msg') {
    const browserWs = activeTunnels.get(msg.tunnelId);
    if (browserWs?.readyState === WebSocket.OPEN) {
      browserWs.send(msg.data);
    }
    return;
  }

  if (msg.type === 'ws-close') {
    const browserWs = activeTunnels.get(msg.tunnelId);
    activeTunnels.delete(msg.tunnelId);
    if (browserWs?.readyState === WebSocket.OPEN) browserWs.close();
    return;
  }
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
// Large enough for base64 file previews (office/pdf ≤15MB → ~20MB JSON)
app.use(express.json({ limit: '25mb' }));

// Machine list API (used by the frontend picker)
app.get('/api/machines', (req, res) => {
  const list = [...machines.entries()].map(([id, m]) => ({
    id,
    ...m.meta,
    connectedAt: m.connectedAt,
    online: m.ws.readyState === WebSocket.OPEN,
  }));
  res.json(list);
});

// Machine picker page — minimal HTML, loads the real UI from the selected machine
app.get('/', (req, res) => {
  if (req.query.machine) {
    // Redirect into the machine's proxied app
    return res.redirect(`/machine/${req.query.machine}/`);
  }
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Select machine</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 16px; }
    h1 { font-size: 1.2rem; margin-bottom: 24px; }
    .machine { display:flex; justify-content:space-between; align-items:center;
               border:1px solid #ddd; border-radius:8px; padding:12px 16px; margin-bottom:12px; }
    .machine a { text-decoration:none; font-weight:600; color:#0070f3; }
    .dot { width:8px; height:8px; border-radius:50%; background:#22c55e; }
    .dot.offline { background:#ef4444; }
    #empty { color:#888; }
  </style>
</head>
<body>
  <h1>Choose a machine</h1>
  <div id="list"><p id="empty">Loading...</p></div>
  <script>
    async function load() {
      const res = await fetch('/api/machines');
      const machines = await res.json();
      const el = document.getElementById('list');
      if (!machines.length) { el.innerHTML = '<p id="empty">No machines connected.</p>'; return; }
      el.innerHTML = machines.map(m => \`
        <div class="machine">
          <a href="/machine/\${m.id}/">\${m.id}</a>
          <span>\${m.hostname || ''} · \${m.platform || ''}</span>
          <span class="dot \${m.online ? '' : 'offline'}"></span>
        </div>
      \`).join('');
    }
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>`);
});

// ─── HTTP proxy: /machine/:id/* ───────────────────────────────────────────────
app.all('/machine/:machineId/*', async (req, res) => {
  const { machineId } = req.params;
  if (!getMachine(machineId)) {
    return res.status(503).json({ error: `Machine "${machineId}" not connected` });
  }

  // Strip /machine/:id prefix so the machine sees its own paths
  const path = req.path.replace(`/machine/${machineId}`, '') || '/';
  const qs   = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

  // Pass body as string for JSON; raw otherwise
  const body = req.method !== 'GET' && req.method !== 'HEAD'
    ? JSON.stringify(req.body)
    : undefined;

  try {
    const result = await forwardHttp(machineId, req.method, path + qs, {
      ...req.headers,
      host: 'localhost',
    }, body);

    // Don't forward hop-by-hop headers
    const skip = new Set(['transfer-encoding', 'connection', 'keep-alive']);
    Object.entries(result.headers || {}).forEach(([k, v]) => {
      if (!skip.has(k.toLowerCase())) res.setHeader(k, v);
    });
    res.status(result.status).send(result.body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
const server = http.createServer(app);

// Two WS servers — one for machines registering, one for browser tunnels
const wssMachines = new WebSocketServer({ noServer: true });
const wssBrowser  = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url      = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/machine-connect') {
    wssMachines.handleUpgrade(req, socket, head, ws => wssMachines.emit('connection', ws, req));
    return;
  }

  // /machine/:id/ws/chat or /machine/:id/ws/shell
  const m = pathname.match(/^\/machine\/([^/]+)(\/ws\/.+)$/);
  if (m) {
    wssBrowser.handleUpgrade(req, socket, head, ws => wssBrowser.emit('connection', ws, req, m[1], m[2]));
    return;
  }

  socket.destroy();
});

// ─── Machine control connections ──────────────────────────────────────────────
wssMachines.on('connection', (ws, req) => {
  // Verify shared token
  const token = req.headers['x-machine-token'];
  if (token !== MACHINE_TOKEN) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  let machineId = null;

  // Heartbeat
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 30_000);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'register') {
      machineId = msg.machineId;
      machines.set(machineId, { ws, meta: msg.meta || {}, connectedAt: Date.now() });
      console.log(`[gateway] Machine registered: ${machineId}`);
      return;
    }

    handleMachineMessage(msg);
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    if (machineId) {
      machines.delete(machineId);
      console.log(`[gateway] Machine disconnected: ${machineId}`);
    }
  });

  ws.on('error', e => console.error('[gateway] machine ws error:', e.message));
});

// ─── Browser WS tunnel connections ───────────────────────────────────────────
wssBrowser.on('connection', async (browserWs, req, machineId, wsPath) => {
  const url      = new URL(req.url, 'http://localhost');
  const query    = url.search; // e.g. ?token=xxx
  const tunnelId = crypto.randomUUID();

  if (!getMachine(machineId)) {
    browserWs.close(1011, 'Machine not connected');
    return;
  }

  try {
    await openTunnel(machineId, tunnelId, wsPath, query);
  } catch (e) {
    console.error(`[gateway] Tunnel open failed: ${e.message}`);
    browserWs.close(1011, 'Tunnel failed');
    return;
  }

  activeTunnels.set(tunnelId, browserWs);

  browserWs.on('message', raw => {
    const m = getMachine(machineId);
    if (!m) return;
    m.ws.send(JSON.stringify({ type: 'ws-msg', tunnelId, data: raw.toString() }));
  });

  browserWs.on('close', () => {
    activeTunnels.delete(tunnelId);
    const m = getMachine(machineId);
    if (m) m.ws.send(JSON.stringify({ type: 'ws-close', tunnelId }));
  });

  browserWs.on('error', e => console.error('[gateway] browser ws error:', e.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  Gateway running at http://localhost:${PORT}`);
  console.log(`  Waiting for machines to connect at ws://localhost:${PORT}/machine-connect\n`);
});
