// state.js — All reactive state + mutable runtime context
import { signal, computed } from './lib.js';

export const sessionsData    = signal([]);
export const workspacesData  = signal([]);
export const sessionFilter  = signal(null);   // cwd to filter by
export const sessionSearch  = signal('');
export const sessionSort    = signal('time'); // 'time' | 'project'
export const currentProject = signal(null);   // { id, name, path } | null
export const currentTab     = signal('chat');
export const isProcessing   = signal(false);
export const currentModel      = signal('claude-sonnet-4-5');
export const currentEffort     = signal('');
export const currentPermission = signal('default'); // 'default'|'acceptEdits'|'bypassPermissions'|'plan'|'auto'
export const filesRoot      = signal(''); // custom root override for Files tab
export const gitRoot        = signal(''); // custom root override for Git tab

export const filteredSessions = computed(() => {
  const filter = sessionFilter.value;   // cwd path OR configDir path (workspace tab)
  const search = sessionSearch.value.toLowerCase();
  const sort   = sessionSort.value;
  let list = sessionsData.value;

  if (filter) list = list.filter(s => s.cwd === filter || s.configDir === filter);
  if (search) list = list.filter(s =>
    (s.cwd || '').toLowerCase().includes(search) ||
    (s.display || '').toLowerCase().includes(search)
  );

  list = [...list].sort((a, b) =>
    sort === 'project'
      ? (a.cwd || '').localeCompare(b.cwd || '')
      : b.updatedAt - a.updatedAt
  );

  return filter ? list : list.slice(0, 100);
});

// Mutable runtime — passed by reference so all modules see mutations
export const ctx = {
  token:       localStorage.getItem('token'),
  sessionId:   null,
  ws:          null,
  shellBubble: null,
};
