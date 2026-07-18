'use strict';

const pty = require('node-pty');
const { StringDecoder } = require('node:string_decoder');
const { createTerminalOutputSink } = require('./terminal-output-sink');
const { sanitizeSessionTitle, terminalTitleSequence } = require('./session-title');

// Keep mouse reporting disabled in the outer terminal. With Codex running in
// --no-alt-screen mode, this lets Windows Terminal own a physical wheel event
// and scroll its real normal-buffer history, exactly as it does for a local
// Codex process. Capturing the wheel here breaks that behavior and older Node
// runtimes can discard Windows mouse records before JavaScript sees them.
const DISABLE_MOUSE_REPORTING = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';

function terminalDimensions(output) {
  return {
    cols: Math.max(20, Number.isInteger(output?.columns) ? output.columns : 120),
    rows: Math.max(5, Number.isInteger(output?.rows) ? output.rows : 36),
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
  const inputDecoder = new StringDecoder('utf8');

  function writeChild(data) {
    if (!exited && !stopped && data) { child.write(data); }
  }

  function onInput(data) {
    writeChild(Buffer.isBuffer(data) ? inputDecoder.write(data) : String(data));
  }
  function onInputError(error) { fail(error); }
  function onResize() {
    if (exited || stopped) { return; }
    const size = terminalDimensions(output);
    try { child.resize(size.cols, size.rows); }
    catch (error) { fail(error); }
  }

  const dataSubscription = child.onData((data) => {
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
  sink.write(DISABLE_MOUSE_REPORTING);
  if (currentTitle) { sink.write(terminalTitleSequence(currentTitle)); }
  if (input.isTTY && typeof input.setRawMode === 'function' && !wasRaw) { input.setRawMode(true); }
  if (typeof input.resume === 'function') { input.resume(); }

  function stop() {
    if (stopped) { return; }
    stopped = true;
    input.off('data', onInput);
    input.off('error', onInputError);
    output.off('resize', onResize);
    dataSubscription?.dispose?.();
    exitSubscription?.dispose?.();
    sink.write(DISABLE_MOUSE_REPORTING);
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
  DISABLE_MOUSE_REPORTING,
  startNativeCodexTerminal,
  terminalDimensions,
};
