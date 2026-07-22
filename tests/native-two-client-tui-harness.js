#!/usr/bin/env node
'use strict';

// Opt-in authenticated proof: two independent official Codex TUIs resume the
// same app-server thread. Input is typed into the office TUI, then the distinct
// model response and running state must render in both terminal models.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { acquireSharedAppServer } = require(path.join(packageRoot, 'lib', 'app-server-host'));
const { AppServerClient, initializeNewThreadForRemoteTui } = require(path.join(packageRoot, 'lib', 'app-server-session'));
const { findNativeCodex } = require(path.join(packageRoot, 'lib', 'codex-executable'));

const RUN = process.env.XCODE_RUN_NATIVE_TWO_CLIENT_TUI === '1';

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      try {
        if (predicate()) {
          clearInterval(timer);
          resolve();
        }
        else if (Date.now() >= deadline) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for ${description}.`));
        }
      }
      catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, 25);
  });
}

function createTui(file, url, threadId, cwd, cols, rows) {
  const child = pty.spawn(file, ['resume', '--remote', url, '--no-alt-screen', threadId], {
    name: 'xterm-256color', cols, rows, cwd, env: process.env, useConptyDll: true,
  });
  const terminal = new Terminal({
    cols, rows, scrollback: 2_000, allowProposedApi: true, convertEol: false, logLevel: 'off',
  });
  let raw = '';
  let workingObserved = false;
  child.onData((data) => {
    raw += data;
    terminal.write(data, () => {
      if (text().includes('Working')) { workingObserved = true; }
    });
  });
  function text() {
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) =>
      buffer.getLine(index)?.translateToString(true) || '').join('\n');
  }
  return { child, terminal, text, raw: () => raw, workingObserved: () => workingObserved };
}

async function typeLikeUser(child, text) {
  for (const character of text) {
    child.write(character);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  child.write('\r');
}

async function stopTui(tui) {
  if (!tui) { return; }
  const exited = new Promise((resolve) => tui.child.onExit(resolve));
  tui.child.kill();
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!stopped && Number.isInteger(tui.child.pid)) {
    spawnSync('taskkill.exe', ['/pid', String(tui.child.pid), '/t', '/f'], { windowsHide: true });
  }
  tui.terminal.dispose();
}

async function main() {
  if (!RUN) {
    console.log('NATIVE_TWO_CLIENT_TUI=SKIPPED (set XCODE_RUN_NATIVE_TWO_CLIENT_TUI=1)');
    return;
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-native-two-client-'));
  const hostRoot = path.join(workspace, 'host');
  const codex = findNativeCodex({ packageRoot, preferGlobal: false });
  const authority = new AppServerClient('', 'xcode-native-two-client-authority');
  let host;
  let mainTui;
  let officeTui;
  let threadId;
  try {
    host = await acquireSharedAppServer({ file: codex, cwd: workspace, hostRoot });
    authority.url = host.url;
    await authority.connect();
    const started = await authority.request('thread/start', {
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    threadId = started.thread?.id || started.threadId;
    assert.ok(threadId, 'thread/start did not return a thread id.');
    await initializeNewThreadForRemoteTui(authority, threadId);

    mainTui = createTui(codex, host.url, threadId, workspace, 104, 32);
    officeTui = createTui(codex, host.url, threadId, workspace, 72, 24);
    await waitFor(
      () => [mainTui, officeTui].every((tui) => tui.text().includes('OpenAI Codex') && tui.text().includes('›')),
      30_000,
      'both official Codex composers',
    );
    assert.equal(mainTui.workingObserved(), false,
      'The main official TUI rendered Working before any user or Office turn.');
    assert.equal(officeTui.workingObserved(), false,
      'The office official TUI rendered Working before any user or Office turn.');

    const challenge = `NATIVE_TWO_CLIENT_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const acknowledgement = `ACK_${challenge}`;
    await typeLikeUser(
      officeTui.child,
      `Take the token ${challenge}, prepend ACK_ to it, and reply with only the result. Do not use tools.`,
    );

    await waitFor(
      () => mainTui.text().includes(acknowledgement) && officeTui.text().includes(acknowledgement),
      120_000,
      'the same model response in both official Codex TUIs',
    );
    assert.equal(mainTui.workingObserved(), true, 'The main official TUI never rendered its working state.');
    assert.equal(officeTui.workingObserved(), true, 'The office official TUI never rendered its working state.');
    console.log(`NATIVE_TWO_CLIENT_TUI=PASS threadId=${threadId}`);
  }
  catch (error) {
    error.message += `\nmain TUI tail:\n${mainTui?.text().slice(-4_000) || mainTui?.raw().slice(-4_000) || '<not started>'}`;
    error.message += `\noffice TUI tail:\n${officeTui?.text().slice(-4_000) || officeTui?.raw().slice(-4_000) || '<not started>'}`;
    throw error;
  }
  finally {
    await stopTui(officeTui);
    await stopTui(mainTui);
    if (threadId && !authority.closed) {
      try { await authority.request('thread/delete', { threadId }); }
      catch { /* Test cleanup must not mask the collaboration result. */ }
    }
    authority.close();
    await host?.release();
    try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* A Windows TUI can release its temporary cwd slightly later. */ }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
