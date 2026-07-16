#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');

function parseArgs(argv) {
  const index = argv.indexOf('--ssh-config');
  if (index < 0 || !argv[index + 1] || index + 2 !== argv.length) {
    throw new Error('Usage: session-client.js --ssh-config <path>');
  }
  return { sshConfig: argv[index + 1] };
}

function runGateway(sshConfig, args, options = {}) {
  const ssh = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\OpenSSH\\ssh.exe` : 'ssh';
  return spawn(ssh, ['-F', sshConfig, '-o', 'BatchMode=yes', 'xcode-main', 'xcode-gateway', ...args], options);
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
    throw new Error('The main PC has no managed Codex session yet. Start or resume one there with codex.');
  }
  if (response.sessions.length === 1) { return response.sessions[0]; }
  if (!process.stdin.isTTY) { return response.sessions[0]; }
  process.stdout.write('Managed Codex sessions on the main PC:\n');
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

async function main() {
  const { sshConfig } = parseArgs(process.argv.slice(2));
  const session = await chooseSession(sshConfig);
  const bridge = runGateway(sshConfig, ['attach', session.sessionId], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  let pending = '';
  let typed = '';
  let attached = false;

  function send(frame) {
    bridge.stdin.write(`${JSON.stringify(frame)}\n`);
  }
  function writeOutput(frame) {
    if (typeof frame.data === 'string') {
      process.stdout.write(Buffer.from(frame.data, 'base64').toString('utf8'));
    }
  }
  function submitTypedMessage() {
    const message = typed;
    typed = '';
    process.stdout.write('\r\n');
    if (message.trim()) {
      send({ type: 'message', messageId: crypto.randomUUID(), text: message });
    }
  }
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (data) => {
    pending += data;
    while (pending.includes('\n')) {
      const newline = pending.indexOf('\n');
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let frame;
      try { frame = JSON.parse(line); }
      catch { throw new Error('The main PC sent an invalid xcode session frame.'); }
      if (frame.type === 'snapshot' || frame.type === 'output') { writeOutput(frame); }
      if (frame.type === 'attached') { attached = true; }
      if (frame.type === 'error') { process.stderr.write(`\nxcode: ${frame.message || frame.code || 'message was not delivered'}\n`); }
    }
  });
  bridge.on('error', (error) => { throw error; });
  bridge.on('exit', (code) => process.exit(code || 0));

  if (!process.stdin.isTTY) { throw new Error('xcode needs an interactive PowerShell terminal.'); }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    for (const character of data) {
      if (character === '\u0003' || character === '\u0004') {
        bridge.stdin.end();
        return;
      }
      if (character === '\r' || character === '\n') { submitTypedMessage(); continue; }
      if (character === '\u0008' || character === '\u007f') {
        if (typed) { typed = typed.slice(0, -1); process.stdout.write('\b \b'); }
        continue;
      }
      if (character >= ' ' && character !== '\u007f') { typed += character; process.stdout.write(character); }
    }
  });
  await new Promise((resolve) => {
    const timer = setInterval(() => { if (attached) { clearInterval(timer); resolve(); } }, 10);
  });
}

main().catch((error) => {
  process.stderr.write(`xcode: ${error.message}\n`);
  process.exit(1);
});
