'use strict';

const { WebSocket, WebSocketServer } = require('ws');
const { findNativeCodex } = require('./codex-executable');
const { startNativeCodexTerminal } = require('./native-codex-terminal');
const { resolveSessionTitle } = require('./session-title');
const { MAX_APP_SERVER_MESSAGE_BYTES } = require('./scoped-app-server-relay');

const MAX_RELAY_FRAME_BYTES = Math.ceil(MAX_APP_SERVER_MESSAGE_BYTES * 4 / 3) + 1024;
const REMOTE_TRANSPORT_ERROR = 'XCODE_REMOTE_TRANSPORT_ERROR';
const DEFAULT_TRANSPORT_RECOVERY_ATTEMPTS = 2;
const DEFAULT_TRANSPORT_RECOVERY_DELAY_MS = 250;

function remoteTransportError(message) {
  const error = new Error(message || 'The selected-thread gateway lost its remote app-server transport.');
  error.code = REMOTE_TRANSPORT_ERROR;
  return error;
}

function isRemoteTransportMessage(message) {
  return /connection reset without closing handshake|\beconnreset\b|remote app server[\s\S]{0,1024}transport failed/i.test(String(message || ''));
}

function gatewayStartupError(message) {
  const error = message instanceof Error ? message : new Error(String(message || 'The selected-thread gateway stopped before opening the Codex client.'));
  return isRemoteTransportMessage(error.message) ? remoteTransportError(error.message) : error;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function nativeResumeArgs(session, localUrl) {
  const args = ['resume'];
  if (typeof session.model === 'string' && session.model) {
    args.push('--model', session.model);
  }
  if (Object.hasOwn(session, 'serviceTier')) {
    const serviceTier = typeof session.serviceTier === 'string' && session.serviceTier
      ? session.serviceTier
      : 'default';
    args.push('--config', `service_tier=${JSON.stringify(serviceTier)}`);
  }
  args.push('--remote', localUrl, '--no-alt-screen', session.threadId);
  return args;
}

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function waitForGatewayOpen(bridge, onFrame, timeoutMs = 15_000, onRuntimeError = () => {}) {
  return new Promise((resolve, reject) => {
    let pending = '';
    let errors = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Timed out opening the selected Codex thread on the main PC.')), timeoutMs);

    function cleanupBeforeOpen() {
      clearTimeout(timer);
      bridge.off('error', onError);
      bridge.off('exit', onExitBeforeOpen);
    }

    function finish(error) {
      if (settled) { return; }
      settled = true;
      cleanupBeforeOpen();
      if (error) { reject(error); }
      else { resolve({ getErrors: () => errors }); }
    }

    function onError(error) { finish(gatewayStartupError(error)); }
    function onExitBeforeOpen(code) {
      finish(gatewayStartupError(errors.trim() || `The xcode gateway exited ${code} before the Codex client connected.`));
    }

    bridge.stdout.setEncoding('utf8');
    bridge.stderr.setEncoding('utf8');
    bridge.stderr.on('data', (data) => { errors += data; });
    bridge.stdout.on('data', (data) => {
      pending += data;
      if (pending.length > MAX_RELAY_FRAME_BYTES * 2) {
        const error = new Error('The main PC sent an oversized Codex relay frame.');
        if (settled) { onRuntimeError(error); }
        else { finish(error); }
        return;
      }
      while (true) {
        const newline = pending.indexOf('\n');
        if (newline < 0) { break; }
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) { continue; }
        let frame;
        try { frame = JSON.parse(line); }
        catch {
          const error = new Error('The main PC sent an invalid Codex relay frame.');
          if (settled) { onRuntimeError(error); }
          else { finish(error); }
          return;
        }
        if (frame.type === 'open') {
          if (!settled) { finish(); }
          continue;
        }
        try { onFrame(frame); }
        catch (error) {
          if (settled) { onRuntimeError(error); }
          else { finish(error); }
        }
      }
    });
    bridge.once('error', onError);
    bridge.once('exit', onExitBeforeOpen);
  });
}

async function runNativeCodexOfficeSession({
  session,
  openGateway,
  codexExecutable = findNativeCodex({ preferGlobal: false }),
  cwd = process.cwd(),
  env = process.env,
  spawnPty,
  terminalInput = process.stdin,
  terminalOutput = process.stdout,
  recoverSession = async ({ previousSession }) => previousSession,
  transportRecoveryAttempts = DEFAULT_TRANSPORT_RECOVERY_ATTEMPTS,
  transportRecoveryDelayMs = DEFAULT_TRANSPORT_RECOVERY_DELAY_MS,
}) {
  if (!session || typeof session.sessionId !== 'string' || typeof session.threadId !== 'string') {
    throw new TypeError('A native office session requires an active session id and thread id.');
  }
  if (typeof openGateway !== 'function') { throw new TypeError('A native office session requires a gateway adapter.'); }
  if (typeof recoverSession !== 'function') { throw new TypeError('A native office session recovery adapter must be a function.'); }
  if (!Number.isInteger(transportRecoveryAttempts) || transportRecoveryAttempts < 0) {
    throw new RangeError('The transport recovery attempt count must be a non-negative integer.');
  }
  if (!Number.isFinite(transportRecoveryDelayMs) || transportRecoveryDelayMs < 0) {
    throw new RangeError('The transport recovery delay must be a non-negative number.');
  }

  let activeSession = session;
  for (let recoveryAttempt = 0; ; recoveryAttempt += 1) {
    try {
      return await runNativeCodexOfficeSessionAttempt({
        session: activeSession,
        openGateway,
        codexExecutable,
        cwd,
        env,
        spawnPty,
        terminalInput,
        terminalOutput,
      });
    }
    catch (error) {
      if (error?.code !== REMOTE_TRANSPORT_ERROR) { throw error; }
      if (recoveryAttempt >= transportRecoveryAttempts) {
        throw new Error(`The shared Codex transport reset ${recoveryAttempt + 1} times and could not recover: ${error.message}`);
      }
      if (transportRecoveryDelayMs > 0) { await wait(transportRecoveryDelayMs); }
      activeSession = await recoverSession({
        threadId: session.threadId,
        previousSession: activeSession,
        attempt: recoveryAttempt + 1,
      });
      if (!activeSession || typeof activeSession.sessionId !== 'string' || activeSession.sessionId.length === 0 || activeSession.threadId !== session.threadId) {
        throw new Error('The recovered main-PC session did not preserve the selected Codex thread.');
      }
    }
  }
}

async function runNativeCodexOfficeSessionAttempt({
  session,
  openGateway,
  codexExecutable,
  cwd,
  env,
  spawnPty,
  terminalInput,
  terminalOutput,
}) {

  const sockets = new Set();
  const waitingServerMessages = [];
  let localSocket = null;
  let bridge = null;
  let codex = null;
  let shuttingDown = false;
  let rejectRuntimeFailure;
  const runtimeFailure = new Promise((_, reject) => { rejectRuntimeFailure = reject; });
  // This promise intentionally participates only in the race below.
  runtimeFailure.catch(() => {});

  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    maxPayload: MAX_APP_SERVER_MESSAGE_BYTES,
  });

  function sendBridgeFrame(text) {
    if (!bridge || bridge.stdin.destroyed || !bridge.stdin.writable) {
      throw remoteTransportError('The selected-thread gateway is no longer writable.');
    }
    bridge.stdin.write(`${JSON.stringify({ type: 'message', data: Buffer.from(text, 'utf8').toString('base64') })}\n`, (error) => {
      if (error && !shuttingDown) { rejectRuntimeFailure(remoteTransportError(error.message)); }
    });
  }

  function handleGatewayFrame(frame) {
    if (frame.type === 'message' && typeof frame.data === 'string') {
      const text = Buffer.from(frame.data, 'base64').toString('utf8');
      try {
        const message = JSON.parse(text);
        if (message.method === 'thread/name/updated' && message.params?.threadId === session.threadId) {
          codex?.setTitle(resolveSessionTitle(message.params.threadName, session.cwd));
        }
      }
      catch { /* App-server validation remains the native Codex client's responsibility. */ }
      if (localSocket?.readyState === WebSocket.OPEN) { localSocket.send(text); }
      else { waitingServerMessages.push(text); }
      return;
    }
    if (frame.type === 'close') {
      throw remoteTransportError(frame.reason || 'The main Codex app-server connection closed.');
    }
    if (frame.type === 'error') {
      throw gatewayStartupError(frame.message || 'The main PC rejected the Codex relay connection.');
    }
    throw new Error('The main PC sent an unknown Codex relay frame.');
  }

  server.on('connection', (socket) => {
    if (localSocket && localSocket.readyState !== WebSocket.CLOSED) {
      socket.close(1008, 'Only one local Codex client may use this session.');
      return;
    }
    localSocket = socket;
    sockets.add(socket);
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Binary app-server messages are unsupported.');
        return;
      }
      try { sendBridgeFrame(data.toString('utf8')); }
      catch (error) { rejectRuntimeFailure(error); }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      if (localSocket === socket) { localSocket = null; }
    });
    for (const text of waitingServerMessages.splice(0)) { socket.send(text); }
  });

  async function cleanup() {
    if (shuttingDown) { return; }
    shuttingDown = true;
    for (const socket of sockets) { socket.terminate(); }
    if (server.address()) { await new Promise((resolve) => server.close(() => resolve())); }
    if (bridge) {
      bridge.stdin.end();
      if (!bridge.killed) { bridge.kill(); }
    }
  }

  try {
    await waitForListening(server);
    const address = server.address();
    const localUrl = `ws://127.0.0.1:${address.port}`;
    bridge = openGateway(['native', session.sessionId], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    bridge.stdin.on('error', (error) => {
      if (!shuttingDown) { rejectRuntimeFailure(remoteTransportError(error.message)); }
    });
    const gateway = await waitForGatewayOpen(bridge, handleGatewayFrame, 15_000, rejectRuntimeFailure);
    bridge.on('error', (error) => rejectRuntimeFailure(remoteTransportError(error.message)));
    bridge.on('exit', (code) => {
      if (!shuttingDown) {
        rejectRuntimeFailure(remoteTransportError(gateway.getErrors().trim() || `The selected-thread gateway exited ${code}.`));
      }
    });

    codex = startNativeCodexTerminal({
      file: codexExecutable,
      args: nativeResumeArgs(session, localUrl),
      cwd,
      env,
      ...(spawnPty ? { spawnPty } : {}),
      input: terminalInput,
      output: terminalOutput,
      initialTitle: resolveSessionTitle(session.title, session.cwd),
    });
    const result = await Promise.race([codex.completed, runtimeFailure]);
    return result.code;
  }
  finally {
    codex?.stop();
    await cleanup();
  }
}

module.exports = { runNativeCodexOfficeSession, waitForGatewayOpen };
