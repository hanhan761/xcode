#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline/promises');
const { runNativeCodexOfficeSession } = require('../lib/native-codex-office-session');

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
  const keepAlive = args[0] === 'native'
    ? ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'TCPKeepAlive=yes']
    : [];
  return spawn(ssh, [...wrapper, '-F', sshConfig, '-o', 'BatchMode=yes', ...keepAlive, 'xcode-main', 'xcode-gateway', ...args], options);
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
  const active = Array.isArray(response.sessions) ? response.sessions : [];
  const sessions = active.filter((session) => session.nativeTuiAvailable && typeof session.threadId === 'string');
  if (sessions.length === 0) {
    if (active.length > 0) {
      throw new Error('The active main-PC conversations were started by an older xcode version. Close and resume them once after updating the main PC.');
    }
    throw new Error('The main PC has no active managed Codex session. Start or resume one there with codex. Saved history is not listed here.');
  }
  if (sessions.length === 1) { return sessions[0]; }
  if (!process.stdin.isTTY) { return sessions[0]; }
  process.stdout.write('Active Codex conversations on the main PC:\n');
  sessions.forEach((session, index) => process.stdout.write(`  [${index + 1}] ${session.cwd || 'unknown folder'}  ${session.createdAt || ''}\n`));
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question('Choose a conversation: ');
    const selected = Number.parseInt(answer, 10);
    if (!Number.isInteger(selected) || selected < 1 || selected > sessions.length) {
      throw new Error('Invalid session selection.');
    }
    return sessions[selected - 1];
  }
  finally { prompt.close(); }
}

async function main() {
  const { sshConfig } = parseArgs(process.argv.slice(2));
  const session = await chooseSession(sshConfig);
  const exitCode = await runNativeCodexOfficeSession({
    session,
    openGateway: (args, options) => runGateway(sshConfig, args, options),
  });
  process.exitCode = exitCode;
}

main().catch((error) => {
  process.stderr.write(`xcode: ${error.message}\n`);
  process.exit(1);
});
