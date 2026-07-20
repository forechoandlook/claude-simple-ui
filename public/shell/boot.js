// shell/boot.js — showApp after login
import { $ } from '../lib.js';
import {
  hubMode, machinesList, hubMachineReady, setSelectedMachine, sessionsData, ctx,
} from '../state.js';
import { probeHub } from '../api.js';
import { getCachedSessions } from '../cache.js';
import { getLastSessionContext } from './session-context.js';
import { loadAllSessions, loadWorkspaces } from './session-list.js';
import { loadSessionMetaMap } from './notes.js';
import { resumeSession } from './session-nav.js';
import {
  refreshMachinesList, hideMachinePicker, showMachinePicker,
  syncTopbarMachine, startMachinePolling,
} from './hub.js';

export async function showApp(opts = {}) {
  $('auth-screen').style.display = 'none';
  const app = $('app');
  app.classList.remove('hidden');
  app.style.display = 'flex';

  // Use probe result from boot when provided (avoid second /api/hub round-trip)
  let hub = opts.hub;
  if (hub === undefined) {
    hub = await probeHub();
  } else if (hub) {
    hubMode.value = true;
    if (hub.machines) machinesList.value = hub.machines;
  } else {
    hubMode.value = false;
  }

  const deep = opts.deepLink || null;
  const last = getLastSessionContext();

  // Hide welcome early when restoring a session URL
  if (deep?.id || location.hash.startsWith('#/session/')) {
    $('welcome')?.classList.add('hidden');
    const pv = $('project-view');
    if (pv) { pv.classList.remove('hidden'); pv.style.display = 'flex'; }
  }

  if (hubMode.peek()) {
    const remembered = localStorage.getItem('machineId') || last?.machineId || '';
    // Optimistic: use remembered machine immediately (don't wait for machines list)
    if (remembered) {
      setSelectedMachine(remembered);
      hideMachinePicker();
      hubMachineReady.value = true;
    }

    // Machines list: refresh in background; only block picker if no remembered id
    const machinesP = refreshMachinesList().then(ms => {
      syncTopbarMachine();
      if (!remembered) return ms;
      const online = ms.some(m => m.id === remembered && m.online !== false);
      if (!online && ms.length) {
        // remembered offline — user can switch from menu; keep selection unless gone entirely
        const exists = ms.some(m => m.id === remembered);
        if (!exists) {
          setSelectedMachine(null);
          showMachinePicker();
        }
      }
      return ms;
    });

    startMachinePolling();
    syncTopbarMachine();

    // Sessions/workspaces: paint cache fast, refresh bg — don't block deep-link
    const dataP = Promise.all([
      loadAllSessions({ waitFresh: false }),
      loadWorkspaces({ waitFresh: false }),
      loadSessionMetaMap().catch(() => {}),
    ]);

    // Deep-link ASAP using lastSessionContext / list cache
    if (deep?.id) {
      const s = sessionsData.peek().find(x => x.sessionId === deep.id)
        || (last?.sessionId === deep.id ? last : null);
      await resumeSession(
        deep.id,
        s?.cwd || last?.cwd || null,
        s?.configDir || last?.configDir || null,
        s?.agent || last?.agent || null,
        s?.machineId || last?.machineId || remembered || null,
        { tab: deep.tab || 'chat' },
      );
      // ensure machines eventually known
      machinesP.catch(() => {});
      dataP.catch(() => {});
      return;
    }

    if (!remembered) {
      await machinesP;
      const ms = machinesList.peek() || [];
      if (!ms.length) {
        showMachinePicker();
        dataP.catch(() => {});
        return;
      }
      showMachinePicker();
      dataP.catch(() => {});
      return;
    }

    await dataP;
    const bar = $('topbar-project');
    if (bar && bar.textContent === 'Select a session') {
      bar.textContent = `Machine · ${remembered}`;
    }
    return;
  }

  // Standalone: cache-first sessions, then deep link
  const dataP = Promise.all([
    loadAllSessions({ waitFresh: false }),
    loadWorkspaces({ waitFresh: false }),
    loadSessionMetaMap().catch(() => {}),
  ]);

  if (deep?.id) {
    // Apply cache if any, then resume without waiting for network sessions
    await getCachedSessions().then(c => { if (c) sessionsData.value = c; }).catch(() => {});
    const s = sessionsData.peek().find(x => x.sessionId === deep.id)
      || (last?.sessionId === deep.id ? last : null);
    await resumeSession(
      deep.id,
      s?.cwd || last?.cwd || null,
      s?.configDir || last?.configDir || null,
      s?.agent || last?.agent || null,
      null,
      { tab: deep.tab || 'chat' },
    );
    dataP.catch(() => {});
    return;
  }

  await dataP;
}
