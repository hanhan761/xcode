#!/usr/bin/env node
'use strict';

// Runs the same multi-thread resume shape as CodexSessionRecovery, but against
// an isolated xcode state root so it can assert the host-wide app-server count.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pty = require('node-pty');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));

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

function isAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  }
  catch { return false; }
}

function readySessionCount(stateRoot) {
  try {
    return fs.readdirSync(stateRoot)
      .filter((entry) => entry.endsWith('.json'))
      .filter((entry) => JSON.parse(fs.readFileSync(path.join(stateRoot, entry), 'utf8')).ready).length;
  }
  catch { return 0; }
}

function appendTail(current, data, limit = 4_000) {
  const combined = current + data;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

async function main() {
  const snapshotPath = process.env.XCODE_RECOVERY_SNAPSHOT;
  if (!snapshotPath) {
    console.log('RECOVERY_SHARED_HOST=SKIPPED (set XCODE_RECOVERY_SNAPSHOT to a saved Codex session snapshot)');
    return;
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const sessions = [...new Map((snapshot.sessions || [])
    .filter((session) => typeof session.sessionId === 'string' && session.sessionId)
    .filter((session) => !/[\\/]xcode-(?:semantic-workspace|recovery-shared-host|live-codex-probe|app-server-proof|semantic-two-machine)-/i.test(session.cwd || ''))
    .map((session) => [session.sessionId.toLowerCase(), session])).values()];
  assert.ok(sessions.length > 1, 'The recovery snapshot must contain at least two sessions.');

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-recovery-shared-host-'));
  const stateRoot = path.join(fixtureRoot, 'state', 'managed-sessions');
  const hostStatePath = path.join(path.dirname(stateRoot), 'app-server-host', 'host.json');
  const runners = [];
  const runnerDiagnostics = [];
  let hostProcessId = null;
  try {
    for (const session of sessions) {
      const cwd = typeof session.cwd === 'string' && fs.existsSync(session.cwd) ? session.cwd : packageRoot;
      const runner = pty.spawn(process.execPath, [path.join(packageRoot, 'bin', 'managed-codex.js'), 'resume', session.sessionId], {
        name: 'xterm-256color', cols: 120, rows: 36, cwd,
        env: { ...process.env, XCODE_STATE_ROOT: stateRoot },
        useConptyDll: true,
      });
      runners.push(runner);
      const diagnostic = { sessionId: session.sessionId, output: '', exit: null };
      runnerDiagnostics.push(diagnostic);
      runner.onData((data) => { diagnostic.output = appendTail(diagnostic.output, data); });
      runner.onExit((exit) => { diagnostic.exit = exit; });
    }
    try {
      await waitFor(() => readySessionCount(stateRoot) === sessions.length, 45_000, 'every recovered session gateway to become ready');
    }
    catch (error) {
      error.message += `\nready=${readySessionCount(stateRoot)}/${sessions.length}\nrunner diagnostics=${JSON.stringify(runnerDiagnostics)}`;
      throw error;
    }
    await waitFor(
      () => runnerDiagnostics.every((diagnostic) => diagnostic.output.includes('\x1b]0;')),
      5_000,
      'every recovered main PowerShell tab to receive a conversation title',
    );
    const activeStates = fs.readdirSync(stateRoot)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => JSON.parse(fs.readFileSync(path.join(stateRoot, entry), 'utf8')));
    assert.equal(activeStates.every((state) => typeof state.title === 'string' && state.title.length > 0), true, 'A recovered active session omitted its persistent title.');
    const host = JSON.parse(fs.readFileSync(hostStatePath, 'utf8'));
    hostProcessId = host.processId;
    assert.equal(isAlive(hostProcessId), true, 'The shared recovery app-server is not alive.');
    const duplicate = pty.spawn(process.execPath, [path.join(packageRoot, 'bin', 'managed-codex.js'), 'resume', sessions[0].sessionId], {
      name: 'xterm-256color', cols: 120, rows: 36, cwd: packageRoot,
      env: { ...process.env, XCODE_STATE_ROOT: stateRoot },
      useConptyDll: true,
    });
    let duplicateOutput = '';
    let duplicateExit = null;
    duplicate.onData((data) => { duplicateOutput = appendTail(duplicateOutput, data); });
    duplicate.onExit((exit) => { duplicateExit = exit; });
    try {
      await waitFor(() => duplicateExit !== null, 5_000, 'a duplicate recovery attempt to finish');
      assert.equal(duplicateExit.exitCode, 0, 'A duplicate recovery did not exit cleanly.');
      assert.match(duplicateOutput, /already active/i, 'A duplicate recovery was not identified before opening another Codex TUI.');
      assert.equal(readySessionCount(stateRoot), sessions.length, 'A duplicate recovery published another active office session.');
    }
    finally { duplicate.kill(); }
    console.log(`RECOVERY_SHARED_HOST=PASS sessions=${sessions.length} appServerPid=${hostProcessId}`);
  }
  finally {
    for (const runner of runners) { runner.kill(); }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    for (const runner of runners) {
      if (Number.isInteger(runner.pid) && isAlive(runner.pid)) {
        spawnSync('taskkill.exe', ['/pid', String(runner.pid), '/t', '/f'], { windowsHide: true });
      }
    }
    if (hostProcessId) {
      await waitFor(() => !isAlive(hostProcessId), 8_000, 'the shared app-server watchdog to clean a crashed recovery group');
    }
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* Windows can release a stopped ConPTY after the harness exits. */ }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
