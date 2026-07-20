// shell/session-context.js — last-opened session metadata for fast deep-link restore
const LAST_SESSION_KEY = 'lastSessionContext';

export function getLastSessionContext() {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setLastSessionContext(partial) {
  try {
    const prev = getLastSessionContext() || {};
    const next = { ...prev, ...partial, updatedAt: Date.now() };
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(next));
  } catch { /* ignore quota / private mode */ }
}
