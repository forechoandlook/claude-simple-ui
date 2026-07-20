// shell.js — HTML templates, layout bootstrap, sidebar, tabs, auth, modals
import { watch, effect, batch, computed, delegate, esc, $ } from './lib.js';
import { sessionsData, workspacesData, sessionFilter, sessionSearch, sessionSort,
         expandedFolders, collapsedFolders, filesPath, viewingFile, filteredSessions, projectGroups, currentProject, currentTab, filesRoot, gitRoot,
         currentModel, currentEffort, currentPermission, currentAgent, setAgent,
         sidebarView, agentFilter, timeRange, activityHits, activityLoading,
         chatDensity, setChatDensity,
         sessionMetaMap, favoritesOnly, LOW_TURN_THRESHOLD, metaKey, getSessionMeta,
         hubMode, machinesList,
         AGENT_LABELS, AGENT_MODELS, AGENT_DEFAULT_MODEL, ctx } from './state.js';
import { api, probeHub } from './api.js';
import { getCachedSessions, setCachedSessions, getCachedWorkspaces, setCachedWorkspaces } from './cache.js';
import { connectWS, clearMessages, appendMsg, appendSystemMsg, renderToolUse,
         appendHistoryTokenBar, appendContextBar, sendMessage, stopProcessing, attachImage,
         flushToolBatch, applyChatDensity, coerceTs } from './chat.js';
import { setHash, syncHash } from './router.js';
import { initSettings, openSettings } from './settings.js';

// ── HTML Templates ────────────────────────────────────────────────────────────
const AuthScreen = () => `
  <div id="auth-screen" class="${ctx.token ? 'hidden' : ''} flex items-center justify-center h-full p-4" ${ctx.token ? 'style="display:none"' : ''}>
    <div class="card bg-base-200 border border-base-300 w-full max-w-sm shadow-xl">
      <div class="card-body gap-3 p-8">
        <h1 class="text-xl font-bold">🤖 Agent UI</h1>
        <p id="auth-subtitle" class="text-sm text-base-content/60 mb-1">Claude · Codex · Grok</p>
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
  <div id="app" class="${ctx.token ? '' : 'hidden'} flex-col flex-1 overflow-hidden" ${ctx.token ? 'style="display:flex"' : 'style="display:none"'}>
    <div class="flex items-center gap-2 px-3 bg-base-200 border-b border-base-300 flex-shrink-0" style="height:44px">
      <button id="hamburger" class="btn btn-ghost btn-sm px-2 text-lg">☰</button>
      <span id="btn-home" class="font-semibold text-sm hidden sm:inline cursor-pointer hover:text-primary transition-colors select-none">🤖 Agent UI</span>
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
      <div id="sidebar" class="bg-base-200 border-r border-base-300 flex flex-col flex-shrink-0 overflow-hidden" style="width:280px;min-width:180px;max-width:520px">
        <div class="flex items-center justify-between px-3 py-2 border-b border-base-300 flex-shrink-0">
          <span class="text-xs uppercase tracking-wider text-base-content/50 font-medium">Projects</span>
          <div class="flex items-center gap-1">
            <span id="session-filter-badge" class="hidden text-[10px] text-primary cursor-pointer">× filter</span>
            <button id="sidebar-refresh" class="btn btn-ghost btn-xs px-1 text-[10px] text-base-content/40" title="Refresh">↻</button>
          </div>
        </div>
        <div id="ws-tabs" class="flex overflow-x-auto border-b border-base-300 flex-shrink-0" style="scrollbar-width:none"></div>
        <div class="px-2 py-1.5 border-b border-base-300 flex-shrink-0 flex flex-col gap-1.5">
          <input id="session-search" type="text" placeholder="Search projects & recent work…"
            class="input input-xs input-bordered w-full text-xs" autocomplete="off">
          <div class="flex items-center gap-1 flex-wrap">
            <div id="view-tabs" class="flex rounded-md border border-base-300 overflow-hidden text-[10px]">
              <button data-view="projects" class="px-2 py-0.5 bg-primary/15 text-primary font-medium">Projects</button>
              <button data-view="timeline" class="px-2 py-0.5 text-base-content/50 hover:bg-base-300">Recent</button>
            </div>
            <select id="time-range" class="select select-xs select-bordered text-[10px] h-6 min-h-0 py-0 pl-1 pr-6" title="Time range">
              <option value="1">Today</option>
              <option value="7">7d</option>
              <option value="14" selected>14d</option>
              <option value="30">30d</option>
              <option value="0">All</option>
            </select>
          </div>
          <div id="agent-filter" class="flex gap-1 flex-wrap">
            <button data-agent-filter="all" class="agent-pill active">All</button>
            <button data-agent-filter="claude" class="agent-pill">Claude</button>
            <button data-agent-filter="codex" class="agent-pill">Codex</button>
            <button data-agent-filter="grok" class="agent-pill">Grok</button>
            <button id="btn-fav-filter" class="agent-pill" title="Show only favorites">★ Fav</button>
          </div>
          <div id="search-status" class="hidden text-[10px] text-base-content/40 px-0.5"></div>
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
        <div id="welcome" class="flex-1 flex flex-col items-center justify-start overflow-y-auto p-4 md:p-6 gap-5">
          <div class="max-w-4xl w-full text-center flex flex-col items-center gap-2 mt-2 md:mt-4">
            <h2 class="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent select-none">🤖 Agent UI</h2>
            <p class="text-sm text-base-content/65 max-w-md">Claude · Codex · Grok — Select a session from the sidebar or click a day on the calendar to view activity.</p>
            <button id="btn-new-session-welcome" class="btn btn-primary btn-sm mt-0.5 shadow-md">＋ New Session</button>
          </div>
          
          <!-- Stats Banner -->
          <div class="max-w-4xl w-full grid grid-cols-2 md:grid-cols-4 gap-4 text-center select-none mt-1">
            <div class="bg-base-200 border border-base-300 rounded-2xl p-3 shadow-md flex flex-col justify-center items-center">
              <span class="text-[10px] uppercase tracking-wider text-base-content/40 font-bold">Total Sessions</span>
              <span id="stats-total-sessions" class="text-xl md:text-2xl font-extrabold text-primary mt-0.5">0</span>
            </div>
            <div class="bg-base-200 border border-base-300 rounded-2xl p-3 shadow-md flex flex-col justify-center items-center">
              <span class="text-[10px] uppercase tracking-wider text-base-content/40 font-bold">Active Projects</span>
              <span id="stats-total-projects" class="text-xl md:text-2xl font-extrabold text-accent mt-0.5">0</span>
            </div>
            <div class="bg-base-200 border border-base-300 rounded-2xl p-3 shadow-md flex flex-col justify-center items-center">
              <span class="text-[10px] uppercase tracking-wider text-base-content/40 font-bold">Total Tokens</span>
              <span id="stats-total-tokens" class="text-xl md:text-2xl font-extrabold text-secondary mt-0.5">0</span>
            </div>
            <div class="bg-base-200 border border-base-300 rounded-2xl p-3 shadow-md flex flex-col justify-center items-center">
              <span class="text-[10px] uppercase tracking-wider text-base-content/40 font-bold">Selected Day Tokens</span>
              <span id="stats-selected-tokens" class="text-xl md:text-2xl font-extrabold text-success mt-0.5">0</span>
            </div>
          </div>
          <div class="max-w-4xl w-full grid grid-cols-1 md:grid-cols-12 gap-5 items-start text-left">
            <!-- Calendar Card -->
            <div class="card bg-base-200 border border-base-300 md:col-span-7 shadow-xl">
              <div class="card-body p-4">
                <div class="flex items-center justify-between mb-3">
                  <button id="btn-cal-prev" class="btn btn-ghost btn-sm text-base font-bold">◀</button>
                  <h3 id="calendar-month-year" class="text-base font-extrabold text-base-content select-none"></h3>
                  <button id="btn-cal-next" class="btn btn-ghost btn-sm text-base font-bold">▶</button>
                </div>
                
                <div class="grid grid-cols-7 gap-2 text-center text-[10px] font-bold text-base-content/40 mb-1">
                  <div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
                </div>
                
                <div id="calendar-grid" class="grid grid-cols-7 gap-2">
                  <!-- JS Rendered -->
                </div>
              </div>
            </div>
            
            <!-- Details Card -->
            <div class="card bg-base-200 border border-base-300 md:col-span-5 shadow-xl min-h-[290px] flex flex-col">
              <div class="card-body p-4 flex flex-col flex-1">
                <h3 id="selected-day-title" class="card-title text-xs font-bold uppercase tracking-wider text-base-content/50 mb-3 select-none">Daily Activity</h3>
                <div id="selected-day-sessions" class="flex-1 overflow-y-auto flex flex-col gap-2 max-h-[250px]">
                  <div class="text-center text-xs text-base-content/40 my-auto py-6">Select a date on the calendar to view its sessions.</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Recent Sessions Section -->
          <div class="max-w-4xl w-full border-t border-base-300/60 pt-4 mt-1 text-left">
            <h3 class="text-xs font-bold uppercase tracking-wider text-base-content/50 mb-3 select-none">Recent Workspaces & Sessions</h3>
            <div id="recent-sessions-list" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              <!-- JS Rendered -->
            </div>
          </div>
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
            <div id="project-notes-bar" class="bg-base-200 border-b border-base-300 px-3 py-1.5 text-xs flex flex-col gap-1" style="display:none"></div>
            <div id="session-notes-bar" class="bg-base-200/80 border-b border-base-300 px-3 py-1 text-xs flex justify-between items-center gap-2" style="display:none"></div>
            <div id="messages" class="flex-1 overflow-y-auto p-3 flex flex-col gap-2"></div>
            <div id="scroll-nav" class="absolute right-3 bottom-24 flex flex-col gap-1.5 z-10">
              <button id="scroll-top-btn" class="scroll-fab hidden" title="Jump to top">↑</button>
              <button id="scroll-bottom-btn" class="scroll-fab hidden" title="Jump to bottom">↓</button>
            </div>
            <div id="permission-requests"></div>
            <div class="flex flex-col border-t border-base-300 bg-base-200 flex-shrink-0">
              <div id="chat-opts" class="hidden flex items-center gap-1.5 px-3 pt-2 flex-wrap">
                <select id="sel-agent" class="select select-xs select-bordered text-xs font-semibold" title="Agent">
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                  <option value="grok">Grok</option>
                </select>
                <select id="sel-convert-agent" class="select select-xs select-bordered text-xs font-semibold" title="Convert session to another agent">
                  <option value="" disabled selected>Convert to...</option>
                  <option value="claude">Convert to Claude</option>
                  <option value="codex">Convert to Codex</option>
                  <option value="grok">Convert to Grok</option>
                </select>
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
                <select id="sel-density" class="select select-xs select-bordered text-xs" title="Chat density — how tools are shown">
                  <option value="clean">density: clean</option>
                  <option value="normal">density: normal</option>
                  <option value="full">density: full</option>
                </select>
              </div>
              <div class="flex gap-2 items-end px-3 pt-2 pb-2">
                <button id="btn-opts" class="btn btn-ghost btn-sm px-2 text-base-content/30 hover:text-base-content flex-shrink-0" title="Options" style="height:40px">⚙</button>
                <textarea id="chat-input" rows="1" placeholder="Ask… (!cmd shell · ⌘↵ send)"
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
              <button id="term-reconnect" class="btn btn-ghost btn-xs text-xs text-base-content/40">Reconnect</button>
            </div>
            <div id="terminal-container" class="flex-1 p-2 overflow-hidden"></div>
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
          <div class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Agent</span></div>
          <select id="new-session-agent" class="select select-bordered select-sm">
            <option value="claude">Claude Code</option>
            <option value="codex">OpenAI Codex</option>
            <option value="grok">Grok</option>
          </select>
        </label>
        <label class="form-control" id="new-session-machine-wrap" style="display:none">
          <div class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Machine (edge server)</span></div>
          <select id="new-session-machine" class="select select-bordered select-sm"></select>
        </label>
        <label class="form-control">
          <div class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Working Directory</span></div>
          <input id="new-session-path" type="text" class="input input-bordered input-sm font-mono"
            placeholder="~/projects/my-app" autocomplete="off">
        </label>
        <label class="form-control" id="new-session-ws-wrap">
          <div class="label py-1"><span class="label-text text-xs uppercase tracking-wide">Claude Workspace</span></div>
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

let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth(); // 0-11
let selectedCalDate = null;

function getLocalDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getMonthGrid(year, month) {
  const cells = [];
  const firstDay = new Date(year, month, 1);
  const startDay = firstDay.getDay();
  const lastDay = new Date(year, month + 1, 0);
  const totalDays = lastDay.getDate();
  const prevLastDay = new Date(year, month, 0).getDate();
  
  for (let i = startDay - 1; i >= 0; i--) {
    cells.push({
      date: new Date(year, month - 1, prevLastDay - i),
      isCurrentMonth: false
    });
  }
  
  for (let i = 1; i <= totalDays; i++) {
    cells.push({
      date: new Date(year, month, i),
      isCurrentMonth: true
    });
  }
  
  const remaining = 7 - (cells.length % 7);
  if (remaining < 7) {
    for (let i = 1; i <= remaining; i++) {
      cells.push({
        date: new Date(year, month + 1, i),
        isCurrentMonth: false
      });
    }
  }
  
  return cells;
}

function getSessionsForDate(date, sessions) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return sessions.filter(s => {
    const ts = coerceTs(s.updatedAt);
    return ts >= start && ts < end;
  });
}

function formatTokenCount(n) {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function updateDashboard(sessions) {
  const grid = $('calendar-grid');
  if (!grid) return;

  const header = $('calendar-month-year');
  if (header) {
    const dummyDate = new Date(calYear, calMonth, 1);
    header.textContent = dummyDate.toLocaleDateString([], { month: 'long', year: 'numeric' });
  }

  // Calculate total sessions, unique projects, and total tokens
  const totalSessions = sessions.length;
  const uniqueProjects = new Set(sessions.map(s => s.cwd).filter(Boolean)).size;
  const totalTokens = sessions.reduce((acc, s) => acc + (s.totalTokens || 0), 0);

  const tSessionsEl = $('stats-total-sessions');
  const tProjectsEl = $('stats-total-projects');
  const tTokensEl = $('stats-total-tokens');

  if (tSessionsEl) tSessionsEl.textContent = String(totalSessions);
  if (tProjectsEl) tProjectsEl.textContent = String(uniqueProjects);
  if (tTokensEl) tTokensEl.textContent = formatTokenCount(totalTokens);

  const cells = getMonthGrid(calYear, calMonth);

  if (!selectedCalDate) {
    selectedCalDate = getLocalDateString(new Date());
  }

  grid.innerHTML = cells.map(cell => {
    const day = cell.date;
    const dateStr = getLocalDateString(day);
    const daySessions = getSessionsForDate(day, sessions);
    const count = daySessions.length;
    const isToday = day.toDateString() === new Date().toDateString();
    const isSelected = dateStr === selectedCalDate;
    
    let bgClass = '';
    let textClass = 'text-base-content/65';
    let borderClass = 'border border-transparent';
    let cursorClass = 'cursor-default';
    let opacityClass = cell.isCurrentMonth ? '' : 'opacity-25';

    if (count > 0) {
      cursorClass = 'cursor-pointer';
      if (count <= 2) {
        bgClass = 'bg-primary/15';
        textClass = 'text-primary font-bold';
        borderClass = 'border border-primary/30';
      } else if (count <= 5) {
        bgClass = 'bg-primary/30';
        textClass = 'text-primary font-bold';
        borderClass = 'border border-primary/50';
      } else {
        bgClass = 'bg-primary/60';
        textClass = 'text-primary-content font-bold';
        borderClass = 'border border-primary/80';
      }
    } else {
      bgClass = 'bg-base-300/25';
      if (cell.isCurrentMonth) cursorClass = 'hover:bg-base-300/50';
    }

    if (isToday) {
      borderClass = 'border-2 border-primary';
    } else if (isSelected) {
      borderClass = 'border-2 border-accent';
    }

    const monthLabel = day.getDate() === 1 ? `<span class="absolute top-0.5 left-1 text-[8px] opacity-60 uppercase">${day.toLocaleDateString([], {month:'short'})}</span>` : '';

    return `
      <div class="aspect-square rounded-xl flex flex-col items-center justify-center p-2 relative transition-all min-h-[50px] md:min-h-[60px] ${bgClass} ${textClass} ${borderClass} ${cursorClass} ${opacityClass}" 
           data-cal-date="${dateStr}" title="${day.toDateString()}: ${count} session(s)">
        ${monthLabel}
        <span class="text-sm font-semibold">${day.getDate()}</span>
        ${count > 0 ? `<span class="text-[10px] mt-0.5 opacity-80 font-medium whitespace-nowrap">${count}s</span>` : ''}
      </div>`;
  }).join('');

  showSelectedDaySessions(sessions);
  updateRecentSessionsList(sessions);
}

function showSelectedDaySessions(sessions) {
  const titleEl = $('selected-day-title');
  const listEl = $('selected-day-sessions');
  if (!titleEl || !listEl) return;

  const [y, m, d] = selectedCalDate.split('-').map(Number);
  const targetDate = new Date(y, m - 1, d);
  titleEl.textContent = `Activity on ${targetDate.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;

  const daySessions = getSessionsForDate(targetDate, sessions);
  const selectedTokens = daySessions.reduce((acc, s) => acc + (s.totalTokens || 0), 0);
  const sTokensEl = $('stats-selected-tokens');
  if (sTokensEl) sTokensEl.textContent = formatTokenCount(selectedTokens);

  if (!daySessions.length) {
    listEl.innerHTML = `<div class="text-center text-xs text-base-content/40 my-auto py-6">No sessions active on this day</div>`;
    return;
  }

  daySessions.sort((a, b) => b.updatedAt - a.updatedAt);

  listEl.innerHTML = daySessions.map(s => {
    const timeStr = new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const active = ctx.sessionId === s.sessionId;
    return `
      <div class="flex items-center gap-2.5 p-2.5 rounded-lg bg-base-300/40 hover:bg-base-300 border border-base-300/50 cursor-pointer text-left transition-all ${active ? 'border-primary bg-primary/5' : ''}"
           data-session-id="${esc(s.sessionId)}"
           data-session-cwd="${esc(s.cwd || '')}"
           data-session-config-dir="${esc(s.configDir || '')}"
           data-session-agent="${esc(s.agent || 'claude')}">
        <div class="flex-shrink-0">${agentBadge(s.agent)}</div>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-semibold truncate text-base-content/90">${esc(s.display || s.sessionId.slice(0, 8))}</div>
          <div class="text-[10px] text-base-content/40 truncate mt-0.5">${esc(s.projectName || shortPath(s.cwd) || 'No workspace')}</div>
        </div>
        <div class="text-[9px] text-base-content/45 font-mono whitespace-nowrap bg-base-300 px-1.5 py-0.5 rounded">${timeStr}</div>
      </div>`;
  }).join('');
}

function updateRecentSessionsList(sessions) {
  const container = $('recent-sessions-list');
  if (!container) return;

  const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);

  if (!recent.length) {
    container.innerHTML = `<div class="col-span-full text-center text-xs text-base-content/40 py-4">No recent sessions</div>`;
    return;
  }

  container.innerHTML = recent.map(s => {
    const timeStr = formatTime(s.updatedAt);
    const active = ctx.sessionId === s.sessionId;
    return `
      <div class="flex items-center gap-2.5 p-3 rounded-xl bg-base-200 hover:bg-base-300 border border-base-300/80 cursor-pointer text-left transition-all ${active ? 'border-primary bg-primary/5' : ''}"
           data-session-id="${esc(s.sessionId)}"
           data-session-cwd="${esc(s.cwd || '')}"
           data-session-config-dir="${esc(s.configDir || '')}"
           data-session-agent="${esc(s.agent || 'claude')}">
        <div class="flex-shrink-0">${agentBadge(s.agent)}</div>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-bold truncate text-base-content/95">${esc(s.display || s.sessionId.slice(0, 8))}</div>
          <div class="text-[10px] text-base-content/40 truncate mt-1">${esc(s.projectName || shortPath(s.cwd) || 'No workspace')}</div>
        </div>
        <div class="text-[9px] text-base-content/40 whitespace-nowrap self-start mt-0.5">${timeStr}</div>
      </div>`;
  }).join('');
}

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

function agentBadge(agent, compact = true) {
  const a = agent || 'claude';
  const colors = {
    claude: 'bg-orange-500/15 text-orange-400',
    codex:  'bg-emerald-500/15 text-emerald-400',
    grok:   'bg-sky-500/15 text-sky-400',
  };
  const cls = colors[a] || 'bg-base-300 text-base-content/50';
  const label = compact
    ? (a === 'claude' ? 'CC' : a === 'codex' ? 'CX' : a === 'grok' ? 'GX' : a.slice(0, 2).toUpperCase())
    : (AGENT_LABELS[a] || a);
  return `<span class="text-[9px] px-1 py-0.5 rounded font-mono font-semibold flex-shrink-0 ${cls}" title="${esc(AGENT_LABELS[a] || a)}">${label}</span>`;
}

function agentCountPills(agents) {
  return Object.entries(agents || {})
    .filter(([, n]) => n > 0)
    .map(([a, n]) => `${agentBadge(a)}<span class="text-[9px] text-base-content/40 -ml-0.5">${n}</span>`)
    .join('');
}

function shortPath(cwd) {
  if (!cwd) return '';
  const home = ''; // browser can't know home reliably; show last 2 segments if long
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 3) return cwd;
  return '…/' + parts.slice(-2).join('/');
}

function sessionItemHtml(s, { showProject = false } = {}) {
  const active = ctx.sessionId === s.sessionId && (ctx.agent || currentAgent.peek()) === (s.agent || 'claude');
  const title  = s.snippet && sessionSearch.peek()
    ? s.snippet
    : (s.display || s.sessionId.slice(0, 8));
  const meta = sessionMetaMap.peek()?.[metaKey(s.agent, s.sessionId, s.machineId)] || {};
  const fav = !!meta.favorite;
  const hasNote = !!(meta.notes && String(meta.notes).trim());
  const turns = Number(s.turnCount) || 0;
  const thin = turns > 0 && turns <= LOW_TURN_THRESHOLD;
  const projectLine = showProject
    ? `<div class="text-[10px] text-base-content/40 font-mono truncate" title="${esc(s.cwd || '')}">${esc(s.projectName || shortPath(s.cwd) || '—')}</div>`
    : '';
  const badges = [
    thin ? `<span class="session-thin-badge" title="Only ${turns} turn${turns === 1 ? '' : 's'}">thin·${turns}</span>` : '',
    hasNote ? `<span class="session-note-dot" title="${esc(meta.notes)}">📝</span>` : '',
  ].filter(Boolean).join('');
  const machineBadge = s.machineId
    ? `<span class="text-[9px] px-1 py-0.5 rounded bg-base-300 text-base-content/50 font-mono flex-shrink-0" title="Machine">${esc(s.machineId)}</span>`
    : '';
  return `<div class="session-row px-2.5 py-1.5 cursor-pointer hover:bg-base-300 border-l-2
              ${active ? 'border-primary bg-primary/5' : 'border-transparent'} ${fav ? 'session-fav' : ''} ${thin ? 'session-thin' : ''}"
       data-session-id="${esc(s.sessionId)}"
       data-session-cwd="${esc(s.cwd || '')}"
       data-session-config-dir="${esc(s.configDir || '')}"
       data-session-agent="${esc(s.agent || 'claude')}"
       data-session-machine="${esc(s.machineId || '')}">
    <div class="flex items-start gap-1.5">
      <button type="button" class="session-fav-btn flex-shrink-0 leading-none mt-0.5 ${fav ? 'is-fav' : ''}"
              data-fav-toggle="1"
              data-fav-session-id="${esc(s.sessionId)}"
              data-fav-session-agent="${esc(s.agent || 'claude')}"
              data-fav-session-machine="${esc(s.machineId || '')}"
              title="${fav ? 'Unfavorite' : 'Favorite'}">${fav ? '★' : '☆'}</button>
      ${agentBadge(s.agent)}
      <div class="min-w-0 flex-1">
        <div class="text-[11px] leading-snug truncate ${active ? 'text-primary font-medium' : 'text-base-content/85'}"
             title="${esc(s.display || '')}">${esc(title)}</div>
        ${projectLine}
        ${badges || machineBadge ? `<div class="flex items-center gap-1 mt-0.5 flex-wrap">${machineBadge}${badges}</div>` : ''}
      </div>
      <span class="text-[9px] text-base-content/30 flex-shrink-0 mt-0.5">${formatTime(s.updatedAt)}</span>
    </div>
  </div>`;
}

function refreshModelSelect() {
  const sel = $('sel-model');
  if (!sel) return;
  const agent = currentAgent.peek() || 'claude';
  const models = AGENT_MODELS[agent] || AGENT_MODELS.claude;
  const cur = currentModel.peek();
  sel.innerHTML = models.map(m =>
    `<option value="${esc(m.value)}" ${m.value === cur ? 'selected' : ''}>${esc(m.label)}</option>`
  ).join('');
  if (!models.some(m => m.value === cur)) {
    const def = AGENT_DEFAULT_MODEL[agent] || models[0]?.value;
    currentModel.value = def;
    localStorage.setItem('model', def);
    sel.value = def;
  } else {
    sel.value = cur;
  }
  const agentSel = $('sel-agent');
  if (agentSel) agentSel.value = agent;
}

function renderProjectGroups(groups) {
  if (!groups.length) {
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

function renderTimeline(sessions) {
  if (!sessions.length) {
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

function renderSessionList() {
  const view = sidebarView.value;
  if (view === 'timeline') {
    return renderTimeline(filteredSessions.value);
  }
  return renderProjectGroups(projectGroups.value);
}

function syncSidebarChrome() {
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
  const q = sessionSearch.peek().trim();
  if (activityLoading.peek()) {
    status.classList.remove('hidden');
    status.textContent = 'Searching content…';
  } else if (q && hits?.results) {
    status.classList.remove('hidden');
    status.textContent = `${hits.results.length} hit${hits.results.length === 1 ? '' : 's'} · ${timeRange.peek() === '0' ? 'all time' : timeRange.peek() + 'd'}${hits.deep === false ? '' : ' (incl. content)'}`;
  } else if (q) {
    status.classList.remove('hidden');
    status.textContent = 'Local filter only — type to deep-search';
  } else {
    const n = filteredSessions.peek().length;
    const pg = projectGroups.peek().length;
    status.classList.remove('hidden');
    status.textContent = sidebarView.peek() === 'projects'
      ? `${pg} project${pg === 1 ? '' : 's'} · ${n} session${n === 1 ? '' : 's'}`
      : `${n} recent session${n === 1 ? '' : 's'}`;
  }
}

// Debounced deep search against /api/activity
let _searchTimer = null;
async function runActivitySearch(q) {
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

function scheduleActivitySearch(q) {
  clearTimeout(_searchTimer);
  const query = (q || '').trim();
  if (!query) {
    activityHits.value = null;
    activityLoading.value = false;
    return;
  }
  _searchTimer = setTimeout(() => runActivitySearch(query), 350);
}

function mdToHtml(text) {
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
async function loadMemoryTab() {
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

export function goHome() {
  currentProject.value = null;
  sessionFilter.value = null;
  filesRoot.value = '';
  gitRoot.value = '';
  filesPath.value = '';
  viewingFile.value = null;
  ctx.sessionId = null;

  const topbar = $('topbar-project');
  if (topbar) topbar.textContent = 'Select a session';
  const welcome = $('welcome');
  if (welcome) {
    welcome.classList.remove('hidden');
    updateDashboard(filteredSessions.peek());
  }
  const pv = $('project-view');
  if (pv) pv.classList.add('hidden');
  setHash('/');
}

export async function resumeSession(sid, cwd, configDir, agent, machineId) {
  const fromList = sessionsData.peek().find(s =>
    s.sessionId === sid && (!machineId || s.machineId === machineId || !s.machineId)
  );
  const resolvedAgent = agent || fromList?.agent || 'claude';
  const resolvedMachine = machineId || fromList?.machineId || null;

  // Switch edge machine (hub): reconnect WS so chat runs on the right host
  if (resolvedMachine && resolvedMachine !== ctx.machineId) {
    ctx.machineId = resolvedMachine;
    localStorage.setItem('machineId', resolvedMachine);
    try { ctx.ws?.close(); } catch {}
    ctx.ws = null;
  } else if (!resolvedMachine && ctx.machineId && !hubMode.peek()) {
    // keep
  } else if (resolvedMachine) {
    ctx.machineId = resolvedMachine;
    localStorage.setItem('machineId', resolvedMachine);
  }

  ctx.sessionId = sid;
  ctx.configDir = configDir || null;
  ctx.agent = resolvedAgent;
  setAgent(resolvedAgent);
  refreshModelSelect();

  const topLabel = resolvedMachine ? `${cwd || sid}  @${resolvedMachine}` : (cwd || sid);

  if (cwd && cwd !== currentProject.peek()?.path) {
    const name = cwd.split('/').filter(Boolean).pop() || cwd;
    batch(() => {
      currentProject.value = { id: name, name, path: cwd, machineId: resolvedMachine };
      sessionFilter.value = cwd;
      filesRoot.value = '';
      gitRoot.value = '';
      filesPath.value = '';
      viewingFile.value = null;
    });
    $('topbar-project').textContent = topLabel;
    // Pre-fill root inputs with session cwd so user can see/edit the path
    const fi = $('files-root-input'); if (fi) fi.value = cwd;
    const gi = $('git-root-input');   if (gi) gi.value = cwd;
    const pv = $('project-view');
    pv.classList.remove('hidden');
    pv.style.display = 'flex';
    $('welcome').classList.add('hidden');
    connectWS();
  } else if (!currentProject.peek() && cwd) {
    const name = cwd.split('/').filter(Boolean).pop() || cwd;
    batch(() => {
      currentProject.value = { id: name, name, path: cwd, machineId: resolvedMachine };
      sessionFilter.value = cwd;
      filesRoot.value = '';
      gitRoot.value = '';
      filesPath.value = '';
      viewingFile.value = null;
    });
    $('topbar-project').textContent = topLabel;
    const fi = $('files-root-input'); if (fi) fi.value = cwd;
    const gi = $('git-root-input');   if (gi) gi.value = cwd;
    $('welcome').classList.add('hidden');
    const pv = $('project-view');
    pv.classList.remove('hidden');
    pv.style.display = 'flex';
    connectWS();
  }
  clearMessages();
  switchTab('chat');
  sessionsData.value = [...sessionsData.peek()];

  const label = AGENT_LABELS[resolvedAgent] || resolvedAgent;
  appendSystemMsg(`Loading ${label} history…`);
  try {
    const q = new URLSearchParams({ agent: resolvedAgent });
    const data = await api('GET', `/api/sessions/${sid}/messages?${q}`);
    // Support both legacy array and { messages, context }
    const msgs = Array.isArray(data) ? data : (data.messages || []);
    const context = Array.isArray(data) ? null : (data.context || null);
    $('messages').innerHTML = '';
    if (!msgs.length) {
      appendSystemMsg(`${label} · ${sid.slice(0,8)}… — no history`);
    } else {
      flushToolBatch();
      for (const m of msgs) {
        const ts = coerceTs(m.ts ?? m.timestamp);
        if (m.type === 'text') {
          if (m.role === 'assistant' || m.role === 'user') flushToolBatch();
          appendMsg(m.role === 'user' ? 'user' : 'assistant', m.role === 'user' ? 'You' : label, m.content, { ts });
        } else if (m.type === 'tool_use') {
          renderToolUse({ name: m.name, input: m.input ?? {} }, { ts });
        } else if (m.type === 'token_usage') {
          flushToolBatch();
          appendHistoryTokenBar(m.usage);
        }
      }
      flushToolBatch();
      if (context) appendContextBar(context);
      const turnCount = msgs.filter(m => m.type === 'token_usage').length
        || msgs.filter(m => m.role === 'user').length;
      appendSystemMsg(`── ${label} history · ${turnCount} turn${turnCount !== 1 ? 's' : ''} ──`);
    }
  } catch (e) {
    $('messages').innerHTML = '';
    appendSystemMsg(`${label} · ${sid.slice(0,8)}… (history unavailable: ${e.message})`);
  }
  syncHash();
  renderSessionNotesBar();
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
export function switchTab(name) { currentTab.value = name; }

// ── Auth ──────────────────────────────────────────────────────────────────────
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

let activeProjectGoal = '';
let activeProjectNotes = '';

async function fetchProjectNotes(rootPath) {
  const bar = $('project-notes-bar');
  if (!bar) return;

  try {
    const res = await api('GET', `/api/projects/notes?root=${encodeURIComponent(rootPath)}`);
    activeProjectGoal = res.goal || '';
    activeProjectNotes = res.notes || '';
    renderProjectNotesDisplayMode();
    bar.style.display = 'flex';
  } catch (err) {
    console.error('Error fetching project notes:', err);
    bar.style.display = 'none';
  }
}

function renderProjectNotesDisplayMode() {
  const bar = $('project-notes-bar');
  if (!bar) return;

  const goalText = activeProjectGoal || 'No goal yet — click Edit';
  const notesText = activeProjectNotes || '';
  bar.innerHTML = `
    <div class="flex items-start gap-2 w-full">
      <div class="flex-1 min-w-0">
        <div class="truncate">
          <span class="font-bold text-base-content/40 uppercase mr-1">Goal:</span>
          <span id="project-goal-text" class="text-base-content/80 cursor-pointer hover:underline" title="Click to edit">${esc(goalText)}</span>
        </div>
        ${notesText
          ? `<div class="mt-0.5 text-base-content/55 line-clamp-2 whitespace-pre-wrap" id="project-notes-text" title="${esc(notesText)}"><span class="font-bold text-base-content/35 uppercase mr-1">Notes:</span>${esc(notesText)}</div>`
          : `<div class="mt-0.5 text-base-content/35 italic text-[11px]" id="project-notes-text">No project notes</div>`}
      </div>
      <button id="btn-edit-project-notes" class="btn btn-ghost btn-xs px-1.5 hover:bg-base-300 flex-shrink-0">Edit</button>
    </div>
  `;
}

function renderProjectNotesEditMode() {
  const bar = $('project-notes-bar');
  if (!bar) return;

  bar.innerHTML = `
    <div class="flex flex-col gap-1.5 w-full">
      <div class="flex items-center gap-2">
        <span class="text-[10px] font-bold text-base-content/40 uppercase w-12 flex-shrink-0">Goal</span>
        <input id="project-goal-input" type="text" class="input input-xs input-bordered flex-1 text-xs"
               placeholder="One-line project goal…" value="${esc(activeProjectGoal)}">
      </div>
      <div class="flex items-start gap-2">
        <span class="text-[10px] font-bold text-base-content/40 uppercase w-12 flex-shrink-0 mt-1">Notes</span>
        <textarea id="project-notes-input" rows="2" class="textarea textarea-xs textarea-bordered flex-1 text-xs leading-snug"
                  placeholder="Longer project notes (stack, links, status…)">${esc(activeProjectNotes)}</textarea>
      </div>
      <div class="flex items-center gap-1 justify-end">
        <button id="btn-save-project-notes" class="btn btn-primary btn-xs px-2">Save</button>
        <button id="btn-cancel-project-notes" class="btn btn-ghost btn-xs px-2">Cancel</button>
      </div>
    </div>
  `;

  $('project-goal-input')?.focus();
}

async function loadSessionMetaMap() {
  try {
    const db = await api('GET', '/api/sessions/meta');
    sessionMetaMap.value = db || {};
  } catch (e) {
    console.warn('session meta load failed', e);
  }
}

function renderSessionNotesBar() {
  const bar = $('session-notes-bar');
  if (!bar) return;
  const sid = ctx.sessionId;
  const agent = ctx.agent || currentAgent.peek() || 'claude';
  if (!sid) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  const meta = getSessionMeta(agent, sid);
  const note = (meta.notes || '').trim();
  const fav = !!meta.favorite;
  bar.style.display = 'flex';
  bar.innerHTML = `
    <div class="flex-1 min-w-0 flex items-center gap-2">
      <button type="button" class="session-fav-btn ${fav ? 'is-fav' : ''}" data-fav-toggle="1"
              data-fav-session-id="${esc(sid)}" data-fav-session-agent="${esc(agent)}"
              title="${fav ? 'Unfavorite' : 'Favorite'}">${fav ? '★' : '☆'}</button>
      <span class="font-bold text-base-content/40 uppercase flex-shrink-0">Session:</span>
      <span class="truncate text-base-content/70 ${note ? '' : 'italic text-base-content/40'}"
            id="session-notes-text" title="${esc(note || 'Add a note for this session')}">${esc(note || 'No session note')}</span>
    </div>
    <button id="btn-edit-session-notes" class="btn btn-ghost btn-xs px-1.5">Note</button>
  `;
}

function renderSessionNotesEditMode() {
  const bar = $('session-notes-bar');
  if (!bar || !ctx.sessionId) return;
  const agent = ctx.agent || currentAgent.peek() || 'claude';
  const meta = getSessionMeta(agent, ctx.sessionId);
  bar.innerHTML = `
    <input id="session-notes-input" type="text" class="input input-xs input-bordered flex-1 text-xs"
           placeholder="Note for this session…" value="${esc(meta.notes || '')}">
    <button id="btn-save-session-notes" class="btn btn-primary btn-xs px-2">Save</button>
    <button id="btn-cancel-session-notes" class="btn btn-ghost btn-xs px-2">Cancel</button>
  `;
  const input = $('session-notes-input');
  input?.focus();
  input?.select();
}

async function toggleSessionFavorite(sessionId, agent) {
  const key = metaKey(agent, sessionId);
  const prev = sessionMetaMap.peek()?.[key] || { favorite: false, notes: '' };
  const nextFav = !prev.favorite;
  // optimistic
  sessionMetaMap.value = {
    ...sessionMetaMap.peek(),
    [key]: { ...prev, favorite: nextFav, updatedAt: Date.now() },
  };
  try {
    await api('PUT', '/api/sessions/meta', { sessionId, agent, favorite: nextFav });
  } catch (e) {
    sessionMetaMap.value = { ...sessionMetaMap.peek(), [key]: prev };
    alert(`Favorite failed: ${e.message}`);
  }
  if (ctx.sessionId === sessionId) renderSessionNotesBar();
}

async function saveSessionNotes(sessionId, agent, notes) {
  const key = metaKey(agent, sessionId);
  const prev = sessionMetaMap.peek()?.[key] || { favorite: false, notes: '' };
  try {
    const res = await api('PUT', '/api/sessions/meta', { sessionId, agent, notes });
    sessionMetaMap.value = {
      ...sessionMetaMap.peek(),
      [key]: { favorite: res.favorite ?? prev.favorite, notes: res.notes ?? notes, updatedAt: Date.now() },
    };
  } catch (e) {
    alert(`Save note failed: ${e.message}`);
    return false;
  }
  return true;
}

export async function showApp() {
  $('auth-screen').style.display = 'none';
  const app = $('app');
  app.classList.remove('hidden');
  app.style.display = 'flex';
  
  if (location.hash.startsWith('#/session/')) {
    const welcome = $('welcome');
    if (welcome) welcome.classList.add('hidden');
    const pv = $('project-view');
    if (pv) {
      pv.classList.remove('hidden');
      pv.style.display = 'flex';
    }
  }

  // Detect unified hub (public WebUI + many edges)
  const hub = await probeHub();
  if (hub) {
    machinesList.value = hub.machines || [];
    const subtitle = $('auth-subtitle');
    // leave auth as-is; topbar hint after login
  }
  await Promise.all([loadAllSessions(), loadWorkspaces(), loadSessionMetaMap()]);
  if (hubMode.peek()) {
    const n = machinesList.peek()?.length || 0;
    const bar = $('topbar-project');
    if (bar && bar.textContent === 'Select a session') {
      bar.textContent = n ? `Hub · ${n} machine(s)` : 'Hub · no machines online';
    }
  }
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
  if (btn) btn.textContent = theme === 'dark' || theme === 'night' || theme === 'black' ? '🌙' : '☀️';
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

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

// ── New Session modal ─────────────────────────────────────────────────────────
function openNewSessionModal() {
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
    if (hubMode.peek()) {
      mwrap.style.display = '';
      const ms = machinesList.peek() || [];
      msel.innerHTML = ms.length
        ? ms.map(m => `<option value="${esc(m.id)}">${esc(m.id)}${m.hostname ? ' — ' + esc(m.hostname) : ''}</option>`).join('')
        : '<option value="">(no machines online)</option>';
      if (ctx.machineId) msel.value = ctx.machineId;
    } else {
      mwrap.style.display = 'none';
    }
  }
  updateNewSessionAgentUI();
  $('new-session-path').value = currentProject.peek()?.path || '';
  $('new-session-error').classList.add('hidden');
  $('modal-new-session').showModal();
  setTimeout(() => $('new-session-path').focus(), 50);
}

function updateNewSessionAgentUI() {
  const agent = $('new-session-agent')?.value || 'claude';
  const wrap = $('new-session-ws-wrap');
  if (wrap) wrap.style.display = agent === 'claude' ? '' : 'none';
}

async function startNewSession() {
  const rawPath  = $('new-session-path').value.trim();
  const agent    = $('new-session-agent')?.value || 'claude';
  const configDir = agent === 'claude' ? $('new-session-workspace').value : null;
  const errEl    = $('new-session-error');
  errEl.classList.add('hidden');

  if (!rawPath) { errEl.textContent = 'Working directory is required'; errEl.classList.remove('hidden'); return; }

  // Hub: new session must target an online edge machine
  if (hubMode.peek()) {
    const mid = $('new-session-machine')?.value || ctx.machineId || machinesList.peek()?.[0]?.id;
    if (!mid) {
      errEl.textContent = 'No edge machine online — start client.js on a host first';
      errEl.classList.remove('hidden');
      return;
    }
    ctx.machineId = mid;
    localStorage.setItem('machineId', mid);
  }

  try {
    const result = await api('POST', '/api/resolve-path', { path: rawPath });
    if (!result.isDir) throw new Error('Path is not a directory');

    $('modal-new-session').close();

    const name = result.path.split('/').filter(Boolean).pop() || result.path;
    ctx.sessionId = null;
    ctx.configDir = configDir || null;
    ctx.agent = agent;
    setAgent(agent);
    currentModel.value = AGENT_DEFAULT_MODEL[agent] || currentModel.peek();
    localStorage.setItem('model', currentModel.peek());
    refreshModelSelect();
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
    appendSystemMsg(`New ${AGENT_LABELS[agent] || agent} session · ${result.path}`);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

// ── Init — render HTML, wire everything up ────────────────────────────────────
export function initShell() {
  // 0. Restore saved theme
  applyTheme(localStorage.getItem('theme') || 'dark');

  // Inject xterm.js local files
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

  // 3. Reactive session list + chrome
  effect(() => {
    // touch reactive deps
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

  // 3b. Welcome dashboard activity calendar
  effect(() => {
    const sessions = filteredSessions.value;
    const welcome = $('welcome');
    if (welcome && !welcome.classList.contains('hidden')) {
      updateDashboard(sessions);
    }
  });

  // 3. Filter badge
  watch(sessionFilter, f => {
    const badge = $('session-filter-badge');
    if (!badge) return;
    badge.style.display = f ? 'inline' : 'none';
    badge.title = f || '';
  });

  // 3c. Project Notes loading
  effect(() => {
    const proj = currentProject.value;
    if (proj && proj.path) {
      fetchProjectNotes(proj.path);
    } else {
      const bar = $('project-notes-bar');
      if (bar) bar.style.display = 'none';
    }
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
  document.addEventListener('router:home', goHome);

  // 7. Router: deep-link to a session by id
  document.addEventListener('router:session', async ({ detail: { id, tab } }) => {
    const s = sessionsData.peek().find(s => s.sessionId === id);
    await resumeSession(id, s?.cwd || null, s?.configDir || null, s?.agent || null);
    if (tab && ['chat','files','git','shell','memory'].includes(tab)) switchTab(tab);
  });

  // 7. Event delegation
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
  // Double-click project header → open project (filter + new chat context)
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
    calMonth--;
    if (calMonth < 0) {
      calMonth = 11;
      calYear--;
    }
    updateDashboard(sessionsData.peek());
  });

  delegate.on('click', '#btn-cal-next', () => {
    calMonth++;
    if (calMonth > 11) {
      calMonth = 0;
      calYear++;
    }
    updateDashboard(sessionsData.peek());
  });

  delegate.on('click', '[data-cal-date]', (_, el) => {
    selectedCalDate = el.dataset.calDate;
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
    const cwd  = el.dataset.folder;
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

  // Agent / model / effort / permission selectors
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
    if (!sid) {
      alert('No active session to convert.');
      el.value = '';
      return;
    }
    const source = ctx.agent || currentAgent.peek() || 'claude';
    if (source === target) {
      alert('Cannot convert to the same agent.');
      el.value = '';
      return;
    }

    el.disabled = true;
    appendSystemMsg(`Converting session ${sid.slice(0, 8)} from ${source} to ${target}...`);
    try {
      const res = await api('POST', `/api/sessions/${sid}/convert`, {
        targetAgent: target,
        sourceAgent: source
      });
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
  delegate.on('change', '#sel-effort',     (_, el) => { currentEffort.value     = el.value; });
  delegate.on('change', '#sel-permission', (_, el) => { currentPermission.value = el.value; });
  delegate.on('change', '#sel-density', (_, el) => {
    setChatDensity(el.value);
    appendSystemMsg(`Density → ${el.value} (applies to new tool calls; reload session to re-group history)`);
  });
  document.addEventListener('agent-changed', refreshModelSelect);

  delegate.on('click', '#btn-new-session, #btn-new-session-welcome', openNewSessionModal);
  delegate.on('click', '#new-session-cancel', () => $('modal-new-session').close());
  delegate.on('click', '#new-session-start',  startNewSession);
  delegate.on('change', '#new-session-agent', updateNewSessionAgentUI);
  delegate.on('keydown', '#new-session-path', e => { if (e.key === 'Enter') startNewSession(); });
  delegate.on('click', '#send-btn',        sendMessage);
  delegate.on('click', '#stop-btn',        stopProcessing);
  delegate.on('click', '#btn-logout',      () => { ctx.token = null; localStorage.removeItem('token'); location.reload(); });

  // Project Goal + Notes
  delegate.on('click', '#btn-edit-project-notes, #project-goal-text, #project-notes-text', () => {
    renderProjectNotesEditMode();
  });
  delegate.on('click', '#btn-cancel-project-notes', () => {
    renderProjectNotesDisplayMode();
  });

  const handleSaveProjectNotes = async () => {
    const goal = $('project-goal-input')?.value?.trim() ?? activeProjectGoal;
    const notes = $('project-notes-input')?.value?.trim() ?? activeProjectNotes;
    const proj = currentProject.peek();
    if (!proj || !proj.path) return;
    try {
      const res = await api('POST', '/api/projects/notes', { root: proj.path, goal, notes });
      activeProjectGoal = res.goal || '';
      activeProjectNotes = res.notes || '';
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

  // Session favorites + notes
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

  // Restore agent/model selectors + sidebar filters after DOM is ready
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
