// shell/layout.js — sidebar, theme, new-session modal
import { batch, esc, $ } from '../lib.js';
import {
  workspacesData, sessionFilter, filesPath, viewingFile, currentProject,
  filesRoot, gitRoot, currentModel, currentAgent, setAgent,
  hubMode, machinesList, selectedMachineId, setSelectedMachine,
  getDefaultModel, AGENT_LABELS, ctx,
} from '../state.js';
// filesRoot/gitRoot used when starting a new session (default paths)
import { api } from '../api.js';
import { connectWS, clearMessages, appendSystemMsg, applyChatDensity, stashComposerDraft, restoreComposerDraft, discardComposerAttachments, parkQueuedMessages, detachProcessingForSessionSwitch } from '../chat.js';
import { refreshModelSelect } from './session-list.js';
import { switchTab } from './session-nav.js';
import { showMachinePicker } from './hub.js';
import { syncFocusScope } from '../mobile.js';

// ── Sidebar ───────────────────────────────────────────────────────────────────
export function openSidebar()  {
  const sidebar = $('sidebar');
  if (!sidebar) return;
  sidebar.classList.add('open');
  $('sidebar-overlay').classList.remove('hidden');
  $('hamburger')?.setAttribute('aria-expanded', 'true');
  syncFocusScope();
  // Put the next action where it belongs. Delaying lets the drawer transition
  // start first, which is more reliable in mobile Safari.
  setTimeout(() => $('session-search')?.focus({ preventScroll: true }), 180);
}
export function closeSidebar() {
  const sidebar = $('sidebar');
  if (!sidebar) return;
  sidebar.classList.remove('open');
  $('sidebar-overlay').classList.add('hidden');
  $('hamburger')?.setAttribute('aria-expanded', 'false');
  syncFocusScope();
  $('hamburger')?.focus({ preventScroll: true });
}
export function closeSidebarOnMobile() { if (window.innerWidth <= 640) closeSidebar(); }

export function initSidebarToggle() {
  const btn     = $('sidebar-toggle');
  const sidebar = $('sidebar');
  if (!btn || !sidebar) return;
  let collapsed = localStorage.getItem('sidebarCollapsed') === '1';
  let savedWidth = localStorage.getItem('sidebarWidth') || sidebar.style.width || '280px';

  const applyCollapsed = () => {
    sidebar.classList.toggle('desktop-collapsed', collapsed);
    if (collapsed) {
      sidebar.style.width = '0';
      sidebar.style.minWidth = '0';
      sidebar.style.overflow = 'hidden';
    } else {
      sidebar.style.width = savedWidth;
      sidebar.style.minWidth = '';
      sidebar.style.overflow = '';
    }
    btn.textContent = collapsed ? '▶' : '◀';
    btn.title = collapsed ? '展开侧栏' : '收起侧栏';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  };
  applyCollapsed();

  btn.addEventListener('click', () => {
    collapsed = !collapsed;
    if (collapsed) savedWidth = sidebar.style.width || savedWidth;
    localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
    applyCollapsed();
  });
}

export function initSidebarResize() {
  const handle  = $('sidebar-resize');
  const sidebar = $('sidebar');
  let dragging  = false;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.min(Math.max(e.clientX, 160), 520);
    sidebar.style.width = w + 'px';
    sidebar.style.minWidth = '';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    const width = Math.round(sidebar.getBoundingClientRect().width);
    if (width >= 160) localStorage.setItem('sidebarWidth', `${width}px`);
  });
}

// ── Theme ─────────────────────────────────────────────────────────────────────
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const btn = $('btn-theme');
  const icon = theme === 'dark' || theme === 'night' || theme === 'black' ? '🌙' : '☀️';
  if (btn) btn.textContent = icon;
  document.querySelectorAll('[data-sidebar-action="theme"]').forEach(el => { el.textContent = icon; });
  // Swap highlight.js stylesheet for light/dark
  let link = document.getElementById('hljs-theme');
  if (!link) {
    link = document.querySelector('link[href*="highlight"][href*="styles"]');
    if (link) link.id = 'hljs-theme';
  }
  if (link) {
    const dark = theme === 'dark' || theme === 'night' || theme === 'black';
    link.href = dark
      ? 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/styles/github-dark.min.css'
      : 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/styles/github.min.css';
  }
}

export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

// ── New Session modal ─────────────────────────────────────────────────────────
export function openNewSessionModal() {
  const agentSel = $('new-session-agent');
  if (agentSel) agentSel.value = currentAgent.peek() || 'claude';
  const sel = $('new-session-workspace');
  if (sel) {
    const wss = workspacesData.peek();
    sel.innerHTML = wss.map(w =>
      `<option value="${esc(w.configDir)}">${esc(w.name)} — ${esc(w.configDir)}</option>`
    ).join('');
    // pre-select current session's workspace
    if (ctx.configDir) sel.value = ctx.configDir;
  }
  const mwrap = $('new-session-machine-wrap');
  const msel = $('new-session-machine');
  if (mwrap && msel) {
    // Machine already chosen at login; still show locked selection for clarity
    if (hubMode.peek()) {
      mwrap.style.display = '';
      const ms = machinesList.peek() || [];
      const cur = selectedMachineId.peek() || '';
      msel.innerHTML = ms.length
        ? ms.map(m => `<option value="${esc(m.id)}">${esc(m.id)}${m.hostname ? ' — ' + esc(m.hostname) : ''}</option>`).join('')
        : '<option value="">(no machines online)</option>';
      if (cur) msel.value = cur;
      msel.disabled = true;
    } else {
      mwrap.style.display = 'none';
      if (msel) msel.disabled = false;
    }
  }
  updateNewSessionAgentUI();
  $('new-session-path').value = currentProject.peek()?.path || '';
  $('new-session-error').classList.add('hidden');
  $('modal-new-session').showModal();
  setTimeout(() => $('new-session-path').focus(), 50);
}

export function updateNewSessionAgentUI() {
  const agent = $('new-session-agent')?.value || 'claude';
  const wrap = $('new-session-ws-wrap');
  if (wrap) wrap.style.display = agent === 'claude' ? '' : 'none';
}

export async function startNewSession() {
  const rawPath  = $('new-session-path').value.trim();
  const agent    = $('new-session-agent')?.value || 'claude';
  const configDir = agent === 'claude' ? $('new-session-workspace').value : null;
  const errEl    = $('new-session-error');
  errEl.classList.add('hidden');

  if (!rawPath) { errEl.textContent = 'Working directory is required'; errEl.classList.remove('hidden'); return; }

  // Hub: new session uses currently selected machine
  if (hubMode.peek()) {
    const mid = selectedMachineId.peek() || $('new-session-machine')?.value || machinesList.peek()?.[0]?.id;
    if (!mid) {
      errEl.textContent = '请先选择一台机器';
      errEl.classList.remove('hidden');
      showMachinePicker();
      return;
    }
    setSelectedMachine(mid);
  }

  try {
    const result = await api('POST', '/api/resolve-path', { path: rawPath });
    if (!result.isDir) throw new Error('Path is not a directory');

    $('modal-new-session').close();

    const name = result.path.split('/').filter(Boolean).pop() || result.path;
    stashComposerDraft();
    parkQueuedMessages();
    discardComposerAttachments();
    detachProcessingForSessionSwitch();
    ctx.sessionId = null;
    ctx.configDir = configDir || null;
    ctx.agent = agent;
    setAgent(agent);
    currentModel.value = getDefaultModel(agent) || currentModel.peek();
    localStorage.setItem('model', currentModel.peek());
    refreshModelSelect();
    batch(() => {
      currentProject.value = { id: name, name, path: result.path, machineId: selectedMachineId.peek() || ctx.machineId };
      sessionFilter.value  = result.path;
      filesRoot.value = result.path;
      gitRoot.value = result.path;
      filesPath.value = '';
      viewingFile.value = null;
    });
    $('topbar-project').textContent = result.path;
    const fi = $('files-root-input'); if (fi) fi.value = result.path;
    const gi = $('git-root-input');   if (gi) gi.value = result.path;
    $('welcome').classList.add('hidden');
    const pv = $('project-view');
    pv.classList.remove('hidden');
    pv.style.display = 'flex';
    clearMessages();
    restoreComposerDraft({ sessionId: null });
    connectWS();
    switchTab('chat');
    appendSystemMsg(`New ${AGENT_LABELS[agent] || agent} session · ${result.path}`);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}
