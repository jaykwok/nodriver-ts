import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import { legacyOnlyTransport } from '../../src/mcp/protocol.ts';
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
