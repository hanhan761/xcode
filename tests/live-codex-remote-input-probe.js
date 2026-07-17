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

const packageRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'xcode-remote');
const { startManagedSession } = require(path.join(packageRoot, 'lib', 'session-runner'));

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

function waitFor(predicate, timeoutMs, description, output) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      }
      else if (Date.now() > deadline) {
        clearInterval(timer);
        const tail = output.join('').slice(-4_000);
        reject(new Error(`Timed out waiting for ${description}. Terminal tail:\n${tail}`));
      }
    }, 50);
  });
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-live-codex-probe-'));
  const stateRoot = path.join(workspace, 'managed-state');
  const challenge = `XCODE_CHALLENGE_${Date.now().toString(36).toUpperCase()}`;
  const acknowledgement = challenge.replace('CHALLENGE', 'ACK');
  const message = `Reply with exactly the token formed by replacing CHALLENGE with ACK in: ${challenge}. Do not use tools and do not modify files.`;
  const output = [];
  let primaryError = null;
  const session = startManagedSession({
    file: findNativeCodex(),
    args: ['--sandbox', 'read-only', '--ask-for-approval', 'never', '--cd', workspace],
    cwd: workspace,
    stateRoot,
  });

  try {
    session.onOutput((data) => output.push(data));
    await waitFor(() => output.join('').length > 0, 15_000, 'the real Codex TUI to initialize', output);
    // Codex's full-screen renderer places cursor controls between visual words,
    // so raw-byte text matching cannot safely identify the trust prompt. A
    // blank Enter accepts its selected default here; it is a no-op once Codex
    // has already reached an empty conversation composer.
    await wait(3_000);
    session.submitLocal('\r');
    await wait(1_000);
    await session.submitRemoteMessage(message);
    await waitFor(() => output.join('').includes(acknowledgement), 90_000, 'the real Codex TUI to answer the remote challenge', output);
    assert.match(output.join(''), new RegExp(acknowledgement), 'The real Codex TUI did not generate the remote challenge acknowledgement.');
    console.log('LIVE_CODEX_REMOTE_INPUT=PASS');
  }
  catch (error) {
    primaryError = error;
    throw error;
  }
  finally {
    session.stop();
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
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
