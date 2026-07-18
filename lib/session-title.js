'use strict';

const path = require('node:path');

const MAX_TITLE_CHARACTERS = 120;

function sanitizeSessionTitle(value) {
  const withoutControls = String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  return Array.from(withoutControls.trim()).slice(0, MAX_TITLE_CHARACTERS).join('');
}

function resolveSessionTitle(threadName, cwd) {
  const custom = sanitizeSessionTitle(threadName);
  if (custom) { return custom; }
  const folder = sanitizeSessionTitle(path.basename(String(cwd || '')));
  return folder || 'Codex';
}

function terminalTitleSequence(title) {
  return `\x1b]0;${sanitizeSessionTitle(title) || 'Codex'}\x07`;
}

function createTerminalTitleFilter(write) {
  if (typeof write !== 'function') { throw new TypeError('A terminal title filter requires a writer.'); }
  let pending = '';

  function drain(flush) {
    let output = '';
    while (pending) {
      const start = pending.indexOf('\x1b]');
      if (start < 0) {
        const retained = flush || !pending.endsWith('\x1b') ? 0 : 1;
        output += pending.slice(0, pending.length - retained);
        pending = retained ? pending.slice(-retained) : '';
        break;
      }
      if (start > 0) {
        output += pending.slice(0, start);
        pending = pending.slice(start);
        continue;
      }
      if (pending.startsWith('\x1b]0;') || pending.startsWith('\x1b]2;')) {
        const terminator = /\x07|\x1b\\/.exec(pending.slice(4));
        if (!terminator) {
          if (flush) { pending = ''; }
          break;
        }
        pending = pending.slice(4 + terminator.index + terminator[0].length);
        continue;
      }
      if (!flush && '\x1b]0;'.startsWith(pending)) { break; }
      output += pending.slice(0, 2);
      pending = pending.slice(2);
    }
    if (output) { write(output); }
  }

  return {
    write(data) {
      if (!data) { return; }
      pending += String(data);
      drain(false);
    },
    flush() { drain(true); },
  };
}

module.exports = { createTerminalTitleFilter, resolveSessionTitle, sanitizeSessionTitle, terminalTitleSequence };
