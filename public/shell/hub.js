// shell/hub.js — multi-machine picker, menu, polling
import { batch, esc, $ } from '../lib.js';
import {
  machinesList, hubMode, hubMachineReady, selectedMachineId, setSelectedMachine,
  currentProject, sessionFilter, viewingFile, ctx,
} from '../state.js';
import { api, probeHub } from '../api.js';
import { loadAllSessions, loadWorkspaces } from './session-list.js';
import { loadSessionMetaMap } from './notes.js';
// goHome imported dynamically in enterMachine to avoid circular deps

export async function refreshMachinesList() {
  try {
    const list = await api('GET', '/api/machines');
    machinesList.value = Array.isArray(list) ? list : [];
  } catch {
    try {
      const hub = await probeHub();
      if (hub?.machines) machinesList.value = hub.machines;
    } catch { /* ignore */ }
  }
  return machinesList.peek() || [];
}

export function renderMachinePickerList() {
  const listEl = $('machine-picker-list');
  const emptyEl = $('machine-picker-empty');
  if (!listEl) return;
  const ms = machinesList.peek() || [];
  if (!ms.length) {
    listEl.innerHTML = '';
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');
  listEl.innerHTML = ms.map(m => {
    const online = m.online !== false;
    const meta = [m.hostname, m.platform].filter(Boolean).join(' · ');
    return `
      <button type="button" class="machine-pick-card w-full text-left px-4 py-3 rounded-xl border border-base-300
              hover:border-primary hover:bg-primary/5 transition-colors ${online ? '' : 'opacity-50'}"
              data-pick-machine="${esc(m.id)}" ${online ? '' : 'disabled'}>
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full flex-shrink-0 ${online ? 'bg-success' : 'bg-error'}"></span>
          <span class="font-semibold text-sm font-mono">${esc(m.id)}</span>
        </div>
        ${meta ? `<div class="text-xs text-base-content/45 mt-1 pl-4">${esc(meta)}</div>` : ''}
      </button>`;
  }).join('');
}

export function showMachinePicker() {
  const el = $('machine-picker');
  if (!el) return;
  el.classList.remove('hidden');
  hubMachineReady.value = false;
  renderMachinePickerList();
  const status = $('machine-picker-status');
  if (status) {
    const n = (machinesList.peek() || []).filter(m => m.online !== false).length;
    status.textContent = `${n} online`;
  }
}

export function hideMachinePicker() {
  $('machine-picker')?.classList.add('hidden');
  hubMachineReady.value = true;
}

export function closeMachineMenu() {
  $('machine-menu')?.classList.add('hidden');
}

export function renderMachineMenuList() {
  const listEl = $('machine-menu-list');
  const emptyEl = $('machine-menu-empty');
  if (!listEl) return;
  const ms = machinesList.peek() || [];
  const cur = selectedMachineId.peek() || '';
  if (!ms.length) {
    listEl.innerHTML = '';
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');
  listEl.innerHTML = ms.map(m => {
    const online = m.online !== false;
    const active = m.id === cur;
    const meta = [m.hostname, m.platform].filter(Boolean).join(' · ');
    const since = m.connectedAt
      ? new Date(m.connectedAt).toLocaleTimeString()
      : '';
    return `
      <button type="button"
        class="machine-menu-item w-full text-left px-2 py-1.5 rounded-md text-xs
               ${active ? 'bg-primary/15 text-primary' : 'hover:bg-base-200'}
               ${online ? '' : 'opacity-50'}"
        data-pick-machine="${esc(m.id)}"
        ${online ? '' : 'disabled'}>
        <div class="flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full flex-shrink-0 ${online ? 'bg-success' : 'bg-error'}"></span>
          <span class="font-mono font-semibold truncate flex-1">${esc(m.id)}</span>
          ${active ? '<span class="text-[9px] opacity-70">当前</span>' : ''}
          <span class="text-[9px] ${online ? 'text-success' : 'text-error'}">${online ? 'online' : 'offline'}</span>
        </div>
        ${meta || since ? `<div class="text-[10px] text-base-content/40 pl-3.5 mt-0.5 truncate">${esc(meta)}${since ? ' · ' + esc(since) : ''}</div>` : ''}
      </button>`;
  }).join('');
}

export function syncTopbarMachine() {
  const wrap = $('machine-menu-wrap');
  const label = $('topbar-machine-label');
  const dot = $('topbar-machine-dot');
  if (!hubMode.peek()) {
    wrap?.classList.add('hidden');
    return;
  }
  wrap?.classList.remove('hidden');
  const cur = selectedMachineId.peek() || '';
  const ms = machinesList.peek() || [];
  const info = ms.find(m => m.id === cur);
  const online = info ? info.online !== false : false;
  if (label) label.textContent = cur || '选择机器';
  if (dot) {
    dot.classList.toggle('bg-success', !!cur && online);
    dot.classList.toggle('bg-warning', !!cur && !online);
    dot.classList.toggle('bg-base-content/30', !cur);
  }
  renderMachineMenuList();
}

let _machinePollTimer = null;
export function startMachinePolling() {
  if (_machinePollTimer) return;
  _machinePollTimer = setInterval(async () => {
    if (!hubMode.peek() || !ctx.token) return;
    await refreshMachinesList();
    syncTopbarMachine();
    // If current machine went offline, warn in topbar label only (don't force picker)
    const cur = selectedMachineId.peek();
    if (cur) {
      const m = (machinesList.peek() || []).find(x => x.id === cur);
      if (m && m.online === false) {
        const label = $('topbar-machine-label');
        if (label) label.textContent = `${cur} (offline)`;
      }
    }
  }, 15000);
}

/** Enter / switch hub machine. */
export async function enterMachine(machineId, { forceReload = false } = {}) {
  if (!machineId) return;
  const prev = selectedMachineId.peek();
  const switching = prev && prev !== machineId;
  setSelectedMachine(machineId);
  hideMachinePicker();
  closeMachineMenu();
  syncTopbarMachine();

  if (switching || forceReload) {
    try { ctx.ws?.close(); } catch {}
    ctx.ws = null;
    ctx.sessionId = null;
    batch(() => {
      currentProject.value = null;
      sessionFilter.value = null;
      viewingFile.value = null;
    });
    if (switching) {
      const { goHome } = await import('./session-nav.js');
      goHome();
    }
  }

  const bar = $('topbar-project');
  if (bar && (!currentProject.peek())) {
    bar.textContent = `Machine · ${machineId}`;
  }

  await Promise.all([loadAllSessions(), loadWorkspaces(), loadSessionMetaMap()]);
  hubMachineReady.value = true;
}

