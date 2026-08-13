#!/usr/bin/env node
import { createApp, init } from './src/app.js';
import { WebSocket } from 'ws';
import os from 'os';
import crypto from 'crypto';

const GATEWAY_URL   = process.env.GATEWAY_URL;    // e.g. wss://your-server.com/machine-connect
const MACHINE_ID    = process.env.MACHINE_ID || os.hostname();
const MACHINE_TOKEN = process.env.MACHINE_TOKEN;  // shared secret with gateway
const LOCAL_PORT    = parseInt(process.env.LOCAL_PORT || '13000');

if (!GATEWAY_URL)    { console.error('GATEWAY_URL is required'); process.exit(1); }
if (!MACHINE_TOKEN)  { console.error('MACHINE_TOKEN is required'); process.exit(1); }

// ─── Start local app (only binds to 127.0.0.1) ───────────────────────────────
await init();
const { server } = createApp();
await new Promise(resolve => server.listen(LOCAL_PORT, '127.0.0.1', resolve));
console.log(`[client] Local app listening on 127.0.0.1:${LOCAL_PORT}`);

// ─── Active WS tunnels: tunnelId → local WebSocket ───────────────────────────
const tunnels = new Map();

// ─── Gateway connection ───────────────────────────────────────────────────────
let controlWs = null;
let reconnectDelay = 1000;

function sendControl(msg) {
  if (controlWs?.readyState === WebSocket.OPEN) {
    controlWs.send(JSON.stringify(msg));
  }
}

function connect() {
  console.log(`[client] Connecting to gateway ${GATEWAY_URL} ...`);
  controlWs = new WebSocket(GATEWAY_URL, {
    headers: { 'x-machine-token': MACHINE_TOKEN },
    perMessageDeflate: true,
  });

  controlWs.on('open', () => {
    reconnectDelay = 1000;
    console.log(`[client] Connected. Registering as "${MACHINE_ID}"`);
    sendControl({
      type: 'register',
      machineId: MACHINE_ID,
      meta: { hostname: os.hostname(), platform: os.platform() },
    });
  });

  controlWs.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── HTTP proxy ────────────────────────────────────────────────────────────
    if (msg.type === 'http-req') {
      try {
        const url = `http://127.0.0.1:${LOCAL_PORT}${msg.path}`;
        const res = await fetch(url, {
          method: msg.method,
          headers: { ...msg.headers, host: `127.0.0.1:${LOCAL_PORT}` },
          body: msg.body || undefined,
        });
        const headers = Object.fromEntries(res.headers.entries());
        const contentType = res.headers.get('content-type') || '';

        // SSE (and any other body-less-until-done response) is forwarded as
        // it arrives instead of buffered in full, so remote/hub viewers get
        // real-time streaming instead of one lump delivered at the end.
        if (contentType.includes('text/event-stream') && res.body) {
          sendControl({ type: 'http-res-start', reqId: msg.reqId, status: res.status, headers });
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            sendControl({ type: 'http-chunk', reqId: msg.reqId, data: decoder.decode(value, { stream: true }) });
          }
          // Flush a possibly incomplete UTF-8 code point held by TextDecoder
          // before terminating the stream (SSE payloads often contain Chinese).
          const tail = decoder.decode();
          if (tail) sendControl({ type: 'http-chunk', reqId: msg.reqId, data: tail });
          sendControl({ type: 'http-end', reqId: msg.reqId });
          return;
        }

        const body = await res.text();
        sendControl({
          type: 'http-res',
          reqId: msg.reqId,
          status: res.status,
          headers,
          body,
        });
      } catch (e) {
        sendControl({ type: 'http-res', reqId: msg.reqId, status: 502, headers: {}, body: e.message });
      }
      return;
    }

    // ── WS tunnel open ────────────────────────────────────────────────────────
    if (msg.type === 'ws-open') {
      const { tunnelId, path, query } = msg;
      const localUrl = `ws://127.0.0.1:${LOCAL_PORT}${path}${query || ''}`;
      const localWs  = new WebSocket(localUrl);

      localWs.on('open', () => {
        tunnels.set(tunnelId, localWs);
        sendControl({ type: 'ws-ready', tunnelId });
      });

      localWs.on('message', (data) => {
        sendControl({ type: 'ws-msg', tunnelId, data: data.toString() });
      });

      localWs.on('close', () => {
        tunnels.delete(tunnelId);
        sendControl({ type: 'ws-close', tunnelId });
      });

      localWs.on('error', (e) => {
        tunnels.delete(tunnelId);
        sendControl({ type: 'ws-error', tunnelId, message: e.message });
      });

      return;
    }

    // ── WS tunnel message (gateway → local) ───────────────────────────────────
    if (msg.type === 'ws-msg') {
      const localWs = tunnels.get(msg.tunnelId);
      if (localWs?.readyState === WebSocket.OPEN) localWs.send(msg.data);
      return;
    }

    // ── WS tunnel close (gateway side closed) ─────────────────────────────────
    if (msg.type === 'ws-close') {
      const localWs = tunnels.get(msg.tunnelId);
      tunnels.delete(msg.tunnelId);
      if (localWs?.readyState === WebSocket.OPEN) localWs.close();
      return;
    }

    if (msg.type === 'ping') {
      sendControl({ type: 'pong' });
    }
  });

  controlWs.on('close', () => {
    console.log(`[client] Disconnected. Reconnecting in ${reconnectDelay}ms ...`);
    // Close all open tunnels
    for (const localWs of tunnels.values()) {
      try { localWs.close(); } catch {}
    }
    tunnels.clear();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });

  controlWs.on('error', e => console.error('[client] WS error:', e.message));
}

connect();
