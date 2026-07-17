#!/usr/bin/env node
'use strict';

// Real production path, with only SSH itself replaced by a local command
// wrapper: office PowerShell UI -> forced gateway -> named pipe -> semantic
// app-server turn/start -> main native Codex TUI.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pty = require('node-pty');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { startSharedAppServerSession } = require(path.join(packageRoot, 'lib', 'app-server-session'));

function waitFor(predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      }
      else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${description}.`));
      }
    }, 25);
  });
}

function isSessionReady(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')).ready === true; }
  catch { return false; }
}

function findNativeCodex() {
  const root = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  for (const packageName of fs.readdirSync(root)) {
    if (!/^codex-win32-/i.test(packageName)) { continue; }
    const vendorRoot = path.join(root, packageName, 'vendor');
    for (const vendor of fs.readdirSync(vendorRoot)) {
      const candidate = path.join(vendorRoot, vendor, 'bin', 'codex.exe');
      if (fs.existsSync(candidate)) { return candidate; }
    }
  }
  throw new Error('The native Windows Codex executable was not found.');
}

async function main() {
  if (process.env.XCODE_RUN_SEMANTIC_TWO_MACHINE !== '1') {
    console.log('SEMANTIC_TWO_MACHINE_E2E=SKIPPED (set XCODE_RUN_SEMANTIC_TWO_MACHINE=1 to run the authenticated live proof)');
    return;
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-semantic-two-machine-'));
  const mainLocalAppData = path.join(fixtureRoot, 'main-localappdata');
  const stateRoot = path.join(mainLocalAppData, 'XcodeRemote', 'managed-sessions');
  const gateway = path.join(packageRoot, 'bin', 'session-gateway.js');
  const officeSshWrapper = path.join(fixtureRoot, 'office-ssh.cmd');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-semantic-workspace-'));
  const codex = findNativeCodex();
  const node = process.execPath;
  const command = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  const marker = `office-to-main-same-thread-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let session;
  let office;
  let mainOutput = '';
  let officeOutput = '';

  fs.writeFileSync(officeSshWrapper, [
    '@echo off',
    'setlocal EnableDelayedExpansion',
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
    `  set "LOCALAPPDATA=${mainLocalAppData}"`,
    '  set "SSH_ORIGINAL_COMMAND=xcode-gateway list"',
    `  "${node}" "${gateway}"`,
    '  exit /b %ERRORLEVEL%',
    ')',
    'if "!previous2!"=="xcode-gateway" if "!previous1!"=="attach" (',
    `  set "LOCALAPPDATA=${mainLocalAppData}"`,
    '  set "SSH_ORIGINAL_COMMAND=xcode-gateway attach !last!"',
    `  "${node}" "${gateway}"`,
    '  exit /b %ERRORLEVEL%',
    ')',
    'exit /b 9',
    '',
  ].join('\r\n'), 'utf8');

  try {
    session = await startSharedAppServerSession({
      file: codex,
      cwd: workspace,
      stateRoot,
    });
    session.onOutput((data) => { mainOutput += data; });
    await waitFor(() => isSessionReady(path.join(stateRoot, `${session.sessionId}.json`)), 10_000, 'the semantic main-session gateway to become ready');

    office = pty.spawn(node, ['bin/session-client.js', '--ssh-config', path.join(fixtureRoot, 'office-ssh-config')], {
      name: 'xterm-256color', cols: 100, rows: 24, cwd: packageRoot,
      env: { ...process.env, XCODE_SSH_PATH: command, XCODE_SSH_WRAPPER: officeSshWrapper },
      useConptyDll: true,
    });
    let sent = false;
    office.onData((data) => {
      officeOutput += data;
      if (!sent && officeOutput.includes('Ready — type below')) {
        sent = true;
        office.write(`Reply with exactly: ${marker}. Do not use tools.\r`);
      }
    });

    await waitFor(() => officeOutput.includes('Ready — message is in the shared Codex conversation'), 15_000, 'the office client to settle after semantic delivery');
    await waitFor(() => mainOutput.includes(marker), 90_000, 'the office turn to render in the main native Codex TUI');
    await waitFor(() => officeOutput.includes(marker), 30_000, 'the same native-Codex reply to render in the office mirror');
    assert.equal(sent, true, 'The office client never accepted its local message.');
    assert.match(officeOutput, /\x1b\[\?1049h/, 'The office client did not use its single current-window terminal UI.');
    console.log(`SEMANTIC_TWO_MACHINE_E2E=PASS package=${packageRoot}`);
  }
  catch (error) {
    error.message += `\nmain TUI tail: ${JSON.stringify(mainOutput.slice(-4_000))}\noffice UI tail: ${JSON.stringify(officeOutput.slice(-4_000))}`;
    throw error;
  }
  finally {
    if (office) { office.kill(); }
    if (session) {
      session.stop();
      await Promise.race([session.completed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      spawnSync('taskkill.exe', ['/pid', String(session.processId), '/t', '/f'], { windowsHide: true });
      spawnSync(codex, ['delete', session.threadId], { cwd: workspace, stdio: 'ignore', windowsHide: true });
    }
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* Windows terminal handles can linger after the bounded proof. */ }
    try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 }); }
    catch { /* See above. */ }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  },
);
