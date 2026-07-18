#!/usr/bin/env node
'use strict';

// Real production path, with only SSH itself replaced by a local command
// wrapper: office official Codex TUI -> forced selected-thread gateway ->
// main private app-server -> main official Codex TUI.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { AppServerClient, startSharedAppServerSession } = require(path.join(packageRoot, 'lib', 'app-server-session'));
const { findNativeCodex } = require(path.join(packageRoot, 'lib', 'codex-executable'));

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${description}.`));
      }
    }, 25);
  });
}

function isSessionReady(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')).ready === true; }
  catch { return false; }
}

async function typeLikeUser(terminal, text) {
  for (const character of text) {
    terminal.write(character);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  terminal.write('\r');
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function main() {
  if (process.env.XCODE_RUN_SEMANTIC_TWO_MACHINE !== '1') {
    console.log('SEMANTIC_TWO_MACHINE_E2E=SKIPPED (set XCODE_RUN_SEMANTIC_TWO_MACHINE=1 to run the authenticated live proof)');
    return;
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-semantic-two-machine-'));
  const mainLocalAppData = path.join(fixtureRoot, 'main-localappdata');
  const stateRoot = path.join(mainLocalAppData, 'XcodeRemote', 'managed-sessions');
  const gateway = path.join(packageRoot, 'bin', 'session-gateway.js');
  const officeSshWrapper = path.join(fixtureRoot, 'office-ssh.cmd');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-semantic-workspace-'));
  const codex = findNativeCodex({ packageRoot, preferGlobal: false });
  const node = process.execPath;
  const command = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  const marker = `NATIVE_RELAY_ACK_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let session;
  let office;
  let control;
  const controlEvents = [];
  let mainOutput = '';
  let officeOutput = '';
  let mainText = '';
  let officeText = '';
  let officeScreen = '';
  const mainTerminal = new Terminal({
    cols: 120,
    rows: 36,
    scrollback: 500,
    allowProposedApi: true,
    convertEol: false,
    logLevel: 'off',
  });
  function createOfficeTerminal() {
    return new Terminal({
      cols: 100,
      rows: 24,
      scrollback: 500,
      allowProposedApi: true,
      convertEol: false,
      logLevel: 'off',
    });
  }
  let officeTerminal = createOfficeTerminal();

  function terminalText(terminal) {
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) =>
      buffer.getLine(index)?.translateToString(true) || '').join('\n');
  }

  function visibleTerminalText(terminal) {
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, index) =>
      buffer.getLine(buffer.viewportY + index)?.translateToString(true) || '').join('\n');
  }

  function updateOfficeScreen() {
    const buffer = officeTerminal.buffer.active;
    officeScreen = Array.from({ length: officeTerminal.rows }, (_, index) =>
      buffer.getLine(buffer.viewportY + index)?.translateToString(true) || '').join('\n');
    officeText = terminalText(officeTerminal);
  }

  let sent = false;
  let officeGeneration = 0;
  function startOffice({ sendInitialMessage = false } = {}) {
    const child = pty.spawn(node, ['bin/session-client.js', '--ssh-config', path.join(fixtureRoot, 'office-ssh-config')], {
      name: 'xterm-256color', cols: 100, rows: 24, cwd: packageRoot,
      env: { ...process.env, XCODE_SSH_PATH: command, XCODE_SSH_WRAPPER: officeSshWrapper },
      useConptyDll: true,
    });
    const generation = ++officeGeneration;
    child.onData((data) => {
      if (generation !== officeGeneration) { return; }
      officeOutput += data;
      officeTerminal.write(data, updateOfficeScreen);
      if (sendInitialMessage && !sent && officeOutput.includes('OpenAI Codex') && officeOutput.includes('›')) {
        sent = true;
        officeTerminal.resize(148, 38);
        child.resize(148, 38);
        setTimeout(() => {
          typeLikeUser(child, `Reply with exactly ${marker} and nothing else. Do not use tools.`).catch(() => {});
        }, 500);
      }
    });
    return child;
  }

  fs.writeFileSync(officeSshWrapper, [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    'set "previous2="',
    'set "previous1="',
    'set "last="',
    ':next_arg',
    'if "%~1"=="" goto parsed_args',
    'set "previous2=!previous1!"',
    'set "previous1=!last!"',
    'set "last=%~1"',
    'shift',
    'goto next_arg',
    ':parsed_args',
    'if "!previous1!"=="xcode-gateway" if "!last!"=="list" (',
    `  set "LOCALAPPDATA=${mainLocalAppData}"`,
    '  set "SSH_ORIGINAL_COMMAND=xcode-gateway list"',
    `  "${node}" "${gateway}"`,
    '  exit /b %ERRORLEVEL%',
    ')',
    'if "!previous2!"=="xcode-gateway" if "!previous1!"=="native" (',
    `  set "LOCALAPPDATA=${mainLocalAppData}"`,
    '  set "SSH_ORIGINAL_COMMAND=xcode-gateway native !last!"',
    `  "${node}" "${gateway}"`,
    '  exit /b %ERRORLEVEL%',
    ')',
    'exit /b 9',
    '',
  ].join('\r\n'), 'utf8');

  try {
    session = await startSharedAppServerSession({ file: codex, cwd: workspace, stateRoot });
    session.onOutput((data) => {
      mainOutput += data;
      mainTerminal.write(data, () => { mainText = terminalText(mainTerminal); });
    });
    await waitFor(() => isSessionReady(path.join(stateRoot, `${session.sessionId}.json`)), 10_000, 'the semantic main-session gateway to become ready');
    const activeSession = JSON.parse(fs.readFileSync(path.join(stateRoot, `${session.sessionId}.json`), 'utf8'));
    control = await new AppServerClient(activeSession.appServerUrl, 'xcode-working-state-proof').connect();
    control.onNotification((event) => controlEvents.push(event));
    await control.request('thread/resume', { threadId: session.threadId });

    office = startOffice({ sendInitialMessage: true });

    await waitFor(() => mainText.includes('Working') && officeText.includes('Working'), 30_000, 'both official Codex clients to display the shared working turn');
    await waitFor(() => mainText.includes(marker), 120_000, 'the office-originated acknowledgement to render in the main official Codex TUI');
    await waitFor(() => officeText.includes(marker), 30_000, 'the same acknowledgement to render in the office official Codex TUI');
    await waitFor(
      () => !visibleTerminalText(mainTerminal).includes('Working') && !visibleTerminalText(officeTerminal).includes('Working'),
      30_000,
      'both official Codex TUIs to clear Working after the completed turn',
    );

    const interrupted = await control.request('turn/start', {
      threadId: session.threadId,
      input: [{ type: 'text', text: 'Use the shell tool to run Start-Sleep -Seconds 20. Do not respond before it finishes.' }],
    });
    const interruptedTurnId = interrupted.turn?.id || interrupted.turnId;
    assert.ok(interruptedTurnId, 'The interrupted turn did not return a turn id.');
    await waitFor(
      () => visibleTerminalText(mainTerminal).includes('Working') && visibleTerminalText(officeTerminal).includes('Working'),
      30_000,
      'both official Codex TUIs to display the interrupted working turn',
    );
    await control.request('turn/interrupt', { threadId: session.threadId, turnId: interruptedTurnId });
    await waitFor(
      () => controlEvents.some((event) => event.method === 'turn/completed' &&
        event.params?.threadId === session.threadId && event.params?.turn?.id === interruptedTurnId && event.params.turn.status === 'interrupted'),
      30_000,
      'the authoritative interrupted turn completion',
    );
    await waitFor(
      () => !visibleTerminalText(mainTerminal).includes('Working') && !visibleTerminalText(officeTerminal).includes('Working'),
      30_000,
      'both official Codex TUIs to clear Working after the interrupted turn',
    );

    const failed = await control.request('turn/start', {
      threadId: session.threadId,
      model: 'xcode-no-such-model',
      input: [{ type: 'text', text: 'Reply only with ok.' }],
    });
    const failedTurnId = failed.turn?.id || failed.turnId;
    assert.ok(failedTurnId, 'The failed turn did not return a turn id.');
    await waitFor(
      () => controlEvents.some((event) => event.method === 'turn/completed' &&
        event.params?.threadId === session.threadId && event.params?.turn?.id === failedTurnId && event.params.turn.status === 'failed'),
      30_000,
      'the authoritative failed turn completion',
    );
    await waitFor(
      () => !visibleTerminalText(mainTerminal).includes('Working') && !visibleTerminalText(officeTerminal).includes('Working'),
      30_000,
      'both official Codex TUIs to clear Working after the failed turn',
    );
    assert.equal(sent, true, 'The office official Codex client never accepted its local message.');
    assert.match(officeOutput, /OpenAI Codex/, 'The office side did not render the official Codex TUI.');
    assert.match(officeOutput, /›/, 'The official Codex composer was not visible on the office side.');
    assert.match(officeOutput, /\x1b\[\d+;38r/, 'The official office TUI did not receive the 148x38 ConPTY resize.');
    assert.match(officeScreen, /›/, 'The official composer was not redrawn after the office terminal resize.');
    assert.doesNotMatch(officeScreen, /xcode ·|Ready ·|message is in the shared/, 'Legacy xcode renderer chrome leaked into the official TUI.');
    assert.match(officeOutput, /\x1b\[\?1000l/, 'The office adapter did not release the host terminal mouse wheel.');
    assert.match(officeOutput, /\x1b\[\?1006l/, 'The office adapter left SGR mouse reporting enabled.');
    assert.doesNotMatch(officeOutput, /\x1b\[\?100[0236]h/, 'The office adapter captured the physical mouse wheel.');
    assert.equal(officeTerminal.buffer.active.type, 'normal', 'The official office TUI did not retain normal terminal scrollback.');

    const previousOffice = office;
    const previousOfficeExited = new Promise((resolve) => previousOffice.onExit(resolve));
    officeGeneration += 1;
    previousOffice.kill();
    await Promise.race([previousOfficeExited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    officeTerminal.dispose();
    officeTerminal = createOfficeTerminal();
    officeOutput = '';
    officeText = '';
    officeScreen = '';
    office = startOffice();
    await waitFor(() => officeText.includes('OpenAI Codex') && officeText.includes('›'), 30_000, 'the reconnected official office Codex TUI');
    await wait(1_000);
    assert.doesNotMatch(visibleTerminalText(mainTerminal), /Working/, 'A delayed main-PC terminal frame resurrected Working.');
    assert.doesNotMatch(visibleTerminalText(officeTerminal), /Working/, 'An old terminal frame resurrected Working after the office reconnect.');
    console.log(`SEMANTIC_TWO_MACHINE_E2E=PASS package=${packageRoot}`);
  }
  catch (error) {
    error.message += `\nmain TUI tail: ${JSON.stringify(mainOutput.slice(-4_000))}\noffice TUI tail: ${JSON.stringify(officeOutput.slice(-4_000))}`;
    throw error;
  }
  finally {
    mainTerminal.dispose();
    officeTerminal.dispose();
    control?.close();
    if (office) { office.kill(); }
    if (session) {
      session.stop();
      await Promise.race([session.completed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      spawnSync('taskkill.exe', ['/pid', String(session.processId), '/t', '/f'], { windowsHide: true });
      spawnSync(codex, ['delete', session.threadId], { cwd: workspace, stdio: 'ignore', windowsHide: true });
    }
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* Windows terminal handles can linger after the bounded proof. */ }
    try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* See above. */ }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
