#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');
const { createOfficeAttachmentRegistry } = require('../lib/office-attachment-registry');
const { runOfficeAttachAll } = require('../lib/office-attach-all');
const { runNativeCodexOfficeSession } = require('../lib/native-codex-office-session');

function parseArgs(argv) {
  let sshConfig = null;
  let sessionId = null;
  let attachmentToken = null;
  let attachAll = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--attach-all') {
      if (attachAll) { throw new Error('Usage: session-client.js --ssh-config <path> [--attach-all | --session-id <id> [--attachment-token <token>]]'); }
      attachAll = true;
      continue;
    }
    if (value === '--ssh-config' || value === '--session-id' || value === '--attachment-token') {
      const next = argv[index + 1];
      if (!next) { throw new Error('Usage: session-client.js --ssh-config <path> [--attach-all | --session-id <id> [--attachment-token <token>]]'); }
      if (value === '--ssh-config' && !sshConfig) { sshConfig = next; }
      else if (value === '--session-id' && !sessionId) { sessionId = next; }
      else if (value === '--attachment-token' && !attachmentToken) { attachmentToken = next; }
      else { throw new Error('Usage: session-client.js --ssh-config <path> [--attach-all | --session-id <id> [--attachment-token <token>]]'); }
      index += 1;
      continue;
    }
    throw new Error('Usage: session-client.js --ssh-config <path> [--attach-all | --session-id <id> [--attachment-token <token>]]');
  }
  if (!sshConfig || (attachAll && (sessionId || attachmentToken)) || (attachmentToken && !sessionId)) {
    throw new Error('Usage: session-client.js --ssh-config <path> [--attach-all | --session-id <id> [--attachment-token <token>]]');
  }
  return { sshConfig, sessionId, attachmentToken, attachAll };
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

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function listSessions(sshConfig) {
  const output = await collectOutput(runGateway(sshConfig, ['list'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  const response = JSON.parse(output);
  return Array.isArray(response.sessions) ? response.sessions : [];
}

function nativeSessions(active) {
  return active.filter((session) => session?.nativeTuiAvailable === true &&
    typeof session.threadId === 'string' && session.threadId &&
    typeof session.sessionId === 'string' && session.sessionId);
}

async function listNativeSessions(sshConfig) {
  return nativeSessions(await listSessions(sshConfig));
}

function noNativeSessionError(active) {
  if (active.length > 0) {
    return new Error('The active main-PC conversations were started by an older xcode version. Close and resume them once after updating the main PC.');
  }
  return new Error('The main PC has no active managed Codex session. Start or resume one there with codex. Saved history is not listed here.');
}

async function chooseSession(sshConfig) {
  const active = await listSessions(sshConfig);
  const sessions = nativeSessions(active);
  if (sessions.length === 0) { throw noNativeSessionError(active); }
  if (sessions.length === 1) { return sessions[0]; }
  if (!process.stdin.isTTY) { return sessions[0]; }
  process.stdout.write('Active Codex conversations on the main PC:\n');
  sessions.forEach((session, index) => process.stdout.write(`  [${index + 1}] ${session.title || session.cwd || 'unknown folder'}  ${session.createdAt || ''}\n`));
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

async function findSelectedSession(sshConfig, sessionId) {
  const active = await listSessions(sshConfig);
  const session = nativeSessions(active).find((candidate) => candidate.sessionId === sessionId);
  if (session) { return session; }
  if (active.length === 0) { throw new Error('The selected main-PC Codex conversation is no longer active. Run xcode -aa again.'); }
  throw new Error('The selected main-PC Codex conversation is unavailable or was started by an older xcode version. Run xcode -aa again.');
}

async function recoverSessionByThread(sshConfig, threadId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const recovered = (await listNativeSessions(sshConfig)).find((candidate) => candidate.threadId === threadId);
      if (recovered) { return recovered; }
      lastError = new Error('The recovered main-PC session is not ready yet.');
    }
    catch (error) { lastError = error; }
    if (Date.now() < deadline) { await wait(250); }
  }
  throw new Error(`Could not rediscover the recovered Codex thread: ${lastError?.message || 'no matching managed session was published.'}`);
}

function resolveWindowsTerminal({ env = process.env, spawnSyncProcess = spawnSync } = {}) {
  if (env.XCODE_WINDOWS_TERMINAL) { return env.XCODE_WINDOWS_TERMINAL; }
  const result = spawnSyncProcess('where.exe', ['wt.exe'], { encoding: 'utf8', windowsHide: true });
  const candidate = String(result.stdout || '').split(/\r?\n/).find(Boolean);
  if (result.error || result.status !== 0 || !candidate) {
    throw new Error('Windows Terminal (wt.exe) was not found. Install Windows Terminal, then rerun xcode -aa.');
  }
  return candidate;
}

function powerShellLiteral(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function openWindowsTerminalTabs(entries, {
  terminal = resolveWindowsTerminal(),
  spawnProcess = spawn,
  xcodeCommand = 'xcode.cmd',
} = {}) {
  const args = ['-w', 'xcode-office'];
  entries.forEach((entry, index) => {
    if (index > 0) { args.push(';'); }
    args.push('new-tab', '--title', entry.title, 'powershell.exe', '-NoLogo', '-NoExit', '-Command',
      `& ${xcodeCommand} -a ${powerShellLiteral(entry.sessionId)} ${powerShellLiteral(entry.attachmentToken)}`);
  });
  return new Promise((resolve, reject) => {
    const child = spawnProcess(terminal, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`Windows Terminal could not open the requested Codex tabs (exit ${code}).`)); }
    });
  });
}

async function runAttachedOfficeSession({
  sshConfig,
  sessionId,
  attachmentToken,
  registry,
  runNative = runNativeCodexOfficeSession,
  findSession = findSelectedSession,
  selectSession = chooseSession,
  openGateway = (args, options) => runGateway(sshConfig, args, options),
}) {
  let session;
  try { session = sessionId ? await findSession(sshConfig, sessionId) : await selectSession(sshConfig); }
  catch (error) {
    if (sessionId && attachmentToken) { registry.releaseBySessionId({ sessionId, attachmentToken }); }
    throw error;
  }
  const reservation = attachmentToken
    ? registry.claim({ threadId: session.threadId, sessionId: session.sessionId, attachmentToken })
    : registry.reserve({ threadId: session.threadId, sessionId: session.sessionId });
  if (!reservation) { throw new Error('This Codex conversation is already open on the office laptop.'); }
  const claim = attachmentToken ? reservation : registry.claim(reservation);
  try {
    return await runNative({
      session,
      openGateway,
      recoverSession: ({ threadId }) => recoverSessionByThread(sshConfig, threadId),
    });
  }
  finally { registry.release(claim); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const registry = createOfficeAttachmentRegistry();
  if (options.attachAll) {
    const terminal = resolveWindowsTerminal();
    const result = await runOfficeAttachAll({
      listSessions: () => listSessions(options.sshConfig),
      registry,
      openTabs: (entries) => openWindowsTerminalTabs(entries, { terminal }),
    });
    process.stdout.write(`Opened ${result.opened} office Codex tab(s); skipped ${result.skipped} already-open attachment(s).\n`);
    return;
  }
  process.exitCode = await runAttachedOfficeSession({ ...options, registry });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`xcode: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  findSelectedSession,
  nativeSessions,
  openWindowsTerminalTabs,
  parseArgs,
  powerShellLiteral,
  resolveWindowsTerminal,
  runAttachedOfficeSession,
};
