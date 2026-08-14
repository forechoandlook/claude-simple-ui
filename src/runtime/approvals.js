/**
 * In-flight tool permission requests (Claude canUseTool bridge).
 * requestId → { resolve, reject, sessionId, createdAt }
 */

const pending = new Map();

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * @param {string} requestId
 * @param {string | null} sessionId
 * @param {number} [ttlMs]
 * @returns {Promise<{ allow: boolean, always?: boolean }>}
 */
export function waitForApproval(requestId, sessionId, ttlMs = DEFAULT_TTL_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ allow: false, always: false, timeout: true });
    }, ttlMs);

    pending.set(requestId, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
      sessionId: sessionId || null,
      createdAt: Date.now(),
    });
  });
}

/**
 * @param {string} requestId
 * @param {{ allow: boolean, always?: boolean }} decision
 * @returns {boolean}
 */
export function resolveApproval(requestId, decision) {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  entry.resolve({
    allow: !!decision.allow,
    always: !!decision.always,
  });
  return true;
}

/** Drop pending approvals for a session (on interrupt). */
export function cancelApprovalsForSession(sessionId) {
  if (!sessionId) return;
  for (const [id, entry] of pending) {
    if (entry.sessionId === sessionId || entry.sessionId == null) {
      pending.delete(id);
      entry.resolve({ allow: false, always: false, cancelled: true });
    }
  }
}

export function pendingApprovalCount() {
  return pending.size;
}
