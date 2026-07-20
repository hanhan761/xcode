#!/usr/bin/env node
'use strict';

// Opt-in authenticated probe. It measures when a second app-server client can
// really resume a newly-created thread, rather than assuming that turn/start's
// initial response already made its rollout available to the native TUI.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { acquireSharedAppServer } = require(path.join(packageRoot, 'lib', 'app-server-host'));
const { AppServerClient } = require(path.join(packageRoot, 'lib', 'app-server-session'));
const { findNativeCodex } = require(path.join(packageRoot, 'lib', 'codex-executable'));

const RUN = process.env.XCODE_RUN_APP_SERVER_ROLLOUT_PROBE === '1';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopTui(tui) {
  if (!tui) { return; }
  const exited = new Promise((resolve) => tui.onExit(resolve));
  tui.kill();
  await Promise.race([exited, delay(3_000)]);
}

async function removeTemporaryDirectory(directory) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    }
    catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError;
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) { return value; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function main() {
  if (!RUN) {
    console.log('APP_SERVER_ROLLOUT_READINESS=SKIPPED (set XCODE_RUN_APP_SERVER_ROLLOUT_PROBE=1 to run the authenticated startup proof)');
    return;
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-rollout-readiness-'));
  const hostRoot = path.join(workspace, 'host');
  const codex = findNativeCodex({ packageRoot, preferGlobal: false });
  const authority = new AppServerClient('', 'xcode-rollout-readiness-authority');
  let host;
  let threadId;
  let tui;
  let terminal;
  try {
    host = await acquireSharedAppServer({ file: codex, cwd: workspace, hostRoot });
    authority.url = host.url;
    await authority.connect();
    console.log('APP_SERVER_ROLLOUT_READINESS=connected');
    const started = await authority.request('thread/start', {
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    threadId = started.thread?.id || started.threadId;
    assert.ok(threadId, 'thread/start did not return a thread id.');
    console.log('APP_SERVER_ROLLOUT_READINESS=thread-started');

    let completedAt = null;
    authority.onNotification((event) => {
      if (event.method === 'turn/completed' && event.params?.threadId === threadId) {
        completedAt = Date.now();
      }
    });
    const turnAcceptedAt = Date.now();
    await authority.request('turn/start', { threadId, input: [] });
    console.log('APP_SERVER_ROLLOUT_READINESS=turn-accepted');
    terminal = new Terminal({ cols: 104, rows: 32, scrollback: 2_000, allowProposedApi: true, convertEol: false, logLevel: 'off' });
    let raw = '';
    tui = pty.spawn(codex, ['resume', '--remote', host.url, '--no-alt-screen', threadId], {
      name: 'xterm-256color', cols: 104, rows: 32, cwd: workspace, env: process.env, useConptyDll: true,
    });
    tui.onData((data) => {
      raw += data;
      terminal.write(data);
    });
    await waitFor(() => {
      const buffer = terminal.buffer.active;
      const text = Array.from({ length: buffer.length }, (_, index) =>
        buffer.getLine(index)?.translateToString(true) || '').join('\n');
      return text.includes('OpenAI Codex');
    }, 45_000, `the native remote TUI to open (tail: ${JSON.stringify(raw.slice(-1_000))})`);

    const nativeTuiReadyAt = Date.now();
    const nativeTuiLatencyMs = nativeTuiReadyAt - turnAcceptedAt;
    assert.ok(nativeTuiLatencyMs >= 0, 'The native TUI timestamp predates turn/start acceptance.');
    const completedBeforeTui = completedAt !== null && completedAt <= nativeTuiReadyAt;
    assert.equal(completedBeforeTui, false, 'The native remote TUI was still gated on the bootstrap turn completion event.');
    console.log(`APP_SERVER_ROLLOUT_READINESS=PASS nativeTuiMs=${nativeTuiLatencyMs} completedBeforeTui=${completedBeforeTui}`);
  }
  finally {
    await stopTui(tui);
    terminal?.dispose();
    if (threadId && !authority.closed) {
      try { await authority.request('thread/delete', { threadId }); }
      catch { /* Test cleanup must not hide its timing result. */ }
    }
    authority.close();
    await host?.release();
    await removeTemporaryDirectory(workspace);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
