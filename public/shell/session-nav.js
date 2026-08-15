// shell/session-nav.js — open project, resume session, tabs, home
import { batch, esc, $ } from '../lib.js';
import {
  sessionsData, sessionFilter, filesPath, viewingFile, filteredSessions,
  currentProject, currentTab, filesRoot, gitRoot, currentAgent, setAgent,
  selectedMachineId, setSelectedMachine, AGENT_LABELS, ctx, hubMode,
} from '../state.js';
import { api } from '../api.js';
import { getLastSessionContext, setLastSessionContext } from './session-context.js';
import {
  connectWS, clearMessages, appendMsg, appendSystemMsg, renderToolUse,
  appendHistoryTokenBar, appendContextBar, flushToolBatch, coerceTs,
  stashComposerDraft, restoreComposerDraft, discardComposerAttachments, parkQueuedMessages, detachProcessingForSessionSwitch,
} from '../chat.js';
import { setHash, syncHash } from '../router.js';
import { refreshModelSelect } from './session-list.js';
import { renderSessionNotesBar } from './notes.js';
import { updateDashboard, getDashboardSessions } from './dashboard.js';

/** Show which edge machine Files/Git/Shell paths belong to. */
function syncMachinePathHints(machineId) {
  for (const id of ['files-machine-hint', 'git-machine-hint']) {
    const el = $(id);
    if (!el) continue;
    if (machineId) {
      el.textContent = `@${machineId}`;
      el.classList.remove('hidden');
      el.title = `Paths are on machine ${machineId}`;
    } else {
      el.textContent = '';
      el.classList.add('hidden');
      el.title = '';
    }
  }
}

export function openProject(project) {
  stashComposerDraft();
  parkQueuedMessages();
  discardComposerAttachments();
  detachProcessingForSessionSwitch();
  const path = project?.path || '';
  batch(() => {
    currentProject.value = project;
    sessionFilter.value = path;
    // Default Files/Git root = project path
    if (path) {
      filesRoot.value = path;
      gitRoot.value = path;
      filesPath.value = '';
      viewingFile.value = null;
    }
  });
  ctx.sessionId = null;
  $('topbar-project').textContent = path || 'Project';
  const fi = $('files-root-input'); if (fi && path) fi.value = path;
  const gi = $('git-root-input');   if (gi && path) gi.value = path;
  syncMachinePathHints(project?.machineId || selectedMachineId.peek() || ctx.machineId);
  $('welcome').classList.add('hidden');
  const pv = $('project-view');
  pv.classList.remove('hidden');
  pv.style.display = 'flex';
  clearMessages();
  restoreComposerDraft({ sessionId: null });
  connectWS();
  switchTab('chat');
}

export function goHome() {
  stashComposerDraft();
  parkQueuedMessages();
  discardComposerAttachments();
  detachProcessingForSessionSwitch();
  currentProject.value = null;
  sessionFilter.value = null;
  filesRoot.value = '';
  gitRoot.value = '';
  filesPath.value = '';
  viewingFile.value = null;
  ctx.sessionId = null;
  restoreComposerDraft({ sessionId: null });
  syncMachinePathHints(null);

  // Leaving session restore mode — calendar is allowed again
  document.documentElement.classList.remove('boot-restore');

  const topbar = $('topbar-project');
  if (topbar) topbar.textContent = 'Select a session';
  const welcome = $('welcome');
  if (welcome) {
    welcome.classList.remove('hidden');
    welcome.style.display = '';
    updateDashboard(getDashboardSessions());
  }
  const pv = $('project-view');
  if (pv) {
    pv.classList.add('hidden');
    pv.style.display = 'none';
  }
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

  // Capture before changing ctx, then restore only after the new identity is set.
  stashComposerDraft();
  parkQueuedMessages();
  discardComposerAttachments();
  detachProcessingForSessionSwitch();

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
  restoreComposerDraft({ sessionId: sid, agent: resolvedAgent, machineId: resolvedMachine });

  // Default path = session cwd on the target machine (set immediately; no await)
  let edgeCwd = resolvedCwd;
  applyProjectPaths(edgeCwd, resolvedMachine, sid);
  connectWS();

  // Background: normalize path on the edge (does not block chat)
  if (edgeCwd) {
    api('POST', '/api/resolve-path', { path: edgeCwd }, undefined, {
      machineId: resolvedMachine || undefined,
    }).then(r => {
      if (ctx.sessionId !== sid || !r?.path || r.path === edgeCwd) return;
      edgeCwd = r.path;
      applyProjectPaths(edgeCwd, resolvedMachine, sid);
      setLastSessionContext({ sessionId: sid, cwd: edgeCwd });
    }).catch(() => {});
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
    cwd: edgeCwd || resolvedCwd,
    configDir: resolvedConfig,
    agent: resolvedAgent,
    machineId: resolvedMachine,
    tab: targetTab,
  });

  const label = AGENT_LABELS[resolvedAgent] || resolvedAgent;
  const cacheKey = `${resolvedMachine || ''}:${resolvedAgent}:${sid}`;

  const paintMessages = (msgs, context, meta = {}) => {
    if (ctx.sessionId !== sid) return;
    $('messages').innerHTML = '';
    if (!msgs.length) {
      appendSystemMsg(`${label} · ${sid.slice(0, 8)}… — no history`);
      return;
    }
    flushToolBatch();
    // Paint in chunks so the UI stays responsive on long histories
    const CHUNK = 40;
    let i = 0;
    const paintChunk = () => {
      if (ctx.sessionId !== sid) return;
      const end = Math.min(i + CHUNK, msgs.length);
      for (; i < end; i++) {
        const m = msgs[i];
        const ts = coerceTs(m.ts ?? m.timestamp);
        // Accept both normalized history rows and a few legacy shapes.
        const typ = m.type || (m.role ? 'text' : null);
        if (typ === 'text' || (m.role && m.content != null && !m.name)) {
          if (m.role === 'assistant' || m.role === 'user') flushToolBatch();
          const content = typeof m.content === 'string'
            ? m.content
            : (Array.isArray(m.content)
              ? m.content.map(p => p?.text || '').filter(Boolean).join('\n')
              : String(m.content ?? ''));
          if (content) {
            appendMsg(m.role === 'user' ? 'user' : 'assistant', m.role === 'user' ? 'You' : label, content, { ts });
          }
        } else if (typ === 'tool_use' || m.name) {
          renderToolUse({ name: m.name || 'tool', input: m.input ?? m.arguments ?? {} }, { ts });
        } else if (typ === 'token_usage' || m.usage) {
          flushToolBatch();
          appendHistoryTokenBar(m.usage || m);
        }
      }
      if (i < msgs.length) {
        requestAnimationFrame(paintChunk);
        return;
      }
      flushToolBatch();
      if (context) appendContextBar(context);
      const turnCount = msgs.filter(m => m.type === 'token_usage').length
        || msgs.filter(m => m.role === 'user').length;
      const more = meta.truncated
        ? ` (showing last ${msgs.length} of ${meta.total || '?'})`
        : '';
      appendSystemMsg(`── ${label} history · ${turnCount} turn${turnCount !== 1 ? 's' : ''}${more} ──`);
    };
    paintChunk();
  };

  const loadHistory = async () => {
    // Instant re-open from in-memory cache (never trust empty cache — race/stale)
    const cached = historyCache.get(cacheKey);
    if (cached && cached.msgs?.length && Date.now() - cached.at < HISTORY_CACHE_TTL) {
      paintMessages(cached.msgs, cached.context, cached.meta);
      return;
    }
    appendSystemMsg(`Loading ${label} history…`);
    try {
      // Hub mode must route to the edge that owns the session.
      const mid = resolvedMachine || selectedMachineId.peek() || ctx.machineId || null;
      if (hubMode.peek() && !mid) {
        throw new Error('未选择机器，无法加载历史');
      }
      if (mid && ctx.machineId !== mid) setSelectedMachine(mid);

      // Full history (tail=0); tool inputs compacted server-side (~100 chars each).
      const fetchMsgs = async (agent) => {
        const q = new URLSearchParams({
          tail: '0',
          compact: '1',
        });
        if (agent) q.set('agent', agent);
        // Also put machine in query for proxies that drop custom headers.
        if (mid) q.set('machine', mid);
        return api('GET', `/api/sessions/${sid}/messages?${q}`, undefined, undefined, {
          machineId: mid || undefined,
          dedupe: false,
        });
      };

      let data = await fetchMsgs(resolvedAgent);
      let msgs = Array.isArray(data) ? data : (data?.messages || []);
      // Prefer stated agent; if empty, retry scanning all agents on the edge.
      if (!msgs.length && resolvedAgent) {
        data = await fetchMsgs(null);
        msgs = Array.isArray(data) ? data : (data?.messages || []);
      }

      const context = Array.isArray(data) ? null : (data?.context || null);
      const meta = Array.isArray(data) ? {} : { truncated: data?.truncated, total: data?.total };
      if (msgs.length) historyCache.set(cacheKey, { msgs, context, meta, at: Date.now() });
      else historyCache.delete(cacheKey);
      paintMessages(msgs, context, meta);
    } catch (e) {
      if (ctx.sessionId !== sid) return;
      historyCache.delete(cacheKey);
      $('messages').innerHTML = '';
      appendSystemMsg(`${label} · ${sid.slice(0, 8)}… (history unavailable: ${e.message})`);
    }
  };

  // Never block tab UI on history; chat still loads ASAP in background
  if (skipHistory) {
    loadHistory().catch(() => {});
  } else {
    // yield one frame so tab paint happens first
    await new Promise(r => requestAnimationFrame(r));
    loadHistory().catch(() => {});
  }
  syncHash();
  renderSessionNotesBar();
}

/** Apply session cwd as default Files/Git/Shell root (target machine path). */
function applyProjectPaths(edgeCwd, resolvedMachine, sid) {
  if (edgeCwd) {
    const name = edgeCwd.split('/').filter(Boolean).pop() || edgeCwd;
    batch(() => {
      currentProject.value = {
        id: name,
        name,
        path: edgeCwd,
        machineId: resolvedMachine,
      };
      sessionFilter.value = edgeCwd;
      filesRoot.value = edgeCwd;
      gitRoot.value = edgeCwd;
      filesPath.value = '';
      viewingFile.value = null;
    });
    $('topbar-project').textContent = resolvedMachine
      ? `${edgeCwd}  @${resolvedMachine}`
      : edgeCwd;
    const fi = $('files-root-input'); if (fi) fi.value = edgeCwd;
    const gi = $('git-root-input');   if (gi) gi.value = edgeCwd;
    syncMachinePathHints(resolvedMachine);
    $('welcome')?.classList.add('hidden');
    const pv = $('project-view');
    if (pv) {
      pv.classList.remove('hidden');
      pv.style.display = 'flex';
      pv.style.flexDirection = 'column';
      pv.style.flex = '1';
      pv.style.minHeight = '0';
      pv.style.overflow = 'hidden';
    }
  } else {
    $('welcome')?.classList.add('hidden');
    const pv = $('project-view');
    if (pv) {
      pv.classList.remove('hidden');
      pv.style.display = 'flex';
      pv.style.flexDirection = 'column';
      pv.style.flex = '1';
      pv.style.minHeight = '0';
    }
    syncMachinePathHints(resolvedMachine);
  }
}

// In-memory chat history cache (instant re-open within TTL)
const historyCache = new Map();
const HISTORY_CACHE_TTL = 3 * 60 * 1000;

// ── Tabs ──────────────────────────────────────────────────────────────────────
export function switchTab(name) { currentTab.value = name; }
