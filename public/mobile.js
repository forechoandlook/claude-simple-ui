// mobile.js — visual viewport (iOS keyboard) + isolate hidden form fields
// Safari's accessory bar / "Not Secure" chrome cannot be painted over from the page.

function setInert(el, on) {
  if (!el) return;
  if (on) el.setAttribute('inert', '');
  else el.removeAttribute('inert');
}

function isHidden(el) {
  if (!el) return true;
  if (el.classList.contains('hidden')) return true;
  const d = el.style.display;
  return d === 'none';
}

/** Keep iOS form-assistant from tabbing through off-screen / hidden inputs. */
export function syncFocusScope() {
  const mobile = typeof window !== 'undefined'
    && window.matchMedia('(max-width: 640px)').matches;

  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    const open = !mobile || sidebar.classList.contains('open');
    setInert(sidebar, !open);
  }

  setInert(document.getElementById('welcome'), isHidden(document.getElementById('welcome')));
  setInert(document.getElementById('auth-screen'), isHidden(document.getElementById('auth-screen')));
  setInert(document.getElementById('chat-opts'), isHidden(document.getElementById('chat-opts')));
  setInert(document.getElementById('machine-picker'), isHidden(document.getElementById('machine-picker')));

  for (const id of ['files', 'git', 'shell', 'memory']) {
    const el = document.getElementById(`tab-${id}`);
    setInert(el, isHidden(el));
  }

  const chat = document.getElementById('tab-chat');
  if (chat) setInert(chat, isHidden(chat));
}

function applyVisualViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) return;

  const keyboardish = vv.height < window.innerHeight - 80;
  root.classList.toggle('vv-keyboard', keyboardish);
  root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
}

export function initMobileChrome() {
  syncFocusScope();
  applyVisualViewport();

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', applyVisualViewport);
    vv.addEventListener('scroll', applyVisualViewport);
  }
  window.addEventListener('resize', () => {
    applyVisualViewport();
    syncFocusScope();
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      applyVisualViewport();
      syncFocusScope();
    }, 250);
  });
}
