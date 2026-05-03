// state.js — All reactive state + mutable runtime context
import { signal, computed } from './lib.js';

export const projectsData   = signal([]);
export const sessionsData   = signal([]);
export const sessionFilter  = signal(null);   // project cwd to filter by
export const currentProject = signal(null);   // { id, name, path } | null
export const currentTab     = signal('chat');
export const isProcessing   = signal(false);

export const filteredSessions = computed(() => {
  const f = sessionFilter.value, all = sessionsData.value;
  return f ? all.filter(s => s.cwd === f) : all.slice(0, 30);
});

// Mutable runtime — passed by reference so all modules see mutations
export const ctx = {
  token:       localStorage.getItem('token'),
  sessionId:   null,
  ws:          null,
  shellBubble: null,
};
