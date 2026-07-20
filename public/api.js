// api.js — HTTP + WebSocket helpers
import { ctx, hubMode, selectedMachineId } from './state.js';

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

  const res = await fetch(path, {
    method,
    signal,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function sendWs(data) {
  if (ctx.ws?.readyState === WebSocket.OPEN) ctx.ws.send(JSON.stringify(data));
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
