#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.XCODE_RUN_LIVE_CODEX_PROBE !== '1') {
  console.error('Set XCODE_RUN_LIVE_CODEX_PROBE=1 to run this isolated real-Codex probe.');
  process.exit(2);
}

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'xcode-remote'));
const { startManagedSession } = require(path.join(packageRoot, 'lib', 'session-runner'));
const { Terminal } = require(require.resolve('@xterm/headless', { paths: [packageRoot] }));

const MAX_OUTPUT_CHARS = 1_000_000;
let stopActiveSession = null;
const hardStop = setTimeout(() => {
  process.stderr.write('LIVE_CODEX_REMOTE_INPUT=TIMEOUT after 110 seconds; stopping the isolated probe session.\n');
  stopActiveSession?.();
  setTimeout(() => process.exit(1), 1_000).unref();
}, 110_000);

function findNativeCodex() {
  const vendors = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  for (const packageName of fs.readdirSync(vendors)) {
    if (!/^codex-win32-/i.test(packageName)) { continue; }
    const vendorRoot = path.join(vendors, packageName, 'vendor');
    for (const vendor of fs.readdirSync(vendorRoot)) {
      const candidate = path.join(vendorRoot, vendor, 'bin', 'codex.exe');
      if (fs.existsSync(candidate)) { return candidate; }
    }
  }
  throw new Error('The native Codex executable is not installed.');
}

function waitFor(predicate, timeoutMs, description, getOutput) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      }
      else if (Date.now() > deadline) {
        clearInterval(timer);
        const tail = getOutput().slice(-4_000);
        reject(new Error(`Timed out waiting for ${description}. Terminal tail:\n${tail}`));
      }
    }, 50);
  });
}

function terminalScreenText(terminal) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (line) { lines.push(line.translateToString(true)); }
  }
  return lines.join('\n');
}

function isDirectoryTrustPrompt(terminal) {
  const screen = terminalScreenText(terminal);
  return screen.includes('Do you trust the contents of this directory?') && screen.includes('Press enter to continue');
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-live-codex-probe-'));
  const stateRoot = path.join(workspace, 'managed-state');
  const challenge = `XCODE_CHALLENGE_${Date.now().toString(36).toUpperCase()}`;
  const acknowledgement = challenge.replace('CHALLENGE', 'ACK');
  const message = `Reply with exactly the token formed by replacing CHALLENGE with ACK in: ${challenge}. Do not use tools and do not modify files.`;
  let output = '';
  let terminalWrites = 0;
  let primaryError = null;
  const terminal = new Terminal({ cols: 120, rows: 36, scrollback: 2_000, allowProposedApi: true, convertEol: false });
  const session = startManagedSession({
    file: findNativeCodex(),
    args: ['--sandbox', 'read-only', '--ask-for-approval', 'never', '--cd', workspace],
    cwd: workspace,
    stateRoot,
  });
  stopActiveSession = () => session.stop();

  try {
    session.onOutput((data) => {
      output = (output + data).slice(-MAX_OUTPUT_CHARS);
      terminalWrites += 1;
      terminal.write(data, () => { terminalWrites -= 1; });
    });
    await waitFor(() => output.length > 0, 15_000, 'the real Codex TUI to initialize', () => output);
    await waitFor(
      () => terminalWrites === 0 && isDirectoryTrustPrompt(terminal),
      20_000,
      'Codex to show its directory-trust prompt',
      () => output,
    );
    // The production runner uses the same screen-state condition to hold an
    // office message. Accept the prompt locally only after it is actually
    // visible, rather than racing a blind delayed Enter against startup.
    session.submitLocal('\r');
    await waitFor(
      () => terminalWrites === 0 && !isDirectoryTrustPrompt(terminal),
      10_000,
      'the main PC local action to clear the directory-trust prompt',
      () => output,
    );
    await session.submitRemoteMessage(message);
    await waitFor(() => output.includes(acknowledgement), 70_000, 'the real Codex TUI to answer the remote challenge', () => output);
    assert.match(output, new RegExp(acknowledgement), 'The real Codex TUI did not generate the remote challenge acknowledgement.');
    console.log(`LIVE_CODEX_REMOTE_INPUT=PASS package=${packageRoot}`);
  }
  catch (error) {
    primaryError = error;
    throw error;
  }
  finally {
    session.stop();
    stopActiveSession = null;
    await Promise.race([
      session.completed,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    try {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    catch (cleanupError) {
      if (!primaryError) { throw cleanupError; }
      process.stderr.write(`xcode probe cleanup: ${cleanupError.message}\n`);
    }
    terminal.dispose();
  }
}

main().then(
  () => {
    clearTimeout(hardStop);
    process.exit(0);
  },
  (error) => {
    clearTimeout(hardStop);
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
