'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PENDING_TIMEOUT_MS = 30_000;

function defaultRoot(env = process.env) {
  if (!env.LOCALAPPDATA) { throw new Error('LOCALAPPDATA is required to track office Codex attachments.'); }
  return path.join(env.LOCALAPPDATA, 'XcodeRemote', 'office-attachments');
}

function defaultIsProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) { return false; }
  try {
    process.kill(processId, 0);
    return true;
  }
  catch { return false; }
}

function createOfficeAttachmentRegistry({
  root = defaultRoot(),
  now = () => Date.now(),
  isProcessAlive = defaultIsProcessAlive,
  pendingTimeoutMs = DEFAULT_PENDING_TIMEOUT_MS,
} = {}) {
  if (!Number.isFinite(pendingTimeoutMs) || pendingTimeoutMs <= 0) {
    throw new RangeError('The office attachment pending timeout must be positive.');
  }

  const statePath = (threadId) => path.join(root, `${crypto.createHash('sha256').update(threadId).digest('hex')}.json`);
  const lockPath = path.join(root, 'attach-all.lock');

  function ensureRoot() { fs.mkdirSync(root, { recursive: true }); }
  function read(threadId) {
    try { return JSON.parse(fs.readFileSync(statePath(threadId), 'utf8')); }
    catch { return null; }
  }
  function remove(threadId) { fs.rmSync(statePath(threadId), { force: true }); }
  function write(record) { fs.writeFileSync(statePath(record.threadId), JSON.stringify(record), 'utf8'); }
  function stale(record) {
    if (!record || typeof record.threadId !== 'string' || typeof record.attachmentToken !== 'string') { return true; }
    if (record.pending === true) { return !Number.isFinite(record.createdAt) || now() - record.createdAt >= pendingTimeoutMs; }
    return !isProcessAlive(record.processId);
  }
  function current(threadId) {
    const record = read(threadId);
    if (!record) { return null; }
    if (stale(record)) {
      remove(threadId);
      return null;
    }
    return record;
  }

  function reserve({ threadId, sessionId }) {
    if (!threadId || !sessionId) { throw new TypeError('An office attachment reservation requires a thread id and session id.'); }
    ensureRoot();
    if (current(threadId)) { return null; }
    const reservation = {
      threadId,
      sessionId,
      attachmentToken: crypto.randomBytes(18).toString('hex'),
      processId: null,
      pending: true,
      createdAt: now(),
    };
    write(reservation);
    return reservation;
  }

  function claim({ threadId, sessionId, attachmentToken, processId = process.pid }) {
    if (!Number.isInteger(processId) || processId <= 0) { throw new TypeError('An office attachment claim requires a live process id.'); }
    ensureRoot();
    const reservation = current(threadId);
    if (!reservation || reservation.pending !== true || reservation.sessionId !== sessionId || reservation.attachmentToken !== attachmentToken) {
      throw new Error('This office Codex attachment reservation is no longer valid. Run xcode -aa again.');
    }
    const claimRecord = { ...reservation, processId, pending: false, createdAt: now() };
    write(claimRecord);
    return claimRecord;
  }

  function release({ threadId, attachmentToken }) {
    const record = read(threadId);
    if (record && record.attachmentToken === attachmentToken) { remove(threadId); }
  }

  function releaseBySessionId({ sessionId, attachmentToken }) {
    if (!fs.existsSync(root)) { return; }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) { continue; }
      try {
        const record = JSON.parse(fs.readFileSync(path.join(root, entry.name), 'utf8'));
        if (record.sessionId === sessionId && record.attachmentToken === attachmentToken) {
          fs.rmSync(path.join(root, entry.name), { force: true });
        }
      }
      catch {}
    }
  }

  function isActive(threadId) { return Boolean(current(threadId)); }

  function acquireAllLock() {
    ensureRoot();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = fs.openSync(lockPath, 'wx');
        const lockToken = crypto.randomBytes(18).toString('hex');
        try { fs.writeFileSync(descriptor, JSON.stringify({ processId: process.pid, createdAt: now(), lockToken })); }
        finally { fs.closeSync(descriptor); }
        return {
          release: () => {
            try {
              const currentLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
              if (currentLock.lockToken === lockToken) { fs.rmSync(lockPath, { force: true }); }
            }
            catch {}
          },
        };
      }
      catch (error) {
        if (error?.code !== 'EEXIST') { throw error; }
        let existing = null;
        try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
        catch {}
        const isFresh = Number.isFinite(existing?.createdAt) && now() - existing.createdAt < pendingTimeoutMs;
        if (existing && isFresh && isProcessAlive(existing.processId)) {
          throw new Error('An office Codex attach-all recovery is already in progress.');
        }
        fs.rmSync(lockPath, { force: true });
      }
    }
    throw new Error('Could not acquire the office Codex attach-all recovery lock.');
  }

  return { acquireAllLock, claim, isActive, release, releaseBySessionId, reserve };
}

module.exports = { createOfficeAttachmentRegistry };
