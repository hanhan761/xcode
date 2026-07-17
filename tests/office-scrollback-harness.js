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
  const transcript = Array.from(
    { length: 16 },
    (_, index) => `history-${String(index + 1).padStart(2, '0')}\r\n`,
  ).join('');
  const encodedTranscript = Buffer.from(transcript, 'utf8').toString('base64');
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
    '  timeout /t 5 /nobreak >nul',
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
  client.onData((data) => { output += data; });

  try {
    await waitFor(() => output.includes('history-16'), 5_000, 'the newest remote history to appear in the office viewport');
    client.write('\x1b[5~');
    await waitFor(() => output.includes('history-01'), 1_000, 'PageUp to reveal earlier shared conversation history');
    assert.doesNotMatch(output, /› \[5~/, 'PageUp was incorrectly inserted into the office message composer.');
    console.log(`OFFICE_SCROLLBACK=PASS package=${packageRoot}`);
  }
  finally {
    client.write('\u0003');
    client.kill();
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
