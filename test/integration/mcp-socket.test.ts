import { expect, test } from 'bun:test';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import {
  BrowserMcpSocketClientTransport,
  startBrowserMcpSocketServer,
  type BrowserMcpSocketServer,
} from '../../src/mcp/socket.js';
import { fixtureServer } from '../fixtures/server.js';
import { recordWire, forbiddenAutomaticCommands } from '../fixtures/wire.js';
import { poll } from '../../src/utils.js';

const token = 'a'.repeat(40),
  bob = 'b'.repeat(40);
async function clientFor(
  server: BrowserMcpSocketServer,
  version = '2026-07-28',
  leaseId?: string,
  secret = token,
) {
  const transport = new BrowserMcpSocketClientTransport({
    path: server.path,
    token: secret,
    leaseId,
  });
  const client = new Client(
    { name: 'untrusted-name', version: '1' },
    {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: { pin: version } },
    },
  );
  await client.connect(transport);
  return { client, transport };
}
function data<T = Record<string, unknown>>(result: CallToolResult): T {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as T;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return data(await client.callTool({ name, arguments: args }));
}
for (const version of ['2026-07-28']) {
  test(`socket ${version}: official client, Unicode, refs, PNG, reconnect and principal isolation`, async () => {
    const fixture = fixtureServer(),
      audit = recordWire('pipe');
    const server = await startBrowserMcpSocketServer({
      tokens: { [token]: 'alice', [bob]: 'bob' },
      browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1', transport: 'pipe' } },
    });
    let current: Client | undefined;
    try {
      const first = await clientFor(server, version);
      current = first.client;
      expect(current.getNegotiatedProtocolVersion()).toBe(version);
      expect((await current.listTools()).tools).toHaveLength(26);
      expect(server.manager.stats().browsers).toBe(0);
      const { tabId } = await call(current, 'browser_open', { url: fixture.base + '/mcp' });
      const found = await call(current, 'browser_find', { tabId, selector: '#name' });
      const ref = (found.elements as { ref: string }[])[0]!.ref;
      await call(current, 'browser_fill', { tabId, ref, text: 'socket 中文😀' });
      expect(
        await call(current, 'browser_evaluate', {
          tabId,
          script:
            'await Promise.resolve(); return { text: document.querySelector("#name").value, arg };',
          arg: '脚本😀',
        }),
      ).toEqual({ type: 'json', value: { text: 'socket 中文😀', arg: '脚本😀' } });
      expect(JSON.stringify(await call(current, 'browser_snapshot', { tabId }))).toContain(
        'socket 中文😀',
      );
      const png = (await current.callTool({ name: 'browser_screenshot', arguments: { tabId } }))
        .content[0]!;
      expect(png.type).toBe('image');
      if (png.type === 'image')
        expect(Buffer.from(png.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
      await expect(clientFor(server, version, first.transport.leaseId, bob)).rejects.toThrow();
      await current.close();
      const resumed = await clientFor(server, version, first.transport.leaseId);
      current = resumed.client;
      await call(current, 'browser_fill', { tabId, ref, text: 'reconnected' });
      expect(JSON.stringify(await current.readResource({ uri: 'browser://state' }))).toContain(
        String(tabId),
      );
      await call(current, 'browser_navigate', { tabId, url: fixture.base + '/empty' });
      expect(
        (await current.callTool({ name: 'browser_fill', arguments: { tabId, ref, text: 'stale' } }))
          .isError,
      ).toBeTrue();
      expect(audit.messages.filter((m) => forbiddenAutomaticCommands.includes(m.method))).toEqual(
        [],
      );
      await current.close();
      current = undefined;
      await server.manager.release('alice', first.transport.leaseId!);
      expect(server.manager.stats().allocations).toBe(0);
    } finally {
      await current?.close();
      await server.close();
      fixture.server.stop(true);
      audit.restore();
    }
    expect(server.manager.stats().browsers).toBe(0);
  });
}

for (const version of ['2026-07-28'])
  test(`socket ${version}: cancellation and EOF stop pending actions, preserve the lease and drain locks`, async () => {
    const fixture = fixtureServer();
    const server = await startBrowserMcpSocketServer({
      browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' } },
      tokens: { [token]: 'alice' },
    });
    let client: Client | undefined;
    try {
      const first = await clientFor(server, version);
      client = first.client;
      const { tabId } = await call(client, 'browser_open', { url: fixture.base + '/mcp' });
      const session = server.manager.session('alice', first.transport.leaseId!);
      const abort = new AbortController();
      const wait = client
        .callTool(
          { name: 'browser_wait', arguments: { tabId, selector: '#never', timeout: 10000 } },
          { signal: abort.signal },
        )
        .catch((e) => e);
      await poll(async () => (session.status().queuedOperations > 0 ? true : undefined), {
        timeout: 1000,
      });
      abort.abort();
      expect(await wait).toBeInstanceOf(Error);
      await poll(async () => (session.status().queuedOperations === 0 ? true : undefined), {
        timeout: 2000,
      });
      const found = await call(client, 'browser_find', { tabId, selector: '#name' });
      const ref = (found.elements as { ref: string }[])[0]!.ref;
      const pending = call(client, 'browser_wait', {
        tabId,
        selector: '#never',
        timeout: 10000,
      }).catch((e) => e);
      await poll(async () => (session.status().queuedOperations > 0 ? true : undefined), {
        timeout: 1000,
      });
      const queued = call(client, 'browser_fill', { tabId, ref, text: 'must not run' }).catch(
        (e) => e,
      );
      await poll(async () => (session.status().queuedOperations > 1 ? true : undefined), {
        timeout: 1000,
      });
      await client.close();
      await pending;
      await queued;
      await poll(async () => (session.status().queuedOperations === 0 ? true : undefined), {
        timeout: 2000,
      });
      const next = await clientFor(server, version, first.transport.leaseId);
      client = next.client;
      expect(JSON.stringify(await call(client, 'browser_snapshot', { tabId }))).not.toContain(
        'must not run',
      );
      await call(client, 'browser_fill', { tabId, ref, text: 'after cancel' });
      expect(JSON.stringify(await call(client, 'browser_snapshot', { tabId }))).toContain(
        'after cancel',
      );
    } finally {
      await client?.close();
      await server.close();
      fixture.server.stop(true);
    }
  });

for (const version of ['2026-07-28'])
  test(`socket ${version}: scoped subscription and progress on the SDK byte stream`, async () => {
    const server = await startBrowserMcpSocketServer({
      browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' } },
      tokens: { [token]: 'alice', [bob]: 'bob' },
    });
    const first = await clientFor(server, version),
      other = await clientFor(server, version, undefined, bob);
    try {
      let updates = 0;
      first.client.setNotificationHandler('notifications/resources/updated', () => {
        updates++;
      });
      const subscription = await first.client.listen({
        resourceSubscriptions: ['browser://state'],
      });
      const progress: number[] = [];
      await first.client.callTool(
        { name: 'browser_open', arguments: {} },
        {
          onprogress: (event) => {
            progress.push(event.progress);
          },
        },
      );
      await poll(async () => (updates > 0 ? true : undefined), { timeout: 2000 });
      await poll(async () => (progress.length === 3 ? true : undefined), { timeout: 2000 });
      expect(progress).toEqual([0, 1, 2]);
      const before = updates;
      await call(other.client, 'browser_open');
      await Bun.sleep(50);
      expect(updates).toBe(before);
      await subscription?.close();
    } finally {
      await first.client.close();
      await other.client.close();
      await server.close();
    }
  });

test('socket pending-request and output limits close the exchange without unbounded queues', async () => {
  const fixture = fixtureServer();
  const server = await startBrowserMcpSocketServer({
    browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' } },
    tokens: { [token]: 'alice' },
    maxRequestsPerConnection: 1,
  });
  const { client } = await clientFor(server);
  try {
    const { tabId } = await call(client, 'browser_open', { url: fixture.base + '/mcp' });
    const waiting = call(client, 'browser_wait', {
      tabId,
      selector: '#never',
      timeout: 10000,
    }).catch((e) => e);
    await Bun.sleep(50);
    const failure = call(client, 'browser_fill', { tabId, ref: 'unused', text: 'unused' }).catch(
      (e) => e,
    );
    expect(await failure).toBeInstanceOf(Error);
    expect(await waiting).toBeInstanceOf(Error);
  } finally {
    await client.close();
    await server.close();
    fixture.server.stop(true);
  }
  const limited = await startBrowserMcpSocketServer({
    browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' } },
    tokens: { [token]: 'alice' },
    maxOutputBufferSize: 4096,
  });
  let small: Client | undefined;
  try {
    small = (await clientFor(limited)).client;
    await expect(small.listTools()).rejects.toThrow();
    expect(limited.manager.stats().browsers).toBe(0);
  } finally {
    await small?.close();
    await limited.close();
  }
});

test('socket rejects oversized messages and closes clients when their lease retires', async () => {
  const server = await startBrowserMcpSocketServer({
    browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' } },
    tokens: { [token]: 'alice' },
    maxMessageSize: 4096,
  });
  try {
    const { client, transport } = await clientFor(server);
    const failure = client
      .callTool({
        name: 'browser_open',
        arguments: { url: 'http://localhost/' + 'x'.repeat(5000) },
      })
      .catch((e) => e);
    expect(await failure).toBeInstanceOf(Error);
    expect(server.manager.stats().browsers).toBe(0);
    await client.close();
    const next = await clientFor(server, '2026-07-28', transport.leaseId);
    let closed = false;
    next.client.onclose = () => {
      closed = true;
    };
    await server.manager.release('alice', transport.leaseId!);
    await poll(async () => (closed ? true : undefined), { timeout: 1000 });
    expect(server.manager.stats().leases).toBe(0);
    await next.client.close();
  } finally {
    await server.close();
  }
});
