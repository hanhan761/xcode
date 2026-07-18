'use strict';

const MAX_APP_SERVER_MESSAGE_BYTES = 32 * 1024 * 1024;
const DENIED_THREAD_METHODS = new Set([
  'thread/list',
  'thread/start',
  'thread/fork',
  'thread/delete',
  'thread/archive',
  'thread/unarchive',
]);

function isLoopbackWebSocketUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
  }
  catch { return false; }
}

function parseObject(text, description) {
  let message;
  try { message = JSON.parse(text); }
  catch { throw new Error(`${description} was not valid JSON.`); }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error(`${description} must be a JSON object.`);
  }
  return message;
}

function collectThreadIds(value, found = new Set()) {
  if (!value || typeof value !== 'object') { return found; }
  if (Array.isArray(value)) {
    for (const item of value) { collectThreadIds(item, found); }
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'threadId' && typeof child === 'string') { found.add(child); }
    else if (key === 'thread' && child && typeof child === 'object' && typeof child.id === 'string') {
      found.add(child.id);
      collectThreadIds(child, found);
    }
    else { collectThreadIds(child, found); }
  }
  return found;
}

function createThreadRelayPolicy(threadId, sharedSessionPolicy = null) {
  if (typeof threadId !== 'string' || !threadId) {
    throw new TypeError('A selected Codex thread id is required.');
  }
  const policy = typeof sharedSessionPolicy?.model === 'string' && sharedSessionPolicy.model
    ? {
      model: sharedSessionPolicy.model,
      serviceTier: typeof sharedSessionPolicy.serviceTier === 'string' && sharedSessionPolicy.serviceTier
        ? sharedSessionPolicy.serviceTier
        : null,
    }
    : null;

  return {
    acceptClientMessage(text) {
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_APP_SERVER_MESSAGE_BYTES) {
        throw new Error('The Codex client message was too large.');
      }
      const message = parseObject(text, 'The Codex client message');
      const method = typeof message.method === 'string' ? message.method : null;
      if (method && DENIED_THREAD_METHODS.has(method)) {
        throw new Error(`The Codex app-server method ${method} is not permitted by this device grant.`);
      }
      const referenced = collectThreadIds(message);
      for (const referencedThreadId of referenced) {
        if (referencedThreadId !== threadId) {
          throw new Error('The office client requested a different Codex thread.');
        }
      }
      if (method && (method.startsWith('thread/') || method.startsWith('turn/')) && referenced.size === 0) {
        throw new Error(`The Codex app-server method ${method} must include the selected thread id.`);
      }
      if (method === 'thread/resume' && policy) {
        message.params = { ...message.params, model: policy.model, serviceTier: policy.serviceTier };
      }
      return message;
    },

    shouldForwardServerMessage(text) {
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_APP_SERVER_MESSAGE_BYTES) {
        return false;
      }
      let message;
      try { message = parseObject(text, 'The Codex app-server message'); }
      catch { return false; }
      for (const referencedThreadId of collectThreadIds(message)) {
        if (referencedThreadId !== threadId) { return false; }
      }
      return true;
    },
  };
}

function writeFrame(output, frame) {
  if (!output.destroyed && output.writable) {
    output.write(`${JSON.stringify(frame)}\n`);
  }
}

function decodeMessageFrame(frame) {
  if (!frame || frame.type !== 'message' || typeof frame.data !== 'string') {
    throw new Error('The office relay sent an invalid frame.');
  }
  if (frame.data.length > Math.ceil(MAX_APP_SERVER_MESSAGE_BYTES * 4 / 3) + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) {
    throw new Error('The office relay sent invalid message data.');
  }
  const text = Buffer.from(frame.data, 'base64').toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_APP_SERVER_MESSAGE_BYTES) {
    throw new Error('The office relay message was too large.');
  }
  return text;
}

async function relayScopedAppServer({ url, threadId, sharedSessionPolicy = null, input, output, errorOutput }) {
  if (!isLoopbackWebSocketUrl(url)) {
    throw new Error('The selected Codex app-server is not a private loopback WebSocket endpoint.');
  }
  if (!input || !output) { throw new TypeError('The scoped relay requires input and output streams.'); }

  const { WebSocket } = require('ws');
  const policy = createThreadRelayPolicy(threadId, sharedSessionPolicy);
  const socket = new WebSocket(url, { maxPayload: MAX_APP_SERVER_MESSAGE_BYTES });
  let pending = '';
  let settled = false;

  return new Promise((resolve, reject) => {
    function finish(error) {
      if (settled) { return; }
      settled = true;
      input.off('data', onInput);
      input.off('end', onInputEnd);
      input.pause?.();
      input.destroy?.();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) { socket.terminate(); }
      if (error) { reject(error); }
      else { resolve(); }
    }

    function fail(error) {
      const message = error instanceof Error ? error.message : String(error);
      writeFrame(output, { type: 'error', message });
      if (errorOutput?.writable) { errorOutput.write(`xcode gateway: ${message}\n`); }
      finish(error instanceof Error ? error : new Error(message));
    }

    function onInput(data) {
      pending += String(data);
      if (pending.length > MAX_APP_SERVER_MESSAGE_BYTES * 2) {
        fail(new Error('The office relay frame was too large.'));
        return;
      }
      while (!settled) {
        const newline = pending.indexOf('\n');
        if (newline < 0) { break; }
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) { continue; }
        try {
          const frame = parseObject(line, 'The office relay frame');
          const text = decodeMessageFrame(frame);
          socket.send(JSON.stringify(policy.acceptClientMessage(text)));
        }
        catch (error) { fail(error); }
      }
    }

    function onInputEnd() { finish(); }

    input.setEncoding('utf8');
    input.on('data', onInput);
    input.on('end', onInputEnd);
    input.on('error', fail);
    socket.on('open', () => writeFrame(output, { type: 'open' }));
    socket.on('message', (data, isBinary) => {
      if (isBinary) { fail(new Error('The Codex app-server sent an unsupported binary message.')); return; }
      const text = data.toString('utf8');
      if (!policy.shouldForwardServerMessage(text)) { return; }
      writeFrame(output, { type: 'message', data: Buffer.from(text, 'utf8').toString('base64') });
    });
    socket.on('error', fail);
    socket.on('close', (code, reason) => {
      if (settled) { return; }
      writeFrame(output, { type: 'close', code, reason: reason.toString('utf8') });
      finish();
    });
  });
}

module.exports = {
  MAX_APP_SERVER_MESSAGE_BYTES,
  createThreadRelayPolicy,
  isLoopbackWebSocketUrl,
  relayScopedAppServer,
};
