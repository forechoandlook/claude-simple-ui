// shell.js — HTML templates, layout bootstrap, sidebar, tabs, auth, modals
import { watch, effect, batch, computed, delegate, esc, $ } from './lib.js';
import { sessionsData, workspacesData, sessionFilter, sessionSearch, sessionSort,
         expandedFolders, filteredSessions, currentProject, currentTab, filesRoot, gitRoot,
         currentModel, currentEffort, currentPermission, ctx } from './state.js';
import { api } from './api.js';
import { getCachedSessions, setCachedSessions, getCachedWorkspaces, setCachedWorkspaces } from './cache.js';
import { connectWS, clearMessages, appendMsg, appendSystemMsg, renderToolUse,
         appendHistoryTokenBar, sendMessage, stopProcessing, attachImage } from './chat.js';
import { setHash, syncHash } from './router.js';
import { initSettings, openSettings } from './settings.js';

// ── HTML Templates ────────────────────────────────────────────────────────────
const AuthScreen = () => `
  <div id="auth-screen" class="flex items-center justify-center h-full p-4">
    <div class="card bg-base-200 border border-base-300 w-full max-w-sm shadow-xl">
      <div class="card-body gap-3 p-8">
        <h1 class="text-xl font-bold">🤖 Claude Code</h1>
        <p id="auth-subtitle" class="text-sm text-base-content/60 mb-1">Sign in to your workspace</p>
        <label class="form-control">
          <div class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Username</span></div>
          <input id="auth-username" type="text" class="input input-bordered input-sm" placeholder="username" autocomplete="username">
        </label>
        <label class="form-control">
          <div class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Password</span></div>
          <input id="auth-password" type="password" class="input input-bordered input-sm" placeholder="••••••" autocomplete="current-password">
        </label>
        <button id="auth-btn" class="btn btn-primary btn-sm mt-1" data-mode="login">Sign In</button>
        <div id="auth-error" class="alert alert-error text-xs py-2 hidden"></div>
      </div>
    </div>
  </div>`;

const AppShell = () => `
  <div id="sidebar-overlay" class="hidden fixed inset-0 bg-black/50 z-[9]"></div>
  <div id="app" class="hidden flex-col flex-1 overflow-hidden">
    <div class="flex items-center gap-2 px-3 bg-base-200 border-b border-base-300 flex-shrink-0" style="height:44px">
      <button id="hamburger" class="btn btn-ghost btn-sm px-2 text-lg">☰</button>
      <span class="font-semibold text-sm hidden sm:inline">🤖 Claude Code</span>
      <span class="text-base-300 hidden sm:inline">/</span>
      <span id="topbar-project" class="text-sm text-base-content/50 flex-1 truncate">Select a session</span>
      <div class="flex gap-2">
        <button id="btn-new-session" class="btn btn-ghost btn-xs border border-base-300">＋ New</button>
        <button id="btn-theme"        class="btn btn-ghost btn-xs border border-base-300">🌙</button>
        <button id="btn-settings"    class="btn btn-ghost btn-xs border border-base-300">⚙️</button>
        <button id="btn-logout"      class="btn btn-ghost btn-xs border border-base-300">Sign out</button>
      </div>
    </div>
    <div class="flex flex-1 overflow-hidden relative">
      <div id="sidebar" class="bg-base-200 border-r border-base-300 flex flex-col flex-shrink-0 overflow-hidden" style="width:260px;min-width:160px;max-width:480px">
        <div class="flex items-center justify-between px-3 py-2 border-b border-base-300 flex-shrink-0">
          <span class="text-xs uppercase tracking-wider text-base-content/50 font-medium">Sessions</span>
          <div class="flex items-center gap-1">
            <span id="session-filter-badge" class="hidden text-[10px] text-primary cursor-pointer">× filter</span>
            <button id="session-sort-btn" class="btn btn-ghost btn-xs px-1 text-[10px] text-base-content/40" title="Sort">⇅ time</button>
          </div>
        </div>
        <div id="ws-tabs" class="flex overflow-x-auto border-b border-base-300 flex-shrink-0" style="scrollbar-width:none"></div>
        <div class="px-2 py-1.5 border-b border-base-300 flex-shrink-0">
          <input id="session-search" type="text" placeholder="Search path or name…"
            class="input input-xs input-bordered w-full text-xs" autocomplete="off">
        </div>
        <div id="session-list" class="overflow-y-auto flex-1"></div>
      </div>
      <div class="flex flex-col flex-shrink-0 relative" style="width:12px">
        <div id="sidebar-resize" class="absolute inset-0 bg-transparent hover:bg-primary/30 transition-colors cursor-col-resize"></div>
        <button id="sidebar-toggle" title="Toggle sidebar"
          class="absolute z-10 flex items-center justify-center w-5 h-8 bg-base-200 border border-base-300 rounded-r-md text-[10px] text-base-content/40 hover:text-base-content cursor-pointer"
          style="left:0;top:50%;transform:translateY(-50%)">◀</button>
      </div>
      <div id="main" class="flex-1 flex flex-col overflow-hidden min-w-0">
        <div id="welcome" class="flex-1 flex flex-col items-center justify-center gap-3 text-base-content/50 p-6 text-center">
          <h2 class="text-lg font-semibold text-base-content">Welcome to Claude Code</h2>
          <p class="text-sm">Select a session or start a new one</p>
          <button id="btn-new-session-welcome" class="btn btn-primary btn-sm mt-2">＋ New Session</button>
        </div>
        <div id="project-view" class="hidden flex-col flex-1 overflow-hidden">
          <div class="flex bg-base-200 border-b border-base-300 flex-shrink-0 overflow-x-auto" style="scrollbar-width:none">
            <button class="px-4 py-2.5 text-sm border-b-2 flex-shrink-0 text-primary border-primary"            data-tab="chat">Chat</button>
            <button class="px-4 py-2.5 text-sm border-b-2 flex-shrink-0 text-base-content/50 border-transparent" data-tab="files">Files</button>
            <button class="px-4 py-2.5 text-sm border-b-2 flex-shrink-0 text-base-content/50 border-transparent" data-tab="git">Git</button>
            <button class="px-4 py-2.5 text-sm border-b-2 flex-shrink-0 text-base-content/50 border-transparent" data-tab="shell">Shell</button>
            <button class="px-4 py-2.5 text-sm border-b-2 flex-shrink-0 text-base-content/50 border-transparent" data-tab="memory">🧠 Memory</button>
          </div>
          <div id="tab-chat" class="flex flex-col flex-1 overflow-hidden relative">
            <div id="messages" class="flex-1 overflow-y-auto p-3 flex flex-col gap-2"></div>
            <div id="scroll-nav" class="absolute right-3 bottom-24 flex flex-col gap-1.5 z-10">
              <button id="scroll-top-btn" class="scroll-fab hidden" title="Jump to top">↑</button>
              <button id="scroll-bottom-btn" class="scroll-fab hidden" title="Jump to bottom">↓</button>
            </div>
            <div id="permission-requests"></div>
            <div class="flex flex-col border-t border-base-300 bg-base-200 flex-shrink-0">
              <div id="chat-opts" class="hidden flex items-center gap-1.5 px-3 pt-2 flex-wrap">
                <select id="sel-model" class="select select-xs select-bordered font-mono text-xs" title="Model">
                  <option value="claude-sonnet-4-5">sonnet-4-5</option>
                  <option value="claude-sonnet-4-6">sonnet-4-6</option>
                  <option value="claude-opus-4-5">opus-4-5</option>
                  <option value="claude-haiku-4-5">haiku-4-5</option>
                </select>
                <select id="sel-effort" class="select select-xs select-bordered text-xs" title="Effort">
                  <option value="">effort: off</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                  <option value="max">max</option>
                </select>
                <select id="sel-permission" class="select select-xs select-bordered text-xs" title="Permissions">
                  <option value="default">perms: default</option>
                  <option value="acceptEdits">acceptEdits</option>
                  <option value="auto">auto</option>
                  <option value="plan">plan</option>
                  <option value="bypassPermissions">⚠ bypass all</option>
                </select>
              </div>
              <div class="flex gap-2 items-end px-3 pt-2 pb-2">
                <button id="btn-opts" class="btn btn-ghost btn-sm px-2 text-base-content/30 hover:text-base-content flex-shrink-0" title="Options" style="height:40px">⚙</button>
                <textarea id="chat-input" rows="1" placeholder="Ask Claude… (!cmd shell · ⌘↵ send)"
                  class="textarea textarea-bordered flex-1 text-sm resize-none leading-relaxed"
                  style="min-height:40px;max-height:140px"></textarea>
                <button id="send-btn" class="btn btn-primary btn-sm flex-shrink-0" style="height:40px">Send</button>
                <button id="stop-btn" class="btn btn-error btn-sm hidden flex-shrink-0" style="height:40px">■</button>
              </div>
            </div>
          </div>
          <div id="tab-files" class="hidden flex-col flex-1 overflow-hidden">
            <div class="flex items-center gap-2 px-3 py-1.5 border-b border-base-300 flex-shrink-0 bg-base-200">
              <span class="text-xs text-base-content/40 flex-shrink-0">Root</span>
              <input id="files-root-input" type="text" placeholder="Project path (leave blank for session cwd)"
                class="input input-xs flex-1 font-mono text-xs bg-transparent border-0 focus:outline-none px-1" autocomplete="off">
              <button id="files-root-btn" class="btn btn-ghost btn-xs text-xs">Go</button>
            </div>
            <div id="files-breadcrumb" class="flex items-center flex-wrap gap-1 px-4 py-2 border-b border-base-300 text-xs text-base-content/60 flex-shrink-0"></div>
            <div id="files-area" class="flex-1 overflow-y-auto"></div>
          </div>
          <div id="tab-shell" class="hidden flex-col flex-1 overflow-hidden bg-[#0d1117]">
            <div class="flex items-center gap-2 px-3 py-1.5 border-b border-base-300 bg-base-200 flex-shrink-0">
              <span class="text-xs text-base-content/40 font-mono flex-1" id="term-cwd"></span>
              <button id="term-clear"     class="btn btn-ghost btn-xs text-xs text-base-content/40">Clear</button>
              <button id="term-reconnect" class="btn btn-ghost btn-xs text-xs text-base-content/40">Reconnect</button>
            </div>
            <div id="term-output" class="flex-1 overflow-y-auto p-3 font-mono text-xs text-[#c9d1d9] whitespace-pre-wrap break-all cursor-text leading-relaxed"></div>
            <div class="flex items-center gap-2 px-3 py-2 border-t border-base-300 bg-base-200 flex-shrink-0">
              <span class="text-[#4e9a06] font-mono text-xs select-none">$</span>
              <input id="term-input" type="text" autocomplete="off" spellcheck="false"
                class="flex-1 bg-transparent font-mono text-xs text-[#c9d1d9] outline-none border-0"
                placeholder="type a command…">
            </div>
          </div>
          <div id="tab-git" class="hidden flex-col flex-1 overflow-hidden">
            <div class="flex items-center gap-2 px-3 py-1.5 border-b border-base-300 flex-shrink-0 bg-base-200">
              <span class="text-xs text-base-content/40 flex-shrink-0">Root</span>
              <input id="git-root-input" type="text" placeholder="Project path (leave blank for session cwd)"
                class="input input-xs flex-1 font-mono text-xs bg-transparent border-0 focus:outline-none px-1" autocomplete="off">
              <button id="git-root-btn" class="btn btn-ghost btn-xs text-xs">Go</button>
            </div>
            <div id="git-area" class="flex-1 overflow-y-auto"></div>
          </div>
          <div id="tab-memory" class="hidden flex-col flex-1 overflow-hidden">
            <div class="flex items-center gap-2 px-3 py-1.5 border-b border-base-300 flex-shrink-0 bg-base-200">
              <span class="text-xs text-base-content/40 flex-shrink-0">🧠 Project memory</span>
              <span class="flex-1"></span>
              <button id="memory-refresh" class="btn btn-ghost btn-xs text-xs">Refresh</button>
            </div>
            <div id="memory-area" class="flex-1 overflow-y-auto text-sm"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <dialog id="modal-new-session" class="modal">
    <div class="modal-box max-w-sm">
      <h3 class="font-bold text-base mb-4">＋ New Session</h3>
      <div class="flex flex-col gap-3">
        <label class="form-control">
          <div class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Working Directory</span></div>
          <input id="new-session-path" type="text" class="input input-bordered input-sm font-mono"
            placeholder="~/projects/my-app" autocomplete="off">
        </label>
        <label class="form-control">
          <div class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Workspace</span></div>
          <select id="new-session-workspace" class="select select-bordered select-sm"></select>
        </label>
        <div id="new-session-error" class="alert alert-error text-xs py-2 hidden"></div>
      </div>
      <div class="modal-action">
        <button id="new-session-cancel" class="btn btn-ghost btn-sm">Cancel</button>
        <button id="new-session-start"  class="btn btn-primary btn-sm">Start</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>close</button></form>
  </dialog>`;

// ── Sessions + Workspaces ─────────────────────────────────────────────────────
export async function loadAllSessions() {
  // 1. Show cached data immediately if available
  const cached = await getCachedSessions();
  if (cached) sessionsData.value = cached;

  // 2. Fetch fresh data in background
  try {
    const fresh = await api('GET', '/api/sessions');
    sessionsData.value = fresh;
    setCachedSessions(fresh);
  } catch (e) {
    if (!cached) {
      const el = $('session-list');
      if (el) el.innerHTML = `<div class="px-3 py-3 text-xs text-error">${esc(e.message)}</div>`;
    }
  }
}

async function loadWorkspaces() {
  const cached = await getCachedWorkspaces();
  if (cached) workspacesData.value = cached;
  try {
    const fresh = await api('GET', '/api/workspaces');
    workspacesData.value = fresh;
    setCachedWorkspaces(fresh);
  } catch {}
}

function formatTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000)       return 'just now';
  if (diff < 3600000)     return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000)    return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 7*86400000)  return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function sessionItemHtml(s) {
  const active    = ctx.sessionId === s.sessionId;
  const multiWs   = workspacesData.peek().length > 1;
  const wsName    = s.configDir ? s.configDir.split('/').pop() : '';
  const wsBadge   = multiWs && wsName
    ? `<span class="text-[9px] text-base-content/30 flex-shrink-0 font-mono">${esc(wsName)}</span>`
    : '';
  return `<div class="px-3 py-2 cursor-pointer hover:bg-base-300 border-l-2
              ${active ? 'border-primary bg-primary/5' : 'border-transparent'}"
       data-session-id="${esc(s.sessionId)}"
       data-session-cwd="${esc(s.cwd || '')}"
       data-session-config-dir="${esc(s.configDir || '')}">
    <div class="text-xs font-mono truncate ${active ? 'text-primary' : 'text-base-content/80'}"
         title="${esc(s.cwd || '')}">${esc(s.cwd || '(no path)')}</div>
    <div class="flex items-center justify-between mt-0.5 gap-2">
      <span class="text-[10px] text-base-content/40 truncate flex-1">${esc(s.display || s.sessionId.slice(0,8))}</span>
      <div class="flex items-center gap-1.5 flex-shrink-0">${wsBadge}<span class="text-[10px] text-base-content/30">${formatTime(s.updatedAt)}</span></div>
    </div>
  </div>`;
}

// Group sessions by their cwd (folder). Each folder is a collapsible header;
// collapsed by default, expand to reveal the sessions inside.
function renderSessionList(sessions) {
  if (!sessions.length) return '<div class="px-3 py-4 text-xs text-base-content/40">No sessions</div>';

  const groups = new Map();
  for (const s of sessions) {
    const key = s.cwd || '(no path)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const expanded = expandedFolders.value;
  // A search auto-expands every matching folder so results are visible.
  const forceOpen = !!sessionSearch.value.trim();

  return [...groups.entries()].map(([cwd, items]) => {
    const open  = forceOpen || expanded.has(cwd);
    const name  = cwd === '(no path)' ? '(no path)' : (cwd.split('/').filter(Boolean).pop() || cwd);
    const header = `
      <div class="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-base-300 select-none"
           data-folder="${esc(cwd)}">
        <span class="text-[10px] text-base-content/40 w-3 flex-shrink-0">${open ? '▾' : '▸'}</span>
        <span class="text-xs font-medium truncate flex-1" title="${esc(cwd)}">${esc(name)}</span>
        <span class="text-[10px] text-base-content/30 flex-shrink-0">${items.length}</span>
      </div>`;
    const body = open ? `<div class="border-l border-base-300 ml-3">${items.map(sessionItemHtml).join('')}</div>` : '';
    return header + body;
  }).join('');
}

function mdToHtml(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') return `<pre class="whitespace-pre-wrap text-xs">${esc(text)}</pre>`;
  try { return marked.parse(text, { breaks: true, gfm: true }); } catch { return `<pre class="whitespace-pre-wrap text-xs">${esc(text)}</pre>`; }
}

// Load the persistent memory for the currently open session into the Memory tab.
async function loadMemoryTab() {
  const body = $('memory-area');
  if (!body) return;
  if (!ctx.sessionId) {
    body.innerHTML = '<div class="p-4 text-xs text-base-content/40">Open or resume a session to view its memory.</div>';
    return;
  }
  body.innerHTML = '<div class="p-4 text-xs text-base-content/40">Loading…</div>';
  try {
    const mem = await api('GET', `/api/sessions/${ctx.sessionId}/memory`);
    const parts = [];
    if (mem.index) {
      parts.push(`<div class="mb-4"><div class="text-[11px] uppercase tracking-wide text-base-content/40 mb-1">Index (MEMORY.md)</div>
                  <div class="prose prose-sm max-w-none">${mdToHtml(mem.index)}</div></div>`);
    }
    for (const f of (mem.files || [])) {
      parts.push(`<div class="mb-3 border border-base-300 rounded-lg overflow-hidden">
                    <div class="px-3 py-1.5 bg-base-300/50 text-xs font-mono text-base-content/70">${esc(f.name)}</div>
                    <div class="px-3 py-2 prose prose-sm max-w-none">${mdToHtml(f.content)}</div>
                  </div>`);
    }
    if (!parts.length) parts.push('<div class="text-base-content/40 text-xs">No memory saved for this project yet.</div>');
    body.innerHTML = `<div class="p-4">${parts.join('')}</div>`;
  } catch (e) {
    body.innerHTML = `<div class="p-4 text-error text-xs">${esc(e?.message ?? String(e))}</div>`;
  }
}

export function openProject(project) {
  batch(() => { currentProject.value = project; sessionFilter.value = project.path; });
  ctx.sessionId = null;
  $('topbar-project').textContent = project.path;
  $('welcome').classList.add('hidden');
  const pv = $('project-view');
  pv.classList.remove('hidden');
  pv.style.display = 'flex';
  clearMessages();
  connectWS();
  switchTab('chat');
}

export async function resumeSession(sid, cwd, configDir) {
  ctx.sessionId = sid;
  ctx.configDir = configDir || null;
  if (cwd && cwd !== currentProject.peek()?.path) {
    const name = cwd.split('/').filter(Boolean).pop() || cwd;
    batch(() => { currentProject.value = { id: name, name, path: cwd }; sessionFilter.value = cwd; });
    $('topbar-project').textContent = cwd;
    // Pre-fill root inputs with session cwd so user can see/edit the path
    const fi = $('files-root-input'); if (fi && !filesRoot.peek()) fi.value = cwd;
    const gi = $('git-root-input');   if (gi && !gitRoot.peek())   gi.value = cwd;
    const pv = $('project-view');
    pv.classList.remove('hidden');
    pv.style.display = 'flex';
    $('welcome').classList.add('hidden');
    if (!ctx.ws || ctx.ws.readyState !== WebSocket.OPEN) connectWS();
  }
  clearMessages();
  switchTab('chat');
  sessionsData.value = [...sessionsData.peek()];

  appendSystemMsg('Loading history…');
  try {
    const msgs = await api('GET', `/api/sessions/${sid}/messages`);
    $('messages').innerHTML = '';
    if (!msgs.length) {
      appendSystemMsg(`Session ${sid.slice(0,8)}… — no history`);
    } else {
      for (const m of msgs) {
        if (m.type === 'text')
          appendMsg(m.role === 'user' ? 'user' : 'assistant', m.role === 'user' ? 'You' : 'Claude', m.content);
        else if (m.type === 'tool_use')
          renderToolUse({ name: m.name, input: m.input ?? {} });
        else if (m.type === 'token_usage')
          appendHistoryTokenBar(m.usage);
      }
      const turnCount = msgs.filter(m => m.type === 'token_usage').length;
      appendSystemMsg(`── history loaded · ${turnCount} turn${turnCount !== 1 ? 's' : ''} ──`);
    }
  } catch (e) {
    $('messages').innerHTML = '';
    appendSystemMsg(`Session ${sid.slice(0,8)}… (history unavailable: ${e.message})`);
  }
  syncHash();
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
export function switchTab(name) { currentTab.value = name; }

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function initAuth() {
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

export async function showApp() {
  $('auth-screen').style.display = 'none';
  const app = $('app');
  app.classList.remove('hidden');
  app.style.display = 'flex';
  await Promise.all([loadAllSessions(), loadWorkspaces()]);
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function openSidebar()  { $('sidebar').classList.add('open');    $('sidebar-overlay').classList.remove('hidden'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar-overlay').classList.add('hidden'); }
function closeSidebarOnMobile() { if (window.innerWidth <= 640) closeSidebar(); }

function initSidebarToggle() {
  const btn     = $('sidebar-toggle');
  const sidebar = $('sidebar');
  let collapsed = false;
  let savedWidth = sidebar.style.width || '260px';

  btn.addEventListener('click', () => {
    collapsed = !collapsed;
    if (collapsed) {
      savedWidth = sidebar.style.width || '260px';
      sidebar.style.width = '0';
      sidebar.style.minWidth = '0';
      sidebar.style.overflow = 'hidden';
    } else {
      sidebar.style.width = savedWidth;
      sidebar.style.minWidth = '';
      sidebar.style.overflow = '';
    }
    btn.textContent = collapsed ? '▶' : '◀';
  });
}

function initSidebarResize() {
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
  });
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const btn = $('btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

// ── New Session modal ─────────────────────────────────────────────────────────
function openNewSessionModal() {
  const sel = $('new-session-workspace');
  if (sel) {
    const wss = workspacesData.peek();
    sel.innerHTML = wss.map(w =>
      `<option value="${esc(w.configDir)}">${esc(w.name)} — ${esc(w.configDir)}</option>`
    ).join('');
    // pre-select current session's workspace
    if (ctx.configDir) sel.value = ctx.configDir;
  }
  $('new-session-path').value = currentProject.peek()?.path || '';
  $('new-session-error').classList.add('hidden');
  $('modal-new-session').showModal();
  setTimeout(() => $('new-session-path').focus(), 50);
}

async function startNewSession() {
  const rawPath  = $('new-session-path').value.trim();
  const configDir = $('new-session-workspace').value;
  const errEl    = $('new-session-error');
  errEl.classList.add('hidden');

  if (!rawPath) { errEl.textContent = 'Working directory is required'; errEl.classList.remove('hidden'); return; }

  try {
    const result = await api('POST', '/api/resolve-path', { path: rawPath });
    if (!result.isDir) throw new Error('Path is not a directory');

    $('modal-new-session').close();

    const name = result.path.split('/').filter(Boolean).pop() || result.path;
    ctx.sessionId = null;
    ctx.configDir = configDir || null;
    batch(() => {
      currentProject.value = { id: name, name, path: result.path };
      sessionFilter.value  = result.path;
    });
    $('topbar-project').textContent = result.path;
    $('welcome').classList.add('hidden');
    const pv = $('project-view');
    pv.classList.remove('hidden');
    pv.style.display = 'flex';
    clearMessages();
    connectWS();
    switchTab('chat');
    appendSystemMsg(`New session · ${result.path}`);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

// ── Init — render HTML, wire everything up ────────────────────────────────────
export function initShell() {
  // 0. Restore saved theme
  applyTheme(localStorage.getItem('theme') || 'dark');

  // 1. Render into #root (ensure it fills viewport)
  const root = document.getElementById('root');
  root.style.cssText = 'display:flex;flex-direction:column;flex:1;height:100%';
  root.innerHTML = AuthScreen() + AppShell();

  // 2. Workspace tabs
  effect(() => {
    const wss   = workspacesData.value;
    const tabs  = $('ws-tabs');
    if (!tabs) return;
    if (wss.length <= 1) { tabs.innerHTML = ''; return; }
    const activeId = sessionFilter.peek();  // sessionFilter holds configDir when filtering by ws
    tabs.innerHTML = [{ id: null, name: 'All' }, ...wss].map(w => {
      const active = w.id === null ? !activeId : activeId === w.configDir;
      return `<button class="px-3 py-1.5 text-[11px] flex-shrink-0 border-b-2 whitespace-nowrap
                ${active ? 'border-primary text-primary' : 'border-transparent text-base-content/50 hover:text-base-content'}"
              data-ws-tab="${esc(w.configDir || '')}">
        ${esc(w.name)}
      </button>`;
    }).join('');
  });

  // 3. Reactive session list
  effect(() => {
    const el = $('session-list');
    if (!el) return;
    el.innerHTML = renderSessionList(filteredSessions.value);
  });

  // 3. Filter badge
  watch(sessionFilter, f => {
    const badge = $('session-filter-badge');
    if (!badge) return;
    badge.style.display = f ? 'inline' : 'none';
    badge.title = f || '';
  });

  // 4. Tab switching
  watch(currentTab, tab => {
    document.querySelectorAll('[data-tab]').forEach(btn => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('text-primary',         active);
      btn.classList.toggle('border-primary',       active);
      btn.classList.toggle('text-base-content/50', !active);
      btn.classList.toggle('border-transparent',   !active);
    });
    ['chat', 'files', 'git', 'shell', 'memory'].forEach(id => {
      const el = $(`tab-${id}`);
      el.classList.toggle('hidden', id !== tab);
      el.style.display = id === tab ? 'flex' : '';
    });
    if (tab === 'memory') loadMemoryTab();
  });

  // 5. Sidebar resize + collapse
  initSidebarResize();
  initSidebarToggle();

  // 6. Listen for new sessions from WS
  document.addEventListener('sessions-changed', loadAllSessions);

  // 7. Router: deep-link to a session by id
  document.addEventListener('router:session', async ({ detail: { id, tab } }) => {
    const s = sessionsData.peek().find(s => s.sessionId === id);
    await resumeSession(id, s?.cwd || null, s?.configDir || null);
    if (tab && ['chat','files','git','shell','memory'].includes(tab)) switchTab(tab);
  });

  // 7. Event delegation
  delegate.on('click', '#auth-btn', submitAuth);
  delegate.on('keydown', '#auth-username, #auth-password', e => { if (e.key === 'Enter') submitAuth(); });
  delegate.on('click', '#hamburger', () => $('sidebar').classList.contains('open') ? closeSidebar() : openSidebar());
  delegate.on('click', '#sidebar-overlay', closeSidebar);

  delegate.on('input', '#session-search', (_, el) => { sessionSearch.value = el.value; });
  delegate.on('click', '#session-sort-btn', () => {
    sessionSort.value = sessionSort.peek() === 'time' ? 'project' : 'time';
    $('session-sort-btn').textContent = `⇅ ${sessionSort.peek()}`;
  });
  delegate.on('click', '#session-filter-badge', () => { sessionFilter.value = null; });
  delegate.on('click', '[data-ws-tab]', (_, el) => { sessionFilter.value = el.dataset.wsTab || null; });
  delegate.on('click', '#btn-settings', openSettings);
  delegate.on('click', '#btn-theme', toggleTheme);

  delegate.on('click', '[data-session-id]', (e, el) => {
    resumeSession(el.dataset.sessionId, el.dataset.sessionCwd || null, el.dataset.sessionConfigDir || null);
    closeSidebarOnMobile();
  });

  delegate.on('click', '[data-folder]', (_, el) => {
    const cwd  = el.dataset.folder;
    const next = new Set(expandedFolders.peek());
    next.has(cwd) ? next.delete(cwd) : next.add(cwd);
    expandedFolders.value = next;   // new Set → triggers the session-list effect
  });

  delegate.on('click', '#memory-refresh', loadMemoryTab);

  delegate.on('click', '[data-tab]',       (e, el) => switchTab(el.dataset.tab));

  // Custom root path for Files / Git tabs — POST to resolve & validate
  const applyRoot = async (inputId, sig) => {
    const input = $(inputId);
    const raw   = input?.value.trim();
    if (!raw) { sig.value = ''; return; }
    try {
      const result = await api('POST', '/api/resolve-path', { path: raw });
      sig.value = result.path;
      input.value = result.path;  // show the resolved absolute path
    } catch (e) {
      input.style.color = 'oklch(var(--er))';
      input.title = e.message;
      setTimeout(() => { input.style.color = ''; input.title = ''; }, 2000);
    }
  };
  delegate.on('click', '#files-root-btn', () => applyRoot('files-root-input', filesRoot));
  delegate.on('click', '#git-root-btn',   () => applyRoot('git-root-input',   gitRoot));
  delegate.on('keydown', '#files-root-input', e => { if (e.key === 'Enter') applyRoot('files-root-input', filesRoot); });
  delegate.on('keydown', '#git-root-input',   e => { if (e.key === 'Enter') applyRoot('git-root-input',   gitRoot); });
  // Options toggle
  delegate.on('click', '#btn-opts', () => {
    $('chat-opts').classList.toggle('hidden');
  });

  // Model / effort / permission selectors
  delegate.on('change', '#sel-model',      (_, el) => { currentModel.value      = el.value; });
  delegate.on('change', '#sel-effort',     (_, el) => { currentEffort.value     = el.value; });
  delegate.on('change', '#sel-permission', (_, el) => { currentPermission.value = el.value; });

  delegate.on('click', '#btn-new-session, #btn-new-session-welcome', openNewSessionModal);
  delegate.on('click', '#new-session-cancel', () => $('modal-new-session').close());
  delegate.on('click', '#new-session-start',  startNewSession);
  delegate.on('keydown', '#new-session-path', e => { if (e.key === 'Enter') startNewSession(); });
  delegate.on('click', '#send-btn',        sendMessage);
  delegate.on('click', '#stop-btn',        stopProcessing);
  delegate.on('click', '#btn-logout',      () => { ctx.token = null; localStorage.removeItem('token'); location.reload(); });
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
