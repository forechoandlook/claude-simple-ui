// api.js — HTTP + WebSocket helpers
import { ctx, hubMode } from './state.js';

/** Paths the hub answers without routing to a single edge machine. */
function isHubLocalPath(path) {
  const p = path.split('?')[0];
  if (p === '/api/hub' || p === '/api/machines') return true;
  if (p.startsWith('/api/auth/')) return true;
  if (p === '/api/sessions' || p === '/api/projects' || p === '/api/activity') return true;
  // GET /api/sessions/meta is aggregated; PUT is proxied (needs machine)
  return false;
}

export async function api(method, path, body, signal, opts = {}) {
  const machineId = opts.machineId !== undefined ? opts.machineId : ctx.machineId;
  const headers = {
    'Content-Type': 'application/json',
    ...(ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {}),
  };

  const local = isHubLocalPath(path) && method === 'GET';
  const metaPut = path.split('?')[0] === '/api/sessions/meta' && method !== 'GET';
  if (hubMode.peek() && (!local || metaPut) && machineId) {
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
  } catch { /* standalone edge / local */ }
  hubMode.value = false;
  return false;
}
