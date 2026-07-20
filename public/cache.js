// cache.js — IndexedDB-backed cache for sessions and workspaces
import { idb } from './lib.js';

const db = idb('claude-ui');
const SESSIONS_TTL = 5 * 60 * 1000; // 5 minutes

export async function getCachedSessions() {
  try { return await db.get('sessions') ?? null; }
  catch { return null; }
}

export async function setCachedSessions(sessions) {
  try { await db.set('sessions', sessions, { ttl: SESSIONS_TTL }); }
  catch {}
}

export async function getCachedWorkspaces() {
  try { return await db.get('workspaces') ?? null; }
  catch { return null; }
}

export async function setCachedWorkspaces(workspaces) {
  try { await db.set('workspaces', workspaces, { ttl: 60 * 60 * 1000 }); } // 1 hour
  catch {}
}

// lastSessionContext lives in shell/session-context.js (avoid stale cache.js in browsers)
