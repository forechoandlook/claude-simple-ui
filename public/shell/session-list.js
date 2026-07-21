// shell/session-list.js — session list UI, filters, activity search, memory tab
import { esc, $ } from '../lib.js';
import {
  sessionsData, workspacesData, sessionFilter, sessionSearch,
  expandedFolders, collapsedFolders, filteredSessions, projectGroups,
  currentModel, currentAgent,
  sidebarView, agentFilter, timeRange, activityHits, activityLoading,
  sessionMetaMap, LOW_TURN_THRESHOLD, metaKey, sessionDisplayTitle,
  hubMode, selectedMachineId, agentsMeta, currentEffort,
  getModelsForAgent, getDefaultModel, getEffortsForModel,
  addCustomModel, removeCustomModel, getCustomModels, ctx,
} from '../state.js';
import { api } from '../api.js';
import { getCachedSessions, setCachedSessions, getCachedWorkspaces, setCachedWorkspaces } from '../cache.js';
import { formatTime, agentBadge, agentCountPills, shortPath } from './util.js';


function normalizeSessions(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.results)) return v.results;
  if (v && Array.isArray(v.sessions)) return v.sessions;
  return [];
}

/** @param {{ waitFresh?: boolean }} opts waitFresh=false → paint cache first, refresh in bg */
export async function loadAllSessions({ waitFresh = true } = {}) {
  const cached = normalizeSessions(await getCachedSessions());
  if (cached.length) {
    // Hub: if we already selected a machine, prefer cache entries for that machine
    const mid = selectedMachineId.peek();
    if (hubMode.peek() && mid) {
      const filtered = cached.filter(s => !s.machineId || s.machineId === mid);
      sessionsData.value = filtered.length ? filtered : cached;
    } else {
      sessionsData.value = cached;
    }
  }

  const fetchFresh = async () => {
    const fresh = normalizeSessions(await api('GET', '/api/sessions'));
    sessionsData.value = fresh;
    setCachedSessions(fresh);
    return fresh;
  };

  if (waitFresh || !cached.length) {
    try {
      await fetchFresh();
    } catch (e) {
      if (!cached.length) {
        const el = $('session-list');
        if (el) el.innerHTML = `<div class="px-3 py-3 text-xs text-error">${esc(e.message)}</div>`;
      }
    }
  } else {
    fetchFresh().catch(() => {});
  }
}

export async function loadWorkspaces({ waitFresh = true } = {}) {
  const cached = await getCachedWorkspaces();
  if (cached) workspacesData.value = cached;
  const fetchFresh = async () => {
    const fresh = await api('GET', '/api/workspaces');
    workspacesData.value = fresh;
    setCachedWorkspaces(fresh);
  };
  if (waitFresh || !cached) {
    try { await fetchFresh(); } catch {}
  } else {
    fetchFresh().catch(() => {});
  }
}
export function sessionItemHtml(s, { showProject = false } = {}) {
  const active = ctx.sessionId === s.sessionId && (ctx.agent || currentAgent.peek()) === (s.agent || 'claude');
  const meta = sessionMetaMap.peek()?.[metaKey(s.agent, s.sessionId, s.machineId)] || {};
  const renamed = !!(meta.title && String(meta.title).trim());
  const title = s.snippet && sessionSearch.peek()
    ? s.snippet
    : sessionDisplayTitle(s);
  const fav = !!meta.favorite;
  const hasNote = !!(meta.notes && String(meta.notes).trim());
  const turns = Number(s.turnCount) || 0;
  const thin = turns > 0 && turns <= LOW_TURN_THRESHOLD;
  const projectLine = showProject
    ? `<div class="text-[10px] text-base-content/40 font-mono truncate" title="${esc(s.cwd || '')}">${esc(s.projectName || shortPath(s.cwd) || '—')}</div>`
    : '';
  const badges = [
    thin ? `<span class="session-thin-badge" title="Only ${turns} turn${turns === 1 ? '' : 's'}">thin·${turns}</span>` : '',
    renamed ? `<span class="session-renamed-badge" title="Custom name (original: ${esc(s.display || '')})">✎</span>` : '',
    hasNote ? `<span class="session-note-dot" title="${esc(meta.notes)}">📝</span>` : '',
  ].filter(Boolean).join('');
  const machineBadge = s.machineId
    ? `<span class="text-[9px] px-1 py-0.5 rounded bg-base-300 text-base-content/50 font-mono flex-shrink-0" title="Machine">${esc(s.machineId)}</span>`
    : '';
  const tip = renamed
    ? `${title}\n(original: ${s.display || s.sessionId})`
    : (s.display || '');
  return `<div class="session-row px-2.5 py-1.5 cursor-pointer hover:bg-base-300 border-l-2
              ${active ? 'border-primary bg-primary/5' : 'border-transparent'} ${fav ? 'session-fav' : ''} ${thin ? 'session-thin' : ''}"
       data-session-id="${esc(s.sessionId)}"
       data-session-cwd="${esc(s.cwd || '')}"
       data-session-config-dir="${esc(s.configDir || '')}"
       data-session-agent="${esc(s.agent || 'claude')}"
       data-session-machine="${esc(s.machineId || '')}"
       data-session-display="${esc(s.display || '')}">
    <div class="flex items-start gap-1.5">
      <button type="button" class="session-fav-btn flex-shrink-0 leading-none mt-0.5 ${fav ? 'is-fav' : ''}"
              data-fav-toggle="1"
              data-fav-session-id="${esc(s.sessionId)}"
              data-fav-session-agent="${esc(s.agent || 'claude')}"
              data-fav-session-machine="${esc(s.machineId || '')}"
              title="${fav ? 'Unfavorite' : 'Favorite'}">${fav ? '★' : '☆'}</button>
      ${agentBadge(s.agent)}
      <div class="min-w-0 flex-1">
        <div class="session-title-wrap flex items-center gap-1 min-w-0"
             data-session-id="${esc(s.sessionId)}"
             data-rename-session-id="${esc(s.sessionId)}"
             data-rename-session-agent="${esc(s.agent || 'claude')}"
             data-rename-session-machine="${esc(s.machineId || '')}"
             data-rename-session-display="${esc(s.display || '')}">
          <div class="session-title-text text-[11px] leading-snug truncate flex-1 min-w-0 ${active ? 'text-primary font-medium' : 'text-base-content/85'} ${renamed ? 'session-title-renamed' : ''}"
               data-rename-session="1"
               title="${esc(tip)} · click to rename">${esc(title)}</div>
          <button type="button" class="session-rename-btn flex-shrink-0"
                  data-rename-session="1"
                  title="Rename session">✎</button>
        </div>
        ${projectLine}
        ${badges || machineBadge ? `<div class="flex items-center gap-1 mt-0.5 flex-wrap">${machineBadge}${badges}</div>` : ''}
      </div>
      <span class="text-[9px] text-base-content/30 flex-shrink-0 mt-0.5">${formatTime(s.updatedAt)}</span>
    </div>
  </div>`;
}

/** Load /api/agents model lists into agentsMeta (Codex/Grok caches + Claude settings). */
export async function loadAgentsMeta() {
  try {
    const data = await api('GET', '/api/agents');
    agentsMeta.value = data;
    // Align current model with discovered list for active agent
    const agent = currentAgent.peek() || 'claude';
    const models = getModelsForAgent(agent);
    const cur = currentModel.peek();
    if (cur && !models.some(m => m.value === cur)) {
      const def = getDefaultModel(agent);
      currentModel.value = def;
      localStorage.setItem('model', def);
    }
    refreshModelSelect();
    return data;
  } catch (e) {
    console.warn('[agents] failed to load model list', e);
    return null;
  }
}

export function refreshEffortSelect() {
  const sel = $('sel-effort');
  if (!sel) return;
  const agent = currentAgent.peek() || 'claude';
  const model = currentModel.peek();
  const efforts = getEffortsForModel(agent, model);
  const cur = currentEffort.peek() || '';
  const opts = [`<option value="">effort: off</option>`]
    .concat(efforts.map(e =>
      `<option value="${esc(e)}" ${e === cur ? 'selected' : ''}>${esc(e)}</option>`
    ));
  sel.innerHTML = opts.join('');
  if (cur && !efforts.includes(cur)) {
    currentEffort.value = '';
    sel.value = '';
  } else {
    sel.value = cur;
  }
}

export function refreshModelSelect() {
  const sel = $('sel-model');
  if (!sel) return;
  const agent = currentAgent.peek() || 'claude';
  let models = getModelsForAgent(agent);
  let cur = currentModel.peek();
  // Keep a free-typed /model value visible even if not in list
  if (cur && !models.some(m => m.value === cur)) {
    models = [{ value: cur, label: `${cur} ★`, custom: true }, ...models];
  }
  sel.innerHTML = models.map(m =>
    `<option value="${esc(m.value)}" ${m.value === cur ? 'selected' : ''}>${esc(m.label)}</option>`
  ).join('');
  if (!models.some(m => m.value === cur)) {
    const def = getDefaultModel(agent) || models[0]?.value;
    currentModel.value = def;
    localStorage.setItem('model', def);
    sel.value = def;
    cur = def;
  } else {
    sel.value = cur;
  }
  const agentSel = $('sel-agent');
  if (agentSel) agentSel.value = agent;
  refreshEffortSelect();
}

/**
 * Prompt user for a model id, save as custom for current agent, select it.
 * @param {{ editCurrent?: boolean }} opts
 */
export function promptCustomModel({ editCurrent = false } = {}) {
  const agent = currentAgent.peek() || 'claude';
  const initial = editCurrent ? (currentModel.peek() || '') : '';
  const msg = editCurrent
    ? `Edit model id for ${agent}:`
    : `Add model id for ${agent} (saved in this browser):`;
  const raw = window.prompt(msg, initial);
  if (raw == null) return;
  const id = raw.trim();
  if (!id) return;

  if (editCurrent && initial && initial !== id && getCustomModels(agent).includes(initial)) {
    removeCustomModel(agent, initial);
  }
  addCustomModel(agent, id);
  currentModel.value = id;
  localStorage.setItem('model', id);
  refreshModelSelect();
}

export function renderProjectGroups(groups) {
  if (!Array.isArray(groups) || !groups.length) {
    return `<div class="px-3 py-6 text-center text-xs text-base-content/40">
      No projects in this range.<br>
      <span class="text-base-content/30">Try “All” time or another agent.</span>
    </div>`;
  }

  const expanded = expandedFolders.value;
  const collapsed = collapsedFolders.value;
  const forceOpen = !!sessionSearch.value.trim();
  // Auto-expand the most recently active project
  const topCwd = groups[0]?.cwd || '(no path)';

  return groups.map(g => {
    const key = g.cwd || '(no path)';
    let open = false;
    if (collapsed.has(key)) {
      open = false;
    } else if (expanded.has(key)) {
      open = true;
    } else {
      open = forceOpen || key === topCwd || groups.length <= 3;
    }
    const latestTitle = g.latest?.display || g.latest?.snippet || '';
    const machineTag = g.machineId
      ? `<span class="text-[9px] font-mono text-base-content/40 flex-shrink-0">@${esc(g.machineId)}</span>`
      : '';
    const header = `
      <div class="project-header px-2.5 py-2 cursor-pointer hover:bg-base-300/80 select-none border-b border-base-300/40"
           data-folder="${esc(key)}" data-project-cwd="${esc(g.cwd || '')}" data-project-machine="${esc(g.machineId || '')}">
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] text-base-content/40 w-3 flex-shrink-0">${open ? '▾' : '▸'}</span>
          <span class="text-[12px] font-semibold truncate flex-1" title="${esc(g.cwd || '')}">${esc(g.projectName)}</span>
          ${machineTag}
          <span class="text-[9px] text-base-content/30 flex-shrink-0">${formatTime(g.updatedAt)}</span>
        </div>
        <div class="flex items-center gap-1.5 mt-0.5 pl-4">
          <span class="text-[10px] text-base-content/35 font-mono truncate flex-1" title="${esc(g.cwd || '')}">${esc(shortPath(g.cwd))}</span>
          <span class="flex items-center gap-0.5 flex-shrink-0">${agentCountPills(g.agents)}</span>
        </div>
        ${latestTitle && !open ? `<div class="pl-4 mt-0.5 text-[10px] text-base-content/45 truncate" title="${esc(latestTitle)}">↳ ${esc(latestTitle)}</div>` : ''}
      </div>`;
    const sessions = g.sessions.slice(0, 40);
    const more = g.sessions.length > 40
      ? `<div class="px-3 py-1 text-[10px] text-base-content/30">+${g.sessions.length - 40} more</div>` : '';
    const body = open
      ? `<div class="pb-1 border-b border-base-300/30">${sessions.map(s => sessionItemHtml(s)).join('')}${more}</div>`
      : '';
    return header + body;
  }).join('');
}

export function renderTimeline(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) {
    return `<div class="px-3 py-6 text-center text-xs text-base-content/40">
      No recent activity.<br>
      <span class="text-base-content/30">Widen the time range or clear filters.</span>
    </div>`;
  }

  // Group by day for readability
  const byDay = new Map();
  for (const s of sessions) {
    const d = s.updatedAt ? new Date(s.updatedAt) : new Date();
    const key = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(s);
  }

  return [...byDay.entries()].map(([day, items]) => `
    <div class="px-2.5 pt-2.5 pb-1 text-[10px] uppercase tracking-wide text-base-content/35 font-medium sticky top-0 bg-base-200/95 backdrop-blur-sm z-[1]">${esc(day)}</div>
    ${items.map(s => sessionItemHtml(s, { showProject: true })).join('')}
  `).join('');
}

export function renderSessionList() {
  const view = sidebarView.value;
  const sessions = Array.isArray(filteredSessions.value) ? filteredSessions.value : [];
  const groups = Array.isArray(projectGroups.value) ? projectGroups.value : [];
  if (view === 'timeline') {
    return renderTimeline(sessions);
  }
  return renderProjectGroups(groups);
}

export function syncSidebarChrome() {
  // View tabs
  document.querySelectorAll('[data-view]').forEach(btn => {
    const on = btn.dataset.view === sidebarView.peek();
    btn.classList.toggle('bg-primary/15', on);
    btn.classList.toggle('text-primary', on);
    btn.classList.toggle('font-medium', on);
    btn.classList.toggle('text-base-content/50', !on);
  });
  // Agent pills
  document.querySelectorAll('[data-agent-filter]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.agentFilter === agentFilter.peek());
  });
  const tr = $('time-range');
  if (tr && tr.value !== timeRange.peek()) tr.value = timeRange.peek();

  const status = $('search-status');
  if (!status) return;
  const hits = activityHits.peek();
  const hitResults = Array.isArray(hits?.results) ? hits.results : null;
  const q = (sessionSearch.peek() || '').trim();
  if (activityLoading.peek()) {
    status.classList.remove('hidden');
    status.textContent = 'Searching content…';
  } else if (q && hitResults) {
    status.classList.remove('hidden');
    status.textContent = `${hitResults.length} hit${hitResults.length === 1 ? '' : 's'} · ${timeRange.peek() === '0' ? 'all time' : timeRange.peek() + 'd'}${hits.deep === false ? '' : ' (incl. content)'}`;
  } else if (q) {
    status.classList.remove('hidden');
    status.textContent = 'Local filter only — type to deep-search';
  } else {
    const sessions = filteredSessions.peek();
    const groups = projectGroups.peek();
    const n = Array.isArray(sessions) ? sessions.length : 0;
    const pg = Array.isArray(groups) ? groups.length : 0;
    status.classList.remove('hidden');
    status.textContent = sidebarView.peek() === 'projects'
      ? `${pg} project${pg === 1 ? '' : 's'} · ${n} session${n === 1 ? '' : 's'}`
      : `${n} recent session${n === 1 ? '' : 's'}`;
  }
}

// Debounced deep search against /api/activity
let _searchTimer = null;
export async function runActivitySearch(q) {
  const query = (q || '').trim();
  if (!query) {
    activityHits.value = null;
    activityLoading.value = false;
    return;
  }
  activityLoading.value = true;
  try {
    const params = new URLSearchParams({
      q: query,
      days: timeRange.peek() || '14',
      limit: '50',
      deep: '1',
    });
    if (agentFilter.peek() && agentFilter.peek() !== 'all') {
      params.set('agent', agentFilter.peek());
    }
    const data = await api('GET', `/api/activity?${params}`);
    // Only apply if query still matches
    if (sessionSearch.peek().trim() === query) {
      activityHits.value = { q: query.toLowerCase(), results: data.results || [], deep: true };
    }
  } catch (e) {
    if (sessionSearch.peek().trim() === query) {
      activityHits.value = { q: query.toLowerCase(), results: [], error: e.message };
    }
  } finally {
    activityLoading.value = false;
  }
}

export function scheduleActivitySearch(q) {
  clearTimeout(_searchTimer);
  const query = (q || '').trim();
  if (!query) {
    activityHits.value = null;
    activityLoading.value = false;
    return;
  }
  _searchTimer = setTimeout(() => runActivitySearch(query), 350);
}

export function mdToHtml(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') return `<pre class="whitespace-pre-wrap text-xs">${esc(text)}</pre>`;
  try {
    // Prefer shared renderer if chat has configured marked
    return marked.parse(String(text), { breaks: true, gfm: true });
  } catch {
    return `<pre class="whitespace-pre-wrap text-xs">${esc(text)}</pre>`;
  }
}

// Load the persistent memory for the currently open session into the Memory tab.
export async function loadMemoryTab() {
  const body = $('memory-area');
  if (!body) return;
  if (!ctx.sessionId) {
    body.innerHTML = '<div class="p-4 text-xs text-base-content/40">Open or resume a session to view its memory.</div>';
    return;
  }
  body.innerHTML = '<div class="p-4 text-xs text-base-content/40">Loading…</div>';
  try {
    const q = new URLSearchParams({ agent: ctx.agent || currentAgent.peek() || 'claude' });
    const mem = await api('GET', `/api/sessions/${ctx.sessionId}/memory?${q}`);
    const parts = [];
    if (mem.index) {
      parts.push(`<div class="mb-4"><div class="text-[11px] uppercase tracking-wide text-base-content/40 mb-1">Index (MEMORY.md)</div>
                  <div class="md">${mdToHtml(mem.index)}</div></div>`);
    }
    for (const f of (mem.files || [])) {
      parts.push(`<div class="mb-3 border border-base-300 rounded-lg overflow-hidden">
                    <div class="px-3 py-1.5 bg-base-300/50 text-xs font-mono text-base-content/70">${esc(f.name)}</div>
                    <div class="px-3 py-2 md">${mdToHtml(f.content)}</div>
                  </div>`);
    }
    if (!parts.length) parts.push('<div class="text-base-content/40 text-xs">No memory saved for this project yet.</div>');
    body.innerHTML = `<div class="p-4">${parts.join('')}</div>`;
  } catch (e) {
    body.innerHTML = `<div class="p-4 text-error text-xs">${esc(e?.message ?? String(e))}</div>`;
  }
}
