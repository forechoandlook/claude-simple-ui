// shell.js — HTML templates, layout bootstrap, sidebar, tabs, auth, modals
import { watch, batch, computed, delegate, keyedList, defineComponent, esc, $ } from './lib.js';
import { projectsData, sessionsData, sessionFilter, filteredSessions,
         currentProject, currentTab, ctx } from './state.js';
import { api } from './api.js';
import { connectWS, clearMessages, appendMsg, appendSystemMsg, renderToolUse,
         sendMessage, stopProcessing, newSession } from './chat.js';

// ── HTML Templates ────────────────────────────────────────────────────────────
const AuthScreen = () => `
  <div id="auth-screen" class="flex items-center justify-center h-dvh p-4">
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
      <span id="topbar-project" class="text-sm text-base-content/50 flex-1 truncate">Select a project</span>
      <div class="flex gap-2">
        <button id="btn-new-session" class="btn btn-ghost btn-xs border border-base-300">＋ Session</button>
        <button id="btn-logout"      class="btn btn-ghost btn-xs border border-base-300">Sign out</button>
      </div>
    </div>
    <div class="flex flex-1 overflow-hidden relative">
      <div id="sidebar" class="w-64 bg-base-200 border-r border-base-300 flex flex-col flex-shrink-0 overflow-hidden">
        <div class="flex flex-col overflow-hidden" style="max-height:50%;min-height:120px">
          <div class="flex items-center justify-between px-3 py-2 border-b border-base-300">
            <span class="text-xs uppercase tracking-wider text-base-content/50 font-medium">Projects</span>
            <button id="btn-new-project" class="btn btn-ghost btn-xs">＋</button>
          </div>
          <div id="project-list" class="overflow-y-auto flex-1"></div>
        </div>
        <div class="flex flex-col flex-1 overflow-hidden border-t border-base-300">
          <div class="flex items-center justify-between px-3 py-2 border-b border-base-300">
            <span class="text-xs uppercase tracking-wider text-base-content/50 font-medium">Sessions</span>
            <span id="session-filter-badge" class="hidden text-[10px] text-primary cursor-pointer">× filter</span>
          </div>
          <div id="session-list" class="overflow-y-auto flex-1"></div>
        </div>
      </div>
      <div id="main" class="flex-1 flex flex-col overflow-hidden min-w-0">
        <div id="welcome" class="flex-1 flex flex-col items-center justify-center gap-3 text-base-content/50 p-6 text-center">
          <h2 class="text-lg font-semibold text-base-content">Welcome to Claude Code</h2>
          <p class="text-sm">Select or create a project to start</p>
          <button id="btn-new-project-welcome" class="btn btn-primary btn-sm mt-2">Create Project</button>
        </div>
        <div id="project-view" class="hidden flex-col flex-1 overflow-hidden">
          <div class="flex bg-base-200 border-b border-base-300 flex-shrink-0 overflow-x-auto" style="scrollbar-width:none">
            <button class="px-4 py-2.5 text-sm border-b-2 flex-shrink-0 text-primary border-primary"            data-tab="chat">Chat</button>
            <button class="px-4 py-2.5 text-sm border-b-2 flex-shrink-0 text-base-content/50 border-transparent" data-tab="files">Files</button>
            <button class="px-4 py-2.5 text-sm border-b-2 flex-shrink-0 text-base-content/50 border-transparent" data-tab="git">Source Control</button>
          </div>
          <div id="tab-chat" class="flex flex-col flex-1 overflow-hidden">
            <div id="messages" class="flex-1 overflow-y-auto p-3 flex flex-col gap-2"></div>
            <div id="permission-requests"></div>
            <div class="flex gap-2 items-end p-3 border-t border-base-300 bg-base-200 flex-shrink-0">
              <textarea id="chat-input" rows="1" placeholder="Ask Claude… or !cmd for shell"
                class="textarea textarea-bordered flex-1 text-sm resize-none leading-relaxed"
                style="min-height:40px;max-height:140px"></textarea>
              <button id="send-btn" class="btn btn-primary btn-sm" style="height:40px">Send</button>
              <button id="stop-btn" class="btn btn-error btn-sm hidden" style="height:40px">■</button>
            </div>
          </div>
          <div id="tab-files" class="hidden flex-col flex-1 overflow-hidden">
            <div id="files-breadcrumb" class="flex items-center flex-wrap gap-1 px-4 py-2 border-b border-base-300 text-xs text-base-content/60 flex-shrink-0"></div>
            <div id="files-area" class="flex-1 overflow-y-auto"></div>
          </div>
          <div id="tab-git" class="hidden flex-col flex-1 overflow-hidden">
            <div id="git-area" class="flex-1 overflow-y-auto"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <dialog id="modal-new-project" class="modal">
    <div class="modal-box max-w-sm">
      <h3 class="font-bold text-base mb-4">Create New Project</h3>
      <label class="form-control mb-3">
        <div class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Folder Name</span></div>
        <input id="new-project-name" type="text" class="input input-bordered input-sm" placeholder="my-project" autocomplete="off">
      </label>
      <div id="new-project-error" class="alert alert-error text-xs py-2 hidden mb-3"></div>
      <div class="modal-action">
        <button id="modal-cancel" class="btn btn-ghost btn-sm">Cancel</button>
        <button id="modal-create" class="btn btn-primary btn-sm">Create</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>close</button></form>
  </dialog>`;

const ProjectItem = defineComponent(({ p, active }) => `
  <div class="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-base-300 ${active ? 'bg-primary/10' : ''}"
       data-project-id="${esc(p.id)}" data-project-path="${esc(p.path)}" data-project-name="${esc(p.name)}">
    <span class="text-base-content/40 flex-shrink-0 text-sm">📁</span>
    <span class="text-sm flex-1 truncate ${active ? 'text-primary font-medium' : ''}">${esc(p.name)}</span>
    ${p.isGit ? '<span class="badge badge-success badge-xs">git</span>' : ''}
  </div>`);

const SessionItem = defineComponent(({ s, active, showProject }) => `
  <div class="flex items-start gap-2 px-3 py-1.5 cursor-pointer border-l-2 hover:bg-base-300
              ${active ? 'border-primary bg-primary/5' : 'border-transparent'}"
       data-session-id="${esc(s.sessionId)}" data-session-cwd="${esc(s.cwd || '')}">
    <span class="text-base-content/40 text-sm flex-shrink-0 mt-0.5">💬</span>
    <div class="flex-1 min-w-0">
      <div class="text-xs truncate ${active ? '' : 'text-base-content/60'}" title="${esc(s.cwd||'')}">${esc(s.display)}</div>
      ${showProject ? `<div class="text-[10px] text-base-content/40 truncate mt-0.5">${esc(s.projectName||'')}</div>` : ''}
    </div>
  </div>`);

// ── Projects & Sessions ───────────────────────────────────────────────────────
export async function loadProjects() {
  try { projectsData.value = await api('GET', '/api/projects'); }
  catch (e) { $('project-list').innerHTML = `<div class="px-3 py-3 text-xs text-error">${esc(e.message)}</div>`; }
}

export async function loadAllSessions() {
  try { sessionsData.value = await api('GET', '/api/sessions'); }
  catch (e) { $('session-list').innerHTML = `<div class="px-3 py-3 text-xs text-error">${esc(e.message)}</div>`; }
}

export function openProject(project) {
  batch(() => { currentProject.value = project; sessionFilter.value = project.path; });
  ctx.sessionId = null;
  $('topbar-project').textContent = project.name;
  $('welcome').classList.add('hidden');
  const pv = $('project-view');
  pv.classList.remove('hidden');
  pv.style.display = 'flex';
  clearMessages();
  connectWS();
  switchTab('chat');
}

export async function resumeSession(sid, cwd) {
  ctx.sessionId = sid;
  if (cwd && cwd !== currentProject.peek()?.path) {
    const name = cwd.split('/').filter(Boolean).pop() || cwd;
    batch(() => { currentProject.value = { id: name, name, path: cwd }; sessionFilter.value = cwd; });
    $('topbar-project').textContent = name;
    const pv = $('project-view');
    pv.classList.remove('hidden');
    pv.style.display = 'flex';
    $('welcome').classList.add('hidden');
    if (!ctx.ws || ctx.ws.readyState !== WebSocket.OPEN) connectWS();
  }
  clearMessages();
  switchTab('chat');
  sessionsData.value = [...sessionsData.peek()]; // nudge for active-state re-render

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
      }
      appendSystemMsg(`── ${msgs.length} messages loaded · continuing session ──`);
    }
  } catch (e) {
    $('messages').innerHTML = '';
    appendSystemMsg(`Session ${sid.slice(0,8)}… (history unavailable: ${e.message})`);
  }
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
  await Promise.all([loadProjects(), loadAllSessions()]);
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function openSidebar()  { $('sidebar').classList.add('open');    $('sidebar-overlay').classList.remove('hidden'); }
function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar-overlay').classList.add('hidden'); }
function closeSidebarOnMobile() { if (window.innerWidth <= 640) closeSidebar(); }

// ── Modal ─────────────────────────────────────────────────────────────────────
function openNewProjectModal() {
  $('new-project-name').value = '';
  $('new-project-error').classList.add('hidden');
  $('modal-new-project').showModal();
  setTimeout(() => $('new-project-name').focus(), 50);
}

async function createProject() {
  const name = $('new-project-name').value.trim();
  const errEl = $('new-project-error');
  errEl.classList.add('hidden');
  try {
    const project = await api('POST', '/api/projects', { name });
    $('modal-new-project').close();
    projectsData.value = await api('GET', '/api/projects');
    openProject(project);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

// ── Init — render HTML, wire everything up ────────────────────────────────────
export function initShell() {
  // 1. Render static shell into #root
  document.getElementById('root').innerHTML = AuthScreen() + AppShell();

  // 2. Reactive project list (keyedList: DOM diff + slide animations)
  const projectListData = computed(() => { currentProject.value; return projectsData.value; });
  const setupProjects = keyedList(
    projectListData,
    p => ProjectItem({ p, active: currentProject.peek()?.id === p.id }),
    p => p.id
  );
  setupProjects($('project-list'));

  // 3. Reactive session list
  const setupSessions = keyedList(
    filteredSessions,
    s => SessionItem({ s, active: ctx.sessionId === s.sessionId, showProject: !sessionFilter.peek() && !!s.cwd }),
    s => s.sessionId
  );
  setupSessions($('session-list'));

  // 4. Filter badge visibility
  watch(sessionFilter, f => {
    const badge = $('session-filter-badge');
    if (!badge) return;
    badge.style.display = f ? 'inline' : 'none';
    badge.title = f || '';
  });

  // 5. Tab switching
  watch(currentTab, tab => {
    document.querySelectorAll('[data-tab]').forEach(btn => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('text-primary',         active);
      btn.classList.toggle('border-primary',       active);
      btn.classList.toggle('text-base-content/50', !active);
      btn.classList.toggle('border-transparent',   !active);
    });
    ['chat', 'files', 'git'].forEach(id => {
      const el = $(`tab-${id}`);
      el.classList.toggle('hidden', id !== tab);
      el.style.display = id === tab ? 'flex' : '';
    });
  });

  // 6. Listen for new sessions from WS (avoids circular import with chat.js)
  document.addEventListener('sessions-changed', loadAllSessions);

  // 7. Event delegation
  delegate.on('click', '#auth-btn', submitAuth);
  delegate.on('keydown', '#auth-username, #auth-password', e => { if (e.key === 'Enter') submitAuth(); });
  delegate.on('click', '#hamburger', () => $('sidebar').classList.contains('open') ? closeSidebar() : openSidebar());
  delegate.on('click', '#sidebar-overlay', closeSidebar);

  delegate.on('click', '#btn-new-project, #btn-new-project-welcome', openNewProjectModal);
  delegate.on('click', '#modal-cancel',   () => $('modal-new-project').close());
  delegate.on('click', '#modal-create',   createProject);
  delegate.on('keydown', '#new-project-name', e => { if (e.key === 'Enter') createProject(); });

  delegate.on('click', '[data-project-id]', (e, el) => {
    openProject({ id: el.dataset.projectId, name: el.dataset.projectName, path: el.dataset.projectPath });
    closeSidebarOnMobile();
  });
  delegate.on('click', '[data-session-id]', (e, el) => {
    resumeSession(el.dataset.sessionId, el.dataset.sessionCwd || null);
    closeSidebarOnMobile();
  });
  delegate.on('click', '#session-filter-badge', () => { sessionFilter.value = null; });

  delegate.on('click', '[data-tab]',       (e, el) => switchTab(el.dataset.tab));
  delegate.on('click', '#btn-new-session', newSession);
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
