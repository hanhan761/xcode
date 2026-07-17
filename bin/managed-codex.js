#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { startSharedAppServerSession } = require('../lib/app-server-session');

function findNativeCodex() {
  const npmRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  if (!fs.existsSync(npmRoot)) {
    throw new Error('Codex is not installed globally. Run npm install --global @openai/codex first.');
  }
  for (const packageName of fs.readdirSync(npmRoot)) {
    if (!/^codex-win32-/i.test(packageName)) { continue; }
    const vendorRoot = path.join(npmRoot, packageName, 'vendor');
    if (!fs.existsSync(vendorRoot)) { continue; }
    for (const vendor of fs.readdirSync(vendorRoot)) {
      const candidate = path.join(vendorRoot, vendor, 'bin', 'codex.exe');
      if (fs.existsSync(candidate)) { return candidate; }
    }
  }
  throw new Error('The native Windows Codex executable was not found in the global Codex package. Run codex update, then retry.');
}

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

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Managed Codex must be started from an interactive PowerShell terminal.');
  }
  const codex = findNativeCodex();
  const initialSize = terminalDimensions();
  const stateRoot = process.env.XCODE_STATE_ROOT || undefined;
  const session = await startSharedAppServerSession({ file: codex, args: process.argv.slice(2), cwd: process.cwd(), stateRoot, ...initialSize });
  session.onOutput((data) => process.stdout.write(data));
  const resize = () => {
    try {
      const dimensions = terminalDimensions();
      session.resize(dimensions.cols, dimensions.rows);
    }
    catch { /* The terminal is closing or the managed TUI already exited. */ }
  };
  process.stdout.on('resize', resize);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => session.submitLocal(data));
  const result = await session.completed;
  process.stdout.off('resize', resize);
  restoreTerminal(true);
  process.exit(result.exitCode || 0);
}

main().catch((error) => {
  restoreTerminal(process.stdin.isRaw);
  process.stderr.write(`xcode: ${error.message}\n`);
  process.exit(1);
});
