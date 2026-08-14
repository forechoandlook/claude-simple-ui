#!/usr/bin/env node
import { createApp, init, hasBusyAgent } from './src/app.js';
import { startAutoUpdate } from './src/auto-update.js';
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

// Self-update from npm (default every 12h). Disable with AUTO_UPDATE=0.
// Requires global install + systemd Restart= (or equivalent) for full apply.
startAutoUpdate({ role: 'edge-client', isBusy: hasBusyAgent });

// ─── Active WS tunnels: tunnelId → local WebSocket ───────────────────────────
const tunnels = new Map();

// ─── Gateway connection ───────────────────────────────────────────────────────
let controlWs = null;
let reconnectDelay = 1000;

/** Drop hop-by-hop / encoding headers so hub clients see the decoded body. */
function sanitizeProxyHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (
      lk === 'content-encoding'
      || lk === 'content-length'
      || lk === 'transfer-encoding'
      || lk === 'connection'
      || lk === 'keep-alive'
      || lk === 'proxy-authenticate'
      || lk === 'proxy-authorization'
      || lk === 'te'
      || lk === 'trailer'
      || lk === 'upgrade'
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

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
        // Node fetch auto-decompresses gzip/br. If we forward Content-Encoding
        // with the already-plain body, browsers try to gunzip JSON and fail
        // (chat history / large API payloads look "empty" or parse-error).
        const reqHeaders = { ...(msg.headers || {}), host: `127.0.0.1:${LOCAL_PORT}` };
        delete reqHeaders['accept-encoding'];
        delete reqHeaders['Accept-Encoding'];
        reqHeaders['Accept-Encoding'] = 'identity';

        // Hub may send binary request bodies as base64 (image/file uploads).
        // Without decoding, Node fetch would write the base64 text to disk.
        let reqBody = msg.body || undefined;
        if (reqBody != null && reqBody !== '' && String(msg.encoding || '').toLowerCase() === 'base64') {
          reqBody = Buffer.from(reqBody, 'base64');
        }
        const res = await fetch(url, {
          method: msg.method,
          headers: reqHeaders,
          body: reqBody,
        });
        const headers = sanitizeProxyHeaders(Object.fromEntries(res.headers.entries()));
        const contentType = res.headers.get('content-type') || '';
        const contentDisp = res.headers.get('content-disposition') || '';

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

        // Binary responses (file downloads, images, …) must NOT go through
        // res.text() — UTF-8 decoding corrupts bytes and downloads break on hub.
        const isBinary =
          /attachment/i.test(contentDisp)
          || /^(application\/octet-stream|application\/pdf|application\/zip|application\/gzip|application\/x-|application\/vnd\.|image\/|audio\/|video\/|font\/)/i.test(contentType)
          || (contentType !== '' && !/^(text\/|application\/(json|javascript|xml|problem\+json|x-www-form-urlencoded)|multipart\/)/i.test(contentType));

        if (isBinary) {
          const buf = Buffer.from(await res.arrayBuffer());
          headers['content-length'] = String(buf.length);
          sendControl({
            type: 'http-res',
            reqId: msg.reqId,
            status: res.status,
            headers,
            body: buf.toString('base64'),
            encoding: 'base64',
          });
          return;
        }

        const body = await res.text();
        // Body is always decoded text here — length must match UTF-8 bytes.
        headers['content-length'] = String(Buffer.byteLength(body));
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
