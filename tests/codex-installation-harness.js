'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const {
  resolveCodexExecutable,
  inspectCodexInstallation,
} = require(path.join(packageRoot, 'lib', 'codex-executable'));

function writeCodex(root, packageName = 'codex-win32-x64') {
  const executable = path.join(root, 'node_modules', '@openai', packageName, 'vendor', '0.0.0-test', 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'fixture');
  return executable;
}

function writeReleaseCodexManifest(root, version = '0.0.0-test') {
  const manifest = path.join(root, 'node_modules', '@openai', 'codex', 'package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ name: '@openai/codex', version }));
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-codex-installation-'));
try {
  const releaseRoot = path.join(fixtureRoot, 'release');
  const appData = path.join(fixtureRoot, 'appdata');
  const releaseExecutable = writeCodex(releaseRoot);
  writeReleaseCodexManifest(releaseRoot);
  const globalExecutable = writeCodex(path.join(appData, 'npm', 'node_modules', '@openai', 'codex'));

  const release = resolveCodexExecutable({ env: { APPDATA: appData }, packageRoot: releaseRoot });
  assert.deepEqual(
    release,
    { executable: releaseExecutable, source: 'release-payload' },
    'A managed session must use the release payload rather than an unrelated global Codex installation.',
  );
  assert.notEqual(release.executable, globalExecutable);

  const overrideExecutable = path.join(fixtureRoot, 'override-codex.exe');
  fs.writeFileSync(overrideExecutable, 'fixture');
  const override = resolveCodexExecutable({
    env: { APPDATA: appData, XCODE_CODEX_PATH: overrideExecutable },
    packageRoot: releaseRoot,
  });
  assert.deepEqual(override, { executable: overrideExecutable, source: 'explicit-override' });

  const installation = inspectCodexInstallation({
    env: { APPDATA: appData },
    packageRoot: releaseRoot,
    probeVersion: (executable) => {
      assert.equal(executable, releaseExecutable);
      return 'codex 0.0.0-test';
    },
  });
  assert.deepEqual(installation, {
    source: 'release-payload',
    packageVersion: '0.0.0-test',
    version: 'codex 0.0.0-test',
  });

  assert.throws(
    () => inspectCodexInstallation({
      env: { APPDATA: appData },
      packageRoot: releaseRoot,
      probeVersion: () => 'codex 9.9.9',
    }),
    /does not match the release payload version/i,
    'A different Codex binary must not be reported as the release-pinned payload.',
  );

  const reporter = path.join(packageRoot, 'bin', 'codex-installation.js');
  const reportProcess = spawnSync(process.execPath, [reporter, '--json'], { encoding: 'utf8' });
  assert.equal(reportProcess.status, 0, reportProcess.stderr);
  const report = JSON.parse(reportProcess.stdout);
  assert.equal(report.xcodeVersion, require(path.join(packageRoot, 'package.json')).version);
  assert.equal(report.codex.source, 'release-payload');
  assert.equal(report.codex.packageVersion, require(path.join(packageRoot, 'node_modules', '@openai', 'codex', 'package.json')).version);
  assert.match(report.codex.version, /\S/);

  assert.throws(
    () => inspectCodexInstallation({
      env: { APPDATA: appData },
      packageRoot: releaseRoot,
      probeVersion: () => { throw new Error('version probe failed'); },
    }),
    /version probe failed/,
    'A failed official Codex version probe must prevent a successful update/status report.',
  );

  process.stdout.write('CODEX_INSTALLATION=PASS\n');
}
finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
