'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { Terminal } = require('@xterm/headless');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const managedCodexSource = fs.readFileSync(path.join(packageRoot, 'bin', 'managed-codex.js'), 'utf8');

assert.doesNotMatch(managedCodexSource, /terminal-output-coalescer/,
  'The main Codex terminal still redraws snapshots instead of preserving official terminal bytes.');
assert.match(managedCodexSource, /createTerminalTitleFilter/,
  'The main Codex terminal no longer preserves persistent xcode tab titles.');
assert.match(managedCodexSource, /session\.onOutput\(\(data\) => terminalOutput\.write\(data\)\)/,
  'The main Codex terminal does not forward official output directly.');
assert.match(managedCodexSource, /const DISABLE_MOUSE_REPORTING =/,
  'The main Codex terminal does not explicitly release the physical mouse wheel.');
assert.match(managedCodexSource, /output\.write\(DISABLE_MOUSE_REPORTING\)/,
  'The main Codex terminal leaves terminal mouse capture enabled.');

const { createTerminalTitleFilter } = require(path.join(packageRoot, 'lib', 'session-title'));
const { createTerminalOutputSink } = require(path.join(packageRoot, 'lib', 'terminal-output-sink'));

async function main() {
  const output = new PassThrough();
  output.columns = 80;
  output.rows = 6;
  const terminal = new Terminal({ cols: 80, rows: 6, scrollback: 200, allowProposedApi: true, logLevel: 'off' });
  let rawOutput = '';
  output.on('data', (data) => {
    rawOutput += data;
    terminal.write(data);
  });

  const sink = createTerminalOutputSink(output);
  const terminalOutput = createTerminalTitleFilter((data) => sink.write(data), 'Shared conversation');
  terminalOutput.write('\x1b]0;upstream transient title');
  terminalOutput.write('\x07');
  terminalOutput.write('\x1b]9;Codex turn complete\x07\x07');
  terminalOutput.write('\x1b[2;1H⠋ Working');
  terminalOutput.write(Array.from({ length: 20 }, (_, index) => `\r\nHISTORY_${index}`).join(''));
  terminalOutput.flush();

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(rawOutput, /\x1b\]0;upstream transient title — Shared conversation\x07/, 'The upstream working title was not combined with the persisted conversation title.');
  assert.doesNotMatch(rawOutput, /\x1b\]0;upstream transient title\x07/, 'The upstream working title bypassed the persisted conversation title.');
  assert.match(rawOutput, /\x1b\]9;Codex turn complete\x07/, 'The official terminal notification was dropped.');
  assert.match(rawOutput, /⠋ Working/, 'The official working spinner frame was dropped.');
  assert.ok(terminal.buffer.normal.baseY > 0, 'The main terminal did not retain native normal-buffer scrollback.');
  sink.close();
  terminal.dispose();
  console.log('MANAGED_CODEX_NATIVE_OUTPUT=PASS');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
