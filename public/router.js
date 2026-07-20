// router.js — Hash routing: #/  #/session/:id  #/session/:id/:tab
import { createRouter, watch } from './lib.js';
import { currentTab, ctx } from './state.js';

export const router = createRouter({
  '/':                  () => {},
  '/session/*':         () => {},
  '/session/*/*':       () => {},
  '*':                  () => {},
});

let _resumeSession = null;
let _switchTab     = null;
let _ignoreNext    = false;  // prevent feedback loop when we set hash programmatically

// Called by app.js after shell+chat are initialised
export function initRouter(resumeSession, switchTab) {
  _resumeSession = resumeSession;
  _switchTab     = switchTab;

  // Handle hash changes (back/forward/manual)
  window.addEventListener('hashchange', () => {
    if (_ignoreNext) { _ignoreNext = false; return; }
    applyHash(location.hash.slice(1) || '/');
  });

  // Keep hash in sync when session/tab changes
  watch(currentTab, tab => {
    if (ctx.sessionId) setHash(`/session/${ctx.sessionId}/${tab}`);
  });
}

// Called by app.js AFTER showApp() + sessions loaded — applies the initial URL hash
export function applyInitialRoute() {
  applyHash(location.hash.slice(1) || '/');
}

function applyHash(path) {
  // /session/:id  or  /session/:id/:tab
  const m = path.match(/^\/session\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) {
    document.dispatchEvent(new CustomEvent('router:home'));
    return;
  }
  const [, id, tab] = m;
  if (!_resumeSession || !_switchTab) return;

  if (id !== ctx.sessionId) {
    // Need to look up cwd from loaded sessions — defer to shell
    document.dispatchEvent(new CustomEvent('router:session', { detail: { id, tab } }));
  } else if (tab && tab !== currentTab.peek()) {
    _switchTab(tab);
  }
}

export function setHash(path) {
  _ignoreNext = true;
  location.hash = path;
}

// Convenience: call after resumeSession completes to set URL
export function syncHash() {
  if (ctx.sessionId) setHash(`/session/${ctx.sessionId}/${currentTab.peek()}`);
}
