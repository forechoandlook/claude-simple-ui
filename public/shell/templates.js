// shell/templates.js — Auth + main app HTML shells
import { ctx } from '../state.js';

export const AuthScreen = () => `
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
      <div id="machine-menu-wrap" class="relative hidden flex-shrink-0">
        <button type="button" id="btn-machine-menu" class="btn btn-ghost btn-xs border border-base-300 font-mono gap-1 max-w-[11rem]"
                title="机器列表 / 切换">
          <span id="topbar-machine-dot" class="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0"></span>
          <span id="topbar-machine-label" class="truncate">机器</span>
          <span class="text-[10px] opacity-50">▾</span>
        </button>
        <div id="machine-menu" class="hidden absolute left-0 top-full mt-1 z-50 w-72 max-h-80 overflow-y-auto
             rounded-lg border border-base-300 bg-base-100 shadow-xl p-2">
          <div class="flex items-center justify-between px-1 pb-1.5 mb-1 border-b border-base-300">
            <span class="text-[10px] uppercase tracking-wide text-base-content/45 font-semibold">Machines</span>
            <button type="button" id="btn-refresh-machines-menu" class="btn btn-ghost btn-xs px-1 text-[10px]">↻</button>
          </div>
          <div id="machine-menu-list" class="flex flex-col gap-1"></div>
          <p id="machine-menu-empty" class="text-xs text-base-content/40 px-1 py-2 hidden">暂无机器在线</p>
        </div>
      </div>
      <span id="topbar-project" class="text-sm text-base-content/50 flex-1 truncate">Select a session</span>
      <div class="flex gap-2">
        <button id="btn-new-session" class="btn btn-ghost btn-xs border border-base-300">＋ New</button>
        <button id="btn-theme"        class="btn btn-ghost btn-xs border border-base-300">🌙</button>
        <button id="btn-settings"    class="btn btn-ghost btn-xs border border-base-300">⚙️</button>
        <button id="btn-logout"      class="btn btn-ghost btn-xs border border-base-300">Sign out</button>
      </div>
    </div>
    <!-- Hub: only when no remembered machine (or last one offline) -->
    <div id="machine-picker" class="hidden fixed inset-0 z-[60] bg-base-100 flex items-center justify-center p-4">
      <div class="w-full max-w-md">
        <h2 class="text-xl font-bold mb-1">选择机器</h2>
        <p class="text-sm text-base-content/55 mb-4">首次使用或上次选择的机器不在线时需要选择。之后会记住你的选择，也可随时在顶栏切换。</p>
        <div id="machine-picker-list" class="flex flex-col gap-2 mb-4"></div>
        <p id="machine-picker-empty" class="text-sm text-base-content/40 hidden">暂无在线机器。请在业务机上运行 <code class="text-xs">npm run client</code> 后点刷新。</p>
        <div class="flex items-center gap-2">
          <button id="btn-refresh-machines" class="btn btn-ghost btn-sm border border-base-300">↻ 刷新</button>
          <span id="machine-picker-status" class="text-xs text-base-content/40"></span>
        </div>
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
