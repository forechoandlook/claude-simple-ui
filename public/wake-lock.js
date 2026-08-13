// wake-lock.js — keep screen awake during active chat / agent runs (macOS sleep fix)
let wakeLock = null;
let wantLock = false;

async function acquire() {
  if (!wantLock) return;
  if (typeof navigator === 'undefined' || !navigator.wakeLock?.request) return;
  if (document.visibilityState !== 'visible') return;
  if (wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      // System released (e.g. low battery) — try again if still wanted
      if (wantLock && document.visibilityState === 'visible') {
        setTimeout(() => { acquire().catch(() => {}); }, 500);
      }
    });
  } catch {
    // Not allowed / unsupported — ignore
    wakeLock = null;
  }
}

async function release() {
  const lock = wakeLock;
  wakeLock = null;
  if (!lock) return;
  try { await lock.release(); } catch { /* ignore */ }
}

/** Enable/disable preferred wake-lock state (still requires visible document). */
export function setWakeLockDesired(on) {
  wantLock = !!on;
  if (wantLock) acquire().catch(() => {});
  else release().catch(() => {});
}

export function initWakeLock() {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wantLock) acquire().catch(() => {});
    else if (document.visibilityState === 'hidden') release().catch(() => {});
  });
}
