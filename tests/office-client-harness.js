#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');

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

async function main() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-office-client-'));
  const remoteBytes = '\x1b]2;REMOTE-LEAK\x07\x1b[2J\x1b[HMain Codex UI\x1b[2;1HLive output';
  const encodedRemote = Buffer.from(remoteBytes, 'utf8').toString('base64');
  const fakeSsh = path.join(fixtureRoot, 'ssh.cmd');
  fs.writeFileSync(fakeSsh, [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    'if "%8"=="list" (',
    '  echo {"sessions":[{"sessionId":"11111111-1111-4111-8111-111111111111","cwd":"C:/main","createdAt":"2026-07-16T00:00:00.000Z"}]}',
    '  exit /b 0',
    ')',
    'if "%8"=="attach" (',
    `  echo {"type":"snapshot","data":"${encodedRemote}"}`,
    '  echo {"type":"attached","sessionId":"11111111-1111-4111-8111-111111111111","cols":40,"rows":8}',
    '  set /p submitted=',
    '  echo {"type":"queued","messageId":"test-message"}',
    '  echo {"type":"delivered","messageId":"test-message"}',
    '  exit /b 0',
    ')',
    'exit /b 9',
    '',
  ].join('\r\n'), 'utf8');

  const node = process.execPath;
  const client = pty.spawn(node, ['bin/session-client.js', '--ssh-config', path.join(fixtureRoot, 'config')], {
    name: 'xterm-256color',
    cols: 80,
    rows: 16,
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      XCODE_SSH_PATH: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      XCODE_SSH_WRAPPER: fakeSsh,
    },
    useConptyDll: true,
  });
  const clientExit = new Promise((resolve) => client.onExit(resolve));
  let output = '';
  let sent = false;
  client.onData((data) => {
    output += data;
    if (!sent && output.includes('Connected')) {
      sent = true;
      client.write('hello from office\r');
    }
  });

  try {
    try {
      await waitFor(() => output.includes('Written to the main Codex terminal'), 5_000, 'the office client terminal-write acknowledgement');
    }
    catch (error) {
      error.message += ` Captured terminal: ${JSON.stringify(output)}`;
      throw error;
    }
    const exit = await Promise.race([
      clientExit,
      new Promise((_, reject) => setTimeout(() => reject(new Error('The office client did not exit after its gateway closed.')), 5_000)),
    ]);
    assert.equal(exit.exitCode, 0, output);
    assert.equal(sent, true, 'The office client did not accept a complete local message.');
    assert.match(output, /Main Codex UI/, 'The mirrored main session was not rendered.');
    assert.match(output, /Live output/, 'The mirrored main output was not rendered.');
    assert.match(output, /\x1b\[\?1049h/, 'The office UI did not remain in the current terminal window.');
    assert.match(output, /\x1b\[\?1049l/, 'The office UI did not restore the calling PowerShell window.');
    assert.equal(output.includes('REMOTE-LEAK'), false, 'A remote terminal control sequence leaked into the office UI.');
    console.log('OFFICE_CLIENT_SINGLE_WINDOW=PASS');
  }
  finally {
    client.kill();
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
