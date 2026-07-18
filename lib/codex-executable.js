'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function findInOpenAiPackageRoot(openAiRoot) {
  if (!openAiRoot || !fs.existsSync(openAiRoot)) { return null; }
  for (const packageName of fs.readdirSync(openAiRoot)) {
    if (!/^codex-win32-/i.test(packageName)) { continue; }
    const vendorRoot = path.join(openAiRoot, packageName, 'vendor');
    if (!fs.existsSync(vendorRoot)) { continue; }
    for (const target of fs.readdirSync(vendorRoot)) {
      const candidate = path.join(vendorRoot, target, 'bin', 'codex.exe');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { return candidate; }
    }
  }
  return null;
}

function resolveCodexExecutable({
  env = process.env,
  packageRoot = path.resolve(__dirname, '..'),
} = {}) {
  if (env.XCODE_CODEX_PATH) {
    const explicit = path.resolve(env.XCODE_CODEX_PATH);
    if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) {
      return { executable: explicit, source: 'explicit-override' };
    }
    throw new Error(`XCODE_CODEX_PATH does not name a Codex executable: ${explicit}`);
  }

  const roots = [
    path.join(packageRoot, 'node_modules', '@openai'),
    path.join(packageRoot, 'node_modules', '@openai', 'codex', 'node_modules', '@openai'),
  ];
  for (const root of roots) {
    const executable = findInOpenAiPackageRoot(root);
    if (executable) { return { executable, source: 'release-payload' }; }
  }
  throw new Error('The release-pinned Windows Codex executable was not found. Run xcode update, then retry.');
}

function probeCodexVersion(executable, { spawn = spawnSync } = {}) {
  const result = spawn(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (result.error) { throw new Error(`Could not run the official Codex version probe: ${result.error.message}`); }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`The official Codex version probe failed${detail ? `: ${detail}` : '.'}`);
  }
  const version = String(result.stdout || '').trim();
  if (!version) { throw new Error('The official Codex version probe returned no version.'); }
  return version;
}

function inspectCodexInstallation(options = {}) {
  const { executable, source } = resolveCodexExecutable(options);
  const version = (options.probeVersion || probeCodexVersion)(executable);
  return { source, version };
}

function findNativeCodex(options = {}) {
  return resolveCodexExecutable(options).executable;
}

module.exports = {
  findNativeCodex,
  inspectCodexInstallation,
  probeCodexVersion,
  resolveCodexExecutable,
};
