// api.js — HTTP + WebSocket helpers
import { ctx } from './state.js';

export async function api(method, path, body, signal) {
  const res = await fetch(path, {
    method, signal,
    headers: {
      'Content-Type': 'application/json',
      ...(ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function sendWs(data) {
  if (ctx.ws?.readyState === WebSocket.OPEN) ctx.ws.send(JSON.stringify(data));
}
