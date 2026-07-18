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

  const configuredResume = await resolveThreadRequest({}, ['resume', '--model', 'gpt-5.6', '--config', 'service_tier="fast"', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', savedThreadId], fallbackCwd);
  assert.deepEqual(configuredResume, {
    method: 'thread/resume',
    params: { threadId: savedThreadId, model: 'gpt-5.6', serviceTier: 'fast' },
  });

  const lastResume = await resolveThreadRequest({
    async request(method, params) {
      assert.equal(method, 'thread/list');
      assert.deepEqual(params, { cwd: fallbackCwd, limit: 1, sortKey: 'recency_at', sortDirection: 'desc' });
      return { data: [{ id: savedThreadId }] };
    },
  }, ['resume', '--last', '--model', 'gpt-5.6', '--config=service_tier="fast"'], fallbackCwd);
  assert.deepEqual(lastResume, {
    method: 'thread/resume',
    params: { threadId: savedThreadId, model: 'gpt-5.6', serviceTier: 'fast' },
  });

  const started = await resolveThreadRequest({}, ['--model', 'gpt-5.6', '--config', 'service_tier="fast"'], fallbackCwd);
  assert.deepEqual(started, {
    method: 'thread/start',
    params: { cwd: fallbackCwd, model: 'gpt-5.6', serviceTier: 'fast' },
  });
  console.log('APP_SERVER_RESUME_PRESERVES_THREAD=PASS');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
