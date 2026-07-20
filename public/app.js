// app.js — Entry point
import { ctx } from './state.js';
import { probeHub } from './api.js';
import { initShell, showApp, initAuth, resumeSession, switchTab, shouldRestoreSessionOnBoot } from './shell.js';
import { initChat } from './chat.js';
import { initFilesTab } from './files.js';
import { initGitTab } from './git.js';
import { initSettings } from './settings.js';
import { initTerminal } from './terminal.js';
import { initImagePaste } from './chat.js';
import { initMetaAgent } from './agent-panel.js';
import { initRouter, applyInitialRoute, parseHashPath } from './router.js';

function markBootReady() {
  const root = document.documentElement;
  root.classList.add('boot-ready');
  root.classList.remove('boot-pending');
  // Keep boot-restore until welcome is intentionally shown (goHome)
}

function clearBootRestore() {
  document.documentElement.classList.remove('boot-restore');
}

const deepLink = parseHashPath(location.hash.slice(1) || '/');
const restoreSession = shouldRestoreSessionOnBoot() || !!(ctx.token && deepLink?.id);

// 1. Build DOM (welcome already suppressed via html.boot-restore CSS when restoring)
initShell({ restoreSession });

// 2. Feature panels
initChat();
initFilesTab();
initGitTab();
initSettings();
initTerminal();
initImagePaste();
initMetaAgent();
initRouter(resumeSession, switchTab);

// 3. Boot data
(async () => {
  const hubPromise = probeHub();

  if (ctx.token) {
    try {
      const auth = document.getElementById('auth-screen');
      const app = document.getElementById('app');
      if (auth) { auth.style.display = 'none'; auth.classList.add('hidden'); }
      if (app) { app.style.display = 'flex'; app.classList.remove('hidden'); }

      if (restoreSession) {
        document.documentElement.classList.add('boot-restore');
        const welcome = document.getElementById('welcome');
        const pv = document.getElementById('project-view');
        if (welcome) {
          welcome.classList.add('hidden');
          welcome.style.display = 'none';
        }
        if (pv) {
          pv.classList.remove('hidden');
          pv.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden';
        }
      }

      const hub = await hubPromise;
      await showApp({ hub, deepLink });
      if (!deepLink?.id) {
        applyInitialRoute();
        // Home: allow calendar; drop restore lock
        if (!(location.hash || '').startsWith('#/session/')) clearBootRestore();
      }
      // Reveal only after shell + route/session start settled
      requestAnimationFrame(() => {
        requestAnimationFrame(markBootReady);
      });
    } catch (e) {
      console.error('[boot]', e);
      ctx.token = null;
      localStorage.removeItem('token');
      clearBootRestore();
      await initAuth();
      markBootReady();
    }
  } else {
    clearBootRestore();
    await initAuth();
    markBootReady();
  }
})();

// When user goes home later, allow welcome again
document.addEventListener('router:home', () => {
  clearBootRestore();
});
