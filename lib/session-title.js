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

module.exports = { resolveSessionTitle, sanitizeSessionTitle, terminalTitleSequence };
