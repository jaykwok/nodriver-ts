import { test } from 'node:test';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect } from '../fixtures/expect.ts';
import { fixtureServer } from '../fixtures/server.ts';
import { startBrowserMcpHttpServer } from '../../src/mcp/http.ts';
import { createBrowserMcpServer } from '../../src/mcp/server.ts';
import { poll } from '../../src/utils.ts';

test('a remote handoff shows real frames and clicks the real page', async () => {
  const fixture = await fixtureServer();
  const http = await startBrowserMcpHttpServer({
    port: 0,
    tokens: { ['z'.repeat(32)]: 'alice' },
    browser: {
      launch: { headless: process.env.NODRIVER_HEADFUL !== '1' },
      remoteHandoff: { linkInResult: true },
    },
  });
  const leaseId = http.manager.create('alice').id;
  const server = createBrowserMcpServer(
    {},
    { manager: http.manager, principal: 'alice', leaseId, handoffOrigin: () => http.url },
  );
  const client = new Client(
    { name: 'handoff', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (reply.isError) throw new Error(JSON.stringify(reply.content));
    return reply.structuredContent as any;
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await server.connect(b);
    await client.connect(a);
    const { tabId } = await call('browser_open', { url: fixture.base + '/page' });
    const box = (
      await call('browser_evaluate', {
        tabId,
        script:
          "const r = document.querySelector('#button').getBoundingClientRect(); return { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight };",
      })
    ).result as { x: number; y: number };
    const { url, handoffId } = await call('browser_handoff', { tabId, mode: 'remote' });
    const opened = await fetch(url);
    expect(opened.status).toBe(200);
    const cookie = opened.headers.get('set-cookie')!.split(';')[0]!;
    const path = `${http.url}/handoff/${handoffId}`;
    const stream = await fetch(`${path}/frames`, { headers: { cookie } });
    expect(stream.status).toBe(200);
    reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: frame')) {
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      text += decoder.decode(value);
    }
    const post = (segment: string, body?: unknown) =>
      fetch(`${path}/${segment}`, {
        method: 'POST',
        headers: { cookie, origin: http.url, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    const click = { kind: 'mouse', ...box, button: 'left', clickCount: 1 };
    expect((await post('input', { ...click, action: 'down', buttons: 1 })).status).toBe(204);
    expect((await post('input', { ...click, action: 'up' })).status).toBe(204);
    expect((await post('done')).status).toBe(204);
    expect(await call('browser_handoff_wait', { handoffId })).toMatchObject({
      state: 'ended',
      reason: 'completed',
    });
    await poll(
      async () =>
        (await call('browser_evaluate', { tabId, script: 'return globalThis.clicks' })).result === 1
          ? true
          : undefined,
      { timeout: 5000 },
    );
  } finally {
    await reader?.cancel().catch(() => {});
    await client.close().catch(() => {});
    await http.close();
    await fixture.server.stop();
  }
});
