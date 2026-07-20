// shell.js — public facade: re-exports + init wiring
// Implementation lives under ./shell/*

import { watch, effect, batch, delegate, esc, $ } from './lib.js';
import {
  sessionsData, workspacesData, sessionFilter, sessionSearch,
  expandedFolders, collapsedFolders, filesPath, viewingFile, filteredSessions, projectGroups,
  currentProject, currentTab, filesRoot, gitRoot,
  currentModel, currentEffort, currentPermission, currentAgent, setAgent,
  sidebarView, agentFilter, timeRange, activityHits, activityLoading,
  chatDensity, setChatDensity,
  favoritesOnly, hubMode, hubMachineReady, selectedMachineId, setSelectedMachine,
  machinesList, AGENT_LABELS, AGENT_DEFAULT_MODEL, ctx,
} from './state.js';
import { api } from './api.js';
import { getLastSessionContext } from './shell/session-context.js';
import {
  connectWS, clearMessages, appendMsg, appendSystemMsg, sendMessage, stopProcessing,
  applyChatDensity,
} from './chat.js';
import { syncHash } from './router.js';
import { initSettings, openSettings } from './settings.js';

import { AuthScreen, AppShell } from './shell/templates.js';
import { updateDashboard, shiftCalMonth, setSelectedCalDate } from './shell/dashboard.js';
import {
  loadAllSessions, loadWorkspaces, renderSessionList, syncSidebarChrome,
  refreshModelSelect, scheduleActivitySearch, runActivitySearch, loadMemoryTab,
} from './shell/session-list.js';
import { openProject, goHome, resumeSession, switchTab } from './shell/session-nav.js';
import { showApp } from './shell/boot.js';
import {
  fetchProjectNotes, renderProjectNotesDisplayMode, renderProjectNotesEditMode,
  renderSessionNotesBar, renderSessionNotesEditMode,
  toggleSessionFavorite, saveSessionNotes, setProjectNoteFields,
} from './shell/notes.js';
import {
  refreshMachinesList, renderMachinePickerList, renderMachineMenuList,
  syncTopbarMachine, closeMachineMenu, enterMachine,
} from './shell/hub.js';
import {
  openSidebar, closeSidebar, closeSidebarOnMobile,
  initSidebarToggle, initSidebarResize,
  applyTheme, toggleTheme,
  openNewSessionModal, updateNewSessionAgentUI, startNewSession,
} from './shell/layout.js';

// Re-export public API (app.js and others)
export { showApp, resumeSession, switchTab, openProject, goHome, loadAllSessions };

export async function initAuth() {
  const authScreen = $('auth-screen');
  if (authScreen) {
    authScreen.classList.remove('hidden');
    authScreen.style.display = 'flex';
  }
  const app = $('app');
  if (app) {
    app.classList.add('hidden');
    app.style.display = 'none';
  }
  const status = await api('GET', '/api/auth/status');
  const btn = $('auth-btn');
  if (status.needsSetup) {
    $('auth-subtitle').textContent = 'Create your account to get started';
    btn.textContent = 'Create Account';
    btn.dataset.mode = 'register';
  } else {
    btn.dataset.mode = 'login';
  }
}

async function submitAuth() {
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  const errEl = $('auth-error');
  errEl.classList.add('hidden');
  try {
    const res = await api('POST', `/api/auth/${$('auth-btn').dataset.mode || 'login'}`, { username, password });
    ctx.token = res.token;
    localStorage.setItem('token', res.token);
    showApp();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

// ── Init — render HTML, wire everything up ────────────────────────────────────
export function initShell() {
  applyTheme(localStorage.getItem('theme') || 'dark');

  if (!document.getElementById('xterm-css')) {
    const css = document.createElement('link');
    css.id = 'xterm-css';
    css.rel = 'stylesheet';
    css.href = '/xterm.min.css';
    document.head.appendChild(css);
  }
  if (!document.getElementById('xterm-js')) {
    const js = document.createElement('script');
    js.id = 'xterm-js';
    js.src = '/xterm.min.js';
    document.head.appendChild(js);
  }
  if (!document.getElementById('xterm-fit-js')) {
    const jsFit = document.createElement('script');
    jsFit.id = 'xterm-fit-js';
    jsFit.src = '/addon-fit.min.js';
    document.head.appendChild(jsFit);
  }

  const root = document.getElementById('root');
  root.style.cssText = 'display:flex;flex-direction:column;flex:1;height:100%';
  root.innerHTML = AuthScreen() + AppShell();

  effect(() => {
    const wss = workspacesData.value;
    const tabs = $('ws-tabs');
    if (!tabs) return;
    if (wss.length <= 1) { tabs.innerHTML = ''; return; }
    const activeId = sessionFilter.peek();
    tabs.innerHTML = [{ id: null, name: 'All' }, ...wss].map(w => {
      const active = w.id === null ? !activeId : activeId === w.configDir;
      return `<button class="px-3 py-1.5 text-[11px] flex-shrink-0 border-b-2 whitespace-nowrap
                ${active ? 'border-primary text-primary' : 'border-transparent text-base-content/50 hover:text-base-content'}"
              data-ws-tab="${esc(w.configDir || '')}">
        ${esc(w.name)}
      </button>`;
    }).join('');
  });

  effect(() => {
    void filteredSessions.value;
    void projectGroups.value;
    void sidebarView.value;
    void activityLoading.value;
    void activityHits.value;
    const el = $('session-list');
    if (!el) return;
    el.innerHTML = renderSessionList();
    syncSidebarChrome();
  });

  effect(() => {
    const sessions = filteredSessions.value;
    const welcome = $('welcome');
    if (welcome && !welcome.classList.contains('hidden')) {
      updateDashboard(sessions);
    }
  });

  watch(sessionFilter, f => {
    const badge = $('session-filter-badge');
    if (!badge) return;
    badge.style.display = f ? 'inline' : 'none';
    badge.title = f || '';
  });

  effect(() => {
    const proj = currentProject.value;
    if (proj && proj.path) {
      fetchProjectNotes(proj.path);
    } else {
      const bar = $('project-notes-bar');
      if (bar) bar.style.display = 'none';
    }
  });

  watch(currentTab, tab => {
    document.querySelectorAll('[data-tab]').forEach(btn => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('text-primary', active);
      btn.classList.toggle('border-primary', active);
      btn.classList.toggle('text-base-content/50', !active);
      btn.classList.toggle('border-transparent', !active);
    });
    ['chat', 'files', 'git', 'shell', 'memory'].forEach(id => {
      const el = $(`tab-${id}`);
      el.classList.toggle('hidden', id !== tab);
      el.style.display = id === tab ? 'flex' : '';
    });
    if (tab === 'memory') loadMemoryTab();
  });

  initSidebarResize();
  initSidebarToggle();

  document.addEventListener('sessions-changed', () => loadAllSessions());
  document.addEventListener('router:home', goHome);

  document.addEventListener('router:session', async ({ detail: { id, tab } }) => {
    const s = sessionsData.peek().find(x => x.sessionId === id);
    const last = getLastSessionContext();
    await resumeSession(
      id,
      s?.cwd || (last?.sessionId === id ? last.cwd : null) || null,
      s?.configDir || (last?.sessionId === id ? last.configDir : null) || null,
      s?.agent || (last?.sessionId === id ? last.agent : null) || null,
      s?.machineId || (last?.sessionId === id ? last.machineId : null) || null,
      { tab: tab || 'chat' },
    );
  });

  delegate.on('click', '#btn-home', goHome);
  delegate.on('click', '#auth-btn', submitAuth);
  delegate.on('keydown', '#auth-username, #auth-password', e => { if (e.key === 'Enter') submitAuth(); });
  delegate.on('click', '#hamburger', () => $('sidebar').classList.contains('open') ? closeSidebar() : openSidebar());
  delegate.on('click', '#sidebar-overlay', closeSidebar);

  delegate.on('input', '#session-search', (_, el) => {
    sessionSearch.value = el.value;
    scheduleActivitySearch(el.value);
  });
  delegate.on('click', '#session-filter-badge', () => { sessionFilter.value = null; });
  delegate.on('click', '[data-ws-tab]', (_, el) => { sessionFilter.value = el.dataset.wsTab || null; });
  delegate.on('click', '#sidebar-refresh', () => {
    loadAllSessions();
    if (sessionSearch.peek().trim()) runActivitySearch(sessionSearch.peek());
  });
  delegate.on('click', '[data-view]', (_, el) => {
    sidebarView.value = el.dataset.view;
    localStorage.setItem('sidebarView', el.dataset.view);
  });
  delegate.on('click', '[data-agent-filter]', (_, el) => {
    agentFilter.value = el.dataset.agentFilter;
    localStorage.setItem('agentFilter', el.dataset.agentFilter);
    if (sessionSearch.peek().trim()) scheduleActivitySearch(sessionSearch.peek());
  });
  delegate.on('change', '#time-range', (_, el) => {
    timeRange.value = el.value;
    localStorage.setItem('timeRange', el.value);
    if (sessionSearch.peek().trim()) scheduleActivitySearch(sessionSearch.peek());
  });
  delegate.on('dblclick', '[data-project-cwd]', (_, el) => {
    const cwd = el.dataset.projectCwd;
    if (!cwd) return;
    const name = cwd.split('/').filter(Boolean).pop() || cwd;
    openProject({ id: name, name, path: cwd });
    appendSystemMsg(`Project · ${cwd}`);
  });
  delegate.on('click', '#btn-settings', openSettings);
  delegate.on('click', '#btn-theme', toggleTheme);

  delegate.on('click', '#btn-cal-prev', () => {
    shiftCalMonth(-1);
    updateDashboard(sessionsData.peek());
  });
  delegate.on('click', '#btn-cal-next', () => {
    shiftCalMonth(1);
    updateDashboard(sessionsData.peek());
  });
  delegate.on('click', '[data-cal-date]', (_, el) => {
    setSelectedCalDate(el.dataset.calDate);
    updateDashboard(sessionsData.peek());
  });

  delegate.on('click', '[data-session-id]', (e, el) => {
    if (e.target.closest('[data-fav-toggle]')) return;
    resumeSession(
      el.dataset.sessionId,
      el.dataset.sessionCwd || null,
      el.dataset.sessionConfigDir || null,
      el.dataset.sessionAgent || 'claude',
      el.dataset.sessionMachine || null,
    );
    closeSidebarOnMobile();
  });

  delegate.on('click', '[data-folder]', (_, el) => {
    const cwd = el.dataset.folder;
    const chevron = el.querySelector('span')?.textContent.trim();
    const wasOpen = chevron === '▾';
    const nextExpanded = new Set(expandedFolders.peek());
    const nextCollapsed = new Set(collapsedFolders.peek());
    if (wasOpen) {
      nextExpanded.delete(cwd);
      nextCollapsed.add(cwd);
    } else {
      nextExpanded.add(cwd);
      nextCollapsed.delete(cwd);
    }
    batch(() => {
      expandedFolders.value = nextExpanded;
      collapsedFolders.value = nextCollapsed;
    });
  });

  delegate.on('click', '#memory-refresh', loadMemoryTab);
  delegate.on('click', '[data-tab]', (e, el) => switchTab(el.dataset.tab));

  const applyRoot = async (inputId, sig) => {
    const input = $(inputId);
    const raw = input?.value.trim();
    if (!raw) { sig.value = ''; return; }
    try {
      const result = await api('POST', '/api/resolve-path', { path: raw });
      sig.value = result.path;
      input.value = result.path;
    } catch (e) {
      input.style.color = 'oklch(var(--er))';
      input.title = e.message;
      setTimeout(() => { input.style.color = ''; input.title = ''; }, 2000);
    }
  };
  delegate.on('click', '#files-root-btn', () => applyRoot('files-root-input', filesRoot));
  delegate.on('click', '#git-root-btn', () => applyRoot('git-root-input', gitRoot));
  delegate.on('keydown', '#files-root-input', e => { if (e.key === 'Enter') applyRoot('files-root-input', filesRoot); });
  delegate.on('keydown', '#git-root-input', e => { if (e.key === 'Enter') applyRoot('git-root-input', gitRoot); });
  delegate.on('click', '#btn-opts', () => { $('chat-opts').classList.toggle('hidden'); });

  delegate.on('change', '#sel-agent', (_, el) => {
    const prev = currentAgent.peek();
    const next = el.value;
    if (prev !== next) {
      ctx.sessionId = null;
      setAgent(next);
      currentModel.value = AGENT_DEFAULT_MODEL[next] || currentModel.peek();
      localStorage.setItem('model', currentModel.peek());
      refreshModelSelect();
      appendSystemMsg(`Agent → ${AGENT_LABELS[next] || next} · model ${currentModel.peek()} · new session`);
    }
  });
  delegate.on('change', '#sel-convert-agent', async (_, el) => {
    const target = el.value;
    if (!target) return;
    const sid = ctx.sessionId;
    if (!sid) { alert('No active session to convert.'); el.value = ''; return; }
    const source = ctx.agent || currentAgent.peek() || 'claude';
    if (source === target) { alert('Cannot convert to the same agent.'); el.value = ''; return; }
    el.disabled = true;
    appendSystemMsg(`Converting session ${sid.slice(0, 8)} from ${source} to ${target}...`);
    try {
      const res = await api('POST', `/api/sessions/${sid}/convert`, { targetAgent: target, sourceAgent: source });
      if (res && res.success) {
        appendSystemMsg(`✓ Converted successfully. New session: ${res.targetSessionId.slice(0, 8)}`);
        await loadAllSessions();
        await resumeSession(res.targetSessionId, currentProject.peek()?.path || null, null, res.targetAgent);
        syncHash();
      } else {
        appendSystemMsg(`Failed to convert session.`);
      }
    } catch (err) {
      appendSystemMsg(`Error converting session: ${err.message}`);
      alert(`Error converting session: ${err.message}`);
    } finally {
      el.disabled = false;
      el.value = '';
    }
  });
  delegate.on('change', '#sel-model', (_, el) => {
    currentModel.value = el.value;
    localStorage.setItem('model', el.value);
  });
  delegate.on('change', '#sel-effort', (_, el) => { currentEffort.value = el.value; });
  delegate.on('change', '#sel-permission', (_, el) => { currentPermission.value = el.value; });
  delegate.on('change', '#sel-density', (_, el) => {
    setChatDensity(el.value);
    appendSystemMsg(`Density → ${el.value} (applies to new tool calls; reload session to re-group history)`);
  });
  document.addEventListener('agent-changed', refreshModelSelect);

  delegate.on('click', '#btn-new-session, #btn-new-session-welcome', openNewSessionModal);
  delegate.on('click', '#new-session-cancel', () => $('modal-new-session').close());
  delegate.on('click', '#new-session-start', startNewSession);
  delegate.on('change', '#new-session-agent', updateNewSessionAgentUI);
  delegate.on('keydown', '#new-session-path', e => { if (e.key === 'Enter') startNewSession(); });
  delegate.on('click', '#send-btn', sendMessage);
  delegate.on('click', '#stop-btn', stopProcessing);
  delegate.on('click', '#btn-logout', () => {
    ctx.token = null;
    localStorage.removeItem('token');
    setSelectedMachine(null);
    hubMachineReady.value = false;
    location.reload();
  });

  delegate.on('click', '[data-pick-machine]', async (_, el) => {
    const id = el.dataset.pickMachine;
    if (!id || id === selectedMachineId.peek()) {
      closeMachineMenu();
      return;
    }
    await enterMachine(id, { forceReload: true });
  });
  const refreshMachinesUi = async () => {
    const st = $('machine-picker-status');
    if (st) st.textContent = '刷新中…';
    await refreshMachinesList();
    renderMachinePickerList();
    renderMachineMenuList();
    syncTopbarMachine();
    if (st) {
      const n = (machinesList.peek() || []).filter(m => m.online !== false).length;
      st.textContent = `${n} online`;
    }
  };
  delegate.on('click', '#btn-refresh-machines', refreshMachinesUi);
  delegate.on('click', '#btn-refresh-machines-menu', async e => {
    e.stopPropagation();
    await refreshMachinesUi();
  });
  delegate.on('click', '#btn-machine-menu', async e => {
    e.stopPropagation();
    const menu = $('machine-menu');
    if (!menu) return;
    if (menu.classList.contains('hidden')) {
      await refreshMachinesList();
      renderMachineMenuList();
      menu.classList.remove('hidden');
    } else {
      menu.classList.add('hidden');
    }
  });
  document.addEventListener('click', e => {
    const wrap = $('machine-menu-wrap');
    if (wrap && !wrap.contains(e.target)) closeMachineMenu();
  });

  delegate.on('click', '#btn-edit-project-notes, #project-goal-text, #project-notes-text', () => {
    renderProjectNotesEditMode();
  });
  delegate.on('click', '#btn-cancel-project-notes', () => {
    renderProjectNotesDisplayMode();
  });

  const handleSaveProjectNotes = async () => {
    const goal = $('project-goal-input')?.value?.trim() ?? '';
    const notes = $('project-notes-input')?.value?.trim() ?? '';
    const proj = currentProject.peek();
    if (!proj || !proj.path) return;
    try {
      const res = await api('POST', '/api/projects/notes', { root: proj.path, goal, notes });
      setProjectNoteFields(res.goal || '', res.notes || '');
      renderProjectNotesDisplayMode();
    } catch (err) {
      alert(`Error saving project notes: ${err.message}`);
    }
  };
  delegate.on('click', '#btn-save-project-notes', handleSaveProjectNotes);
  delegate.on('keydown', '#project-goal-input', e => {
    if (e.key === 'Enter') handleSaveProjectNotes();
    if (e.key === 'Escape') renderProjectNotesDisplayMode();
  });
  delegate.on('keydown', '#project-notes-input', e => {
    if (e.key === 'Escape') renderProjectNotesDisplayMode();
  });

  delegate.on('click', '[data-fav-toggle]', (e, el) => {
    e.stopPropagation();
    e.preventDefault();
    const mid = el.dataset.favSessionMachine || ctx.machineId;
    if (mid) { ctx.machineId = mid; localStorage.setItem('machineId', mid); }
    toggleSessionFavorite(el.dataset.favSessionId, el.dataset.favSessionAgent || 'claude');
  });
  delegate.on('click', '#btn-edit-session-notes, #session-notes-text', () => {
    renderSessionNotesEditMode();
  });
  delegate.on('click', '#btn-cancel-session-notes', () => renderSessionNotesBar());
  delegate.on('click', '#btn-save-session-notes', async () => {
    const notes = $('session-notes-input')?.value?.trim() || '';
    if (!ctx.sessionId) return;
    const agent = ctx.agent || currentAgent.peek() || 'claude';
    if (await saveSessionNotes(ctx.sessionId, agent, notes)) renderSessionNotesBar();
  });
  delegate.on('keydown', '#session-notes-input', async e => {
    if (e.key === 'Escape') renderSessionNotesBar();
    if (e.key === 'Enter') {
      const notes = e.target.value.trim();
      if (!ctx.sessionId) return;
      const agent = ctx.agent || currentAgent.peek() || 'claude';
      if (await saveSessionNotes(ctx.sessionId, agent, notes)) renderSessionNotesBar();
    }
  });
  delegate.on('click', '#btn-fav-filter', () => {
    const next = !favoritesOnly.peek();
    favoritesOnly.value = next;
    localStorage.setItem('favoritesOnly', next ? '1' : '0');
    $('btn-fav-filter')?.classList.toggle('active', next);
  });

  refreshModelSelect();
  applyChatDensity();
  const dens = $('sel-density');
  if (dens) dens.value = chatDensity.peek() || 'normal';
  const tr = $('time-range');
  if (tr) tr.value = timeRange.peek() || '14';
  document.querySelectorAll('[data-agent-filter]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.agentFilter === agentFilter.peek());
  });
  $('btn-fav-filter')?.classList.toggle('active', favoritesOnly.peek());
  document.querySelectorAll('[data-view]').forEach(btn => {
    const on = btn.dataset.view === sidebarView.peek();
    btn.classList.toggle('bg-primary/15', on);
    btn.classList.toggle('text-primary', on);
    btn.classList.toggle('font-medium', on);
    btn.classList.toggle('text-base-content/50', !on);
  });
}

