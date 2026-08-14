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
/** Chat socket: idle | connecting | open | reconnecting | offline */
export const wsStatus       = signal('idle');
export const currentAgent      = signal(localStorage.getItem('agent') || 'claude'); // 'claude'|'codex'|'grok'
export const currentModel      = signal(localStorage.getItem('model') || 'claude-sonnet-4-5');
export const currentEffort     = signal('');
// All local agents are trusted by default; users can still choose another mode
// from the expanded composer options before starting a turn.
export const currentPermission = signal('bypassPermissions'); // 'default'|'acceptEdits'|'bypassPermissions'|'plan'|'auto'
export const filesRoot      = signal(''); // custom root override for Files tab
export const gitRoot        = signal(''); // custom root override for Git tab
export const agentsMeta     = signal(null); // from /api/agents (dynamic model lists)

// Sidebar project-management filters
export const sidebarView    = signal(localStorage.getItem('sidebarView') || 'projects'); // 'projects' | 'timeline'
export const agentFilter    = signal(localStorage.getItem('agentFilter') || 'all'); // all|claude|codex|grok
export const timeRange      = signal(localStorage.getItem('timeRange') || '14'); // '0'|'1'|'7'|'14'|'30'
export const activityHits   = signal(null); // null | { q, results, loading, error }
export const activityLoading = signal(false);
/** agent:sessionId → { favorite, notes, title, hidden, updatedAt }  (title = rename map) */
export const sessionMetaMap = signal({});
/** Sidebar: show only favorited sessions */
export const favoritesOnly  = signal(localStorage.getItem('favoritesOnly') === '1');
/** Sidebar: show only hidden sessions (default list excludes hidden) */
export const showHiddenOnly = signal(localStorage.getItem('showHiddenOnly') === '1');
/** Sessions with this many user turns or fewer get a “thin” badge */
export const LOW_TURN_THRESHOLD = 2;

// Chat display density: clean (tools batched/hidden) | normal | full (tools expanded-friendly)
export const chatDensity = signal(localStorage.getItem('chatDensity') || 'normal');

// Hub signals — must be declared BEFORE filteredSessions (uses them in the computed)
/** Hub mode: single WebUI, many edge machines (set after /api/hub probe). */
export const hubMode = signal(false);
export const machinesList = signal([]);
/** Currently selected edge machine (hub mode). Also mirrored on ctx.machineId for api/ws. */
export const selectedMachineId = signal(null);
/** Hub: user finished machine picker after login. */
export const hubMachineReady = signal(false);

// Mutable runtime — passed by reference so all modules see mutations
export const ctx = {
  token:       localStorage.getItem('token'),
  sessionId:   null,
  agent:       null,
  machineId:   null, // hub: set via setSelectedMachine / picker
  ws:          null,
  shellBubble: null,
  configDir:   null,
};

/** Select edge machine (hub). Keeps signal + ctx + localStorage in sync. */
export function setSelectedMachine(id) {
  const mid = id || null;
  selectedMachineId.value = mid;
  ctx.machineId = mid;
  if (mid) localStorage.setItem('machineId', mid);
  else localStorage.removeItem('machineId');
}

export function metaKey(agent, sessionId, machineId) {
  const base = `${agent || 'claude'}:${sessionId}`;
  // Hub aggregates as machineId:agent:sessionId
  if (machineId || ctx?.machineId) {
    return `${machineId || ctx.machineId}:${base}`;
  }
  return base;
}

export function getSessionMeta(agent, sessionId, machineId) {
  const m = sessionMetaMap.peek()?.[metaKey(agent, sessionId, machineId)];
  return m || { favorite: false, notes: '', title: '', hidden: false };
}

/** Display title: user rename map → original display → short id. */
export function sessionDisplayTitle(s, { preferSnippet = false } = {}) {
  if (!s) return 'Session';
  if (preferSnippet && s.snippet) return s.snippet;
  const meta = getSessionMeta(s.agent, s.sessionId, s.machineId);
  const custom = (meta.title || '').trim();
  if (custom) return custom;
  return s.display || s.sessionId?.slice(0, 8) || 'Session';
}

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

/** Static fallbacks when /api/agents has not loaded yet. */
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

function normalizeModelEntry(m) {
  if (!m) return null;
  if (typeof m === 'string') return { value: m, label: m };
  if (!m.value) return null;
  return {
    value: String(m.value),
    label: m.label || m.value,
    ...(Array.isArray(m.efforts) && m.efforts.length ? { efforts: m.efforts.map(String) } : {}),
    ...(m.defaultEffort ? { defaultEffort: String(m.defaultEffort) } : {}),
  };
}

const CUSTOM_MODELS_KEY = 'customModelsByAgent';

function readCustomModelsMap() {
  try {
    const raw = localStorage.getItem(CUSTOM_MODELS_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function writeCustomModelsMap(map) {
  localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(map));
}

/** User-added model ids for an agent (localStorage). */
export function getCustomModels(agent) {
  const a = (agent || 'claude').toLowerCase();
  const list = readCustomModelsMap()[a];
  return Array.isArray(list) ? list.filter(Boolean).map(String) : [];
}

/** Persist a custom model id for agent (idempotent). */
export function addCustomModel(agent, modelId) {
  const a = (agent || 'claude').toLowerCase();
  const id = String(modelId || '').trim();
  if (!id) return false;
  const map = readCustomModelsMap();
  const list = Array.isArray(map[a]) ? [...map[a]] : [];
  if (!list.includes(id)) list.push(id);
  map[a] = list;
  writeCustomModelsMap(map);
  return true;
}

/** Remove a custom model id (only from user list, not discovery). */
export function removeCustomModel(agent, modelId) {
  const a = (agent || 'claude').toLowerCase();
  const id = String(modelId || '').trim();
  const map = readCustomModelsMap();
  const list = Array.isArray(map[a]) ? map[a].filter(x => x !== id) : [];
  map[a] = list;
  writeCustomModelsMap(map);
  return true;
}

/** Models for agent: discovery + user custom + static fallback. */
export function getModelsForAgent(agent) {
  const a = (agent || 'claude').toLowerCase();
  const meta = agentsMeta.peek()?.defaults?.[a];
  let base = meta?.models?.length
    ? meta.models.map(normalizeModelEntry).filter(Boolean)
    : (AGENT_MODELS[a] || AGENT_MODELS.claude).map(m => ({ ...m }));

  const custom = getCustomModels(a);
  const seen = new Set(base.map(m => m.value));
  for (const id of custom) {
    if (seen.has(id)) {
      base = base.map(m => {
        if (m.value !== id) return m;
        const label = String(m.label || m.value);
        return {
          ...m,
          custom: true,
          label: label.includes('★') ? label : `${label} ★`,
        };
      });
      continue;
    }
    seen.add(id);
    base.push({ value: id, label: `${id} ★`, custom: true });
  }
  return base;
}

export function getDefaultModel(agent) {
  const a = (agent || 'claude').toLowerCase();
  const meta = agentsMeta.peek()?.defaults?.[a];
  if (meta?.model) return String(meta.model);
  return AGENT_DEFAULT_MODEL[a] || getModelsForAgent(a)[0]?.value || 'claude-sonnet-4-5';
}

/** Effort levels for current (or given) model under agent. */
export function getEffortsForModel(agent, modelId) {
  const models = getModelsForAgent(agent);
  const m = models.find(x => x.value === modelId);
  if (m?.efforts?.length) return m.efforts;
  const meta = agentsMeta.peek()?.defaults?.[(agent || 'claude').toLowerCase()];
  if (meta?.efforts?.length) return meta.efforts.map(String);
  return ['low', 'medium', 'high', 'xhigh', 'max'];
}

export function setAgent(agent) {
  const a = (agent || 'claude').toLowerCase();
  currentAgent.value = a;
  localStorage.setItem('agent', a);
  currentPermission.value = 'bypassPermissions';
  const permissionSelect = typeof document === 'undefined' ? null : document.getElementById('sel-permission');
  if (permissionSelect) permissionSelect.value = currentPermission.peek();
  const models = getModelsForAgent(a);
  const def = getDefaultModel(a);
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
  let ts = s.updatedAt || 0;
  if (typeof ts === 'string') {
    const n = Number(ts);
    ts = Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : Date.parse(ts) || 0;
  } else if (typeof ts === 'number' && ts > 0 && ts < 1e12) {
    ts = ts * 1000;
  }
  return ts >= Date.now() - days * 86400000;
}

function matchesSearch(s, search) {
  if (!search) return true;
  const meta = sessionMetaMap.value?.[metaKey(s.agent, s.sessionId, s.machineId)];
  const hay = [
    s.display, s.cwd, s.projectName, s.agent, s.sessionId, s.snippet, s.machineId,
    meta?.notes, meta?.title,
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(search);
}

function asSessionArray(v) {
  if (Array.isArray(v)) return v;
  // Hub/API/cache may occasionally yield an object or null
  if (v && Array.isArray(v.results)) return v.results;
  if (v && Array.isArray(v.sessions)) return v.sessions;
  return [];
}

/** Sessions after local filters (agent / time / workspace / text / favorites). */
export const filteredSessions = computed(() => {
  const filter = sessionFilter.value;
  const search = sessionSearch.value.toLowerCase().trim();
  const sort   = sessionSort.value;
  const aFilter = agentFilter.value;
  const days = timeRange.value;
  const favOnly = favoritesOnly.value;
  const hiddenOnly = showHiddenOnly.value;
  const metaMap = sessionMetaMap.value;
  // When deep activity results are present and user is searching, prefer those
  const hits = activityHits.value;
  let list = (hits?.results?.length && search)
    ? asSessionArray(hits.results)
    : asSessionArray(sessionsData.value);

  if (filter) list = list.filter(s => s && (s.cwd === filter || s.configDir === filter));
  // Hub: only show sessions on the currently selected machine
  const mid = selectedMachineId.value;
  if (hubMode.value && mid) {
    list = list.filter(s => s && (!s.machineId || s.machineId === mid));
  }
  list = list.filter(s => s && matchesAgentFilter(s, aFilter) && matchesTimeRange(s, days));
  // Hidden sessions: excluded by default; "Hidden" filter shows only them
  if (hiddenOnly) {
    list = list.filter(s => s && metaMap?.[metaKey(s.agent, s.sessionId, s.machineId)]?.hidden);
  } else {
    list = list.filter(s => s && !metaMap?.[metaKey(s.agent, s.sessionId, s.machineId)]?.hidden);
  }
  if (favOnly) {
    list = list.filter(s => s && metaMap?.[metaKey(s.agent, s.sessionId, s.machineId)]?.favorite);
  }
  if (search && !(hits?.results && hits.q === search)) {
    list = list.filter(s => s && matchesSearch(s, search));
  }

  list = [...list].sort((a, b) => {
    // Favorites float to top within the same sort key
    const fa = metaMap?.[metaKey(a.agent, a.sessionId, a.machineId)]?.favorite ? 1 : 0;
    const fb = metaMap?.[metaKey(b.agent, b.sessionId, b.machineId)]?.favorite ? 1 : 0;
    if (fa !== fb) return fb - fa;
    return sort === 'project'
      ? (a.cwd || '').localeCompare(b.cwd || '') || (b.updatedAt - a.updatedAt)
      : b.updatedAt - a.updatedAt;
  });

  // Cap timeline dump when no filter/search
  if (!filter && !search && !favOnly) return list.slice(0, 120);
  return list;
});

/** Project groups derived from filtered sessions. */
export const projectGroups = computed(() => {
  const list = asSessionArray(filteredSessions.value);
  const map = new Map();
  for (const s of list) {
    if (!s) continue;
    // Hub: same cwd on different machines are different projects
    const key = s.machineId ? `${s.machineId}::${s.cwd || '(no path)'}` : (s.cwd || '(no path)');
    if (!map.has(key)) {
      map.set(key, {
        cwd: s.cwd || null,
        machineId: s.machineId || null,
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
