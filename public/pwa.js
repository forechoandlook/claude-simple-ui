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

function isIpHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  // Bare IPv6 (no zone id)
  if (h.includes(':') && /^[0-9a-f:]+$/i.test(h)) return true;
  return false;
}

/** SW requires a trusted TLS cert. IP + self-signed HTTPS always fails fetch(sw.js). */
function canRegisterSw() {
  if (!('serviceWorker' in navigator)) return false;
  if (!window.isSecureContext) return false;
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (isIpHost(host)) return false;
  return location.protocol === 'https:';
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

  if (!canRegisterSw()) {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
    }
    return;
  }

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
      .catch(() => {
        // Typical on self-signed / corporate MITM certs. App works without SW.
        navigator.serviceWorker.getRegistrations()
          .then((regs) => regs.forEach((r) => r.unregister()))
          .catch(() => {});
      });
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
