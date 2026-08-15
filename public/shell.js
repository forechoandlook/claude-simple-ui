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
  favoritesOnly, showHiddenOnly, hubMode, hubMachineReady, selectedMachineId, setSelectedMachine,
  machinesList, AGENT_LABELS, getDefaultModel, sessionMetaMap, ctx,
} from './state.js';
import { api } from './api.js';
import { promptPwaInstall } from './pwa.js';
import { syncFocusScope } from './mobile.js';
import { getLastSessionContext } from './shell/session-context.js';
import {
  connectWS, clearMessages, appendMsg, appendSystemMsg, sendMessage, stopProcessing,
  applyChatDensity,
} from './chat.js';
import { syncHash } from './router.js';
import { initSettings, openSettings } from './settings.js';
import { openMetaAgent, toggleMetaAgent } from './agent-panel.js';

import { AuthScreen, AppShell } from './shell/templates.js';
import {
  updateDashboard, shiftCalMonth, setSelectedCalDate, getDashboardSessions,
  openRecentMenu, toggleRecentMenu, closeRecentMenu, positionRecentMenu,
  dismissRecentSession,
} from './shell/dashboard.js';
import {
  loadAllSessions, loadWorkspaces, renderSessionList, syncSidebarChrome,
  refreshModelSelect, refreshEffortSelect, promptCustomModel,
  scheduleActivitySearch, runActivitySearch, loadMemoryTab, openMemoryFile,
} from './shell/session-list.js';
import { openProject, goHome, resumeSession, switchTab } from './shell/session-nav.js';
import { showApp } from './shell/boot.js';
import {
  fetchProjectNotes, renderProjectNotesDisplayMode, renderProjectNotesEditMode,
  renderSessionNotesBar, renderSessionNotesEditMode,
  toggleSessionFavorite, toggleSessionHidden, saveSessionNotes, startInlineRename, setProjectNoteFields,
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

/** Visible install guide when browser has no beforeinstallprompt (iOS Safari etc.). */
function showPwaInstallHelp() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(navigator.userAgent);
  let body;
  if (isIOS) {
    body = `<ol class="list-decimal pl-4 space-y-2 text-sm text-base-content/80">
      <li>点底部分享按钮 <strong>分享</strong>（方框+向上箭头）</li>
      <li>下滑找到并点 <strong>添加到主屏幕</strong></li>
      <li>确认名称后点 <strong>添加</strong></li>
    </ol>
    <p class="text-xs text-base-content/50 mt-3">需用 <strong>Safari</strong> 打开本站；微信/Chrome 内置浏览器通常没有「添加到主屏幕」。</p>
    <p class="text-xs text-warning/80 mt-2">当前若是 IP + 自签 HTTPS，Safari 仍会显示「不安全」。加到主屏幕可去掉浏览器外壳，但不能去掉系统输入条。彻底干净需要正式域名证书。</p>`;
  } else if (isAndroid) {
    body = `<ol class="list-decimal pl-4 space-y-2 text-sm text-base-content/80">
      <li>点右上角菜单 <strong>⋮</strong></li>
      <li>选择 <strong>安装应用</strong> 或 <strong>添加到主屏幕</strong></li>
    </ol>
    <p class="text-xs text-base-content/50 mt-3">若菜单里没有该项：请用 <strong>Chrome</strong> 打开，并先接受本站证书提示。自签 HTTPS 下部分机型不弹出一键安装。</p>`;
  } else {
    body = `<p class="text-sm text-base-content/80">请在浏览器菜单中选择 <strong>安装应用 / 安装网页应用 / 添加到主屏幕</strong>。</p>
    <p class="text-xs text-base-content/50 mt-3">Chrome / Edge 地址栏右侧有时也会出现安装图标。</p>`;
  }
  let dlg = document.getElementById('modal-pwa-install');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'modal-pwa-install';
    dlg.className = 'modal';
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = `
    <div class="modal-box max-w-sm">
      <h3 class="font-bold text-base mb-3">安装到主屏幕</h3>
      ${body}
      <div class="modal-action">
        <form method="dialog"><button class="btn btn-sm">知道了</button></form>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>close</button></form>`;
  dlg.showModal();
}

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
  const btn = $('auth-btn');
  let status;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // This is the first request made by a cold PWA launch. Bound it so a
    // captive portal, stale reverse proxy, or sleeping hub cannot strand the
    // app behind its boot screen indefinitely.
    status = await api('GET', '/api/auth/status', undefined, controller.signal);
  } catch (e) {
    console.warn('[auth status]', e);
    const error = $('auth-error');
    if (error) {
      error.textContent = '无法连接服务器。请检查网络或服务地址后重试。';
      error.classList.remove('hidden');
    }
    // The normal sign-in form remains usable: a transient status failure
    // should be visible, not turn the installed app into a black screen.
    if (btn) btn.dataset.mode = 'login';
    return;
  } finally {
    clearTimeout(timer);
  }

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

/** First paint: restore session shell (no calendar flash) when hash is a session. */
export function shouldRestoreSessionOnBoot() {
  if (!ctx.token) return false;
  return /^#\/session\//.test(location.hash || '');
}

// ── Init — render HTML, wire everything up ────────────────────────────────────
export function initShell(opts = {}) {
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

  const restoreSession = opts.restoreSession ?? shouldRestoreSessionOnBoot();
  const root = document.getElementById('root');
  root.style.cssText = 'display:flex;flex-direction:column;flex:1;height:100%';
  root.innerHTML = AuthScreen() + AppShell({ restoreSession });

  // Avoid sidebar session-list thrashing until first data arrives when restoring
  if (restoreSession) {
    const list = $('session-list');
    if (list) list.innerHTML = '<div class="px-3 py-3 text-[10px] text-base-content/35">Loading sessions…</div>';
  }

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
    void sessionMetaMap.value;
    const el = $('session-list');
    if (!el) return;
    // Keep inline rename input mounted until blur/Enter
    if (el.querySelector('.session-rename-input')) return;
    el.innerHTML = renderSessionList();
    syncSidebarChrome();
  });

  // Home calendar: full session list (not sidebar time-range / 120-cap filters)
  effect(() => {
    // Subscribe to raw list + agent/machine filters
    void sessionsData.value;
    void agentFilter.value;
    void selectedMachineId.value;
    void hubMode.value;
    const welcome = $('welcome');
    if (!welcome) return;
    if (document.documentElement.classList.contains('boot-restore')) return;
    if (document.documentElement.classList.contains('boot-pending')) return;
    if (welcome.classList.contains('hidden') || welcome.style.display === 'none') return;
    updateDashboard();
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
    // Keep project-view as a column flex container so tab panels can fill height
    const pv = $('project-view');
    if (pv && !pv.classList.contains('hidden')) {
      pv.style.display = 'flex';
      pv.style.flexDirection = 'column';
      pv.style.minHeight = '0';
      pv.style.flex = '1';
    }
    ['chat', 'files', 'git', 'shell', 'memory'].forEach(id => {
      const el = $(`tab-${id}`);
      if (!el) return;
      const on = id === tab;
      el.classList.toggle('hidden', !on);
      if (on) {
        el.style.display = 'flex';
        el.style.flexDirection = 'column';
        el.style.flex = '1 1 0';
        el.style.minHeight = '0';
        el.style.overflow = 'hidden';
      } else {
        el.style.display = 'none';
      }
    });
    if (tab === 'memory') loadMemoryTab();
    // Shell needs a re-fit after becoming visible
    if (tab === 'shell') {
      requestAnimationFrame(() => {
        document.dispatchEvent(new CustomEvent('shell-tab-shown'));
      });
    }
    syncFocusScope();
  });

  initSidebarResize();
  initSidebarToggle();

  let sessionsChangedTimer = null;
  document.addEventListener('sessions-changed', () => {
    // Debounce: rapid agent turns would otherwise re-download the full list.
    if (sessionsChangedTimer) clearTimeout(sessionsChangedTimer);
    sessionsChangedTimer = setTimeout(() => {
      sessionsChangedTimer = null;
      loadAllSessions({ waitFresh: false });
    }, 1200);
  });
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
  delegate.on('submit', '#auth-form', e => { e.preventDefault(); submitAuth(); });
  delegate.on('keydown', '#auth-username, #auth-password', e => { if (e.key === 'Enter') submitAuth(); });
  delegate.on('click', '#hamburger', () => $('sidebar').classList.contains('open') ? closeSidebar() : openSidebar());
  delegate.on('click', '#sidebar-overlay', closeSidebar);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (window.innerWidth <= 640 && $('sidebar')?.classList.contains('open')) {
      e.preventDefault();
      closeSidebar();
    }
  });

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
    loadAllSessions({ waitFresh: true });
    if (sessionSearch.peek().trim()) scheduleActivitySearch(sessionSearch.peek());
  });
  delegate.on('dblclick', '[data-project-cwd]', (_, el) => {
    const cwd = el.dataset.projectCwd;
    if (!cwd) return;
    const name = cwd.split('/').filter(Boolean).pop() || cwd;
    openProject({ id: name, name, path: cwd });
    appendSystemMsg(`Project · ${cwd}`);
  });
  delegate.on('click', '#btn-pwa-install', async () => {
    const ok = await promptPwaInstall();
    if (ok) return;
    // iOS / browsers without beforeinstallprompt: chat system messages are easy
    // to miss (no open session / wrong tab). Always show a modal.
    showPwaInstallHelp();
  });
  document.addEventListener('pwa-installable', () => {
    document.getElementById('btn-pwa-install')?.classList.remove('hidden');
  });
  delegate.on('click', '#btn-settings', openSettings);
  delegate.on('click', '#btn-meta-agent', () => toggleMetaAgent());
  delegate.on('click', '#btn-meta-agent-welcome', () => openMetaAgent('chat'));
  delegate.on('click', '#btn-theme', toggleTheme);
  delegate.on('click', '[data-sidebar-action]', (_, el) => {
    const action = el.dataset.sidebarAction;
    if (action === 'new') openNewSessionModal();
    if (action === 'theme') toggleTheme();
    if (action === 'settings') openSettings();
    if (action === 'logout') {
      ctx.token = null;
      localStorage.removeItem('token');
      setSelectedMachine(null);
      hubMachineReady.value = false;
      location.reload();
    }
  });

  delegate.on('click', '#btn-cal-prev', () => {
    shiftCalMonth(-1);
    updateDashboard(getDashboardSessions());
  });
  delegate.on('click', '#btn-cal-next', () => {
    shiftCalMonth(1);
    updateDashboard(getDashboardSessions());
  });
  delegate.on('click', '[data-cal-date]', (_, el) => {
    setSelectedCalDate(el.dataset.calDate);
    updateDashboard(getDashboardSessions());
  });

  delegate.on('click', '[data-session-id]', (e, el) => {
    if (e.target.closest('[data-fav-toggle]')) return;
    if (e.target.closest('[data-hide-toggle]')) return;
    if (e.target.closest('[data-rename-session]')) return;
    if (e.target.closest('.session-rename-input')) return;
    if (e.target.closest('.session-title-wrap.session-rename-active')) return;
    // Only open when clicking the row / title — not action buttons
    resumeSession(
      el.dataset.sessionId,
      el.dataset.sessionCwd || null,
      el.dataset.sessionConfigDir || null,
      el.dataset.sessionAgent || 'claude',
      el.dataset.sessionMachine || null,
    );
    closeSidebarOnMobile();
  });
  // Inline rename (sidebar): only the ✎ button — title click opens the session
  delegate.on('click', '[data-rename-session]', (e, el) => {
    e.preventDefault();
    e.stopPropagation();
    const wrap = el.closest('.session-title-wrap') || el;
    const sessionId = wrap.dataset.renameSessionId || wrap.dataset.sessionId;
    if (!sessionId) return;
    startInlineRename({
      sessionId,
      agent: wrap.dataset.renameSessionAgent || 'claude',
      machineId: wrap.dataset.renameSessionMachine || null,
      fallbackDisplay: wrap.dataset.renameSessionDisplay || '',
      mountEl: wrap,
    });
  });
  // Inline rename (session bar): only the ✎ button next to the title
  delegate.on('click', '[data-rename-bar]', (e, el) => {
    e.preventDefault();
    e.stopPropagation();
    if (!ctx.sessionId) return;
    const mountEl = document.getElementById('session-title-display') || el;
    startInlineRename({
      sessionId: ctx.sessionId,
      agent: ctx.agent || currentAgent.peek() || 'claude',
      machineId: ctx.machineId || null,
      mountEl,
    });
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
  delegate.on('click', '[data-memory-file]', (el) => openMemoryFile(el.dataset.memoryFile, el.dataset.memoryAgent));
  delegate.on('click', '[data-tab]', (e, el) => switchTab(el.dataset.tab));

  const applyRoot = async (inputId, sig) => {
    const input = $(inputId);
    const raw = input?.value.trim();
    if (!raw) { sig.value = ''; return; }
    try {
      // Resolve on the selected edge machine (hub attaches X-Machine-Id)
      const result = await api('POST', '/api/resolve-path', { path: raw });
      if (result.isDir === false) throw new Error('Path is not a directory on the target machine');
      sig.value = result.path;
      input.value = result.path;
      const proj = currentProject.peek();
      if (proj) currentProject.value = { ...proj, path: result.path };
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
  delegate.on('click', '#btn-opts', () => {
    $('chat-opts').classList.toggle('hidden');
    syncFocusScope();
  });

  delegate.on('change', '#sel-agent', (_, el) => {
    const prev = currentAgent.peek();
    const next = el.value;
    if (prev !== next) {
      ctx.sessionId = null;
      setAgent(next);
      currentModel.value = getDefaultModel(next) || currentModel.peek();
      localStorage.setItem('model', currentModel.peek());
      $('sel-permission').value = currentPermission.peek();
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
    refreshEffortSelect();
  });
  delegate.on('click', '#btn-model-add', () => promptCustomModel({ editCurrent: false }));
  delegate.on('click', '#btn-model-edit', () => promptCustomModel({ editCurrent: true }));
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
    closeRecentMenu();
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
  delegate.on('click', '#btn-recent-sessions', e => {
    e.preventDefault();
    e.stopPropagation();
    closeMachineMenu();
    toggleRecentMenu(getDashboardSessions());
    const open = !$('recent-menu')?.classList.contains('hidden');
    const btn = $('btn-recent-sessions');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  delegate.on('click', '#recent-menu-backdrop', e => {
    e.preventDefault();
    e.stopPropagation();
    closeRecentMenu();
    $('btn-recent-sessions')?.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', e => {
    const machineWrap = $('machine-menu-wrap');
    if (machineWrap && !machineWrap.contains(e.target)) closeMachineMenu();
    const menu = $('recent-menu');
    const btn = $('btn-recent-sessions');
    const t = e.target;
    // Menu is portaled (fixed) outside the button wrap — check both
    if (menu && !menu.classList.contains('hidden')) {
      if (menu.contains(t) || btn?.contains(t)) return;
      closeRecentMenu();
      btn?.setAttribute('aria-expanded', 'false');
    }
  });
  // Keep panel glued under topbar on rotate / URL bar show-hide
  window.addEventListener('resize', () => {
    if ($('recent-menu') && !$('recent-menu').classList.contains('hidden')) {
      positionRecentMenu();
    }
  });
  // After picking a session from the topbar menu, close it (row click also resumes).
  delegate.on('click', '#recent-menu [data-session-id]', () => {
    closeRecentMenu();
    $('btn-recent-sessions')?.setAttribute('aria-expanded', 'false');
  });
  delegate.on('click', '[data-dismiss-recent-session]', (e, el) => {
    e.preventDefault();
    e.stopPropagation();
    dismissRecentSession({
      sessionId: el.dataset.dismissRecentSession,
      agent: el.dataset.dismissRecentAgent || 'claude',
      machineId: el.dataset.dismissRecentMachine || null,
    });
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
    toggleSessionFavorite(el.dataset.favSessionId, el.dataset.favSessionAgent || 'claude', {
      machineId: mid || null,
    });
  });
  delegate.on('click', '[data-hide-toggle]', (e, el) => {
    e.stopPropagation();
    e.preventDefault();
    const mid = el.dataset.hideSessionMachine || ctx.machineId;
    if (mid) { ctx.machineId = mid; localStorage.setItem('machineId', mid); }
    toggleSessionHidden(el.dataset.hideSessionId, el.dataset.hideSessionAgent || 'claude', {
      machineId: mid || null,
    });
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
    // Fav and Hidden filters are exclusive for clarity
    if (next && showHiddenOnly.peek()) {
      showHiddenOnly.value = false;
      localStorage.setItem('showHiddenOnly', '0');
      $('btn-hidden-filter')?.classList.remove('active');
    }
  });
  delegate.on('click', '#btn-hidden-filter', () => {
    const next = !showHiddenOnly.peek();
    showHiddenOnly.value = next;
    localStorage.setItem('showHiddenOnly', next ? '1' : '0');
    $('btn-hidden-filter')?.classList.toggle('active', next);
    if (next && favoritesOnly.peek()) {
      favoritesOnly.value = false;
      localStorage.setItem('favoritesOnly', '0');
      $('btn-fav-filter')?.classList.remove('active');
    }
  });

  refreshModelSelect();
  $('sel-permission').value = currentPermission.peek();
  applyChatDensity();
  const dens = $('sel-density');
  if (dens) dens.value = chatDensity.peek() || 'normal';
  const tr = $('time-range');
  if (tr) tr.value = timeRange.peek() || '14';
  document.querySelectorAll('[data-agent-filter]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.agentFilter === agentFilter.peek());
  });
  $('btn-fav-filter')?.classList.toggle('active', favoritesOnly.peek());
  $('btn-hidden-filter')?.classList.toggle('active', showHiddenOnly.peek());
  document.querySelectorAll('[data-view]').forEach(btn => {
    const on = btn.dataset.view === sidebarView.peek();
    btn.classList.toggle('bg-primary/15', on);
    btn.classList.toggle('text-primary', on);
    btn.classList.toggle('font-medium', on);
    btn.classList.toggle('text-base-content/50', !on);
  });
}
