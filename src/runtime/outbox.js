/**
 * Low-pressure WebSocket outbox.
 * - Coalesces assistant/thought deltas
 * - Optionally packs several small events into one `batch` frame
 * - Flushes on size, time, or non-mergeable event
 */

import { UI_EVENT } from './protocol.js';

const DELTA_TYPES = new Set([
  UI_EVENT.ASSISTANT_DELTA,
  UI_EVENT.THOUGHT_DELTA,
  'shell-output',
]);

/**
 * @param {(data: object) => void} rawSend  — must JSON-send one frame
 * @param {object} [opts]
 */
export function createOutbox(rawSend, opts = {}) {
  const maxWait = opts.maxWait ?? 45;
  const maxDeltaChars = opts.maxDeltaChars ?? 640;
  const maxBatchItems = opts.maxBatchItems ?? 12;
  const maxBatchBytes = opts.maxBatchBytes ?? 8_000;
  const enableBatch = opts.enableBatch !== false;

  /** @type {object | null} */
  let pendingDelta = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let deltaTimer = null;
  /** @type {object[]} */
  let batch = [];
  let batchBytes = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let batchTimer = null;

  function emitFrame(frame) {
    if (!frame) return;
    try {
      rawSend(frame);
    } catch { /* ignore closed socket */ }
  }

  function flushBatch() {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    if (!batch.length) return;
    const items = batch;
    batch = [];
    batchBytes = 0;
    if (items.length === 1) {
      emitFrame(items[0]);
    } else {
      emitFrame({ type: UI_EVENT.BATCH, items });
    }
  }

  function enqueue(frame) {
    if (!enableBatch) {
      emitFrame(frame);
      return;
    }
    // Control / terminal events go out immediately (after draining batch)
    const urgent = frame.type === 'error'
      || frame.type === 'complete'
      || frame.type === 'result'
      || frame.type === 'permission_request'
      || frame.type === 'session-created'
      || frame.type === 'run-status'
      || frame.type === 'abort-result'
      || frame.type === 'shell-exit';
    if (urgent) {
      flushBatch();
      emitFrame(frame);
      return;
    }

    let size;
    try {
      size = JSON.stringify(frame).length;
    } catch {
      size = 256;
    }
    batch.push(frame);
    batchBytes += size;
    if (batch.length >= maxBatchItems || batchBytes >= maxBatchBytes) {
      flushBatch();
      return;
    }
    if (!batchTimer) batchTimer = setTimeout(flushBatch, maxWait);
  }

  function flushDelta() {
    if (deltaTimer) {
      clearTimeout(deltaTimer);
      deltaTimer = null;
    }
    if (!pendingDelta) return;
    const d = pendingDelta;
    pendingDelta = null;
    enqueue(d);
  }

  /**
   * Accept a UI event (or null to drop).
   * @param {object | null | undefined} event
   */
  function send(event) {
    if (!event) return;

    if (DELTA_TYPES.has(event.type)) {
      // Merge consecutive deltas of same type (+ same agent/stream key)
      const key = `${event.type}|${event.agent || ''}|${event.stream || ''}`;
      if (pendingDelta) {
        const pKey = `${pendingDelta.type}|${pendingDelta.agent || ''}|${pendingDelta.stream || ''}`;
        if (pKey === key) {
          pendingDelta.data = (pendingDelta.data || '') + (event.data || '');
          if ((pendingDelta.data || '').length >= maxDeltaChars) flushDelta();
          else if (!deltaTimer) deltaTimer = setTimeout(flushDelta, maxWait);
          return;
        }
        flushDelta();
      }
      pendingDelta = { ...event, data: event.data || '' };
      if ((pendingDelta.data || '').length >= maxDeltaChars) flushDelta();
      else if (!deltaTimer) deltaTimer = setTimeout(flushDelta, maxWait);
      return;
    }

    // Non-delta: flush coalesced text first so order stays correct
    flushDelta();
    enqueue(event);
  }

  function flush() {
    flushDelta();
    flushBatch();
  }

  return { send, flush };
}
