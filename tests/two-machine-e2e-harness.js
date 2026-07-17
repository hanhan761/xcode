#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { startManagedSession } = require(path.join(packageRoot, 'lib', 'session-runner'));

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      }
      else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${description}.`));
      }
    }, 20);
  });
}

function isSessionReady(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')).ready === true;
  }
  catch { return false; }
}

async function main() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-two-machine-'));
  const mainLocalAppData = path.join(fixtureRoot, 'main-localappdata');
  const stateRoot = path.join(mainLocalAppData, 'XcodeRemote', 'managed-sessions');
  const gateway = path.join(packageRoot, 'bin', 'session-gateway.js');
  const officeSshWrapper = path.join(fixtureRoot, 'office-ssh.cmd');
  const command = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  const node = process.execPath;
  const codexLikeTui = path.join(__dirname, 'fixtures', 'codex-like-tui.js');
  const mainOutput = [];
  let office;
  let officeOutput = '';
  let sentOfficeMessage = false;
  const session = startManagedSession({
    file: node,
    args: [codexLikeTui],
    cwd: process.cwd(),
    localIdleMs: 20,
    stateRoot,
    env: { ...process.env, LOCALAPPDATA: mainLocalAppData },
  });

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
    'if "!previous2!"=="xcode-gateway" if "!previous1!"=="attach" (',
    `  set "LOCALAPPDATA=${mainLocalAppData}"`,
    '  set "SSH_ORIGINAL_COMMAND=xcode-gateway attach !last!"',
    `  "${node}" "${gateway}"`,
    '  exit /b %ERRORLEVEL%',
    ')',
    'exit /b 9',
    '',
  ].join('\r\n'), 'utf8');

  try {
    session.onOutput((data) => mainOutput.push(data));
    await waitFor(() => mainOutput.join('').includes('TUI_READY'), 5_000, 'the isolated main Codex-like session to start');
    await waitFor(() => isSessionReady(path.join(stateRoot, `${session.sessionId}.json`)), 5_000, 'the isolated main session gateway to become ready');
    session.submitLocal('main-before-office\r');
    await waitFor(() => mainOutput.join('').includes('TUI_RECEIVED:main-before-office'), 5_000, 'the main PC local input to reach its own conversation');

    office = pty.spawn(node, ['bin/session-client.js', '--ssh-config', path.join(fixtureRoot, 'office-ssh-config')], {
      name: 'xterm-256color',
      cols: 100,
      rows: 24,
      cwd: packageRoot,
      env: {
        ...process.env,
        XCODE_SSH_PATH: command,
        XCODE_SSH_WRAPPER: officeSshWrapper,
      },
      useConptyDll: true,
    });
    office.onData((data) => {
      officeOutput += data;
      if (!sentOfficeMessage && officeOutput.includes('Connected')) {
        sentOfficeMessage = true;
        office.write('office-through-real-gateway\r');
      }
    });

    await waitFor(() => officeOutput.includes('Written to the main Codex terminal'), 8_000, 'the office terminal-write acknowledgement through the real gateway');
    await waitFor(() => mainOutput.join('').includes('TUI_RECEIVED:office-through-real-gateway'), 8_000, 'the office message to reach the same main-PC conversation');
    assert.equal(sentOfficeMessage, true, 'The office terminal never accepted its local message.');
    assert.match(officeOutput, /Codex-like full-screen conversation/, 'The office did not render the main full-screen terminal.');
    assert.match(officeOutput, /TUI_RECEIVED:main-before-office/, 'The office did not mirror the live main-PC conversation.');
    assert.match(officeOutput, /\x1b\[\?1049h/, 'The office client did not use a single current-window terminal UI.');

    office.write('\u0003');
    console.log(`TWO_MACHINE_COLLABORATION_E2E=PASS package=${packageRoot}`);
  }
  finally {
    if (office) { office.kill(); }
    session.stop();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
