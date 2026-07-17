#!/usr/bin/env node
'use strict';

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
  const sshArgsLog = path.join(fixtureRoot, 'ssh-args.log');
  const frameLog = path.join(fixtureRoot, 'office-frames.log');
  fs.writeFileSync(fakeSsh, [
    '@echo off',
    'setlocal EnableDelayedExpansion',
    'if not "%XCODE_SSH_ARGS_LOG%"=="" echo %*>>"%XCODE_SSH_ARGS_LOG%"',
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
    '  echo {"sessions":[{"sessionId":"11111111-1111-4111-8111-111111111111","cwd":"C:/main","createdAt":"2026-07-16T00:00:00.000Z"}]}',
    '  exit /b 0',
    ')',
    'if "!previous2!"=="xcode-gateway" if "!previous1!"=="attach" (',
    `  echo {"type":"snapshot","data":"${encodedRemote}"}`,
    '  echo {"type":"attached","sessionId":"11111111-1111-4111-8111-111111111111","cols":40,"rows":8}',
    '  set /p first_frame=',
    '  if not "%XCODE_FRAME_LOG%"=="" echo !first_frame!>>"%XCODE_FRAME_LOG%"',
    '  set /p second_frame=',
    '  if not "%XCODE_FRAME_LOG%"=="" echo !second_frame!>>"%XCODE_FRAME_LOG%"',
    '  set /p third_frame=',
    '  if not "%XCODE_FRAME_LOG%"=="" echo !third_frame!>>"%XCODE_FRAME_LOG%"',
    '  echo {"type":"queued","messageId":"test-message"}',
    '  echo {"type":"delivered","messageId":"test-message"}',
    '  exit /b 0',
    ')',
    'exit /b 9',
    '',
  ].join('\r\n'), 'utf8');

  const node = process.execPath;
  const client = pty.spawn(node, [path.join(packageRoot, 'bin', 'session-client.js'), '--ssh-config', path.join(fixtureRoot, 'config')], {
    name: 'xterm-256color',
    cols: 80,
    rows: 16,
    cwd: packageRoot,
    env: {
      ...process.env,
      XCODE_SSH_PATH: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      XCODE_SSH_WRAPPER: fakeSsh,
      XCODE_SSH_ARGS_LOG: sshArgsLog,
      XCODE_FRAME_LOG: frameLog,
    },
    useConptyDll: true,
  });
  const clientExit = new Promise((resolve) => client.onExit(resolve));
  let output = '';
  let sent = false;
  client.onData((data) => {
    output += data;
    if (!sent && output.includes('Ready — type below')) {
      sent = true;
      client.resize(160, 40);
      setTimeout(() => client.write('hello from office\r'), 100);
    }
  });

  try {
    try {
      await waitFor(() => output.includes('Ready — message is in the shared Codex conversation'), 5_000, 'the office client to settle after main-PC delivery');
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
    const sshArgs = fs.readFileSync(sshArgsLog, 'utf8');
    assert.match(sshArgs, /ServerAliveInterval=30/, 'The persistent office attachment has no SSH application keepalive interval.');
    assert.match(sshArgs, /ServerAliveCountMax=3/, 'The persistent office attachment has no bounded SSH keepalive retry count.');
    assert.match(sshArgs, /TCPKeepAlive=yes/, 'The persistent office attachment has no TCP keepalive enabled.');
    const submittedFrames = fs.readFileSync(frameLog, 'utf8');
    assert.match(submittedFrames, /"type":"resize","cols":80,"rows":13/, 'The office client did not synchronize its initial full terminal width to the main PTY.');
    assert.match(submittedFrames, /"type":"resize","cols":160,"rows":37/, 'The office client did not synchronize a full-screen/window resize to the main PTY.');
    console.log(`OFFICE_CLIENT_SINGLE_WINDOW=PASS package=${packageRoot}`);
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
