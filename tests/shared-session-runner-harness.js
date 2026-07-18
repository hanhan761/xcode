#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { AppServerClient, startSharedAppServerSession } = require(path.join(packageRoot, 'lib', 'app-server-session'));
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

async function typeLikeUser(session, text) {
  for (const character of text) {
    session.submitLocal(character);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  session.submitLocal('\r');
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
  const renamedTitle = `持久标题-${Date.now()}`;
  let session;
  let observer;
  let output = '';
  try {
    session = await startSharedAppServerSession({ file: codex, cwd: workspace, stateRoot });
    session.onOutput((data) => { output += data; });
    assert.equal(session.title, path.basename(workspace), 'A new conversation did not default to its workspace folder title.');
    const activeState = JSON.parse(fs.readFileSync(path.join(stateRoot, `${session.sessionId}.json`), 'utf8'));
    assert.equal(activeState.title, session.title, 'The active-session capability did not publish the main tab title.');
    assert.equal(activeState.model, session.model, 'The active-session capability did not publish the effective Codex model.');
    assert.equal(activeState.serviceTier, session.serviceTier, 'The active-session capability did not publish the effective Codex service tier.');
    const protocolEvents = [];
    observer = await new AppServerClient(activeState.appServerUrl, 'xcode-title-observer').connect();
    observer.onNotification((event) => protocolEvents.push(event));
    const observedTitles = [];
    session.onTitle((title) => observedTitles.push(title));
    await waitFor(() => output.includes('OpenAI Codex'), 30_000, 'the official Codex composer before rename');
    await typeLikeUser(session, `/rename ${renamedTitle}`);
    try {
      await waitFor(() => session.title === renamedTitle, 10_000, 'the official /rename title to reach the managed session');
    }
    catch (error) {
      error.message += `\nTUI tail: ${JSON.stringify(output.slice(-2_000))}\nName events: ${JSON.stringify(protocolEvents.filter((event) => event.method?.includes('name')))}`;
      throw error;
    }
    assert.ok(observedTitles.includes(renamedTitle), 'The main terminal did not receive the renamed tab title.');
    const renamedState = JSON.parse(fs.readFileSync(path.join(stateRoot, `${session.sessionId}.json`), 'utf8'));
    assert.equal(renamedState.title, renamedTitle, 'The active-session capability did not persist the renamed title.');
    await session.submitRemoteMessage(`Reply with exactly: ${marker}. Do not use tools.`);
    await waitFor(() => output.includes(marker), 90_000, 'the main Codex TUI to render the office-submitted turn');
    assert.match(output, new RegExp(marker));
    const renamedThreadId = session.threadId;
    observer.close();
    observer = null;
    session.stop();
    await Promise.race([session.completed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    session = await startSharedAppServerSession({
      file: codex,
      args: ['resume', renamedThreadId],
      cwd: workspace,
      stateRoot,
    });
    assert.equal(session.threadId, renamedThreadId, 'Resume opened a different Codex conversation.');
    assert.equal(session.title, renamedTitle, 'The official renamed title did not survive a full app-server restart and resume.');
    const resumedState = JSON.parse(fs.readFileSync(path.join(stateRoot, `${session.sessionId}.json`), 'utf8'));
    assert.equal(resumedState.title, renamedTitle, 'The resumed active-session capability did not republish the persisted title.');
    assert.equal(resumedState.model, session.model, 'The resumed session did not republish the effective Codex model.');
    assert.equal(resumedState.serviceTier, session.serviceTier, 'The resumed session did not republish the effective Codex service tier.');
    console.log('SHARED_SESSION_RUNNER=PASS');
  }
  finally {
    observer?.close();
    if (session) {
      session.stop();
      await Promise.race([session.completed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      // This is the dedicated ConPTY process started above.  The fallback only
      // handles a Windows terminal child that ignores a normal PTY close.
      spawnSync('taskkill.exe', ['/pid', String(session.processId), '/t', '/f'], { windowsHide: true });
      spawnSync(codex, ['delete', session.threadId], { cwd: workspace, stdio: 'ignore', windowsHide: true });
    }
    try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* A Windows ConPTY child can release its cwd slightly later. */ }
    try { fs.rmSync(stateRoot, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* The state pipe can close after the process exit notification. */ }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
