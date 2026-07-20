#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { inspectCodexInstallation } = require('../lib/codex-executable');

if (process.argv.length !== 3 || process.argv[2] !== '--json') {
  process.stderr.write('Usage: codex-installation.js --json\n');
  process.exit(1);
}

try {
  const packageRoot = path.resolve(__dirname, '..');
  const manifest = require(path.join(packageRoot, 'package.json'));
  const codex = inspectCodexInstallation({ packageRoot });
  process.stdout.write(`${JSON.stringify({ xcodeVersion: manifest.version, codex })}\n`);
}
catch (error) {
  process.stderr.write(`xcode: ${error.message}\n`);
  process.exit(1);
}
