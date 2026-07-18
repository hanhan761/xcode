#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { startSharedAppServerSession } = require('../lib/app-server-session');
const { findNativeCodex } = require('../lib/codex-executable');
const { createTerminalOutputSink } = require('../lib/terminal-output-sink');
const { createTerminalOutputCoalescer } = require('../lib/terminal-output-coalescer');
const { terminalTitleSequence } = require('../lib/session-title');

function restoreTerminal(rawMode) {
  if (process.stdin.isTTY && rawMode) { process.stdin.setRawMode(false); }
  process.stdin.pause();
}

function terminalDimensions() {
  return {
    cols: Math.max(20, process.stdout.columns || 120),
    rows: Math.max(5, process.stdout.rows || 36),
  };
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

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Managed Codex must be started from an interactive PowerShell terminal.');
  }
  const codex = findNativeCodex({ preferGlobal: false });
  const initialSize = terminalDimensions();
  const stateRoot = process.env.XCODE_STATE_ROOT || defaultStateRoot();
  const codexArgs = process.argv.slice(2);
  const resumedThreadId = codexArgs[0] === 'resume' ? codexArgs[1] : null;
  const existing = findActiveManagedThread(stateRoot, resumedThreadId);
  if (existing) {
    process.stdout.write(`[xcode] This Codex conversation is already active (PID ${existing.processId}); keeping the existing tab.\r\n`);
    appendLifecycleLog('duplicate-resume-skipped', { threadId: resumedThreadId, existingProcessId: existing.processId });
    return;
  }
  const launchLabel = codexArgs[0] === 'resume' ? 'Restoring the shared Codex session…' : 'Starting a shared Codex session…';
  process.stdout.write(`[xcode] ${launchLabel}\r\n`);
  appendLifecycleLog('starting', { command: codexArgs[0] || 'new', threadId: resumedThreadId });
  let session;
  try {
    session = await startSharedAppServerSession({
      file: codex,
      args: codexArgs,
      cwd: process.cwd(),
      stateRoot,
      ...initialSize,
      onStatus: (message) => process.stdout.write(`[xcode] ${message}\r\n`),
    });
  }
  catch (error) {
    appendLifecycleLog('startup-failed', { command: codexArgs[0] || 'new', threadId: resumedThreadId, error: error.message });
    throw error;
  }
  const output = createTerminalOutputSink(process.stdout, () => {
    process.exitCode = 1;
    session.stop();
  });
  const terminalOutput = createTerminalOutputCoalescer((data) => output.write(data), initialSize);
  const unsubscribeTitle = session.onTitle((title) => output.write(terminalTitleSequence(title)));
  session.onOutput((data) => terminalOutput.write(data));
  const resize = () => {
    try {
      const dimensions = terminalDimensions();
      session.resize(dimensions.cols, dimensions.rows);
      terminalOutput.resize(dimensions.cols, dimensions.rows);
    }
    catch { /* The terminal is closing or the managed TUI already exited. */ }
  };
  process.stdout.on('resize', resize);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => session.submitLocal(data));
  const result = await session.completed;
  unsubscribeTitle();
  process.stdout.off('resize', resize);
  await terminalOutput.close();
  output.close();
  restoreTerminal(true);
  appendLifecycleLog('stopped', { sessionId: session.sessionId, threadId: session.threadId, exitCode: result.exitCode, signal: result.signal });
  process.exit(result.exitCode || process.exitCode || 0);
}

main().catch((error) => {
  appendLifecycleLog('fatal', { error: error.message });
  restoreTerminal(process.stdin.isRaw);
  process.stderr.write(`xcode: ${error.message}\n`);
  process.exit(1);
});
