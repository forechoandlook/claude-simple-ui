// pwa.js — register service worker + optional install affordance
// Does not touch WebSocket; SW only caches static shell assets.

let deferredInstall = null;

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
    || document.referrer.includes('android-app://')
  );
}

function showInstallButton() {
  document.getElementById('btn-pwa-install')?.classList.remove('hidden');
}

export function initPwa() {
  if (isStandalone()) {
    document.documentElement.classList.add('pwa-standalone');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    document.dispatchEvent(new CustomEvent('pwa-installable'));
    showInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    document.getElementById('btn-pwa-install')?.classList.add('hidden');
  });

  // iOS Safari has no beforeinstallprompt — still offer a tip button on mobile.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isStandalone() && (isIOS || /Android/i.test(navigator.userAgent))) {
    // Defer until shell HTML exists
    requestAnimationFrame(() => showInstallButton());
  }

  if (!('serviceWorker' in navigator)) return;

  // Register after first paint so install doesn't compete with boot.
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              console.info('[pwa] New version ready — reload to apply');
            }
          });
        });
      })
      .catch((err) => console.warn('[pwa] SW register failed', err));
  };

  if (document.readyState === 'complete') setTimeout(register, 0);
  else window.addEventListener('load', () => setTimeout(register, 0));
}

/** Trigger native install sheet when available (Chrome/Edge Android, some desktop). */
export async function promptPwaInstall() {
  if (!deferredInstall) return false;
  deferredInstall.prompt();
  const choice = await deferredInstall.userChoice.catch(() => null);
  deferredInstall = null;
  document.getElementById('btn-pwa-install')?.classList.add('hidden');
  return choice?.outcome === 'accepted';
}

export function canInstallPwa() {
  return !!deferredInstall;
}
