// app.js — Entry point
import { ctx } from './state.js';
import { api } from './api.js';
import { initShell, showApp, initAuth } from './shell.js';
import { initChat } from './chat.js';
import { initFilesTab } from './files.js';
import { initGitTab } from './git.js';
import { initSettings } from './settings.js';
import { initTerminal } from './terminal.js';

// 1. Render HTML shell (creates all DOM elements)
initShell();

// 2. Initialize feature panels (elements now exist in DOM)
initChat();
initFilesTab();
initGitTab();
initSettings();
initTerminal();

// 3. Boot: resume session if token exists, otherwise show auth
(async () => {
  if (ctx.token) {
    try { await api('GET', '/api/sessions'); showApp(); }
    catch { ctx.token = null; localStorage.removeItem('token'); await initAuth(); }
  } else {
    await initAuth();
  }
})();
