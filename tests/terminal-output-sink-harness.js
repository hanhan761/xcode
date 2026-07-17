#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTerminalOutputSink } = require('../lib/terminal-output-sink');

class FakeTerminalOutput extends EventEmitter {
  write(data, callback) {
    this.writes.push(data);
    if (callback) { queueMicrotask(() => callback(this.writeError)); }
    return true;
  }

  constructor() {
    super();
    this.writes = [];
    this.writeError = null;
  }
}

async function main() {
  const output = new FakeTerminalOutput();
  const failures = [];
  const sink = createTerminalOutputSink(output, (error) => failures.push(error));
  const eagain = Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' });

  output.writeError = eagain;
  sink.write('first frame');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [], 'A transient terminal EAGAIN must not terminate the managed session.');
  assert.doesNotThrow(() => output.emit('error', eagain), 'The terminal stream must have an EAGAIN error listener.');
  assert.deepEqual(failures, [], 'An emitted transient terminal EAGAIN must not be promoted to a fatal error.');

  const fatal = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  output.writeError = fatal;
  sink.write('second frame');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [fatal], 'A non-transient terminal write failure must be reported once.');

  sink.close();
  console.log('TERMINAL_OUTPUT_EAGAIN=PASS');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
