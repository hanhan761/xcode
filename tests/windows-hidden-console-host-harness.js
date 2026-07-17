#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { prepareHiddenCodexEnvironment } = require('../lib/windows-shell-shim');

const packageRoot = path.resolve(__dirname, '..');
const probeScript = path.join(__dirname, 'visible-child-window-probe.ps1');
const resultPath = path.join(os.tmpdir(), `xcode-window-probe-${process.pid}.json`);
const runtimeRoot = path.join(os.tmpdir(), `xcode-hidden-shell-${process.pid}`);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function findNativeCodex() {
  const npmRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  for (const packageName of fs.readdirSync(npmRoot)) {
    if (!/^codex-win32-/i.test(packageName)) { continue; }
    const vendorRoot = path.join(npmRoot, packageName, 'vendor');
    for (const vendor of fs.readdirSync(vendorRoot)) {
      const candidate = path.join(vendorRoot, vendor, 'bin', 'codex.exe');
      if (fs.existsSync(candidate)) { return candidate; }
    }
  }
  throw new Error('The native Codex executable was not found.');
}

async function main() {
  fs.rmSync(resultPath, { force: true });
  const probe = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probeScript,
    '-OutputPath', resultPath, '-DurationSeconds', '4',
  ], { cwd: packageRoot, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let probeError = '';
  probe.stderr.setEncoding('utf8');
  probe.stderr.on('data', (data) => { probeError += data; });
  const probeExit = new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`Window probe exited ${code}: ${probeError.trim()}`)));
  });

  await wait(400);
  const hiddenShell = prepareHiddenCodexEnvironment({
    env: process.env,
    packageRoot,
    shimRoot: runtimeRoot,
    codexExecutable: findNativeCodex(),
  });
  let shellOutput = '';
  let hostProxyOutput = '';
  const hosted = spawn(hiddenShell.shimPath, [
    '-NoProfile', '-Command', 'Start-Sleep -Milliseconds 1800; Write-Output xcode-hidden-shell-ok',
  ], { cwd: packageRoot, env: hiddenShell.env, stdio: ['ignore', 'pipe', 'pipe'] });
  hosted.stdout.setEncoding('utf8');
  hosted.stdout.on('data', (data) => { shellOutput += data; });
  const hostProxy = spawn(hiddenShell.codeModeHostShimPath, [
    '-NoProfile', '-Command', 'Start-Sleep -Milliseconds 1500; Write-Output xcode-hidden-host-ok',
  ], {
    cwd: packageRoot,
    env: { ...hiddenShell.env, XCODE_REAL_CODE_MODE_HOST: hiddenShell.realPowerShell },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hostProxy.stdout.setEncoding('utf8');
  hostProxy.stdout.on('data', (data) => { hostProxyOutput += data; });
  const hostedExit = new Promise((resolve, reject) => {
    hosted.once('error', reject);
    hosted.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Hidden shell exited ${code}.`)));
  });
  const hostProxyExit = new Promise((resolve, reject) => {
    hostProxy.once('error', reject);
    hostProxy.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`Hidden code-mode host proxy exited ${code}.`)));
  });

  await probeExit;
  await hostedExit;
  await hostProxyExit;
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  fs.rmSync(resultPath, { force: true });
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  assert.equal(result.passed, true,
    `A detached xcode host created visible child console windows: ${JSON.stringify(result.visibleChildWindows)}`);
  assert.match(shellOutput, /xcode-hidden-shell-ok/, 'The hidden shell shim lost PowerShell stdout.');
  assert.match(hostProxyOutput, /xcode-hidden-host-ok/, 'The hidden code-mode host proxy lost stdout.');
  console.log('WINDOWS_HIDDEN_PROCESS_SHIMS=PASS');
  process.exit(0);
}

main().catch((error) => {
  fs.rmSync(resultPath, { force: true });
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  console.error(error.stack || error.message);
  process.exit(1);
});
