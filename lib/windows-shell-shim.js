'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function environmentPathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
}

function findRealPowerShell(env, shimPath) {
  const pathKey = environmentPathKey(env);
  const shim = path.resolve(shimPath).toLowerCase();
  if (env.XCODE_REAL_PWSH) {
    const configured = path.resolve(env.XCODE_REAL_PWSH);
    try {
      if (configured.toLowerCase() !== shim && fs.statSync(configured).size > 0) { return configured; }
    }
    catch { /* Fall through to PATH discovery. */ }
  }
  for (const entry of String(env[pathKey] || '').split(path.delimiter)) {
    if (!entry) { continue; }
    const candidate = path.resolve(entry, 'pwsh.exe');
    try {
      if (candidate.toLowerCase() !== shim && fs.statSync(candidate).size > 0) { return candidate; }
    }
    catch { /* This PATH entry has no directly executable PowerShell 7. */ }
  }
  const fallback = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(fallback)) { return fallback; }
  throw new Error('xcode could not find a real PowerShell executable for its hidden shell shim.');
}

function findRealCodeModeHost(env, codexExecutable, shimPath) {
  const shim = path.resolve(shimPath).toLowerCase();
  const candidates = [
    env.XCODE_REAL_CODE_MODE_HOST,
    env.CODEX_CODE_MODE_HOST_PATH,
    codexExecutable && path.join(path.dirname(codexExecutable), 'codex-code-mode-host.exe'),
  ].filter(Boolean);
  for (const candidateValue of candidates) {
    const candidate = path.resolve(candidateValue);
    try {
      if (candidate.toLowerCase() !== shim && fs.statSync(candidate).size > 0) { return candidate; }
    }
    catch { /* Keep looking for the host bundled beside codex.exe. */ }
  }
  throw new Error('xcode could not find the Codex code-mode host for its hidden process shim.');
}

function buildShim({ powershell, buildScript, sourcePath, outputPath, packageRoot, env }) {
  const built = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', buildScript,
    '-OutputPath', outputPath,
    '-SourcePath', sourcePath,
  ], { cwd: packageRoot, env, encoding: 'utf8', windowsHide: true });
  if (built.error || built.status !== 0) {
    const detail = [built.error?.message, built.stdout, built.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`xcode could not build its hidden process shim.${detail ? `\n${detail}` : ''}`);
  }
}

function prepareHiddenCodexEnvironment({
  env = process.env,
  packageRoot = path.resolve(__dirname, '..'),
  shimRoot = path.join(env.LOCALAPPDATA || process.cwd(), 'XcodeRemote', 'hidden-shell'),
  codexExecutable,
} = {}) {
  if (process.platform !== 'win32') { return { env: { ...env } }; }
  const sourcePath = path.join(packageRoot, 'scripts', 'HiddenProcessShim.cs');
  const buildScript = path.join(packageRoot, 'scripts', 'build-hidden-process-shim.ps1');
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  const versionedShimRoot = path.join(shimRoot, sourceHash.slice(0, 16));
  const shimPath = path.join(versionedShimRoot, 'pwsh.exe');
  const codeModeHostShimPath = path.join(versionedShimRoot, 'codex-code-mode-host.exe');
  if (!fs.existsSync(shimPath) || !fs.existsSync(codeModeHostShimPath)) {
    const powershell = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    buildShim({ powershell, buildScript, sourcePath, outputPath: shimPath, packageRoot, env });
    fs.copyFileSync(shimPath, codeModeHostShimPath);
  }

  const realPowerShell = findRealPowerShell(env, shimPath);
  const realCodeModeHost = findRealCodeModeHost(env, codexExecutable, codeModeHostShimPath);
  const pathKey = environmentPathKey(env);
  return {
    shimPath,
    codeModeHostShimPath,
    realPowerShell,
    realCodeModeHost,
    env: {
      ...env,
      [pathKey]: `${versionedShimRoot}${path.delimiter}${env[pathKey] || ''}`,
      XCODE_REAL_PWSH: realPowerShell,
      XCODE_REAL_CODE_MODE_HOST: realCodeModeHost,
      CODEX_CODE_MODE_HOST_PATH: codeModeHostShimPath,
    },
  };
}

module.exports = { prepareHiddenCodexEnvironment };
