#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { parseResumeInvocation, startSharedAppServerSession } = require('../lib/app-server-session');
const { findNativeCodex } = require('../lib/codex-executable');
const { createManagedResumeIndex } = require('../lib/managed-resume-index');
const { createTerminalOutputSink } = require('../lib/terminal-output-sink');
const { createTerminalTitleFilter } = require('../lib/session-title');

const DISABLE_MOUSE_REPORTING = '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
const DEFAULT_TRANSPORT_RECOVERY_ATTEMPTS = 2;
const DEFAULT_TRANSPORT_RECOVERY_DELAY_MS = 250;

function terminalText(output) {
  return String(output || '')
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/gs, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function isRemoteAppServerTransportFailure(output) {
  return /remote app server[\s\S]{0,1024}transport failed|connection reset without closing handshake/i.test(terminalText(output));
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function restoreTerminal(input, rawMode) {
  if (input.isTTY && rawMode) { input.setRawMode(false); }
  input.pause();
}

function terminalDimensions(output = process.stdout) {
  return {
    cols: Math.max(20, output.columns || 120),
    rows: Math.max(5, output.rows || 36),
  };
}

function resumeLabel(candidate) {
  return String(candidate.title || path.basename(candidate.cwd) || 'Unnamed conversation')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Unnamed conversation';
}

async function chooseWorkspaceResume({ candidates, input, output }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('There is no saved managed Codex conversation in this folder to resume. Start one with codex first.');
  }
  output.write('Managed Codex conversations in this folder:\r\n');
  candidates.forEach((candidate, index) => output.write(`  [${index + 1}] ${resumeLabel(candidate)}\r\n`));
  const prompt = readline.createInterface({ input, output });
  try {
    const answer = await prompt.question('Choose a conversation: ');
    const selected = Number.parseInt(answer, 10);
    if (!Number.isInteger(selected) || selected < 1 || selected > candidates.length) {
      throw new Error('Invalid Codex conversation selection.');
    }
    return candidates[selected - 1].threadId;
  }
  finally { prompt.close(); }
}

function defaultStateRoot() {
  return path.join(process.env.LOCALAPPDATA || process.cwd(), 'XcodeRemote', 'managed-sessions');
}

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) { return false; }
  try {
    process.kill(processId, 0);
    return true;
  }
  catch { return false; }
}

function findActiveManagedThread(stateRoot, threadId) {
  if (typeof threadId !== 'string' || !threadId) { return null; }
  try {
    for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) { continue; }
      const statePath = path.join(stateRoot, entry.name);
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (state.threadId !== threadId || state.ready === false) { continue; }
        if (isProcessAlive(state.processId)) { return state; }
        fs.rmSync(statePath, { force: true });
      }
      catch { /* An incomplete or stale state file cannot block recovery. */ }
    }
  }
  catch { /* A first managed session has no registry yet. */ }
  return null;
}

function appendLifecycleLog(event, details = {}) {
  try {
    const stateRoot = process.env.XCODE_STATE_ROOT || defaultStateRoot();
    const directory = path.join(path.dirname(stateRoot), 'logs');
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, 'managed-codex.log'), `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`, 'utf8');
  }
  catch { /* Diagnostic logging must never disturb an interactive Codex session. */ }
}

async function main({
  input = process.stdin,
  outputStream = process.stdout,
  args = process.argv.slice(2),
  cwd = process.cwd(),
  stateRoot = process.env.XCODE_STATE_ROOT || defaultStateRoot(),
  findCodex = findNativeCodex,
  startSession = startSharedAppServerSession,
  findActiveThread = findActiveManagedThread,
  lifecycleLog = appendLifecycleLog,
  resumeIndex = null,
  chooseResume = chooseWorkspaceResume,
  transportRecoveryAttempts = DEFAULT_TRANSPORT_RECOVERY_ATTEMPTS,
  transportRecoveryDelayMs = DEFAULT_TRANSPORT_RECOVERY_DELAY_MS,
} = {}) {
  if (!input.isTTY || !outputStream.isTTY) {
    throw new Error('Managed Codex must be started from an interactive PowerShell terminal.');
  }
  if (!Number.isInteger(transportRecoveryAttempts) || transportRecoveryAttempts < 0) {
    throw new RangeError('The transport recovery attempt count must be a non-negative integer.');
  }
  if (!Number.isFinite(transportRecoveryDelayMs) || transportRecoveryDelayMs < 0) {
    throw new RangeError('The transport recovery delay must be a non-negative number.');
  }
  const codex = findCodex({ preferGlobal: false });
  const initialSize = terminalDimensions(outputStream);
  const managedResumeIndex = resumeIndex || createManagedResumeIndex({ root: path.join(path.dirname(stateRoot), 'managed-resume-index') });
  let codexArgs = args;
  let resume = parseResumeInvocation(codexArgs);
  if (resume && !resume.useLast && !resume.threadId) {
    const candidates = managedResumeIndex.list(cwd);
    const selectedThreadId = await chooseResume({ candidates, cwd, input, output: outputStream });
    if (!candidates.some((candidate) => candidate.threadId === selectedThreadId)) {
      throw new Error('The selected Codex conversation is not available in this folder.');
    }
    codexArgs = [...codexArgs, selectedThreadId];
    resume = parseResumeInvocation(codexArgs);
  }
  const resumedThreadId = resume?.threadId || null;
  const existing = findActiveThread(stateRoot, resumedThreadId);
  if (existing) {
    outputStream.write(`[xcode] This Codex conversation is already active (PID ${existing.processId}); keeping the existing tab.\r\n`);
    lifecycleLog('duplicate-resume-skipped', { threadId: resumedThreadId, existingProcessId: existing.processId });
    return;
  }
  const launchLabel = resume ? 'Restoring the shared Codex session…' : 'Starting a shared Codex session…';
  outputStream.write(`[xcode] ${launchLabel}\r\n`);
  lifecycleLog('starting', { command: codexArgs[0] || 'new', threadId: resumedThreadId });
  let session = null;
  const output = createTerminalOutputSink(outputStream, () => {
    process.exitCode = 1;
    session?.stop();
  });
  const resize = () => {
    try {
      const dimensions = terminalDimensions(outputStream);
      session?.resize(dimensions.cols, dimensions.rows);
    }
    catch { /* The terminal is closing or the managed TUI already exited. */ }
  };
  outputStream.on('resize', resize);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  const onInput = (data) => session?.submitLocal(data);
  input.on('data', onInput);

  let sessionArgs = codexArgs;
  let recoveryAttempts = 0;
  let result;
  try {
    for (;;) {
      try {
        session = await startSession({
          file: codex,
          args: sessionArgs,
          cwd,
          stateRoot,
          ...initialSize,
          onStatus: (message) => outputStream.write(`[xcode] ${message}\r\n`),
        });
      }
      catch (error) {
        lifecycleLog('startup-failed', { command: sessionArgs[0] || 'new', threadId: sessionArgs[1] || null, error: error.message });
        throw error;
      }

      const recordResumeCandidate = (title = session.title) => {
        try {
          managedResumeIndex.record({ threadId: session.threadId, cwd: session.cwd || cwd, title });
        }
        catch (error) { lifecycleLog('resume-index-failed', { threadId: session.threadId, error: error.message }); }
      };
      recordResumeCandidate();

      let outputTail = '';
      const terminalOutput = createTerminalTitleFilter((data) => output.write(data), session.title);
      output.write(DISABLE_MOUSE_REPORTING);
      terminalOutput.setSessionTitle(session.title);
      const unsubscribeTitle = session.onTitle((title) => {
        recordResumeCandidate(title);
        terminalOutput.setSessionTitle(title);
      });
      const unsubscribeOutput = session.onOutput((data) => {
        outputTail = `${outputTail}${data}`.slice(-8_192);
        terminalOutput.write(data);
      });
      result = await session.completed;
      unsubscribeTitle();
      unsubscribeOutput?.();
      terminalOutput.flush();

      const transportReset = Number(result.exitCode) !== 0 && isRemoteAppServerTransportFailure(outputTail);
      if (transportReset && recoveryAttempts < transportRecoveryAttempts) {
        recoveryAttempts += 1;
        output.write(`[xcode] Remote app-server transport reset; recovering the shared Codex session (${recoveryAttempts}/${transportRecoveryAttempts})…\r\n`);
        lifecycleLog('transport-reset-retry', { sessionId: session.sessionId, threadId: session.threadId, attempt: recoveryAttempts });
        sessionArgs = ['resume', session.threadId];
        session = null;
        if (transportRecoveryDelayMs > 0) { await wait(transportRecoveryDelayMs); }
        continue;
      }
      if (transportReset) {
        output.write(`[xcode] The shared Codex transport could not recover after ${recoveryAttempts} retry attempts. Run codex resume ${session.threadId}.\r\n`);
        lifecycleLog('transport-reset-exhausted', { sessionId: session.sessionId, threadId: session.threadId, attempts: recoveryAttempts });
      }
      break;
    }
  }
  finally {
    outputStream.off('resize', resize);
    input.off('data', onInput);
    output.write(DISABLE_MOUSE_REPORTING);
    output.close();
    restoreTerminal(input, true);
  }
  lifecycleLog('stopped', { sessionId: session?.sessionId, threadId: session?.threadId, exitCode: result.exitCode, signal: result.signal });
  return result.exitCode || process.exitCode || 0;
}

if (require.main === module) {
  main().then((exitCode) => process.exit(exitCode)).catch((error) => {
    appendLifecycleLog('fatal', { error: error.message });
    restoreTerminal(process.stdin, process.stdin.isRaw);
    process.stderr.write(`xcode: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { chooseWorkspaceResume, main };
