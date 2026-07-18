'use strict';

const assert = require('node:assert/strict');
const {
  createThreadRelayPolicy,
  isLoopbackWebSocketUrl,
} = require('../lib/scoped-app-server-relay');

const threadId = '11111111-1111-4111-8111-111111111111';
const otherThreadId = '22222222-2222-4222-8222-222222222222';
const policy = createThreadRelayPolicy(threadId);

function request(id, method, params = {}) {
  return JSON.stringify({ id, method, params });
}

assert.equal(isLoopbackWebSocketUrl('ws://127.0.0.1:43123'), true);
assert.equal(isLoopbackWebSocketUrl('ws://localhost:43123'), true);
assert.equal(isLoopbackWebSocketUrl('ws://[::1]:43123'), true);
assert.equal(isLoopbackWebSocketUrl('wss://127.0.0.1:43123'), false);
assert.equal(isLoopbackWebSocketUrl('ws://100.77.199.126:43123'), false);

assert.equal(policy.acceptClientMessage(request(1, 'initialize', { clientInfo: { name: 'codex-cli', version: 'test' } })).method, 'initialize');
assert.equal(policy.acceptClientMessage(JSON.stringify({ method: 'initialized' })).method, 'initialized');
assert.equal(policy.acceptClientMessage(request(2, 'thread/resume', { threadId })).params.threadId, threadId);
assert.equal(policy.acceptClientMessage(request(3, 'thread/read', { threadId, includeTurns: true })).params.threadId, threadId);
assert.equal(policy.acceptClientMessage(request(4, 'turn/start', { threadId, input: [] })).params.threadId, threadId);
assert.equal(policy.acceptClientMessage(request(5, 'turn/interrupt', { threadId, turnId: 'turn-1' })).params.threadId, threadId);
assert.equal(policy.acceptClientMessage(request(6, 'thread/name/set', { threadId, name: 'Persistent title' })).params.threadId, threadId);
assert.equal(policy.acceptClientMessage(request(7, 'model/list', {})).method, 'model/list');

for (const method of ['thread/list', 'thread/start', 'thread/fork', 'thread/delete', 'thread/archive', 'thread/unarchive']) {
  assert.throws(() => policy.acceptClientMessage(request(20, method, { threadId })), /not permitted/i, method);
}
assert.throws(() => policy.acceptClientMessage(request(21, 'thread/resume', { threadId: otherThreadId })), /different Codex thread/i);
assert.throws(() => policy.acceptClientMessage(request(22, 'turn/start', { threadId: otherThreadId, input: [] })), /different Codex thread/i);
assert.throws(() => policy.acceptClientMessage(request(23, 'thread/read', {})), /selected thread id/i);
assert.throws(() => policy.acceptClientMessage('{not json'), /valid JSON/i);
assert.throws(() => policy.acceptClientMessage('null'), /JSON object/i);

assert.equal(policy.shouldForwardServerMessage(JSON.stringify({ id: 1, result: {} })), true);
assert.equal(policy.shouldForwardServerMessage(JSON.stringify({ method: 'turn/started', params: { threadId } })), true);
assert.equal(policy.shouldForwardServerMessage(JSON.stringify({ method: 'turn/started', params: { threadId: otherThreadId } })), false);
assert.equal(policy.shouldForwardServerMessage(JSON.stringify({ method: 'thread/started', params: { thread: { id: threadId } } })), true);
assert.equal(policy.shouldForwardServerMessage(JSON.stringify({ method: 'thread/name/updated', params: { threadId, threadName: 'Persistent title' } })), true);
assert.equal(policy.shouldForwardServerMessage(JSON.stringify({ method: 'thread/started', params: { thread: { id: otherThreadId } } })), false);
assert.equal(policy.shouldForwardServerMessage(JSON.stringify({ method: 'account/updated', params: {} })), true);
assert.equal(policy.shouldForwardServerMessage('{not json'), false);

process.stdout.write('SCOPED_APP_SERVER_RELAY=PASS\n');
