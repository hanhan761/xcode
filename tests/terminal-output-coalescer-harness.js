#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createTerminalOutputCoalescer } = require('../lib/terminal-output-coalescer');

async function main() {
  const writes = [];
  const scheduled = [];
  const coalescer = createTerminalOutputCoalescer((data) => writes.push(data), {
    frameIntervalMs: 50,
    schedule(callback) {
      scheduled.push(callback);
      return callback;
    },
    cancel() {},
  });

  const frames = Array.from({ length: 43 }, (_, index) => `\x1b[3;1H\x1b[2Kworking-${index}`);
  await Promise.all(frames.map((frame) => coalescer.write(frame)));
  assert.equal(scheduled.length, 1, 'A 43 FPS Codex stream scheduled more than one terminal paint in a frame interval.');
  scheduled.shift()();
  assert.equal(writes.length, 1, 'A burst of terminal frames was not merged into one paint.');
  assert.match(writes[0], /^\x1b\[\?2026h/, 'A completed dynamic frame was not opened as synchronized terminal output.');
  assert.match(writes[0], /\x1b\[\?2026l$/, 'A completed dynamic frame was not committed atomically to Windows Terminal.');
  assert.equal((writes[0].match(/\x1b\[2K/g) || []).length, 0, 'Intermediate erase-line animations still reached Windows Terminal.');
  assert.doesNotMatch(writes[0], /working-(?:[0-9]|[1-3][0-9]|4[01])(?![0-9])/, 'An intermediate spinner frame still reached Windows Terminal.');
  assert.match(writes[0], /working-42/, 'The final native Codex screen state was not rendered.');

  coalescer.resize(48, 10);
  const border = `╔${'═'.repeat(46)}╗`;
  await coalescer.write(`\x1b[4;1H\x1b[31;1mfinal-frame\x1b[0m\x1b[10;1H${border}`);
  await coalescer.close();
  assert.equal(writes.every((frame) => frame.startsWith('\x1b[?2026h') && frame.endsWith('\x1b[?2026l')), true,
    'A dynamic paint or terminal-restore frame escaped synchronized output.');
  assert.match(writes.join(''), /final-frame/, 'Closing a Codex session dropped pending terminal output.');
  assert.match(writes.join(''), /\x1b\[[0-9;]*31[0-9;]*m/, 'The final-state renderer lost native Codex foreground color.');
  assert.match(writes.join(''), new RegExp(`\\x1b\\[10;1H[^\\r\\n]*${border}`), 'A resize lost the complete bottom terminal border.');
  console.log('TERMINAL_OUTPUT_COALESCER=PASS');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
