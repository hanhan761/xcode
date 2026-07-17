#!/usr/bin/env node
'use strict';

// Drives the real office terminal UI. A user must be able to inspect output
// above the current viewport with PageUp without turning that key sequence
// into composer text.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

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
    }, 20);
  });
}

async function main() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-office-scrollback-'));
  const fakeSsh = path.join(fixtureRoot, 'ssh.cmd');
  const liveOutputMarker = path.join(fixtureRoot, 'live-output-emitted.txt');
  const transcript = Array.from(
    { length: 16 },
    (_, index) => `history-${String(index + 1).padStart(2, '0')}\r\n`,
  ).join('');
  const encodedTranscript = Buffer.from(transcript, 'utf8').toString('base64');
  const encodedLiveOutput = Buffer.from('live-17\r\n主力机继续输出\r\n', 'utf8').toString('base64');
  fs.writeFileSync(fakeSsh, [
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
    '  echo {"sessions":[{"sessionId":"22222222-2222-4222-8222-222222222222","cwd":"C:\\fixture"}]}',
    '  exit /b 0',
    ')',
    'if "!previous2!"=="xcode-gateway" if "!previous1!"=="attach" (',
    `  echo {"type":"snapshot","data":"${encodedTranscript}"}`,
    '  echo {"type":"attached","sessionId":"22222222-2222-4222-8222-222222222222","cols":60,"rows":8}',
    '  set /p resize_frame=',
    '  ping.exe -n 3 127.0.0.1 >nul',
    `  echo emitted>"${liveOutputMarker}"`,
    `  echo {"type":"output","data":"${encodedLiveOutput}"}`,
    '  echo {"type":"delivered","messageId":"history-delivery"}',
    '  ping.exe -n 5 127.0.0.1 >nul',
    '  exit /b 0',
    ')',
    'exit /b 9',
    '',
  ].join('\r\n'), 'utf8');

  const client = pty.spawn(process.execPath, ['bin/session-client.js', '--ssh-config', path.join(fixtureRoot, 'ssh-config')], {
    name: 'xterm-256color',
    cols: 80,
    rows: 16,
    cwd: packageRoot,
    env: {
      ...process.env,
      XCODE_SSH_PATH: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      XCODE_SSH_WRAPPER: fakeSsh,
    },
    useConptyDll: true,
  });
  let output = '';
  let renderedScreen = '';
  const renderedTerminal = new Terminal({
    cols: 80,
    rows: 16,
    scrollback: 100,
    allowProposedApi: true,
    convertEol: false,
  });
  function updateRenderedScreen() {
    const buffer = renderedTerminal.buffer.active;
    renderedScreen = Array.from({ length: 16 }, (_, index) =>
      buffer.getLine(buffer.viewportY + index)?.translateToString(true) || '').join('\n');
  }
  client.onData((data) => {
    output += data;
    renderedTerminal.write(data, updateRenderedScreen);
  });

  try {
    await waitFor(() => renderedScreen.includes('history-16'), 5_000, 'the newest remote history to appear in the office viewport');
    client.write('\x1b[5~');
    await waitFor(() => renderedScreen.includes('history-01'), 1_000, 'PageUp to reveal earlier shared conversation history');
    await waitFor(() => fs.existsSync(liveOutputMarker), 5_000, 'new main-PC output while reviewing history');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.match(renderedScreen, /history-01/,
      `New output pulled the office viewport away from the reviewed history: ${JSON.stringify(renderedScreen)}`);
    assert.match(renderedScreen, /Reviewing earlier terminal output/,
      'A delivery acknowledgement falsely marked a historical viewport as live.');
    assert.doesNotMatch(renderedScreen, /live-17/,
      'New live output replaced the historical viewport before the user returned to the bottom.');
    client.write('\x1b[F');
    await waitFor(() => renderedScreen.includes('live-17'), 1_000, 'End to return to the newest main-PC output');
    assert.match(renderedScreen, /Ready/, 'End did not restore live-follow status.');
    assert.match(renderedScreen, /主力机继续输出/, 'UTF-8 main-PC output was corrupted in the office terminal.');
    assert.doesNotMatch(output, /› \[5~/, 'PageUp was incorrectly inserted into the office message composer.');
    console.log(`OFFICE_SCROLLBACK=PASS package=${packageRoot}`);
  }
  finally {
    client.write('\u0003');
    client.kill();
    renderedTerminal.dispose();
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* ConPTY can keep the short-lived fixture handle briefly. */ }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
