#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const { resolveThreadRequest } = require(path.join(packageRoot, 'lib', 'app-server-session'));

async function main() {
  const savedThreadId = '019f4ea1-3f67-7613-a233-1ce9ae8a430a';
  const fallbackCwd = 'C:\\Users\\13081';
  const request = await resolveThreadRequest({}, ['resume', savedThreadId], fallbackCwd);
  assert.deepEqual(request, {
    method: 'thread/resume',
    params: { threadId: savedThreadId },
  });
  assert.equal(Object.hasOwn(request.params, 'cwd'), false, 'A recovery fallback directory must not overwrite the saved Codex workspace.');
  console.log('APP_SERVER_RESUME_PRESERVES_THREAD=PASS');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
