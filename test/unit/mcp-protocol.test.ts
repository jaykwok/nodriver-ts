import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  JSONRPCMessage,
  ScopeChallengeHandler,
  Transport,
} from '@modelcontextprotocol/server';
import {
  GatedTransport,
  MCP_PROTOCOL_VERSION,
  legacyOnlyTransport,
  modernOnlyTransport,
} from '../../src/mcp/protocol.ts';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('legacy boundary requires completed handshake and rejects mixed-era envelopes', async () => {
  const sent: JSONRPCMessage[] = [],
    received: JSONRPCMessage[] = [];
  const raw: Transport = {
    async start() {},
    async close() {},
    async send(message) {
      sent.push(message);
    },
  };
  const guarded = legacyOnlyTransport(raw);
  guarded.onmessage = (message) => {
    received.push(message);
  };
  const deliver = (message: JSONRPCMessage) => raw.onmessage!(message);
  deliver({ jsonrpc: '2.0', method: 'notifications/initialized' });
  deliver({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(received.length, 0);
  assert.equal(sent.length, 1);
  deliver({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' },
  });
  deliver({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
  deliver({ jsonrpc: '2.0', method: 'notifications/initialized' });
  deliver({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.equal(received.length, 1);
  await guarded.send({ jsonrpc: '2.0', id: 2, result: {} });
  deliver({ jsonrpc: '2.0', method: 'notifications/initialized' });
  deliver({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  assert.equal(received.length, 3);
  deliver({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
  });
  assert.equal(received.length, 3);
  // Cancellation and server-request responses still reach the SDK on the same connection.
  deliver({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } });
  deliver({ jsonrpc: '2.0', id: 'elicitation', result: { action: 'decline' } });
  assert.equal(received.length, 5);
  deliver({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} });
  assert.equal(received.length, 5);
});

test('compatibility CLI rejects the custom socket transport', () => {
  const cli = fileURLToPath(new URL('../../src/mcp/cli.ts', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [cli, '--mcp-transport', 'socket', '--socket-path', 'test', '--mcp-compat'],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stdio|HTTP/);
});

test('legacy boundary answers ping during initialization', () => {
  const received: JSONRPCMessage[] = [];
  const raw: Transport = { async start() {}, async close() {}, async send() {} };
  const guarded = legacyOnlyTransport(raw);
  guarded.onmessage = (message) => {
    received.push(message);
  };
  raw.onmessage!({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(received.length, 1);
});

test('CLI rejects a missing value and options for another transport', () => {
  const cli = fileURLToPath(new URL('../../src/mcp/cli.ts', import.meta.url));
  for (const [args, message] of [
    [['--executable', '--headless'], /Missing value for --executable/],
    [['--port', '9000'], /--port requires --mcp-transport http/],
    [['constructor', '5'], /Unknown option or invalid value: constructor/],
    [['--mcp-transport', 'http', '--socket-path', 'x'], /--socket-path requires/],
  ] as const) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

function rawTransport(overrides: Partial<Transport> = {}) {
  const sent: Array<[JSONRPCMessage, unknown]> = [];
  const raw: Transport = {
    async start() {},
    async close() {},
    async send(message, options) {
      sent.push([message, options]);
    },
    ...overrides,
  };
  return { raw, sent };
}

test('the gated transport forwards the transport surface and defines optional methods only when present', async () => {
  const calls: unknown[] = [];
  const { raw, sent } = rawTransport({
    sessionId: 'session',
    hasPerRequestStream: true,
    async start() {
      calls.push('start');
    },
    async close() {
      calls.push('close');
    },
    setProtocolVersion(version) {
      calls.push(version);
    },
    setSupportedProtocolVersions(versions) {
      calls.push(versions);
    },
  });
  const resolver: ScopeChallengeHandler = async () => undefined;
  (raw as any).setScopeChallengeResolver = (value: unknown) => calls.push(value);
  const guarded = new GatedTransport(raw);
  assert.equal(guarded.sessionId, 'session');
  assert.equal(guarded.hasPerRequestStream, true);
  await guarded.start();
  await guarded.close();
  const options = { relatedRequestId: 1 };
  await guarded.send({ jsonrpc: '2.0', method: 'x' }, options);
  assert.strictEqual(sent[0]![1], options);
  guarded.setProtocolVersion!('2025-11-25');
  guarded.setSupportedProtocolVersions!(['2025-11-25']);
  guarded.setScopeChallengeResolver!(resolver);
  assert.deepEqual(calls, ['start', 'close', '2025-11-25', ['2025-11-25'], resolver]);
  // The session ID appears later on a stateful transport.
  raw.sessionId = 'later';
  assert.equal(guarded.sessionId, 'later');

  // The SDK feature-tests these by presence.
  const bare = new GatedTransport(rawTransport().raw);
  for (const name of [
    'setProtocolVersion',
    'setSupportedProtocolVersions',
    'setScopeChallengeResolver',
  ])
    assert.equal(name in bare, false, name);
  assert.equal(bare.sessionId, undefined);
  assert.equal(bare.hasPerRequestStream, undefined);
});

test('the gated transport chains callbacks the way Protocol.connect does', () => {
  const order: string[] = [];
  const { raw } = rawTransport({
    onclose: () => order.push('inner close'),
    onerror: () => order.push('inner error'),
    onmessage: () => order.push('inner message'),
  });
  const guarded = new GatedTransport(raw, undefined, () => order.push('closed'));
  guarded.onclose = () => order.push('sdk close');
  guarded.onerror = () => order.push('sdk error');
  guarded.onmessage = () => order.push('sdk message');
  raw.onmessage!({ jsonrpc: '2.0', method: 'x' });
  raw.onerror!(new Error('x'));
  raw.onclose!();
  assert.deepEqual(order, [
    'inner message',
    'sdk message',
    'inner error',
    'sdk error',
    'inner close',
    'sdk close',
    'closed',
  ]);
  // The closed hook and the SDK callback run even when an earlier callback throws.
  const later: string[] = [];
  const { raw: failing } = rawTransport({
    onclose: () => {
      throw new Error('inner failure');
    },
  });
  const decorated = new GatedTransport(failing, undefined, () => later.push('closed'));
  decorated.onclose = () => {
    later.push('sdk close');
    throw new Error('sdk failure');
  };
  assert.throws(() => failing.onclose!(), /sdk failure/);
  assert.deepEqual(later, ['sdk close', 'closed']);
});

test('a gate observes sends and answers rejected requests; a failed answer reaches onerror', async () => {
  const failure = new Error('Wire closed');
  const observed: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  const { raw } = rawTransport({
    onerror: (error) => errors.push(error),
    send: async () => {
      throw failure;
    },
  });
  const guarded = new GatedTransport(raw, {
    receive: () => ({ code: -32600, message: 'Refused', data: { why: 'test' } }),
    sent: (message) => observed.push(message),
  });
  guarded.onerror = (error) => errors.push(error);
  const received: JSONRPCMessage[] = [];
  guarded.onmessage = (message) => {
    received.push(message);
  };
  raw.onmessage!({ jsonrpc: '2.0', method: 'dropped' });
  assert.deepEqual(errors, []);
  raw.onmessage!({ jsonrpc: '2.0', id: 1, method: 'refused' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, []);
  assert.deepEqual(errors, [failure, failure]);
  const message: JSONRPCMessage = { jsonrpc: '2.0', id: 2, result: {} };
  await assert.rejects(guarded.send(message), failure);
  assert.deepEqual(observed, [message]);

  // The answer leaves synchronously, inside the transport's dispatch window.
  const { raw: direct, sent } = rawTransport();
  new GatedTransport(direct, { receive: () => ({ code: -32600, message: 'Refused' }) });
  direct.onmessage!({ jsonrpc: '2.0', id: 3, method: 'refused' });
  assert.deepEqual(sent[0]![0], {
    jsonrpc: '2.0',
    id: 3,
    error: { code: -32600, message: 'Refused' },
  });
});

test('the modern boundary answers with the same codes', () => {
  const { raw, sent } = rawTransport();
  const closed: string[] = [];
  const guarded = modernOnlyTransport(raw, () => closed.push('closed'));
  const received: JSONRPCMessage[] = [];
  guarded.onmessage = (message) => {
    received.push(message);
  };
  const meta = (version: string) => ({
    _meta: { 'io.modelcontextprotocol/protocolVersion': version },
  });
  const deliver = (message: Record<string, unknown>) =>
    raw.onmessage!({ jsonrpc: '2.0', ...message } as JSONRPCMessage);
  deliver({ id: 1, method: 'tools/list', params: meta(MCP_PROTOCOL_VERSION) });
  deliver({ method: 'notifications/cancelled', params: { requestId: 1 } });
  deliver({ id: 'server-request', result: {} });
  assert.equal(received.length, 3);
  assert.equal(sent.length, 0);
  deliver({ id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  deliver({ id: 3, method: 'initialize', params: meta(MCP_PROTOCOL_VERSION) });
  deliver({ id: 4, method: 'tools/list', params: meta('2025-11-25') });
  deliver({ id: 5, method: 'tools/list' });
  assert.equal(received.length, 3);
  const errors = sent.map(([message]) => (message as { error: any }).error);
  assert.deepEqual(
    errors.map((error) => [error.code, error.data]),
    [
      [-32022, { supported: [MCP_PROTOCOL_VERSION], requested: '2025-11-25' }],
      [-32022, { supported: [MCP_PROTOCOL_VERSION], requested: 'unknown' }],
      [-32022, { supported: [MCP_PROTOCOL_VERSION], requested: '2025-11-25' }],
      [-32602, { supported: [MCP_PROTOCOL_VERSION], requested: 'unknown' }],
    ],
  );
  raw.onclose!();
  assert.deepEqual(closed, ['closed']);
});

test('the legacy boundary reopens initialization after a failed answer and reports closing', async () => {
  const { raw, sent } = rawTransport();
  const closed: string[] = [];
  const guarded = legacyOnlyTransport(raw, () => closed.push('closed'));
  const received: JSONRPCMessage[] = [];
  guarded.onmessage = (message) => {
    received.push(message);
  };
  const deliver = (message: Record<string, unknown>) =>
    raw.onmessage!({ jsonrpc: '2.0', ...message } as JSONRPCMessage);
  deliver({ id: 1, method: 'initialize', params: {} });
  await guarded.send({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid' } });
  deliver({ method: 'notifications/initialized' });
  assert.equal(received.length, 1);
  deliver({ id: 2, method: 'initialize', params: {} });
  assert.equal(received.length, 2);
  await guarded.send({ jsonrpc: '2.0', id: 2, result: {} });
  deliver({ method: 'notifications/initialized' });
  assert.equal(received.length, 3);
  // Rejection codes stay JSON-RPC invalid request.
  deliver({ id: 3, method: 'initialize', params: {} });
  const refusal = sent.at(-1)![0] as { id: number; error: { code: number } };
  assert.equal(refusal.id, 3);
  assert.equal(refusal.error.code, -32600);
  raw.onclose!();
  assert.deepEqual(closed, ['closed']);
});
