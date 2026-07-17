#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pty = require('node-pty');

const [launchStatePath, file, cwd, ...args] = process.argv.slice(2);
if (!launchStatePath || !file || !cwd || args.length === 0) {
  process.exit(2);
}

function writeLaunchState(value) {
  const temporaryPath = `${launchStatePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(launchStatePath), { recursive: true });
  fs.writeFileSync(temporaryPath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, launchStatePath);
}

let child;
try {
  child = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: process.env,
    useConptyDll: true,
  });
  // App-server uses WebSocket for its protocol. Drain diagnostic terminal
  // output so ConPTY backpressure can never stall the authority process.
  child.onData(() => {});
  child.onExit(({ exitCode }) => {
    try { fs.rmSync(launchStatePath, { force: true }); }
    catch { /* The acquiring process may already have consumed the state. */ }
    process.exit(exitCode || 0);
  });
  writeLaunchState({
    schemaVersion: 1,
    processId: child.pid,
    pseudoconsoleHostProcessId: process.pid,
    createdAt: new Date().toISOString(),
  });
}
catch (error) {
  try {
    writeLaunchState({
      schemaVersion: 1,
      pseudoconsoleHostProcessId: process.pid,
      error: error.message,
      createdAt: new Date().toISOString(),
    });
  }
  catch { /* The launcher will report that this host exited before startup. */ }
  process.exit(1);
}
