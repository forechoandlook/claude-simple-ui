// cache.js — IndexedDB-backed cache for sessions and workspaces
import { idb } from './lib.js';

const db = idb('claude-ui');
const SESSIONS_TTL = 5 * 60 * 1000; // 5 minutes
const LAST_SESSION_KEY = 'lastSessionContext';

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

/** Fast deep-link restore: last opened session metadata (localStorage). */
export function getLastSessionContext() {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function setLastSessionContext( partial ) {
  try {
    const prev = getLastSessionContext() || {};
    const next = { ...prev, ...partial, updatedAt: Date.now() };
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(next));
  } catch {}
}
