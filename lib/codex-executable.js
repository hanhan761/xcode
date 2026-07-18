'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

function findNativeCodex({
  env = process.env,
  packageRoot = path.resolve(__dirname, '..'),
  preferGlobal = false,
} = {}) {
  if (env.XCODE_CODEX_PATH) {
    const explicit = path.resolve(env.XCODE_CODEX_PATH);
    if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) { return explicit; }
    throw new Error(`XCODE_CODEX_PATH does not name a Codex executable: ${explicit}`);
  }

  const globalOpenAiRoot = path.join(env.APPDATA || '', 'npm', 'node_modules', '@openai');
  const roots = {
    local: [
      path.join(packageRoot, 'node_modules', '@openai'),
      path.join(packageRoot, 'node_modules', '@openai', 'codex', 'node_modules', '@openai'),
    ],
    global: [
      path.join(globalOpenAiRoot, 'codex', 'node_modules', '@openai'),
      globalOpenAiRoot,
    ],
  };
  const ordered = preferGlobal ? [...roots.global, ...roots.local] : [...roots.local, ...roots.global];
  for (const root of ordered) {
    const executable = findInOpenAiPackageRoot(root);
    if (executable) { return executable; }
  }
  throw new Error('The native Windows Codex executable was not found. Run xcode update, then retry.');
}

module.exports = { findNativeCodex };
