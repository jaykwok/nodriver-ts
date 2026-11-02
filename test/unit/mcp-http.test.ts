import { createServer } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { expect } from '../fixtures/expect.ts';
import { createBrowserMcpHttpService, startBrowserMcpHttpServer } from '../../src/mcp/http.ts';
import { BrowserSessionManager } from '../../src/mcp/manager.ts';
import { requestPort } from '../../src/mcp/serve.ts';

const token = 's'.repeat(40);
const tokens = { [token]: 'alice' };
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const post = (path: string, body: BodyInit, more: RequestInit = {}) =>
  new Request(`http://127.0.0.1:3100${path}`, {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
    ...more,
  } as RequestInit);
const initialize = (id: number, meta?: Record<string, unknown>) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
      ...(meta ? { _meta: meta } : {}),
    },
  });

test('a request without a port addresses the default HTTP port', () => {
  expect(requestPort(new Request('http://127.0.0.1/mcp'))).toBe('80');
  expect(requestPort(new Request('http://127.0.0.1:80/mcp'))).toBe('80');
  expect(requestPort(new Request('http://127.0.0.1:3100/mcp'))).toBe('3100');
});

test('a failed start closes only a manager the service created', async (t) => {
  const occupied = createServer().listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => void occupied.close());
  const { port } = occupied.address() as { port: number };
  const closes = t.mock.method(BrowserSessionManager.prototype, 'close');

  await expect(startBrowserMcpHttpServer({ tokens, port, browser: {} })).rejects.toThrow(
    'EADDRINUSE',
  );
  expect(closes.mock.callCount()).toBe(1);

  closes.mock.resetCalls();
  const manager = new BrowserSessionManager();
  t.after(() => manager.close());
  await expect(startBrowserMcpHttpServer({ tokens, port, manager })).rejects.toThrow('EADDRINUSE');
  expect(closes.mock.callCount()).toBe(0);
  expect(manager.retired.size).toBe(0);
  expect(manager.create('alice').principal).toBe('alice');
});

test('closing continues past a failed endpoint and closes the manager and the listener', async (t) => {
  const errors: Error[] = [];
  const server = await startBrowserMcpHttpServer({
    tokens,
    port: 0,
    compatibility: true,
    onError: (error) => errors.push(error),
  });
  const opened = await server.fetch(
    new Request(`${server.url}/mcp/compat`, {
      method: 'POST',
      headers,
      body: initialize(1),
    }),
  );
  expect(opened.status).toBe(200);
  await opened.text();
  const failure = new Error('Endpoint did not close');
  t.mock.method(McpServer.prototype, 'close', async () => {
    throw failure;
  });
  await expect(server.close()).rejects.toBe(failure);
  expect(() => server.manager.create('alice')).toThrow('stopping');
  await expect(fetch(`${server.url}/leases`)).rejects.toThrow();
});

test('DELETE /leases tells an unknown lease from a failed release and keeps the cause', async (t) => {
  const errors: Error[] = [];
  const manager = new BrowserSessionManager();
  const service = createBrowserMcpHttpService({
    tokens,
    manager,
    onError: (error) => errors.push(error),
  });
  t.after(() => service.close());
  const remove = (id: string) =>
    service.fetch(new Request(`http://127.0.0.1:3100/leases/${id}`, { method: 'DELETE', headers }));
  expect((await remove('unknown')).status).toBe(404);
  expect(errors).toEqual([]);

  const { id } = manager.create('alice');
  const failure = new Error('Browser did not close');
  t.mock.method(manager.session('alice', id), 'dispose', async () => {
    throw failure;
  });
  const failed = await remove(id);
  expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({ error: 'Lease release failed' });
  expect(errors).toHaveLength(1);
  expect(errors[0]!.cause).toBe(failure);
});

test('a failed body read keeps its cause, and a parse error never reaches diagnostics', async (t) => {
  const errors: Error[] = [];
  const service = createBrowserMcpHttpService({ tokens, onError: (error) => errors.push(error) });
  t.after(() => service.close());
  const malformed = await service.fetch(post('/leases', '{"raw client bytes'));
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: 'Invalid JSON body' });
  expect(errors).toEqual([]);

  const failure = new Error('Connection lost');
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure);
    },
  });
  const response = await service.fetch(post('/leases', broken));
  expect(response.status).toBe(400);
  expect(errors).toHaveLength(1);
  expect(errors[0]!.message).toBe('Reading a request body failed');
  expect(errors[0]!.cause).toBe(failure);
  expect(service.manager.stats().leases).toBe(0);
});

test('a compatibility initialize that fails frees its session slot', async (t) => {
  const service = createBrowserMcpHttpService({
    tokens,
    compatibility: true,
    maxCompatibilitySessionsPerLease: 1,
  });
  t.after(() => service.close());
  // The legacy boundary answers a modern envelope with a JSON-RPC error inside a 200 stream.
  const envelope = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
  for (let id = 1; id <= 3; id++) {
    const refused = await service.fetch(post('/mcp/compat', initialize(id, envelope)));
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain('Modern envelopes belong to the modern MCP endpoint');
    await tick();
  }
  const accepted = await service.fetch(post('/mcp/compat', initialize(4)));
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get('mcp-session-id')).toBeTruthy();
  expect(await accepted.text()).toContain('"protocolVersion"');
  // A negotiated session keeps its slot after the exchange.
  await tick();
  expect((await service.fetch(post('/mcp/compat', initialize(5)))).status).toBe(429);
});
