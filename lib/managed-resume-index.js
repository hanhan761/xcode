'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

function normalizeCwd(value) {
  if (typeof value !== 'string' || !value.trim()) { return null; }
  return path.resolve(value);
}

function canonicalWorkspace(value) {
  const cwd = normalizeCwd(value);
  if (!cwd) { return null; }
  const root = path.parse(cwd).root;
  const withoutTrailingSeparator = cwd.length > root.length ? cwd.replace(/[\\/]+$/, '') : cwd;
  return process.platform === 'win32' ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator;
}

function normalizeRecord(record) {
  if (!record || !THREAD_ID_PATTERN.test(record.threadId || '')) { return null; }
  const cwd = normalizeCwd(record.cwd);
  const workspace = canonicalWorkspace(cwd);
  if (!cwd || !workspace || !Number.isFinite(record.updatedAt)) { return null; }
  return {
    threadId: record.threadId,
    cwd,
    title: typeof record.title === 'string' ? record.title : null,
    updatedAt: record.updatedAt,
    workspace,
  };
}

function defaultWorkspaceExists(cwd) {
  try { return fs.statSync(cwd).isDirectory(); }
  catch { return false; }
}

function createManagedResumeIndex({
  root = path.join(process.env.LOCALAPPDATA || process.cwd(), 'XcodeRemote', 'managed-resume-index'),
  now = () => Date.now(),
  workspaceExists = defaultWorkspaceExists,
} = {}) {
  function statePath(threadId) {
    return path.join(root, `${crypto.createHash('sha256').update(threadId).digest('hex')}.json`);
  }

  function readRecord(file) {
    try { return normalizeRecord(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch { return null; }
  }

  function record({ threadId, cwd, title = null }) {
    const entry = normalizeRecord({ threadId, cwd, title, updatedAt: now() });
    if (!entry) { throw new TypeError('A managed resume record requires a Codex thread id and workspace path.'); }
    fs.mkdirSync(root, { recursive: true });
    const file = statePath(entry.threadId);
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(entry), 'utf8');
      fs.renameSync(temporary, file);
    }
    finally { fs.rmSync(temporary, { force: true }); }
    return { threadId: entry.threadId, cwd: entry.cwd, title: entry.title, updatedAt: entry.updatedAt };
  }

  function list(cwd) {
    const workspace = canonicalWorkspace(cwd);
    const currentCwd = normalizeCwd(cwd);
    if (!workspace || !currentCwd || !workspaceExists(currentCwd)) { return []; }
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return []; }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readRecord(path.join(root, entry.name)))
      .filter((entry) => entry && entry.workspace === workspace && workspaceExists(entry.cwd))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.threadId.localeCompare(right.threadId))
      .map(({ threadId, cwd: savedCwd, title, updatedAt }) => ({ threadId, cwd: savedCwd, title, updatedAt }));
  }

  return { list, record };
}

module.exports = { canonicalWorkspace, createManagedResumeIndex };
