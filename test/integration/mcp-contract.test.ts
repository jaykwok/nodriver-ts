import { expect, test, spyOn } from 'bun:test';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  InMemoryTransport,
  type Transport,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';
import { fileURLToPath } from 'node:url';
import { createBrowserMcpServer, MCP_PROTOCOL_VERSION } from '../../src/mcp/server.js';
import { startBrowserMcpHttpServer } from '../../src/mcp/http.js';
import {
  startBrowserMcpSocketServer,
  BrowserMcpSocketClientTransport,
} from '../../src/mcp/socket.js';
import { fixtureServer } from '../fixtures/server.js';
import { forbiddenAutomaticCommands, recordWire } from '../fixtures/wire.js';

const cli = fileURLToPath(new URL('../../src/mcp/cli.ts', import.meta.url));
const token = 'contract-secret-'.repeat(4);
const meta = {
  'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'contract', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
function stdio() {
  return new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      process.env.NODRIVER_HEADFUL === '1' ? '--headful' : '--headless',
      '--mcp-transport',
      'stdio',
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter((p): p is [string, string] => p[1] !== undefined),
    ),
    stderr: 'pipe',
  });
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const reply: CallToolResult = await client.callTool({ name, arguments: args });
  expect(reply.isError).not.toBeTrue();
  return reply.structuredContent as Record<string, any>;
}
let schemas: string | undefined;
async function browserContract(client: Client, base: string) {
  const tools = (await client.listTools()).tools;
  expect(tools).toHaveLength(26);
  expect(tools.find((t) => t.name === 'browser_evaluate')?.annotations?.readOnlyHint).toBeFalse();
  const actual = JSON.stringify(tools);
  if (schemas) expect(actual).toBe(schemas);
  else schemas = actual;
  expect(client.getNegotiatedProtocolVersion()).toBe(MCP_PROTOCOL_VERSION);
  expect((await call(client, 'browser_tabs')).tabs).toEqual([]);
  const { tabId, frames } = await call(client, 'browser_open', { url: base + '/audit' });
  expect(frames).toHaveLength(4);
  await call(client, 'browser_input_policy', {
    tabId,
    policy: {
      mode: 'human',
      seed: 29,
      moveDuration: [15, 15],
      moveSteps: [3, 3],
      pause: [0, 0],
      pressDelay: [5, 5],
      keyDelay: [2, 2],
      scrollSteps: [2, 2],
    },
  });
  let oldRef: string | undefined;
  for (const { frameId } of frames) {
    const evaluated = await call(client, 'browser_evaluate', {
      tabId,
      frameId,
      script:
        'await Promise.resolve(); document.documentElement.dataset.mcp = arg; globalThis.__mcpValue = arg; return { url: location.href, value: arg };',
      arg: '脚本😀',
    });
    expect(evaluated).toEqual({
      type: 'json',
      value: { url: frames.find((f: any) => f.frameId === frameId).url, value: '脚本😀' },
    });
    expect(
      await call(client, 'browser_evaluate', {
        tabId,
        frameId,
        world: 'isolated',
        script:
          'return { dom: document.documentElement.dataset.mcp, pageGlobal: typeof __mcpValue };',
      }),
    ).toEqual({ type: 'json', value: { dom: '脚本😀', pageGlobal: 'undefined' } });
    const { elements } = await call(client, 'browser_find', {
      tabId,
      frameId,
      selector: '#closed-input',
    });
    const ref = elements[0].ref;
    oldRef = ref;
    await call(client, 'browser_fill', { tabId, ref, text: '统一契约 中文😀' });
    const typed = await call(client, 'browser_type', { tabId, ref, text: '续😀' });
    expect(typed.input.completedSegments).toBe(2);
    const snapshot = await call(client, 'browser_snapshot', { tabId, frameId });
    expect(JSON.stringify(snapshot)).toContain('统一契约 中文😀');
    const button = snapshot.nodes.find((n: any) => n.role === 'button');
    await call(client, 'browser_click', { tabId, ref: button.ref });
    expect(JSON.stringify(await call(client, 'browser_snapshot', { tabId, frameId }))).toContain(
      '统一契约 中文😀',
    );
  }
  const screenshot = (await client.callTool({ name: 'browser_screenshot', arguments: { tabId } }))
    .content[0]!;
  expect(screenshot.type).toBe('image');
  if (screenshot.type === 'image')
    expect(Buffer.from(screenshot.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
  await call(client, 'browser_navigate', { tabId, url: base + '/mcp' });
  expect(
    await call(client, 'browser_evaluate', { tabId, script: 'return typeof __mcpValue;' }),
  ).toEqual({ type: 'json', value: 'undefined' });
  const diagnostic = await call(client, 'browser_environment', {
    tabId,
    worker: false,
    webgl: true,
    network: false,
  });
  expect(diagnostic.diagnostic.frames).toHaveLength(1);
  expect(diagnostic.diagnostic.http.status).toBe('not-requested');
  await call(client, 'browser_scroll', { tabId, deltaY: 60 });
  expect(
    (
      await client.callTool({
        name: 'browser_fill',
        arguments: { tabId, ref: oldRef, text: 'stale' },
      })
    ).isError,
  ).toBeTrue();
  expect(
    (await client.callTool({ name: 'browser_snapshot', arguments: { tabId: 'unauthorized' } }))
      .isError,
  ).toBeTrue();
}
for (const mode of ['http', 'stdio'] as const) {
  test(`shared browser contract: ${mode} schema, four frames, closed shadow, input, navigation and PNG`, async () => {
    const fixture = fixtureServer();
    const client = new Client(
      { name: 'contract', version: '1' },
      { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
    );
    const service =
      mode === 'http'
        ? await startBrowserMcpHttpServer({
            browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' } },
            tokens: { [token]: 'contract' },
            port: 0,
          })
        : undefined;
    const audit = recordWire('pipe');
    try {
      let transport: Transport;
      if (service) {
        const response = await fetch(service.url + '/leases', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{}',
        });
        const { id } = (await response.json()) as { id: string };
        transport = new StreamableHTTPClientTransport(new URL(service.url + '/mcp'), {
          requestInit: { headers: { authorization: `Bearer ${token}`, 'browser-lease-id': id } },
        });
      } else transport = stdio();
      await client.connect(transport);
      await browserContract(client, fixture.base);
      if (service)
        expect(audit.messages.filter((m) => forbiddenAutomaticCommands.includes(m.method))).toEqual(
          [],
        );
    } finally {
      await client.close();
      await service?.close();
      fixture.server.stop(true);
      audit.restore();
    }
  });
}

async function byteBoundary(transport: Transport) {
  const replies = new Map<number, (message: any) => void>();
  transport.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') replies.get(message.id)?.(message);
  };
  await transport.start();
  let id = 0;
  async function request(method: string, params: Record<string, unknown>) {
    const requestId = ++id;
    const response = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No response to ${method}`)), 4000);
      replies.set(requestId, (m) => {
        clearTimeout(timer);
        replies.delete(requestId);
        resolve(m);
      });
    });
    await transport.send({ jsonrpc: '2.0', id: requestId, method, params } as JSONRPCMessage);
    return response;
  }
  for (const version of ['2025-03-26', '2025-11-25', '2026-07-28']) {
    const reply = await request('initialize', {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'old', version: '1' },
    });
    expect(reply.error.code).toBe(-32022);
    expect(reply.error.data.supported).toEqual([MCP_PROTOCOL_VERSION]);
  }
  for (const metadata of [
    undefined,
    { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' },
    { ...meta, 'io.modelcontextprotocol/clientInfo': 'invalid' },
  ]) {
    const reply = await request('tools/call', {
      name: 'browser_open',
      arguments: {},
      ...(metadata ? { _meta: metadata } : {}),
    });
    expect(reply.error).toBeDefined();
  }
  expect((await request('server/discover', { _meta: meta })).result.supportedVersions).toEqual([
    MCP_PROTOCOL_VERSION,
  ]);
  expect((await request('tools/list', { _meta: meta })).result.tools).toHaveLength(26);
  expect(
    (
      await request('tools/call', {
        name: 'browser_open',
        arguments: {},
        _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' },
      })
    ).error.code,
  ).toBe(-32022);
  expect((await request('tools/call', { name: 'browser_open', arguments: {} })).error.code).toBe(
    -32602,
  );
  expect(
    (
      await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'old', version: '1' },
      })
    ).error.code,
  ).toBe(-32022);
  expect(
    (await request('resources/subscribe', { uri: 'browser://state', _meta: meta })).error.code,
  ).toBe(-32601);
  expect(
    (await request('tools/call', { name: 'browser_tabs', arguments: {}, _meta: meta })).result
      .structuredContent,
  ).toMatchObject({ connected: false, tabs: [] });
}
for (const mode of ['stdio', 'embedded', 'socket'] as const) {
  test(`modern-only boundary: ${mode} rejects initialize and malformed claims before browser allocation`, async () => {
    const server = mode === 'embedded' ? createBrowserMcpServer() : undefined;
    const socket =
      mode === 'socket'
        ? await startBrowserMcpSocketServer({
            browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' } },
            tokens: { [token]: 'contract' },
          })
        : undefined;
    let transport: Transport;
    if (server) {
      const [a, b] = InMemoryTransport.createLinkedPair();
      transport = a;
      await server.connect(b);
    } else if (socket)
      transport = new BrowserMcpSocketClientTransport({ path: socket.path, token });
    else transport = stdio();
    try {
      await byteBoundary(transport);
      if (socket) expect(socket.manager.stats().browsers).toBe(0);
    } finally {
      await transport.close();
      await server?.close();
      await socket?.close();
    }
  });
}

test('modern-only HTTP boundary rejects old versions, sessions and invalid metadata before allocation', async () => {
  const service = await startBrowserMcpHttpServer({
    browser: { launch: { headless: process.env.NODRIVER_HEADFUL !== '1' } },
    tokens: { [token]: 'contract' },
    port: 0,
    responseMode: 'json',
  });
  try {
    const created = await fetch(service.url + '/leases', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const { id } = (await created.json()) as { id: string };
    const headers = {
      authorization: `Bearer ${token}`,
      'browser-lease-id': id,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    for (const version of ['2025-03-26', '2025-11-25', '2099-01-01']) {
      const response = await fetch(service.url + '/mcp', {
        method: 'POST',
        headers: { ...headers, 'mcp-protocol-version': version },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: version,
            capabilities: {},
            clientInfo: { name: 'old', version: '1' },
          },
        }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error.data.supported).toEqual([MCP_PROTOCOL_VERSION]);
    }
    for (const metadata of [
      undefined,
      { ...meta, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' },
      { ...meta, 'io.modelcontextprotocol/clientCapabilities': 'invalid' },
    ]) {
      const response = await fetch(service.url + '/mcp', {
        method: 'POST',
        headers: {
          ...headers,
          'mcp-protocol-version': MCP_PROTOCOL_VERSION,
          'mcp-method': 'tools/call',
          'mcp-name': 'browser_open',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'browser_open', arguments: {}, ...(metadata ? { _meta: metadata } : {}) },
        }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).error).toBeDefined();
    }
    for (const method of ['GET', 'DELETE'])
      expect((await fetch(service.url + '/mcp', { method, headers })).status).toBe(405);
    expect(
      (
        await fetch(service.url + '/mcp', {
          method: 'POST',
          headers: { ...headers, 'mcp-session-id': 'old' },
          body: '{}',
        })
      ).status,
    ).toBe(400);
    expect(service.manager.stats().browsers).toBe(0);
    expect(service.manager.stats().allocations).toBe(0);
  } finally {
    await service.close();
  }
});

test('modern MRTR uses per-request capabilities without consulting the legacy connection cache', async () => {
  const server = createBrowserMcpServer({
    launch: { headless: process.env.NODRIVER_HEADFUL !== '1' },
    humanInteraction: true,
  });
  const cached = spyOn(server.server, 'getClientCapabilities').mockImplementation(() => {
    throw new Error('Legacy capability cache must not be consulted');
  });
  const client = new Client(
    { name: 'mrtr', version: '1' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  let prompts = 0;
  client.setRequestHandler('elicitation/create', async () => {
    prompts++;
    return { action: 'accept', content: { finished: true } };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const { tabId } = await call(client, 'browser_open');
    expect((await call(client, 'browser_handoff', { tabId })).completed).toBeTrue();
    expect(prompts).toBe(1);
    expect(cached).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
    cached.mockRestore();
  }
});

test('HTTP host-provisioned diagnostics/resolver and partial input reports use the shared core', async () => {
  const fixture = fixtureServer();
  let lookups = 0;
  const service = await startBrowserMcpHttpServer({
    tokens: { [token]: 'contract' },
    port: 0,
    browser: {
      launch: { headless: true },
      environmentDiagnostics: { httpProbe: fixture.base + '/signals/ip', stunServers: [] },
      geoIPResolver: async (address) => {
        expect(address).toBe('local-only');
        lookups++;
        return { timezone: 'Europe/Paris' };
      },
    },
  });
  const client = new Client(
    { name: 'host-diagnostic', version: '1' },
    { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } },
  );
  try {
    const created = await fetch(service.url + '/leases', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const { id } = (await created.json()) as { id: string };
    await client.connect(
      new StreamableHTTPClientTransport(new URL(service.url + '/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${token}`, 'browser-lease-id': id } },
      }),
    );
    await client.listTools();
    const { tabId } = await call(client, 'browser_open', { url: fixture.base + '/mcp' });
    const alignment = await call(client, 'browser_environment', {
      tabId,
      mode: 'align',
      network: true,
      geoip: { address: 'local-only', fields: ['timezone'] },
    });
    expect(lookups).toBe(1);
    expect(alignment.alignment.after.http.status).toBe('observed');
    expect(alignment.alignment.after.webrtc.value.complete).toBeTrue();
    expect(alignment.alignment.after.frames[0].document.timezone).toBe('Europe/Paris');
    await call(client, 'browser_input_policy', {
      tabId,
      policy: { mode: 'human', seed: 3, keyDelay: [200, 200] },
    });
    const { elements } = await call(client, 'browser_find', { tabId, selector: '#name' });
    const reply = await client.callTool({
      name: 'browser_type',
      arguments: { tabId, ref: elements[0].ref, text: '甲乙丙', timeout: 80 },
    });
    expect(reply.isError).toBeTrue();
    const partial = reply.structuredContent as any;
    expect(partial.partialInput.status).toBe('interrupted');
    expect(partial.partialInput.completedSegments).toBe(1);
  } finally {
    await client.close();
    await service.close();
    fixture.server.stop(true);
  }
});
