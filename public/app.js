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
import { initRouter, applyInitialRoute, parseHashPath } from './router.js';

const deepLink = parseHashPath(location.hash.slice(1) || '/');
const restoreSession = shouldRestoreSessionOnBoot() || !!(ctx.token && deepLink?.id);

// 1. Render shell — hide welcome calendar immediately when restoring a session URL
initShell({ restoreSession });

// 2. Feature panels (DOM exists)
initChat();
initFilesTab();
initGitTab();
initSettings();
initTerminal();
initImagePaste();
initRouter(resumeSession, switchTab);

// 3. Boot: show app chrome ASAP, then load data (no calendar flash on deep-link)
(async () => {
  // Kick hub probe immediately (don't block first paint of shell)
  const hubPromise = probeHub();

  if (ctx.token) {
    try {
      // Show app frame right away (auth already skipped)
      const auth = document.getElementById('auth-screen');
      const app = document.getElementById('app');
      if (auth) { auth.style.display = 'none'; auth.classList.add('hidden'); }
      if (app) { app.style.display = 'flex'; app.classList.remove('hidden'); }

      if (restoreSession) {
        const welcome = document.getElementById('welcome');
        const pv = document.getElementById('project-view');
        welcome?.classList.add('hidden');
        if (pv) {
          pv.classList.remove('hidden');
          pv.style.display = 'flex';
          pv.style.flexDirection = 'column';
          pv.style.flex = '1';
          pv.style.minHeight = '0';
        }
      }

      const hub = await hubPromise;
      await showApp({ hub, deepLink });
      if (!deepLink?.id) applyInitialRoute();
    } catch (e) {
      console.error('[boot]', e);
      ctx.token = null;
      localStorage.removeItem('token');
      await initAuth();
    }
  } else {
    await initAuth();
  }
})();
