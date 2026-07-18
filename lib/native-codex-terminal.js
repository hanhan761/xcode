'use strict';

const pty = require('node-pty');
const { StringDecoder } = require('node:string_decoder');
const { createTerminalOutputSink } = require('./terminal-output-sink');
const { sanitizeSessionTitle, terminalTitleSequence } = require('./session-title');

const ENABLE_SGR_MOUSE = '\x1b[?1000h\x1b[?1006h';
const DISABLE_SGR_MOUSE = '\x1b[?1006l\x1b[?1000l';
const OPEN_TRANSCRIPT = '\x14';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const ALT_SCREEN_ENTER = '\x1b[?1049h';
const ALT_SCREEN_LEAVE = '\x1b[?1049l';
const MOUSE_PREFIX = '\x1b[<';

function terminalDimensions(output) {
  return {
    cols: Math.max(20, Number.isInteger(output?.columns) ? output.columns : 120),
    rows: Math.max(5, Number.isInteger(output?.rows) ? output.rows : 36),
  };
}

function trailingMousePrefixLength(text) {
  const maximum = Math.min(text.length, MOUSE_PREFIX.length);
  for (let length = maximum; length > 0; length -= 1) {
    if (MOUSE_PREFIX.startsWith(text.slice(-length))) { return length; }
  }
  return 0;
}

function createMouseInputRouter({ write, onWheel, partialSequenceTimeoutMs = 20 }) {
  if (typeof write !== 'function' || typeof onWheel !== 'function') {
    throw new TypeError('A mouse input router requires write and onWheel callbacks.');
  }
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let flushTimer = null;

  function drain(flush = false) {
    while (pending) {
      const start = pending.indexOf(MOUSE_PREFIX);
      if (start < 0) {
        if (flush) {
          write(pending);
          pending = '';
          return;
        }
        const held = trailingMousePrefixLength(pending);
        const writable = pending.slice(0, pending.length - held);
        if (writable) { write(writable); }
        pending = pending.slice(pending.length - held);
        return;
      }
      if (start > 0) {
        write(pending.slice(0, start));
        pending = pending.slice(start);
      }
      const match = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/.exec(pending);
      if (!match) {
        if (!flush && /^\x1b\[<[0-9;]*$/.test(pending)) { return; }
        write(pending[0]);
        pending = pending.slice(1);
        continue;
      }
      pending = pending.slice(match[0].length);
      const button = Number.parseInt(match[1], 10) & ~(4 | 8 | 16);
      if (button === 64) { onWheel('up'); }
      else if (button === 65) { onWheel('down'); }
      // Mouse clicks and motion are intentionally consumed. Codex does not
      // handle them, and forwarding their escape bytes would corrupt input.
    }
  }

  return {
    push(data) {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pending += Buffer.isBuffer(data) ? decoder.write(data) : String(data);
      drain();
      if (pending) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          drain(true);
        }, partialSequenceTimeoutMs);
      }
    },
    flush() {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pending += decoder.end();
      drain(true);
    },
  };
}

function startNativeCodexTerminal({
  file,
  args,
  cwd = process.cwd(),
  env = process.env,
  spawnPty = pty.spawn,
  input = process.stdin,
  output = process.stdout,
  initialTitle = null,
}) {
  if (typeof file !== 'string' || !file) { throw new TypeError('A native Codex executable is required.'); }
  if (!Array.isArray(args)) { throw new TypeError('Native Codex arguments must be an array.'); }
  if (!input || typeof input.on !== 'function') { throw new TypeError('Native Codex requires a terminal input stream.'); }
  if (!output || typeof output.write !== 'function') { throw new TypeError('Native Codex requires a terminal output stream.'); }

  const initialSize = terminalDimensions(output);
  const sink = createTerminalOutputSink(output, (error) => fail(error));
  let exited = false;
  let stopped = false;
  let overlayActive = false;
  let outputTail = '';
  let currentTitle = sanitizeSessionTitle(initialTitle);
  let titleScanTail = '';
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const wasRaw = Boolean(input.isRaw);

  function fail(error) {
    if (exited || stopped) { return; }
    rejectCompleted(error);
  }

  const child = spawnPty(file, args, {
    name: 'xterm-256color',
    cols: initialSize.cols,
    rows: initialSize.rows,
    cwd,
    env,
    useConptyDll: true,
  });

  function writeChild(data) {
    if (!exited && !stopped && data) { child.write(data); }
  }

  const router = createMouseInputRouter({
    write: writeChild,
    onWheel(direction) {
      if (direction === 'up' && !overlayActive) {
        // Ctrl+T is Codex's own transcript viewer. PTY input is ordered, so
        // PageUp is processed after the overlay-open command without a timer.
        writeChild(OPEN_TRANSCRIPT);
      }
      if (direction === 'up') { writeChild(PAGE_UP); }
      else if (overlayActive) { writeChild(PAGE_DOWN); }
    },
  });

  function onInput(data) { router.push(data); }
  function onInputError(error) { fail(error); }
  function onResize() {
    if (exited || stopped) { return; }
    const size = terminalDimensions(output);
    try { child.resize(size.cols, size.rows); }
    catch (error) { fail(error); }
  }

  const dataSubscription = child.onData((data) => {
    const scan = outputTail + data;
    const enter = scan.lastIndexOf(ALT_SCREEN_ENTER);
    const leave = scan.lastIndexOf(ALT_SCREEN_LEAVE);
    if (enter >= 0 || leave >= 0) { overlayActive = enter > leave; }
    outputTail = scan.slice(-Math.max(ALT_SCREEN_ENTER.length, ALT_SCREEN_LEAVE.length) + 1);
    sink.write(data);
    const titleScan = titleScanTail + data;
    const titlePattern = /\x1b\](?:0|2);.*?(?:\x07|\x1b\\)/gs;
    let titleMatch;
    let completedTitle = false;
    let completedThrough = 0;
    while ((titleMatch = titlePattern.exec(titleScan)) !== null) {
      completedTitle = true;
      completedThrough = titlePattern.lastIndex;
    }
    titleScanTail = (completedTitle ? titleScan.slice(completedThrough) : titleScan).slice(-8_192);
    if (currentTitle && completedTitle) {
      sink.write(terminalTitleSequence(currentTitle));
    }
  });
  const exitSubscription = child.onExit(({ exitCode, signal }) => {
    exited = true;
    resolveCompleted({ code: exitCode ?? 1, signal });
  });

  input.on('data', onInput);
  input.on('error', onInputError);
  output.on('resize', onResize);
  if (input.isTTY && typeof input.setRawMode === 'function' && !wasRaw) { input.setRawMode(true); }
  if (typeof input.resume === 'function') { input.resume(); }
  sink.write(ENABLE_SGR_MOUSE);
  if (currentTitle) { sink.write(terminalTitleSequence(currentTitle)); }

  function stop() {
    if (stopped) { return; }
    stopped = true;
    router.flush();
    input.off('data', onInput);
    input.off('error', onInputError);
    output.off('resize', onResize);
    dataSubscription?.dispose?.();
    exitSubscription?.dispose?.();
    sink.write(DISABLE_SGR_MOUSE);
    sink.close();
    if (input.isTTY && typeof input.setRawMode === 'function' && !wasRaw) { input.setRawMode(false); }
    if (typeof input.pause === 'function') { input.pause(); }
    if (!exited) {
      try { child.kill(); }
      catch { /* The ConPTY may already be closing. */ }
    }
  }

  return {
    child,
    completed,
    setTitle(nextTitle) {
      currentTitle = sanitizeSessionTitle(nextTitle) || 'Codex';
      sink.write(terminalTitleSequence(currentTitle));
    },
    stop,
  };
}

module.exports = {
  DISABLE_SGR_MOUSE,
  ENABLE_SGR_MOUSE,
  createMouseInputRouter,
  startNativeCodexTerminal,
  terminalDimensions,
};
