'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) { return false; }
  try {
    process.kill(processId, 0);
    return true;
  }
  catch { return false; }
}

function stopProcess(processId) {
  if (!isProcessAlive(processId)) { return; }
  try { process.kill(processId); }
  catch { /* The host may have exited between the liveness check and termination. */ }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function isAppServerReady(url) {
  try {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.close();
    return true;
  }
  catch { return false; }
}

async function waitForAppServer(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAppServerReady(url)) { return; }
    await sleep(25);
  }
  throw new Error('Timed out waiting for the shared local Codex app-server.');
}

function lockIsStale(lockPath) {
  const owner = readJson(path.join(lockPath, 'owner.json'));
  if (!owner || !isProcessAlive(owner.processId)) { return true; }
  return Date.now() - Number(owner.createdAtMs || 0) > 30_000;
}

async function withHostLock(hostRoot, action) {
  fs.mkdirSync(hostRoot, { recursive: true });
  const lockPath = path.join(hostRoot, 'lock');
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      writeJson(path.join(lockPath, 'owner.json'), { processId: process.pid, createdAtMs: Date.now() });
      break;
    }
    catch (error) {
      if (error.code !== 'EEXIST') { throw error; }
      if (lockIsStale(lockPath)) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); }
        catch { /* Another contender released or replaced the lock. */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the local shared app-server lock.');
      }
      await sleep(25);
    }
  }
  try { return await action(); }
  finally { fs.rmSync(lockPath, { recursive: true, force: true }); }
}

function cleanStaleLeases(leasesRoot) {
  fs.mkdirSync(leasesRoot, { recursive: true });
  for (const entry of fs.readdirSync(leasesRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) { continue; }
    const leasePath = path.join(leasesRoot, entry.name);
    const lease = readJson(leasePath);
    if (!lease || !isProcessAlive(lease.ownerProcessId)) {
      fs.rmSync(leasePath, { force: true });
    }
  }
}

function activeLeaseCount(leasesRoot) {
  return fs.readdirSync(leasesRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
}

function startWatchdog(hostRoot, hostId) {
  const watchdog = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'app-server-host-watchdog.js'), hostRoot, hostId], {
    stdio: 'ignore',
    windowsHide: true,
    detached: true,
  });
  if (!Number.isInteger(watchdog.pid)) {
    throw new Error('Could not start the shared app-server lease watchdog.');
  }
  watchdog.unref();
  return watchdog.pid;
}

function runSharedAppServerWatchdog({ hostRoot, hostId }) {
  const statePath = path.join(hostRoot, 'host.json');
  const leasesRoot = path.join(hostRoot, 'leases');
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) { return; }
    checking = true;
    try {
      let finished = false;
      await withHostLock(hostRoot, async () => {
        const host = readJson(statePath);
        if (!host || host.hostId !== hostId) {
          finished = true;
          return;
        }
        cleanStaleLeases(leasesRoot);
        if (activeLeaseCount(leasesRoot) === 0) {
          stopProcess(host.processId);
          fs.rmSync(statePath, { force: true });
          finished = true;
        }
      });
      if (finished) {
        clearInterval(timer);
        process.exit(0);
      }
    }
    catch {
      // The next check can recover a temporary filesystem race.
    }
    finally { checking = false; }
  }, 1_000);
}

async function acquireSharedAppServer({
  file,
  cwd = process.cwd(),
  env = process.env,
  hostRoot = path.join(env.LOCALAPPDATA || process.cwd(), 'XcodeRemote', 'app-server-host'),
  ownerId = crypto.randomUUID(),
}) {
  if (!file || typeof file !== 'string') {
    throw new TypeError('A shared app-server host requires a native Codex executable path.');
  }

  const statePath = path.join(hostRoot, 'host.json');
  const leasesRoot = path.join(hostRoot, 'leases');
  let host;
  await withHostLock(hostRoot, async () => {
    cleanStaleLeases(leasesRoot);
    host = readJson(statePath);
    if (host && (!isProcessAlive(host.processId) || !await isAppServerReady(host.url))) {
      stopProcess(host.processId);
      fs.rmSync(statePath, { force: true });
      host = null;
    }
    if (!host) {
      const port = await reserveLoopbackPort();
      const url = `ws://127.0.0.1:${port}`;
      const child = spawn(file, ['app-server', '--listen', url], {
        cwd,
        env,
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
      if (!Number.isInteger(child.pid)) {
        throw new Error('Could not start the shared local Codex app-server.');
      }
      child.unref();
      try { await waitForAppServer(url); }
      catch (error) {
        stopProcess(child.pid);
        throw error;
      }
      host = { schemaVersion: 1, hostId: crypto.randomUUID(), processId: child.pid, url, createdAt: new Date().toISOString() };
      writeJson(statePath, host);
    }
    writeJson(path.join(leasesRoot, `${ownerId}.json`), { ownerId, ownerProcessId: process.pid, hostId: host.hostId });
    if (!isProcessAlive(host.watchdogProcessId)) {
      host.watchdogProcessId = startWatchdog(hostRoot, host.hostId);
      writeJson(statePath, host);
    }
  });

  let released = false;
  return {
    url: host.url,
    processId: host.processId,
    async release() {
      if (released) { return; }
      released = true;
      await withHostLock(hostRoot, async () => {
        fs.rmSync(path.join(leasesRoot, `${ownerId}.json`), { force: true });
        cleanStaleLeases(leasesRoot);
        const currentHost = readJson(statePath);
        if (activeLeaseCount(leasesRoot) === 0 && currentHost?.hostId === host.hostId) {
          stopProcess(currentHost.processId);
          stopProcess(currentHost.watchdogProcessId);
          fs.rmSync(statePath, { force: true });
        }
      });
    },
  };
}

module.exports = { acquireSharedAppServer, runSharedAppServerWatchdog };
