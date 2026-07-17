#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { OfficeTerminalSurface } = require('../lib/office-terminal-surface');

function parseArgs(argv) {
  const index = argv.indexOf('--ssh-config');
  if (index < 0 || !argv[index + 1] || index + 2 !== argv.length) {
    throw new Error('Usage: session-client.js --ssh-config <path>');
  }
  return { sshConfig: argv[index + 1] };
}

function runGateway(sshConfig, args, options = {}) {
  const ssh = process.env.XCODE_SSH_PATH || (process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\OpenSSH\\ssh.exe` : 'ssh');
  const wrapper = process.env.XCODE_SSH_WRAPPER ? ['/d', '/c', process.env.XCODE_SSH_WRAPPER] : [];
  return spawn(ssh, [...wrapper, '-F', sshConfig, '-o', 'BatchMode=yes', 'xcode-main', 'xcode-gateway', ...args], options);
}

function collectOutput(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { errors += data; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) { reject(new Error(errors.trim() || `The xcode gateway exited ${code}.`)); }
      else { resolve(output); }
    });
  });
}

async function chooseSession(sshConfig) {
  const output = await collectOutput(runGateway(sshConfig, ['list'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  const response = JSON.parse(output);
  if (!Array.isArray(response.sessions) || response.sessions.length === 0) {
    throw new Error('The main PC has no active managed Codex session. Start or resume one there with codex. Saved history is not listed here.');
  }
  if (response.sessions.length === 1) { return response.sessions[0]; }
  if (!process.stdin.isTTY) { return response.sessions[0]; }
  process.stdout.write('Currently active managed Codex sessions on the main PC:\n');
  response.sessions.forEach((session, index) => process.stdout.write(`  [${index + 1}] ${session.cwd || 'unknown folder'}  ${session.createdAt || ''}\n`));
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question('Choose a session: ');
    const selected = Number.parseInt(answer, 10);
    if (!Number.isInteger(selected) || selected < 1 || selected > response.sessions.length) {
      throw new Error('Invalid session selection.');
    }
    return response.sessions[selected - 1];
  }
  finally { prompt.close(); }
}

function terminalSize() {
  return {
    cols: Math.max(20, process.stdout.columns || 120),
    rows: Math.max(8, process.stdout.rows || 36),
  };
}

function displayText(value) {
  return String(value || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function fitRight(value, cols) {
  const text = displayText(value);
  return text.length <= cols ? text : `…${text.slice(-(Math.max(0, cols - 1)))}`;
}

function fitLeft(value, cols) {
  const text = displayText(value);
  return text.length <= cols ? text : `${text.slice(0, Math.max(0, cols - 1))}…`;
}

async function connectSession(sshConfig, session) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('xcode needs an interactive PowerShell terminal.');
  }

  const bridge = runGateway(sshConfig, ['attach', session.sessionId], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let pendingFrames = '';
  let remoteWrite = Promise.resolve();
  const outputBeforeAttach = [];
  let surface = null;
  let typed = '';
  let status = 'Connecting to the main Codex session…';
  let enteredUi = false;
  let inputEnabled = false;
  let renderQueued = false;
  let disconnected = false;
  let bridgeErrors = '';
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });

  function writeFrame(frame) {
    if (!bridge.stdin.destroyed) {
      bridge.stdin.write(`${JSON.stringify(frame)}\n`);
    }
  }

  function queueRender() {
    if (!enteredUi || renderQueued) { return; }
    renderQueued = true;
    setImmediate(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    if (!enteredUi || !surface) { return; }
    const { cols, rows } = terminalSize();
    const chromeRows = 3;
    const mirrorRows = Math.max(1, rows - chromeRows);
    const viewport = surface.getViewport({ cols, rows: mirrorRows });
    let output = '';
    for (let index = 0; index < mirrorRows; index += 1) {
      output += `\x1b[${index + 1};1H\x1b[2K${fitLeft(viewport[index] || '', cols)}`;
    }
    output += `\x1b[${mirrorRows + 1};1H\x1b[2K\x1b[7m ${fitLeft(`xcode · ${status} · Ctrl+C disconnects`, Math.max(1, cols - 2))} \x1b[0m`;
    output += `\x1b[${mirrorRows + 2};1H\x1b[2K${fitRight(`› ${typed}`, Math.max(1, cols - 1))}▌`;
    output += `\x1b[${mirrorRows + 3};1H\x1b[2K${fitLeft('Enter sends a complete message to this Codex conversation', cols)}`;
    process.stdout.write(output);
  }

  function enterUi() {
    if (enteredUi) { return; }
    enteredUi = true;
    process.stdout.write('\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l');
    queueRender();
  }

  function leaveUi() {
    if (inputEnabled) {
      process.stdin.off('data', onInput);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      inputEnabled = false;
    }
    process.stdout.off('resize', queueRender);
    if (enteredUi) {
      enteredUi = false;
      process.stdout.write('\x1b[?25h\x1b[?1049l');
    }
    if (surface) {
      surface.dispose();
      surface = null;
    }
  }

  function finish(error) {
    if (disconnected) { return; }
    disconnected = true;
    leaveUi();
    resolveFinished(error || null);
  }

  function beginInput() {
    if (inputEnabled) { return; }
    inputEnabled = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onInput);
    process.stdout.on('resize', queueRender);
  }

  function queueRemoteOutput(data) {
    remoteWrite = remoteWrite.then(async () => {
      if (!surface) {
        outputBeforeAttach.push(data);
        return;
      }
      await surface.write(data);
      queueRender();
    }).catch((error) => finish(error));
  }

  function handleFrame(frame) {
    if (frame.type === 'snapshot' || frame.type === 'output') {
      if (typeof frame.data !== 'string') {
        throw new Error('The main PC sent a malformed terminal frame.');
      }
      queueRemoteOutput(Buffer.from(frame.data, 'base64').toString('utf8'));
      return;
    }
    if (frame.type === 'attached') {
      if (!surface) {
        surface = new OfficeTerminalSurface({ remoteCols: frame.cols, remoteRows: frame.rows });
        status = 'Connected — type below; Enter sends to the main Codex conversation';
        enterUi();
        beginInput();
        remoteWrite = remoteWrite.then(async () => {
          for (const output of outputBeforeAttach.splice(0)) {
            await surface.write(output);
          }
          queueRender();
        }).catch((error) => finish(error));
      }
      return;
    }
    if (frame.type === 'queued') {
      status = 'Queued on main PC — waiting for its Codex terminal to become ready';
      queueRender();
      return;
    }
    if (frame.type === 'delivered') {
      status = 'Written to the main Codex terminal — watch the mirrored response';
      queueRender();
      return;
    }
    if (frame.type === 'error') {
      status = `Not delivered — ${frame.message || frame.code || 'main PC rejected the message'}`;
      queueRender();
      return;
    }
    throw new Error('The main PC sent an unknown xcode session frame.');
  }

  function onInput(data) {
    for (const character of data) {
      if (character === '\u0003' || character === '\u0004') {
        status = 'Disconnecting…';
        queueRender();
        disconnected = true;
        leaveUi();
        bridge.stdin.end();
        bridge.kill();
        resolveFinished(null);
        return;
      }
      if (character === '\r' || character === '\n') {
        const message = typed;
        typed = '';
        if (message.trim()) {
          status = 'Sending to the main Codex terminal…';
          writeFrame({ type: 'message', messageId: crypto.randomUUID(), text: message });
        }
        queueRender();
        continue;
      }
      if (character === '\u0008' || character === '\u007f') {
        typed = typed.slice(0, -1);
        queueRender();
        continue;
      }
      if (character >= ' ') {
        typed += character;
        queueRender();
      }
    }
  }

  bridge.stdout.setEncoding('utf8');
  bridge.stderr.setEncoding('utf8');
  bridge.stdout.on('data', (data) => {
    pendingFrames += data;
    while (true) {
      const newline = pendingFrames.indexOf('\n');
      if (newline < 0) { break; }
      const line = pendingFrames.slice(0, newline);
      pendingFrames = pendingFrames.slice(newline + 1);
      let frame;
      try { frame = JSON.parse(line); }
      catch { finish(new Error('The main PC sent an invalid xcode session frame.')); return; }
      try { handleFrame(frame); }
      catch (error) { finish(error); return; }
    }
  });
  bridge.stderr.on('data', (data) => { bridgeErrors += data; });
  bridge.on('error', (error) => finish(error));
  bridge.on('exit', (code) => {
    if (disconnected) { return; }
    finish(code === 0 ? null : new Error(bridgeErrors.trim() || `The xcode gateway exited ${code}.`));
  });

  const failure = await finished;
  if (failure) { throw failure; }
}

async function main() {
  const { sshConfig } = parseArgs(process.argv.slice(2));
  const session = await chooseSession(sshConfig);
  await connectSession(sshConfig, session);
}

main().catch((error) => {
  process.stderr.write(`xcode: ${error.message}\n`);
  process.exit(1);
});
