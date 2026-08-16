// api.js — HTTP + WebSocket helpers
import { ctx, hubMode, selectedMachineId } from './state.js';
import { createFetch } from './lib.js';

// Only coalesce identical in-flight reads.  Data is deliberately not retained
// here: session and workspace freshness remain controlled by their existing
// IndexedDB cache, while other API reads keep their previous always-fresh
// behavior.
const pendingGets = createFetch({ cache: false, dedupe: true, retry: 0 });
/** Path → ETag for conditional GETs (304 = free on mobile radio). */
const etagStore = new Map();
export const NOT_MODIFIED = Symbol('not-modified');

/** Active edge machine id (hub). */
export function currentMachineId(opts = {}) {
  if (opts.machineId !== undefined) return opts.machineId;
  return ctx.machineId || selectedMachineId.peek() || null;
}

/** Hub endpoints that must NOT be proxied to an edge. */
function isHubOnlyPath(path) {
  const p = path.split('?')[0];
  return p === '/api/hub'
    || p === '/api/machines'
    || p === '/api/notifications'
    || p === '/api/notifications/read'
    || p === '/api/ai/notes'
    || p.startsWith('/api/ai/notes/')
    || p.startsWith('/api/auth/');
}

export async function api(method, path, body, signal, opts = {}) {
  const machineId = currentMachineId(opts);
  const headers = {
    'Content-Type': 'application/json',
    ...(ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {}),
  };

  // Hub mode: route data APIs to the selected edge (sessions/files/git/…)
  if (hubMode.peek() && machineId && !isHubOnlyPath(path)) {
    headers['X-Machine-Id'] = machineId;
  }

  const etagKey = opts.etag === true
    ? `${ctx.token || ''}:${machineId || ''}:${path}`
    : (opts.etag || null);
  if (method.toUpperCase() === 'GET' && etagKey) {
    const prev = etagStore.get(etagKey);
    if (prev) headers['If-None-Match'] = prev;
  }

  const request = async () => {
    const res = await fetch(path, {
      method,
      signal,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 304) return NOT_MODIFIED;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (etagKey) {
      const etag = res.headers.get('ETag');
      if (etag) etagStore.set(etagKey, etag);
    }
    return data;
  };

  // A caller-provided AbortSignal must retain exclusive ownership of its
  // request; sharing it could let one panel cancel another panel's read.
  if (method.toUpperCase() !== 'GET' || signal || opts.dedupe === false) {
    return request();
  }
  const key = `${ctx.token || ''}:${machineId || ''}:${path}`;
  return pendingGets.get(key, request);
}

const outboundWs = [];

export function sendWs(data) {
  if (ctx.ws?.readyState === WebSocket.OPEN) {
    ctx.ws.send(JSON.stringify(data));
    return true;
  }
  if (data?.type === 'ping' || data?.type === 'pong' || data?.type === 'subscribe') return false;
  outboundWs.push(data);
  return false;
}

export function flushWsQueue() {
  while (outboundWs.length && ctx.ws?.readyState === WebSocket.OPEN) {
    ctx.ws.send(JSON.stringify(outboundWs.shift()));
  }
}

export function clearWsQueue() {
  outboundWs.length = 0;
}

/** Query string for download links (token + machine in hub mode). */
export function authQuery(extra = {}) {
  const q = new URLSearchParams(extra);
  if (ctx.token) q.set('token', ctx.token);
  const mid = currentMachineId();
  if (hubMode.peek() && mid) q.set('machine', mid);
  return q.toString();
}

/** Headers for raw fetch (e.g. file upload) in hub mode. */
export function authHeaders(extra = {}) {
  const h = { ...extra };
  if (ctx.token) h.Authorization = `Bearer ${ctx.token}`;
  const mid = currentMachineId();
  if (hubMode.peek() && mid) h['X-Machine-Id'] = mid;
  return h;
}

export async function probeHub() {
  try {
    const res = await fetch('/api/hub');
    if (!res.ok) {
      hubMode.value = false;
      return false;
    }
    const data = await res.json();
    if (data?.hub) {
      hubMode.value = true;
      return data;
    }
  } catch { /* standalone */ }
  hubMode.value = false;
  return false;
}
