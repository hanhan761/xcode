'use strict';

function hasVisibleNativeWorkingSpinner(screen) {
  if (typeof screen !== 'string') { return false; }
  return screen.split('\n').some((line) => /^\s*[\u25e6\u2800-\u28ff]\s+Working\b/.test(line));
}

function createAuthoritativeWorkingReconciler({
  threadId,
  readThreadStatus,
  isWorkingSpinnerVisible,
  restartTui,
  delayMs = 750,
}) {
  if (typeof threadId !== 'string' || !threadId) { throw new TypeError('A selected Codex thread id is required.'); }
  if (typeof readThreadStatus !== 'function' || typeof isWorkingSpinnerVisible !== 'function' || typeof restartTui !== 'function') {
    throw new TypeError('The authoritative Working reconciler requires status, screen, and restart callbacks.');
  }

  let closed = false;
  let timer = null;
  let generation = 0;

  function cancelPendingCheck() {
    generation += 1;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleIdleCheck() {
    cancelPendingCheck();
    const scheduledGeneration = generation;
    timer = setTimeout(async () => {
      timer = null;
      try {
        const statusType = await readThreadStatus();
        if (closed || scheduledGeneration !== generation || statusType !== 'idle') { return; }
        if (await isWorkingSpinnerVisible()) {
          if (!closed && scheduledGeneration === generation) { await restartTui(); }
        }
      }
      catch {
        // A transient status read must not disrupt a healthy native terminal.
      }
    }, delayMs);
  }

  return {
    onNotification(event) {
      if (closed || event?.params?.threadId !== threadId) { return; }
      if (event.method === 'turn/started') {
        cancelPendingCheck();
      }
      else if (event.method === 'turn/completed') {
        scheduleIdleCheck();
      }
    },
    close() {
      closed = true;
      cancelPendingCheck();
    },
  };
}

module.exports = { createAuthoritativeWorkingReconciler, hasVisibleNativeWorkingSpinner };
