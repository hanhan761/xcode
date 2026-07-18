'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const { createManagedResumeIndex } = require(path.join(packageRoot, 'lib', 'managed-resume-index'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-managed-resume-index-'));
const projectA = path.join(root, 'project-a');
const projectB = path.join(root, 'project-b');
const indexRoot = path.join(root, 'resume-index');
let now = 10_000;

async function main() {
  try {
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    const index = createManagedResumeIndex({ root: indexRoot, now: () => now });
    const threadA = '11111111-1111-4111-8111-111111111111';
    const threadB = '22222222-2222-4222-8222-222222222222';
    index.record({ threadId: threadA, cwd: `${projectA}${path.sep}`, title: 'Project A' });
    now += 1;
    index.record({ threadId: threadB, cwd: projectB, title: 'Project B' });

    assert.deepEqual(
      index.list(projectA).map((entry) => entry.threadId),
      [threadA],
      'The current workspace resume list included a conversation from another folder.',
    );
    assert.deepEqual(
      index.list(`${projectA}${path.sep}`).map((entry) => entry.threadId),
      [threadA],
      'Trailing path separators changed the current workspace resume scope.',
    );
    if (process.platform === 'win32') {
      assert.deepEqual(
        index.list(projectA.toUpperCase()).map((entry) => entry.threadId),
        [threadA],
        'Windows workspace path casing changed the current resume scope.',
      );
    }

    now += 1;
    index.record({ threadId: threadA, cwd: projectA, title: 'Renamed Project A' });
    assert.deepEqual(index.list(projectA), [{
      threadId: threadA,
      cwd: path.resolve(projectA),
      title: 'Renamed Project A',
      updatedAt: now,
    }], 'A resumed thread was duplicated instead of refreshing its current-workspace record.');

    fs.writeFileSync(path.join(indexRoot, 'malformed.json'), '{not json', 'utf8');
    fs.rmSync(projectB, { recursive: true, force: true });
    assert.deepEqual(index.list(projectA).map((entry) => entry.threadId), [threadA], 'A malformed or stale workspace record leaked into the current resume list.');
    assert.deepEqual(index.list(projectB), [], 'A deleted workspace was still offered for resume.');

    process.stdout.write('MANAGED_RESUME_INDEX=PASS\n');
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
