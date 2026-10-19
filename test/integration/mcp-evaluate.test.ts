import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  createBrowserMcpServer,
  BrowserSessionManager,
  MCP_PROTOCOL_VERSION,
} from '../../src/mcp/server.ts';
import { fixtureServer } from '../fixtures/server.ts';
import { recordWire, forbiddenAutomaticCommands } from '../fixtures/wire.ts';
import { poll } from '../../src/utils.ts';

function data(reply: CallToolResult): Record<string, any> {
  if (reply.isError) throw new Error(JSON.stringify(reply.structuredContent ?? reply.content));
  expect(reply.isError).not.toBe(true);
  return reply.structuredContent as Record<string, any>;
}
for (const transport of ['pipe', 'websocket'] as const) {
  test(`MCP evaluate ${transport}: JSON, failures, deadlines, cancellation and lease boundaries without Runtime.enable`, async () => {
    const fixture = await fixtureServer();
    const wire = recordWire(transport);
    const manager = new BrowserSessionManager({
      launch: { transport, headless: process.env.NODRIVER_HEADFUL !== '1' },
    });
    const first = manager.create('first'),
      second = manager.create('second');
    const server = createBrowserMcpServer({}, { manager, principal: 'first', leaseId: first.id });
    const otherServer = createBrowserMcpServer(
      {},
      { manager, principal: 'second', leaseId: second.id },
    );
    const client = new Client(
      { name: 'script-test', version: '1' },
      { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
    );
    const other = new Client(
      { name: 'other-script-test', version: '1' },
      { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
    );
    const [a, b] = InMemoryTransport.createLinkedPair(),
      [c, d] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(b);
      await client.connect(a);
      await otherServer.connect(d);
      await other.connect(c);
      const { tabId } = data(
        await client.callTool({ name: 'browser_open', arguments: { url: fixture.base + '/mcp' } }),
      );
      const run = (script: string, extra: Record<string, unknown> = {}) =>
        client.callTool({ name: 'browser_evaluate', arguments: { tabId, script, ...extra } });
      const arg = JSON.parse(
        '{"__proto__":{"kept":true},"quote":"\\\" ); globalThis.injected = true; //", "text":"中文😀"}',
      );
      expect(data(await run('return arg;', { arg }))).toEqual({ type: 'json', value: arg });
      expect(
        data(
          await run(
            'return { injected: typeof injected, bun: typeof Bun, process: typeof process, require: typeof require };',
          ),
        ).value,
      ).toEqual({
        injected: 'undefined',
        bun: 'undefined',
        process: 'undefined',
        require: 'undefined',
      });
      expect(data(await run('return;'))).toEqual({ type: 'undefined' });
      expect(data(await run('return null;'))).toEqual({ type: 'json', value: null });
      expect(data(await run('return [1, true, { x: "ok" }];')).value).toEqual([
        1,
        true,
        { x: 'ok' },
      ]);
      expect(data(await run('return await Promise.resolve(arg + 1);', { arg: 41 })).value).toBe(42);
      for (const script of [
        'return 1n;',
        'const x = {}; x.self = x; return x;',
        'return () => 1;',
        'return "x".repeat(262145);',
        'return (;',
        'globalThis.scriptOnce = (globalThis.scriptOnce || 0) + 1; throw new Error("intentional");',
      ])
        expect((await run(script)).isError).toBe(true);
      expect(data(await run('return scriptOnce;')).value).toBe(1);
      for (const extra of [
        { frameId: 'unknown' },
        { world: 'invalid' },
        { timeout: 0 },
        { script: 'x'.repeat(32769) },
        { arg: 'x'.repeat(32769) },
        { unexpected: true },
      ])
        expect((await run('globalThis.invalidRan = true;', extra)).isError).toBe(true);
      expect(data(await run('return typeof invalidRan;')).value).toBe('undefined');
      expect(
        (
          await other.callTool({
            name: 'browser_evaluate',
            arguments: { tabId, script: 'globalThis.wrongLease = true;' },
          })
        ).isError,
      ).toBe(true);
      expect(data(await run('return typeof wrongLease;')).value).toBe('undefined');
      // CDP's execution deadline stops this synchronous loop. A host timeout
      // alone would leave the renderer hung and the next evaluation would fail.
      expect((await run('while (true) {}', { timeout: 150 })).isError).toBe(true);
      expect(data(await run('return 7;', { timeout: 2000 })).value).toBe(7);
      expect((await run('await new Promise(() => {});', { timeout: 100 })).isError).toBe(true);
      const controller = new AbortController();
      const script = '/* cancel-script-probe */ await new Promise(() => {});';
      const pending = client.callTool(
        { name: 'browser_evaluate', arguments: { tabId, script, timeout: 1000 } },
        { signal: controller.signal },
      );
      const cancelled = pending.then(
        () => false,
        () => true,
      );
      await poll(
        async () =>
          wire.messages.some(
            (m) =>
              m.method === 'Runtime.evaluate' &&
              String(m.params?.expression).includes('cancel-script-probe'),
          ) || undefined,
        { timeout: 2000 },
      );
      controller.abort(new Error('script caller cancelled'));
      expect(await cancelled).toBe(true);
      expect(data(await run('return 9;')).value).toBe(9);
      expect(wire.messages.filter((m) => forbiddenAutomaticCommands.includes(m.method))).toEqual(
        [],
      );
      expect(
        wire.messages.some((m) => m.method === 'Runtime.evaluate' && m.params?.timeout === 150),
      ).toBe(true);
    } finally {
      await client.close();
      await other.close();
      await server.close();
      await otherServer.close();
      await manager.close();
      await fixture.server.stop();
      wire.restore();
    }
  });
}
