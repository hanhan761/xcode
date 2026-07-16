#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

function fail(message) {
  process.stderr.write(`xcode: ${message}\n`);
  process.exit(1);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function findSsh() {
  return path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
}

function encodedPowerShell(command) {
  return Buffer.from(`$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Console]::OutputEncoding; ${command}`, 'utf16le').toString('base64');
}

function remoteState(ssh, configPath) {
  const command = "Get-Content -Raw -LiteralPath (Join-Path $env:LOCALAPPDATA 'XcodeRemote\\console-share.json')";
  const result = spawnSync(ssh, ['-F', configPath, '-o', 'BatchMode=yes', 'xcode-main', 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(command)], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('No active shared terminal is reachable on the main PC. Run xcode share there first.');
  }
  try {
    const state = JSON.parse(result.stdout);
    if (state.schemaVersion !== 1 || !Number.isInteger(state.port) || typeof state.token !== 'string') {
      throw new Error('invalid state');
    }
    return state;
  } catch {
    throw new Error('The main PC returned an invalid shared-terminal state. Run xcode share again.');
  }
}

function remoteBridgeCommand(port) {
  return [
    `$relay = [Net.Sockets.TcpClient]::new('127.0.0.1', ${port})`,
    '$stream = $relay.GetStream()',
    '$fromOffice = [Console]::OpenStandardInput().CopyToAsync($stream)',
    '$toOffice = $stream.CopyToAsync([Console]::OpenStandardOutput())',
    '[Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($fromOffice, $toOffice)) | Out-Null',
    '$relay.Dispose()',
  ].join('; ');
}

function render(snapshot) {
  const row = Math.max(1, Number(snapshot.cursorY) + 1);
  const column = Math.max(1, Number(snapshot.cursorX) + 1);
  process.stdout.write(`\x1b[?25l\x1b[2J\x1b[H${snapshot.rows}\x1b[${row};${column}H\x1b[?25h`);
}

const ANSI_KEYS = new Map([
  ['\x1b[A', 0x26], ['\x1b[B', 0x28], ['\x1b[C', 0x27], ['\x1b[D', 0x25],
  ['\x1b[H', 0x24], ['\x1bOH', 0x24], ['\x1b[F', 0x23], ['\x1bOF', 0x23],
  ['\x1b[1~', 0x24], ['\x1b[2~', 0x2d], ['\x1b[3~', 0x2e], ['\x1b[4~', 0x23],
  ['\x1b[5~', 0x21], ['\x1b[6~', 0x22],
]);

function sendKey(stream, virtualKeyCode, unicodeCharacter = 0, controlKeyState = 0) {
  stream.write(`${JSON.stringify({ type: 'key', virtualKeyCode, unicodeCharacter, controlKeyState })}\n`);
}

function sendText(stream, text) {
  if (text) stream.write(`${JSON.stringify({ type: 'input', data: Buffer.from(text, 'utf8').toString('base64') })}\n`);
}

function forwardInput(stream, state, input) {
  state.pending += state.decoder.write(input);
  let text = '';
  const flushText = () => {
    sendText(stream, text);
    text = '';
  };
  while (state.pending) {
    if (state.pending.startsWith('\x1b')) {
      const match = [...ANSI_KEYS.keys()].sort((left, right) => right.length - left.length).find((sequence) => state.pending.startsWith(sequence));
      if (match) {
        flushText();
        sendKey(stream, ANSI_KEYS.get(match));
        state.pending = state.pending.slice(match.length);
        continue;
      }
      if ([...ANSI_KEYS.keys()].some((sequence) => sequence.startsWith(state.pending))) return;
      flushText();
      sendKey(stream, 0x1b);
      state.pending = state.pending.slice(1);
      continue;
    }
    const character = state.pending[0];
    if (character === '\r' || character === '\n') {
      flushText();
      sendKey(stream, 0x0d, 0x0d);
    } else if (character === '\b' || character === '\x7f') {
      flushText();
      sendKey(stream, 0x08, 0x08);
    } else if (character === '\t') {
      flushText();
      sendKey(stream, 0x09, 0x09);
    } else {
      text += character;
    }
    state.pending = state.pending.slice(1);
  }
  flushText();
}

async function main() {
  const configPath = option('--ssh-config');
  if (!configPath) fail('Office SSH configuration was not supplied. Run xcode pair again.');
  const ssh = findSsh();
  const state = remoteState(ssh, configPath);
  const bridge = spawn(ssh, [
    '-F', configPath,
    '-o', 'BatchMode=yes',
    'xcode-main',
    'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(remoteBridgeCommand(state.port)),
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let rawMode = false;
  let alternateScreen = false;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (rawMode && process.stdin.isTTY) process.stdin.setRawMode(false);
    if (alternateScreen) process.stdout.write('\x1b[?25h\x1b[?1049l');
    if (!bridge.killed) bridge.kill();
  };
  process.once('exit', cleanup);
  process.once('SIGINT', () => process.exit(0));

  try {
    let pending = '';
    let ready = false;
    const readyTimeout = setTimeout(() => fail('The SSH bridge did not reach the shared terminal.'), 5000);
    bridge.stdout.setEncoding('utf8');
    bridge.stdout.on('data', (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.type === 'ready') {
          ready = true;
          clearTimeout(readyTimeout);
          return;
        }
        if (message.type === 'snapshot') render(message);
      }
    });
    bridge.stderr.setEncoding('utf8');
    let bridgeError = '';
    bridge.stderr.on('data', (chunk) => { bridgeError += chunk; });
    bridge.once('close', () => {
      if (!closed) fail(ready ? 'The shared terminal disconnected.' : `The SSH bridge could not start. ${bridgeError.trim()}`.trim());
    });
    bridge.once('error', (error) => fail(error.message));
    if (!process.stdin.isTTY) fail('xcode must be run from an interactive office-laptop terminal.');
    process.stdout.write('\x1b[?1049h');
    alternateScreen = true;
    bridge.stdin.write(`${JSON.stringify({ token: state.token })}\n`);
    process.stdin.setRawMode(true);
    rawMode = true;
    process.stdin.resume();
    const inputState = { decoder: new StringDecoder('utf8'), pending: '' };
    process.stdin.on('data', (input) => {
      if (input.length === 1 && input[0] === 3) process.exit(0);
      forwardInput(bridge.stdin, inputState, input);
    });
  } catch (error) {
    cleanup();
    fail(error.message);
  }
}

main().catch((error) => fail(error.message));
