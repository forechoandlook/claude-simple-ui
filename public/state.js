// state.js — All reactive state + mutable runtime context
import { signal, computed } from './lib.js';

export const sessionsData    = signal([]);
export const workspacesData  = signal([]);
export const sessionFilter  = signal(null);   // cwd path OR configDir path (workspace tab)
export const sessionSearch  = signal('');
export const sessionSort    = signal('time'); // 'time' | 'project'  (timeline sort)
export const expandedFolders = signal(new Set()); // cwd paths currently expanded in the session list
export const collapsedFolders = signal(new Set()); // cwd paths explicitly collapsed in the session list
export const filesPath      = signal('');         // current path in Files tab
export const viewingFile    = signal(null);       // currently viewing file in Files tab
export const currentProject = signal(null);   // { id, name, path } | null
export const currentTab     = signal('chat');
export const isProcessing   = signal(false);
export const currentAgent      = signal(localStorage.getItem('agent') || 'claude'); // 'claude'|'codex'|'grok'
export const currentModel      = signal(localStorage.getItem('model') || 'claude-sonnet-4-5');
export const currentEffort     = signal('');
export const currentPermission = signal('default'); // 'default'|'acceptEdits'|'bypassPermissions'|'plan'|'auto'
export const filesRoot      = signal(''); // custom root override for Files tab
export const gitRoot        = signal(''); // custom root override for Git tab
export const agentsMeta     = signal(null); // from /api/agents

// Sidebar project-management filters
export const sidebarView    = signal(localStorage.getItem('sidebarView') || 'projects'); // 'projects' | 'timeline'
export const agentFilter    = signal(localStorage.getItem('agentFilter') || 'all'); // all|claude|codex|grok
export const timeRange      = signal(localStorage.getItem('timeRange') || '14'); // '0'|'1'|'7'|'14'|'30'
export const activityHits   = signal(null); // null | { q, results, loading, error }
export const activityLoading = signal(false);

// Chat display density: clean (tools batched/hidden) | normal | full (tools expanded-friendly)
export const chatDensity = signal(localStorage.getItem('chatDensity') || 'normal');

export function setChatDensity(d) {
  const v = ['clean', 'normal', 'full'].includes(d) ? d : 'normal';
  chatDensity.value = v;
  localStorage.setItem('chatDensity', v);
  document.getElementById('messages')?.setAttribute('data-density', v);
}

export const AGENT_LABELS = {
  claude: 'Claude',
  codex:  'Codex',
  grok:   'Grok',
};

export const AGENT_MODELS = {
  claude: [
    { value: 'claude-sonnet-4-5', label: 'sonnet-4-5' },
    { value: 'claude-sonnet-4-6', label: 'sonnet-4-6' },
    { value: 'claude-opus-4-5',   label: 'opus-4-5' },
    { value: 'claude-haiku-4-5',  label: 'haiku-4-5' },
  ],
  codex: [
    { value: 'gpt-5.4', label: 'gpt-5.4' },
    { value: 'gpt-5.3', label: 'gpt-5.3' },
    { value: 'gpt-5.2', label: 'gpt-5.2' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4-mini' },
    { value: 'codex-mini-latest', label: 'codex-mini' },
  ],
  grok: [
    { value: 'grok-4.5', label: 'grok-4.5' },
    { value: 'grok-4', label: 'grok-4' },
    { value: 'grok-3', label: 'grok-3' },
    { value: 'grok-3-mini', label: 'grok-3-mini' },
  ],
};

export const AGENT_DEFAULT_MODEL = {
  claude: 'claude-sonnet-4-5',
  codex:  'gpt-5.4',
  grok:   'grok-4.5',
};

export function setAgent(agent) {
  const a = (agent || 'claude').toLowerCase();
  currentAgent.value = a;
  localStorage.setItem('agent', a);
  const models = AGENT_MODELS[a] || AGENT_MODELS.claude;
  const def = AGENT_DEFAULT_MODEL[a] || models[0]?.value;
  if (!models.some(m => m.value === currentModel.peek())) {
    currentModel.value = def;
    localStorage.setItem('model', def);
  }
}

function matchesAgentFilter(s, filter) {
  if (!filter || filter === 'all') return true;
  return (s.agent || 'claude') === filter;
}

function matchesTimeRange(s, daysStr) {
  const days = parseInt(daysStr || '0', 10) || 0;
  if (days <= 0) return true;
  return (s.updatedAt || 0) >= Date.now() - days * 86400000;
}

function matchesSearch(s, search) {
  if (!search) return true;
  const hay = [
    s.display, s.cwd, s.projectName, s.agent, s.sessionId, s.snippet,
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(search);
}

/** Sessions after local filters (agent / time / workspace / text). */
export const filteredSessions = computed(() => {
  const filter = sessionFilter.value;
  const search = sessionSearch.value.toLowerCase().trim();
  const sort   = sessionSort.value;
  const aFilter = agentFilter.value;
  const days = timeRange.value;
  // When deep activity results are present and user is searching, prefer those
  const hits = activityHits.value;
  let list = (hits?.results?.length && search)
    ? hits.results
    : sessionsData.value;

  if (filter) list = list.filter(s => s.cwd === filter || s.configDir === filter);
  list = list.filter(s => matchesAgentFilter(s, aFilter) && matchesTimeRange(s, days));
  if (search && !(hits?.results && hits.q === search)) {
    list = list.filter(s => matchesSearch(s, search));
  }

  list = [...list].sort((a, b) =>
    sort === 'project'
      ? (a.cwd || '').localeCompare(b.cwd || '') || (b.updatedAt - a.updatedAt)
      : b.updatedAt - a.updatedAt
  );

  // Cap timeline dump when no filter/search
  if (!filter && !search) return list.slice(0, 120);
  return list;
});

/** Project groups derived from filtered sessions. */
export const projectGroups = computed(() => {
  const list = filteredSessions.value;
  const map = new Map();
  for (const s of list) {
    const key = s.cwd || '(no path)';
    if (!map.has(key)) {
      map.set(key, {
        cwd: s.cwd || null,
        projectName: s.projectName || (s.cwd ? s.cwd.split('/').filter(Boolean).pop() : '(no path)'),
        updatedAt: 0,
        agents: {},
        sessions: [],
        latest: null,
      });
    }
    const g = map.get(key);
    g.sessions.push(s);
    g.agents[s.agent || 'claude'] = (g.agents[s.agent || 'claude'] || 0) + 1;
    if ((s.updatedAt || 0) > g.updatedAt) {
      g.updatedAt = s.updatedAt;
      g.latest = s;
    }
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
});

// Mutable runtime — passed by reference so all modules see mutations
export const ctx = {
  token:       localStorage.getItem('token'),
  sessionId:   null,
  agent:       null,
  ws:          null,
  shellBubble: null,
  configDir:   null,
};
