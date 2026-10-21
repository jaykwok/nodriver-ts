// Diagnostic for SDK 2.3.1 notification/result dispatch, independent of Chrome or this server.
// Prints callback behavior for coalesced and separated delivery without patching the SDK.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
for (const split of [false, true]) {
  const progress = [],
    wire = [],
    errors = [];
  const transport = {
    async start() {},
    async close() {
      this.onclose?.();
    },
    async send(message) {
      if (message.method === 'initialize')
        this.onmessage({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'controlled-wire', version: '1' },
          },
        });
      if (message.method !== 'tools/call') return;
      for (const value of [0, 1, 2]) {
        wire.push(value);
        this.onmessage({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: message.params._meta.progressToken, progress: value, total: 2 },
        });
        if (split) await new Promise(setImmediate);
      }
      wire.push('result');
      this.onmessage({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'ok' }] },
      });
    },
  };
  const client = new Client(
    { name: 'probe', version: '1' },
    { supportedProtocolVersions: ['2025-11-25'], versionNegotiation: { mode: 'legacy' } },
  );
  client.onerror = (error) => errors.push(error.message);
  await client.connect(transport);
  await client.callTool(
    { name: 'test', arguments: {} },
    { onprogress: (update) => progress.push(update.progress) },
  );
  await new Promise(setImmediate);
  assert.deepEqual(wire, [0, 1, 2, 'result']);
  console.log(JSON.stringify({ split, wire, callbacks: progress, errors }));
  await client.close();
}
