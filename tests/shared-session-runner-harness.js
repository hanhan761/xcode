#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { startSharedAppServerSession } = require(path.join(packageRoot, 'lib', 'app-server-session'));
const { findNativeCodex } = require(path.join(packageRoot, 'lib', 'codex-executable'));

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      }
      else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${description}.`));
      }
    }, 25);
  });
}

async function main() {
  if (process.env.XCODE_RUN_SHARED_SESSION !== '1') {
    console.log('SHARED_SESSION_RUNNER=SKIPPED (set XCODE_RUN_SHARED_SESSION=1 to run the authenticated live proof)');
    return;
  }

  const codex = findNativeCodex({ packageRoot, preferGlobal: false });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-shared-session-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-shared-session-state-'));
  const marker = `xcode-main-and-office-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let session;
  let output = '';
  try {
    session = await startSharedAppServerSession({ file: codex, cwd: workspace, stateRoot });
    session.onOutput((data) => { output += data; });
    await session.submitRemoteMessage(`Reply with exactly: ${marker}. Do not use tools.`);
    await waitFor(() => output.includes(marker), 90_000, 'the main Codex TUI to render the office-submitted turn');
    assert.match(output, new RegExp(marker));
    console.log('SHARED_SESSION_RUNNER=PASS');
  }
  finally {
    if (session) {
      session.stop();
      await Promise.race([session.completed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      // This is the dedicated ConPTY process started above.  The fallback only
      // handles a Windows terminal child that ignores a normal PTY close.
      spawnSync('taskkill.exe', ['/pid', String(session.processId), '/t', '/f'], { windowsHide: true });
      spawnSync(codex, ['delete', session.threadId], { cwd: workspace, stdio: 'ignore', windowsHide: true });
    }
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(stateRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
