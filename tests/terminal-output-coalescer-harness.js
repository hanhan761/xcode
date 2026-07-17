#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createTerminalOutputCoalescer } = require('../lib/terminal-output-coalescer');

function main() {
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

  for (let index = 0; index < 43; index++) { coalescer.write(`frame-${index};`); }
  assert.equal(scheduled.length, 1, 'A 43 FPS Codex stream scheduled more than one terminal paint in a frame interval.');
  scheduled.shift()();
  assert.equal(writes.length, 1, 'A burst of terminal frames was not merged into one paint.');
  assert.equal(writes[0], Array.from({ length: 43 }, (_, index) => `frame-${index};`).join(''), 'Coalescing changed the native Codex byte stream.');

  coalescer.write('final-frame');
  coalescer.close();
  assert.deepEqual(writes, [Array.from({ length: 43 }, (_, index) => `frame-${index};`).join(''), 'final-frame'], 'Closing a Codex session dropped pending terminal output.');
  console.log('TERMINAL_OUTPUT_COALESCER=PASS');
}

main();
