import { removeTree } from '../../src/utils.js';
import { expect, test, spyOn } from 'bun:test';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { startBrowserMcpHttpServer, type BrowserMcpHttpServer } from '../../src/mcp/http.js';
import { BrowserSessionManager, createBrowserMcpServer } from '../../src/mcp/server.js';
import { Browser } from '../../src/index.js';
import { BrowserProcess } from '../../src/browser/launcher.js';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureServer } from '../fixtures/server.js';
import { recordWire, forbiddenAutomaticCommands } from '../fixtures/wire.js';
import { poll } from '../../src/utils.js';

const alice = 'a'.repeat(40),
  bob = 'b'.repeat(40);
const tokens = { [alice]: 'alice', [bob]: 'bob' };
function data<T = Record<string, unknown>>(reply: CallToolResult): T {
  if (reply.isError) throw new Error(JSON.stringify(reply));
  return reply.structuredContent as T;
}
async function lease(server: BrowserMcpHttpServer, token = alice) {
  const response = await fetch(server.url + '/leases', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}
async function clientFor(
  server: BrowserMcpHttpServer,
  id: string,
  version = '2026-07-28',
  token = alice,
) {
  const client = new Client(
    { name: 'same-untrusted-client-name', version: '1' },
    {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: { pin: version } },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(server.url + '/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${token}`, 'Browser-Lease-Id': id } },
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 1000,
      initialReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1,
    },
  });
  await client.connect(transport);
  return { client, transport };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return data(await client.callTool({ name, arguments: args }));
}
async function ref(client: Client, tabId: unknown, selector = '#name') {
  return (await call(client, 'browser_find', { tabId, selector })).elements as { ref: string }[];
}

for (const version of ['2026-07-28'])
  for (const responseMode of ['json', 'sse'] as const) {
    test(`HTTP ${version} ${responseMode}: cross-request browser/ref, permissions, resource, cancellation`, async () => {
      const fixture = fixtureServer(),
        audit = recordWire('pipe');
      const server = await startBrowserMcpHttpServer({
        tokens,
        port: 0,
        responseMode,
        browser: {
          launch: {
            headless: process.env.NODRIVER_HEADFUL !== '1',
            transport: 'pipe',
            args: ['--site-per-process'],
          },
        },
      });
      let client: Client | undefined;
      try {
        const id = await lease(server);
        const connected = await clientFor(server, id, version);
        client = connected.client;
        expect(client.getNegotiatedProtocolVersion()).toBe(version);
        expect((await client.listTools()).tools.length).toBe(26);
        expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([
          'browser://state',
          'browser://events',
        ]);
        const { tabId } = await call(client, 'browser_open', { url: fixture.base + '/mcp' });
        const observed = (await ref(client, tabId))[0]!.ref;
        await call(client, 'browser_fill', { tabId, ref: observed, text: 'HTTP 中文😀' });
        const snapshot = await call(client, 'browser_snapshot', { tabId });
        expect(JSON.stringify(snapshot)).toContain('HTTP 中文😀');
        await call(client, 'browser_click', {
          tabId,
          ref: (await ref(client, tabId, '#delayed'))[0]!.ref,
        });
        await call(client, 'browser_wait', { tabId, selector: '#later' });
        expect(JSON.stringify(await call(client, 'browser_snapshot', { tabId }))).toContain(
          'ready',
        );
        const otherId = await lease(server, bob);
        const other = await clientFor(server, otherId, version, bob);
        try {
          expect((await call(other.client, 'browser_tabs')).tabs).toEqual([]);
          expect(
            (
              await other.client.callTool({
                name: 'browser_click',
                arguments: { tabId, ref: observed },
              })
            ).isError,
          ).toBeTrue();
          const { tabId: otherTab } = await call(other.client, 'browser_open', {
            url: fixture.base + '/mcp',
          });
          expect(
            (
              await other.client.callTool({
                name: 'browser_fill',
                arguments: { tabId: otherTab, ref: observed, text: 'forbidden' },
              })
            ).isError,
          ).toBeTrue();
          expect(server.manager.stats().browsers).toBe(1);
          expect(server.manager.stats().allocations).toBe(2);
        } finally {
          await other.client.close();
        }
        const state = await client.readResource({ uri: 'browser://state' });
        expect(JSON.stringify(state)).toContain(String(tabId));
        const controller = new AbortController();
        const waiting = client.callTool(
          { name: 'browser_wait', arguments: { tabId, selector: '#never', timeout: 5000 } },
          { signal: controller.signal },
        );
        const failure = waiting.catch((e) => e);
        await Bun.sleep(80);
        controller.abort();
        expect(await failure).toBeInstanceOf(Error);
        await call(client, 'browser_fill', { tabId, ref: observed, text: 'after cancel' });
        await call(client, 'browser_navigate', { tabId, url: fixture.base + '/audit' });
        expect(
          (
            await client.callTool({
              name: 'browser_fill',
              arguments: { tabId, ref: observed, text: 'stale' },
            })
          ).isError,
        ).toBeTrue();
        for (const frame of (await call(client, 'browser_tabs')).tabs as {
          frames: { frameId: string }[];
          tabId: string;
        }[]) {
          if (frame.tabId === tabId) {
            expect(frame.frames.length).toBe(4);
            for (const child of frame.frames) {
              const frameId = child.frameId;
              const found = await call(client, 'browser_find', {
                tabId,
                frameId,
                selector: '#closed-input',
              });
              await call(client, 'browser_fill', {
                tabId,
                ref: (found.elements as { ref: string }[])[0]!.ref,
                text: 'frame 中文😀',
              });
              const snapshot = await call(client, 'browser_snapshot', { tabId, frameId });
              const button = (snapshot.nodes as { ref: string; role: string }[]).find(
                (n) => n.role === 'button',
              )!;
              await call(client, 'browser_click', { tabId, ref: button.ref });
              expect(
                await server.manager
                  .session('alice', id)
                  .frame(String(tabId), frameId)
                  .evaluate('__audit.sample().clicks'),
              ).toBe(1);
            }
          }
        }
        expect(audit.messages.filter((m) => forbiddenAutomaticCommands.includes(m.method))).toEqual(
          [],
        );
        await client.close();
        const reconnected = await clientFor(server, id, version);
        client = reconnected.client;
        expect(JSON.stringify(await call(client, 'browser_tabs'))).toContain(String(tabId));
        await call(client, 'browser_close');
        expect((await call(client, 'browser_tabs')).connected).toBeFalse();
      } finally {
        await client?.close();
        await server.close();
        fixture.server.stop(true);
        audit.restore();
      }
    });
  }

test('HTTP guards reject origin/host/auth, forged leases/sessions, metadata mismatch and oversized bodies', async () => {
  const server = await startBrowserMcpHttpServer({
    browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' } },
    tokens,
    port: 0,
    maxRequestBodySize: 4096,
  });
  try {
    const id = await lease(server);
    const headers = {
      authorization: `Bearer ${alice}`,
      'browser-lease-id': id,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    expect((await fetch(server.url + '/leases')).status).toBe(401);
    expect(
      (
        await fetch(server.url + '/leases', {
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(server.url + '/leases', { headers: { ...headers, host: 'evil.example' } }))
        .status,
    ).toBe(403);
    expect(
      (
        await fetch(server.url + '/mcp', {
          headers: { ...headers, authorization: `Bearer ${bob}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(server.url + '/mcp', { headers: { ...headers, 'browser-lease-id': 'forged' } }))
        .status,
    ).toBe(404);
    expect(
      (
        await fetch(server.url + '/mcp', {
          headers: { ...headers, 'browser-lease-id': 'bad name' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(server.url + '/mcp', { method: 'POST', headers, body: 'x'.repeat(5000) }))
        .status,
    ).toBe(413);
    expect(
      (await fetch(server.url + '/mcp', { headers: { ...headers, 'mcp-session-id': 'forged' } }))
        .status,
    ).toBe(400);
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'browser_tabs',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'x', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    };
    const mismatch = await fetch(server.url + '/mcp', {
      method: 'POST',
      headers: {
        ...headers,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'wrong',
        'mcp-name': 'browser_tabs',
      },
      body: JSON.stringify(body),
    });
    expect(mismatch.status).toBe(400);
    expect(JSON.stringify(await mismatch.json())).toContain('-32020');
    for (const method of ['GET', 'DELETE'])
      expect(
        (
          await fetch(server.url + '/mcp', {
            method,
            headers: { ...headers, 'mcp-protocol-version': '2026-07-28' },
          })
        ).status,
      ).toBe(405);
  } finally {
    await server.close();
  }
});

test('injected InMemory adapters close only request resources; lease retirement removes owned context', async () => {
  const manager = new BrowserSessionManager({
    launch: { headless: process.env.NODRIVER_HEADFUL !== '1', transport: 'pipe' },
    browserIdleMs: 1,
  });
  const id = manager.create('trusted').id;
  const connect = async () => {
    const server = createBrowserMcpServer({}, { manager, principal: 'trusted', leaseId: id });
    const client = new Client(
      { name: 'in-memory', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    return { server, client };
  };
  try {
    const first = await connect();
    const { tabId } = await call(first.client, 'browser_open');
    await first.client.close();
    await first.server.close();
    const second = await connect();
    expect(JSON.stringify(await call(second.client, 'browser_tabs'))).toContain(String(tabId));
    await second.client.close();
    await second.server.close();
    await manager.release('trusted', id);
    expect(manager.stats().allocations).toBe(0);
    await Bun.sleep(5);
    await manager.sweep();
    expect(manager.stats().browsers).toBe(0);
  } finally {
    await manager.close();
  }
});

test('HTTP queue cancellation, operation deadlines, bounded requests and active lease protection', async () => {
  const fixture = fixtureServer();
  const manager = new BrowserSessionManager({
    launch: { headless: process.env.NODRIVER_HEADFUL !== '1', transport: 'pipe' },
    queueLimit: 1,
    operationTimeout: 8000, // includes a cold Chrome launch on slow CI runners
    leaseIdleMs: 100,
    sweepIntervalMs: 60000,
  });
  const server = await startBrowserMcpHttpServer({
    tokens,
    manager,
    port: 0,
    responseMode: 'sse',
    maxRequestsPerLease: 8,
  });
  let client: Client | undefined;
  try {
    const id = await lease(server);
    client = (await clientFor(server, id)).client;
    await client.listTools();
    const { tabId } = await call(client, 'browser_open', { url: fixture.base + '/mcp' });
    const button = (await ref(client, tabId, '#delayed'))[0]!.ref;
    const active = client.callTool({
      name: 'browser_wait',
      arguments: { tabId, selector: '#never', timeout: 2000 },
    });
    await Bun.sleep(40);
    const controller = new AbortController();
    const queued = client
      .callTool(
        { name: 'browser_click', arguments: { tabId, ref: button } },
        { signal: controller.signal },
      )
      .catch((e) => e);
    await Bun.sleep(40);
    const rejected = await client.callTool({
      name: 'browser_click',
      arguments: { tabId, ref: button },
    });
    expect(rejected.isError).toBeTrue();
    expect(JSON.stringify(rejected)).toContain('queue limit');
    controller.abort();
    expect(await queued).toBeInstanceOf(Error);
    await Bun.sleep(120);
    await manager.sweep();
    expect(manager.list('alice')).toHaveLength(1);
    expect((await active).isError).toBeTrue();
    const snapshot = await call(client, 'browser_snapshot', { tabId });
    expect(JSON.stringify(snapshot)).not.toContain('ready');
    await Bun.sleep(140);
    await manager.sweep();
    expect(manager.stats().leases).toBe(0);
    expect(
      (
        await fetch(server.url + '/mcp', {
          headers: { authorization: `Bearer ${alice}`, 'browser-lease-id': id },
        })
      ).status,
    ).toBe(404);
  } finally {
    await client?.close();
    await server.close();
    fixture.server.stop(true);
  }
});

test('HTTP subscriptions are lease-filtered, event history bounded, progress remains request-scoped', async () => {
  const server = await startBrowserMcpHttpServer({
    browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' } },
    tokens,
    port: 0,
    responseMode: 'sse',
  });
  let a: Client | undefined, b: Client | undefined;
  try {
    const id = await lease(server),
      other = await lease(server, bob);
    a = (await clientFor(server, id)).client;
    b = (await clientFor(server, other, '2026-07-28', bob)).client;
    let notifications = 0;
    a.setNotificationHandler('notifications/resources/updated', () => {
      notifications++;
    });
    const subscription = await a.listen({
      resourceSubscriptions: ['browser://state', 'browser://events'],
    });
    const progress: number[] = [];
    await a.callTool(
      { name: 'browser_open', arguments: {} },
      {
        onprogress: (p) => {
          progress.push(p.progress);
        },
      },
    );
    await poll(async () => (notifications > 0 ? true : undefined), { timeout: 2000 });
    expect(progress).toEqual([0, 1, 2]);
    await Bun.sleep(60);
    const before = notifications;
    await call(b, 'browser_open');
    await Bun.sleep(60);
    expect(notifications).toBe(before);
    const session = server.manager.session('alice', id);
    for (let i = 0; i < 100; i++) session.changed('test');
    expect(session.eventLog().events).toHaveLength(64);
    await subscription.close();
    expect((await a.readResource({ uri: 'browser://events' })).contents.length).toBe(1);
  } finally {
    await a?.close();
    await b?.close();
    await server.close();
  }
});

for (const version of ['2026-07-28'])
  test(`HTTP ${version}: explicit human handoff, authenticated continuation and no action replay`, async () => {
    const fixture = fixtureServer();
    const server = await startBrowserMcpHttpServer({
      tokens,
      port: 0,
      browser: {
        launch: { headless: process.env.NODRIVER_HEADFUL !== '1', transport: 'pipe' },
        humanInteraction: true,
      },
    });
    const id = await lease(server);
    let client: Client | undefined;
    try {
      client = new Client(
        { name: 'human-test', version: '1' },
        {
          capabilities: { elicitation: { form: {} } },
          supportedProtocolVersions: [version],
          versionNegotiation: { mode: { pin: version } },
        },
      );
      let prompts = 0;
      client.setRequestHandler('elicitation/create', async (request) => {
        prompts++;
        expect(request.params.mode).toBe('form');
        expect(JSON.stringify(request.params)).not.toContain('password');
        return { action: 'accept', content: { finished: true } };
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url + '/mcp'), {
          requestInit: { headers: { authorization: `Bearer ${alice}`, 'browser-lease-id': id } },
        }),
      );
      await client.listTools();
      const { tabId } = await call(client, 'browser_open', { url: fixture.base + '/mcp' });
      const result = await call(client, 'browser_handoff', { tabId });
      expect(result.completed).toBeTrue();
      expect(prompts).toBe(1);
      const noCapability = (await clientFor(server, id, version)).client;
      try {
        await noCapability.listTools();
        const unsupported = await noCapability.callTool({
          name: 'browser_handoff',
          arguments: { tabId },
        });
        expect(unsupported.isError).toBeTrue();
      } finally {
        await noCapability.close();
      }
    } finally {
      await client?.close();
      await server.close();
      fixture.server.stop(true);
    }
  });

test('manager persistent/external ownership and crash invalidation', async () => {
  const fixture = fixtureServer(),
    profile = await mkdtemp(join(tmpdir(), 'nodriver-lease-'));
  const persistent = new BrowserSessionManager({
    launch: {
      headless: process.env.NODRIVER_HEADFUL !== '1',
      transport: 'pipe',
      userDataDir: profile,
    },
  });
  try {
    const a = persistent.create('a'),
      b = persistent.create('b');
    await persistent
      .session('a', a.id)
      .run(
        new AbortController().signal,
        (signal) => persistent.session('a', a.id).newTab(signal),
        true,
      );
    await expect(
      persistent.session('b', b.id).getBrowser(new AbortController().signal),
    ).rejects.toThrow('capacity');
    await persistent.release('a', a.id);
    await expect(access(join(profile, '.nodriver.lock'))).rejects.toThrow();
    await access(profile);
  } finally {
    await persistent.close();
    await removeTree(profile);
  }
  const owner = await Browser.launch({ headless: process.env.NODRIVER_HEADFUL !== '1' });
  const external = new BrowserSessionManager({ connect: { endpoint: owner.endpoint! } });
  try {
    const id = external.create('owner').id,
      session = external.session('owner', id);
    const tab = await session.run(
      new AbortController().signal,
      (signal) => session.newTab(signal),
      true,
    );
    await external.release('owner', id);
    expect(await owner.tabs.find((t) => t.id === tab.id)!.evaluate('40+2')).toBe(42);
  } finally {
    await external.close();
    await owner.close();
  }
  const manager = new BrowserSessionManager({
    launch: { headless: process.env.NODRIVER_HEADFUL !== '1', transport: 'pipe' },
  });
  try {
    const id = manager.create('a').id,
      session = manager.session('a', id),
      signal = new AbortController().signal;
    const tab = await session.run(signal, (s) => session.newTab(s), true);
    await tab.goto(fixture.base + '/mcp');
    const ref = session.addRef((await tab.query('#name'))!);
    const browser = await session.getBrowser(signal);
    browser.process!.child.kill('SIGKILL');
    await poll(async () => (browser.closed ? true : undefined));
    expect(() => session.element(tab.id, ref)).toThrow();
    await session.run(signal, () => session.release());
    const reopened = await session.run(signal, (s) => session.newTab(s), true);
    expect(reopened.id).not.toBe(tab.id);
  } finally {
    await manager.close();
    fixture.server.stop(true);
  }
});

function rawTool(
  server: BrowserMcpHttpServer,
  id: string,
  name: string,
  args: Record<string, unknown>,
  version = '2026-07-28',
  sessionId?: string,
  requestId = 99,
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${alice}`,
    'browser-lease-id': id,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': version,
  };
  {
    headers['mcp-method'] = 'tools/call';
    headers['mcp-name'] = name;
    if (args.tabId) headers['mcp-param-tab-id'] = String(args.tabId);
  }
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return fetch(server.url + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          progressToken: 'raw',
          'io.modelcontextprotocol/protocolVersion': version,
          'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

for (const version of ['2026-07-28'])
  test(`HTTP ${version}: stream disconnect follows its era cancellation semantics`, async () => {
    const fixture = fixtureServer();
    const server = await startBrowserMcpHttpServer({
      tokens,
      port: 0,
      responseMode: 'sse',
      browser: {
        launch: { headless: process.env.NODRIVER_HEADFUL !== '1' },
        operationTimeout: 3000,
      },
    });
    let client: Client | undefined;
    try {
      const id = await lease(server),
        connected = await clientFor(server, id, version);
      client = connected.client;
      await client.listTools();
      const { tabId } = await call(client, 'browser_open', { url: fixture.base + '/mcp' });
      const response = await rawTool(
        server,
        id,
        'browser_wait',
        { tabId, selector: '#never', timeout: 1200 },
        version,
        connected.transport.sessionId,
      );
      const reader = response.body!.getReader();
      await reader.read();
      await poll(
        async () =>
          server.manager.session('alice', id).status().queuedOperations === 1 ? true : undefined,
        { timeout: 2000 },
      );
      await reader.cancel();
      await poll(
        async () =>
          server.manager.session('alice', id).status().queuedOperations === 0 ? true : undefined,
        { timeout: 500 },
        'modern stream cancellation',
      );
      expect((await call(client, 'browser_tabs')).connected).toBeTrue();
    } finally {
      await client?.close();
      await server.close();
      fixture.server.stop(true);
    }
  });

test('HTTP request quota and raw header mirror mismatch do not reach browser actions', async () => {
  const server = await startBrowserMcpHttpServer({
    browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' } },
    tokens,
    port: 0,
    responseMode: 'sse',
    maxRequestsPerLease: 1,
  });
  let client: Client | undefined;
  try {
    const id = await lease(server);
    client = (await clientFor(server, id)).client;
    await client.listTools();
    const { tabId } = await call(client, 'browser_open');
    const response = await rawTool(server, id, 'browser_wait', {
      tabId,
      selector: '#never',
      timeout: 3000,
    });
    const reader = response.body!.getReader();
    await reader.read();
    expect((await rawTool(server, id, 'browser_tabs', {})).status).toBe(429);
    await reader.cancel();
    await poll(async () => (server.manager.list('alice')[0]?.active === 0 ? true : undefined), {
      timeout: 1000,
    });
    const reply = await fetch(server.url + '/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${alice}`,
        'browser-lease-id': id,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'browser_snapshot',
        'mcp-param-tab-id': 'wrong-tab',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'browser_snapshot',
          arguments: { tabId },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'x', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(reply.status).toBe(400);
    expect(JSON.stringify(await reply.json())).toContain('-32020');
  } finally {
    await client?.close();
    await server.close();
  }
});

test('bounded pool scales, reuses processes after context retirement and cleans owned profiles', async () => {
  const profiles: string[] = [];
  const original = BrowserProcess.start;
  const spy = spyOn(BrowserProcess, 'start').mockImplementation(async (options) => {
    const result = await original.call(BrowserProcess, options);
    profiles.push(result.process.profile);
    return result;
  });
  const manager = new BrowserSessionManager({
    launch: { headless: process.env.NODRIVER_HEADFUL !== '1' },
    maxBrowsers: 2,
    contextsPerBrowser: 1,
    browserIdleMs: 1,
  });
  try {
    const a = manager.create('same-owner'),
      b = manager.create('same-owner'),
      c = manager.create('same-owner');
    const open = async (id: string) =>
      manager.run('same-owner', id, () =>
        manager
          .session('same-owner', id)
          .run(
            new AbortController().signal,
            (s) => manager.session('same-owner', id).newTab(s),
            true,
          ),
      );
    const first = await open(a.id);
    await open(b.id);
    expect(manager.stats().browsers).toBe(2);
    await expect(open(c.id)).rejects.toThrow('capacity');
    expect(() => manager.session('same-owner', b.id).tab(first.id)).toThrow('Unknown');
    await manager.release('same-owner', a.id);
    await open(c.id);
    expect(profiles).toHaveLength(2);
    await manager.release('same-owner', b.id);
    await manager.release('same-owner', c.id);
    await Bun.sleep(5);
    await manager.sweep();
    expect(manager.stats().browsers).toBe(0);
    for (const profile of profiles) await expect(access(profile)).rejects.toThrow();
  } finally {
    await manager.close();
    spy.mockRestore();
  }
});

test('HTTP MRTR opaque state rejects forgery and cross-lease continuation; completion is not replayed', async () => {
  const server = await startBrowserMcpHttpServer({
    tokens,
    port: 0,
    responseMode: 'json',
    browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' }, humanInteraction: true },
  });
  const id = await lease(server),
    other = await lease(server);
  const first = await clientFor(server, id);
  await first.client.listTools();
  try {
    const { tabId } = await call(first.client, 'browser_open');
    const tab = server.manager.session('alice', id).tab(String(tabId));
    const front = spyOn(tab, 'bringToFront');
    const rpc = async (leaseId: string, requestState?: string) => {
      const reply = await fetch(server.url + '/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${alice}`,
          'browser-lease-id': leaseId,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'browser_handoff',
          'mcp-param-tab-id': String(tabId),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 100,
          method: 'tools/call',
          params: {
            name: 'browser_handoff',
            arguments: { tabId },
            ...(requestState
              ? {
                  requestState,
                  inputResponses: { finished: { action: 'accept', content: { finished: true } } },
                }
              : {}),
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'untrusted', version: '1' },
              'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
            },
          },
        }),
      });
      expect(reply.status).toBe(200);
      return (
        (await reply.json()) as {
          result: {
            requestState?: string;
            isError?: boolean;
            structuredContent?: { completed: boolean };
          };
        }
      ).result;
    };
    try {
      const pending = await rpc(id);
      expect(pending.requestState).toBeString();
      expect(front).toHaveBeenCalledTimes(1);
      expect((await rpc(id, 'forged')).isError).toBeTrue();
      expect((await rpc(other, pending.requestState)).isError).toBeTrue();
      expect((await rpc(id, pending.requestState)).structuredContent?.completed).toBeTrue();
      expect((await rpc(id, pending.requestState)).structuredContent?.completed).toBeTrue();
      expect(front).toHaveBeenCalledTimes(1);
    } finally {
      front.mockRestore();
    }
  } finally {
    await first.client.close();
    await server.close();
  }
});

test('HTTP JSON request deadline cancels waiting work before its longer operation deadline', async () => {
  const server = await startBrowserMcpHttpServer({
    tokens,
    port: 0,
    responseMode: 'json',
    // Also bounds the first browser_open, which includes a cold browser start.
    requestTimeout: 4000,
    browser: {
      launch: { headless: process.env.NODRIVER_HEADFUL !== '1' },
      operationTimeout: 12000,
    },
  });
  let client: Client | undefined;
  try {
    const id = await lease(server);
    client = (await clientFor(server, id)).client;
    await client.listTools();
    const { tabId } = await call(client, 'browser_open');
    const response = await rawTool(server, id, 'browser_wait', {
      tabId,
      selector: '#never',
      timeout: 8000,
    });
    expect([200, 499]).toContain(response.status);
    await response.text();
    await poll(
      async () =>
        server.manager.session('alice', id).status().queuedOperations === 0 ? true : undefined,
      { timeout: 1000 },
    );
    expect((await call(client, 'browser_tabs')).connected).toBeTrue();
  } finally {
    await client?.close();
    await server.close();
  }
});
