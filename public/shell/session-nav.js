// shell/session-nav.js — open project, resume session, tabs, home
import { batch, esc, $ } from '../lib.js';
import {
  sessionsData, sessionFilter, filesPath, viewingFile, filteredSessions,
  currentProject, currentTab, filesRoot, gitRoot, currentAgent, setAgent,
  selectedMachineId, setSelectedMachine, AGENT_LABELS, ctx,
} from '../state.js';
import { api } from '../api.js';
import { getLastSessionContext, setLastSessionContext } from './session-context.js';
import {
  connectWS, clearMessages, appendMsg, appendSystemMsg, renderToolUse,
  appendHistoryTokenBar, appendContextBar, flushToolBatch, coerceTs,
} from '../chat.js';
import { setHash, syncHash } from '../router.js';
import { refreshModelSelect } from './session-list.js';
import { renderSessionNotesBar } from './notes.js';
import { updateDashboard } from './dashboard.js';

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

/**
 * @param {string} sid
 * @param {string|null} cwd
 * @param {string|null} configDir
 * @param {string|null} agent
 * @param {string|null} machineId
 * @param {{ tab?: string, skipHistory?: boolean }} [opts]
 */
export async function resumeSession(sid, cwd, configDir, agent, machineId, opts = {}) {
  const targetTab = opts.tab && ['chat', 'files', 'git', 'shell', 'memory'].includes(opts.tab)
    ? opts.tab
    : 'chat';
  // Non-chat deep links: open tab immediately; don't block on chat history
  const skipHistory = opts.skipHistory ?? (targetTab !== 'chat' && targetTab !== 'memory');

  const fromList = sessionsData.peek().find(s =>
    s.sessionId === sid && (!machineId || s.machineId === machineId || !s.machineId)
  );
  const last = getLastSessionContext();
  const fromLast = last?.sessionId === sid ? last : null;

  const resolvedAgent = agent || fromList?.agent || fromLast?.agent || 'claude';
  const resolvedMachine = machineId || fromList?.machineId || fromLast?.machineId
    || selectedMachineId.peek() || null;
  const resolvedCwd = cwd || fromList?.cwd || fromLast?.cwd || null;
  const resolvedConfig = configDir || fromList?.configDir || fromLast?.configDir || null;

  if (resolvedMachine && resolvedMachine !== ctx.machineId) {
    setSelectedMachine(resolvedMachine);
    try { ctx.ws?.close(); } catch {}
    ctx.ws = null;
  }

  ctx.sessionId = sid;
  ctx.configDir = resolvedConfig;
  ctx.agent = resolvedAgent;
  setAgent(resolvedAgent);
  refreshModelSelect();

  const topLabel = resolvedMachine
    ? `${resolvedCwd || sid}  @${resolvedMachine}`
    : (resolvedCwd || sid);

  if (resolvedCwd && resolvedCwd !== currentProject.peek()?.path) {
    const name = resolvedCwd.split('/').filter(Boolean).pop() || resolvedCwd;
    batch(() => {
      currentProject.value = { id: name, name, path: resolvedCwd, machineId: resolvedMachine };
      sessionFilter.value = resolvedCwd;
      filesRoot.value = '';
      gitRoot.value = '';
      filesPath.value = '';
      viewingFile.value = null;
    });
    $('topbar-project').textContent = topLabel;
    const fi = $('files-root-input'); if (fi) fi.value = resolvedCwd;
    const gi = $('git-root-input');   if (gi) gi.value = resolvedCwd;
    const pv = $('project-view');
    pv.classList.remove('hidden');
    pv.style.display = 'flex';
    $('welcome').classList.add('hidden');
    connectWS();
  } else if (!currentProject.peek() && resolvedCwd) {
    const name = resolvedCwd.split('/').filter(Boolean).pop() || resolvedCwd;
    batch(() => {
      currentProject.value = { id: name, name, path: resolvedCwd, machineId: resolvedMachine };
      sessionFilter.value = resolvedCwd;
      filesRoot.value = '';
      gitRoot.value = '';
      filesPath.value = '';
      viewingFile.value = null;
    });
    $('topbar-project').textContent = topLabel;
    const fi = $('files-root-input'); if (fi) fi.value = resolvedCwd;
    const gi = $('git-root-input');   if (gi) gi.value = resolvedCwd;
    $('welcome').classList.add('hidden');
    const pv = $('project-view');
    pv.classList.remove('hidden');
    pv.style.display = 'flex';
    connectWS();
  } else if (!resolvedCwd) {
    // Still open project shell so files tab can show path input
    $('welcome')?.classList.add('hidden');
    const pv = $('project-view');
    if (pv) { pv.classList.remove('hidden'); pv.style.display = 'flex'; }
  }

  // Switch to target tab BEFORE history (files/git/shell usable immediately)
  clearMessages();
  switchTab(targetTab);
  {
    const cur = sessionsData.peek();
    sessionsData.value = Array.isArray(cur) ? [...cur] : [];
  }

  setLastSessionContext({
    sessionId: sid,
    cwd: resolvedCwd,
    configDir: resolvedConfig,
    agent: resolvedAgent,
    machineId: resolvedMachine,
    tab: targetTab,
  });

  const label = AGENT_LABELS[resolvedAgent] || resolvedAgent;

  const loadHistory = async () => {
    appendSystemMsg(`Loading ${label} history…`);
    try {
      const q = new URLSearchParams({ agent: resolvedAgent });
      const data = await api('GET', `/api/sessions/${sid}/messages?${q}`);
      const msgs = Array.isArray(data) ? data : (data.messages || []);
      const context = Array.isArray(data) ? null : (data.context || null);
      // If user already navigated away from this session, skip paint
      if (ctx.sessionId !== sid) return;
      $('messages').innerHTML = '';
      if (!msgs.length) {
        appendSystemMsg(`${label} · ${sid.slice(0, 8)}… — no history`);
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
      if (ctx.sessionId !== sid) return;
      $('messages').innerHTML = '';
      appendSystemMsg(`${label} · ${sid.slice(0, 8)}… (history unavailable: ${e.message})`);
    }
  };

  if (skipHistory) {
    // Background: history ready when user opens Chat
    loadHistory().catch(() => {});
  } else {
    await loadHistory();
  }
  syncHash();
  renderSessionNotesBar();
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
export function switchTab(name) { currentTab.value = name; }
