#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { acquireSharedAppServer } = require('../lib/app-server-host');
const { AppServerClient } = require('../lib/app-server-session');

const RUN = process.env.XCODE_RUN_LIVE_WINDOW_PROOF === '1';

function findNativeCodex() {
  const npmRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  for (const packageName of fs.readdirSync(npmRoot)) {
    if (!/^codex-win32-/i.test(packageName)) { continue; }
    const vendorRoot = path.join(npmRoot, packageName, 'vendor');
    for (const vendor of fs.readdirSync(vendorRoot)) {
      const candidate = path.join(vendorRoot, vendor, 'bin', 'codex.exe');
      if (fs.existsSync(candidate)) { return candidate; }
    }
  }
  throw new Error('The native Codex executable was not found.');
}

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

function descendantProcessIds(rootProcessId, processes) {
  const descendants = new Set([rootProcessId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes) {
      if (!descendants.has(processInfo.processId) && descendants.has(processInfo.parentProcessId)) {
        descendants.add(processInfo.processId);
        changed = true;
      }
    }
  }
  return descendants;
}

function consoleProcess(processInfo) {
  return /^(pwsh|powershell|cmd|conhost|openconsole|codex-code-mode-host|codex-computer-use)\.exe$/i
    .test(processInfo.processName || '');
}

function associatedConsoleProcess(windowInfo, processes) {
  const observations = windowInfo.titleHistory?.length
    ? windowInfo.titleHistory
    : [{ title: windowInfo.title, observedAt: windowInfo.observedAt }];
  let best;
  for (const observation of observations) {
    const observedAt = Date.parse(observation.observedAt);
    const title = String(observation.title || '').toLowerCase();
    for (const processInfo of processes) {
      if (!consoleProcess(processInfo)) { continue; }
      const startedAt = Date.parse(processInfo.observedAt);
      const lag = observedAt - startedAt;
      if (lag < -500 || lag > 2_000) { continue; }
      const processName = String(processInfo.processName || '').toLowerCase();
      const titleNamesProcess = title && title.includes(processName);
      if (title.includes('.exe') && !titleNamesProcess) { continue; }
      const score = (titleNamesProcess ? 0 : 10_000) + Math.abs(lag);
      if (!best || score < best.score) { best = { processInfo, score }; }
    }
  }
  return best?.processInfo;
}

function visibleWindowsOwnedBy(rootProcessId, result) {
  const processes = result.startedProcesses || [];
  const descendants = descendantProcessIds(rootProcessId, processes);
  return (result.visibleChildWindows || []).filter((windowInfo) => {
    if (descendants.has(windowInfo.processId)) { return true; }
    if (!/^WindowsTerminal$/i.test(windowInfo.processName || '')) { return false; }
    const associated = associatedConsoleProcess(windowInfo, processes);
    return associated ? descendants.has(associated.processId) : false;
  });
}

function visibleShowEventsOwnedBy(rootProcessId, result) {
  const processes = result.startedProcesses || [];
  const descendants = descendantProcessIds(rootProcessId, processes);
  return (result.windowEvents || []).filter((event) => {
    if (event.eventName !== 'show' || event.visible !== true) { return false; }
    if (descendants.has(event.processId)) { return true; }
    if (!/^WindowsTerminal$/i.test(event.processName || '')) { return false; }
    const associated = associatedConsoleProcess({
      title: event.title,
      observedAt: event.observedAt,
    }, processes);
    return associated ? descendants.has(associated.processId) : false;
  });
}

async function main() {
  if (!RUN) {
    console.log('LIVE_HIDDEN_APP_SERVER_WINDOW=SKIPPED (set XCODE_RUN_LIVE_WINDOW_PROOF=1)');
    return;
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-live-codex-probe-'));
  const hostRoot = path.join(workspace, 'app-server-host');
  const probeResult = path.join(workspace, 'visible-windows.json');
  let host;
  let client;
  let threadId;
  let probe;
  try {
    host = await acquireSharedAppServer({ file: findNativeCodex(), cwd: workspace, hostRoot });
    client = await new AppServerClient(host.url, 'xcode-live-window-proof').connect();
    const notifications = [];
    client.onNotification((event) => notifications.push(event));
    const started = await client.request('thread/start', {
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    threadId = started.thread?.id || started.threadId;
    assert.ok(threadId, 'The live window proof did not receive a thread id.');

    // The command that launches this proof may itself be running inside Codex. Let that
    // outer tool's delegated console settle before taking the window baseline, otherwise
    // the proof can attribute its caller's already-starting window to the isolated host.
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    probe = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'visible-child-window-probe.ps1'),
      '-OutputPath', probeResult, '-DurationSeconds', '15',
    ], { cwd: workspace, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let probeError = '';
    probe.stderr.setEncoding('utf8');
    probe.stderr.on('data', (data) => { probeError += data; });
    const probeCompleted = new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.once('exit', (code) => code === 0
        ? resolve()
        : reject(new Error(`The visible-window probe exited ${code}: ${probeError.trim()}`)));
    });

    await client.request('turn/start', {
      threadId,
      input: [{
        type: 'text',
        text: 'Use the shell tool exactly once to run: Start-Sleep -Milliseconds 1200. Then reply with exactly xcode-hidden-shell-ok.',
      }],
    });
    await waitFor(
      () => notifications.some((event) => event.method === 'turn/completed' && event.params?.threadId === threadId),
      90_000,
      'the live Codex PowerShell turn to complete',
    );
    await probeCompleted;
    const result = JSON.parse(fs.readFileSync(probeResult, 'utf8'));
    const scopedVisibleWindows = visibleWindowsOwnedBy(host.processId, result);
    const scopedVisibleShowEvents = visibleShowEventsOwnedBy(host.processId, result);
    assert.deepEqual(scopedVisibleWindows, [],
      `The real Codex app-server created visible tool windows: ${JSON.stringify(scopedVisibleWindows)}\n` +
      `All unrelated visible windows: ${JSON.stringify(result.visibleChildWindows)}\n` +
      `Processes started during the turn: ${JSON.stringify(result.startedProcesses)}`);
    assert.deepEqual(scopedVisibleShowEvents, [],
      `The real Codex app-server briefly showed a tool window: ${JSON.stringify(scopedVisibleShowEvents)}\n` +
      `All window lifecycle events: ${JSON.stringify(result.windowEvents)}\n` +
      `Processes started during the turn: ${JSON.stringify(result.startedProcesses)}`);
    console.log(
      `LIVE_HIDDEN_APP_SERVER_WINDOW=PASS unrelated_windows=${result.visibleChildWindows.length} ` +
      `unrelated_show_events=${(result.windowEvents || []).filter((event) => event.eventName === 'show').length}`,
    );
  }
  finally {
    if (threadId && client) {
      try { await client.request('thread/delete', { threadId }); }
      catch { /* Cleanup must not replace the proof result. */ }
    }
    client?.close();
    await host?.release();
    if (probe && probe.exitCode === null) { probe.kill(); }
    try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* Windows can release a stopped ConPTY shortly after exit. */ }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
