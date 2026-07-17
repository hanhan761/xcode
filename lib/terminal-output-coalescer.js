'use strict';

// Native Codex redraws small cursor/spinner regions at roughly 40 FPS. Writing
// every diff into the outer PowerShell makes Windows Terminal visibly busy,
// although byte ordering is all the terminal requires. Merge one display
// interval at a time; the session gateway still receives every original frame.

function createTerminalOutputCoalescer(write, {
  frameIntervalMs = 50,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof write !== 'function') { throw new TypeError('A terminal coalescer requires a write function.'); }
  if (!Number.isInteger(frameIntervalMs) || frameIntervalMs < 1) { throw new RangeError('A terminal coalescer frame interval must be positive.'); }

  let pending = '';
  let timer = null;
  let closed = false;

  function flush() {
    if (!pending) { return; }
    const data = pending;
    pending = '';
    write(data);
  }

  function scheduleFlush() {
    if (timer !== null) { return; }
    timer = schedule(() => {
      timer = null;
      flush();
    }, frameIntervalMs);
  }

  return {
    write(data) {
      if (closed || typeof data !== 'string' || !data) { return; }
      pending += data;
      scheduleFlush();
    },
    flush() {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      flush();
    },
    close() {
      if (closed) { return; }
      this.flush();
      closed = true;
    },
  };
}

module.exports = { createTerminalOutputCoalescer };
