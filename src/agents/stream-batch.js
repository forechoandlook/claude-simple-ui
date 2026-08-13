/**
 * Coalesce chatty stream chunks into fewer WebSocket frames.
 * Keeps UI latency low (flush on size or ~maxWait ms) while cutting
 * mobile tunnel traffic: each JSON frame has fixed tunnel/header overhead.
 */
export function createDeltaBatcher(send, type, extra = {}, opts = {}) {
  const maxWait = opts.maxWait ?? 48;
  const maxSize = opts.maxSize ?? 480;
  let buf = '';
  let timer = null;

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buf) return;
    const data = buf;
    buf = '';
    send({ type, data, ...extra });
  }

  return {
    push(chunk) {
      if (chunk == null || chunk === '') return;
      buf += String(chunk);
      if (buf.length >= maxSize) {
        flush();
        return;
      }
      if (!timer) timer = setTimeout(flush, maxWait);
    },
    flush,
    pending() { return buf.length; },
  };
}

/** Batch raw text for shell / terminal style streams. */
export function createTextBatcher(sendFn, opts = {}) {
  const maxWait = opts.maxWait ?? 32;
  const maxSize = opts.maxSize ?? 2048;
  let buf = '';
  let timer = null;

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buf) return;
    const data = buf;
    buf = '';
    sendFn(data);
  }

  return {
    push(chunk) {
      if (chunk == null || chunk === '') return;
      buf += String(chunk);
      if (buf.length >= maxSize) {
        flush();
        return;
      }
      if (!timer) timer = setTimeout(flush, maxWait);
    },
    flush,
  };
}
