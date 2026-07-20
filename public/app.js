// app.js — Entry point
import { ctx } from './state.js';
import { probeHub } from './api.js';
import { initShell, showApp, initAuth, resumeSession, switchTab } from './shell.js';
import { initChat } from './chat.js';
import { initFilesTab } from './files.js';
import { initGitTab } from './git.js';
import { initSettings } from './settings.js';
import { initTerminal } from './terminal.js';
import { initImagePaste } from './chat.js';
import { initRouter, applyInitialRoute, parseHashPath } from './router.js';

// 1. Render HTML shell (creates all DOM elements)
initShell();

// 2. Initialize feature panels (elements now exist in DOM)
initChat();
initFilesTab();
initGitTab();
initSettings();
initTerminal();
initImagePaste();
initRouter(resumeSession, switchTab);

// 3. Boot — parallel hub probe; deep-link restored inside showApp (not after full session list)
(async () => {
  const deepLink = parseHashPath(location.hash.slice(1) || '/');
  const hubPromise = probeHub();

  if (ctx.token) {
    try {
      const hub = await hubPromise;
      await showApp({ hub, deepLink });
      // Only apply hash if showApp didn't already handle a deep session link
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
