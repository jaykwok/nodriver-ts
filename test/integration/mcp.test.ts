import { setTimeout as sleep } from 'node:timers/promises';
import { poll, removeTree } from '../../src/utils.ts';
import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { spyOn } from 'jest-mock';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { fileURLToPath } from 'node:url';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Browser } from '../../src/index.ts';
import { BrowserProcess } from '../../src/browser/launcher.ts';
import { createBrowserMcpServer } from '../../src/mcp/server.ts';
import { PipeTransport } from '../../src/transport/pipe.ts';
import { fixtureServer } from '../fixtures/server.ts';

interface Snapshot {
  nodes: Array<{ ref: string; role: string; name: string; states: Record<string, unknown> }>;
  truncated: boolean;
}
interface TabInfo {
  tabId: string;
  frames: Array<{ frameId: string; url: string }>;
}
function data<T>(result: CallToolResult): T {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as T;
}
async function call<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return data<T>(await client.callTool({ name, arguments: args }));
}
async function find(client: Client, tabId: string, selector: string) {
  return (
    await call<{ elements: Array<{ ref: string }> }>(client, 'browser_find', { tabId, selector })
  ).elements[0]!.ref;
}
const cli = fileURLToPath(new URL('../../src/mcp/cli.ts', import.meta.url));

for (const mode of ['websocket', 'pipe'] as const) {
  test(`MCP stdio ${mode}: discovery, snapshot refs, nested frames, actions and errors`, async () => {
    const fixture = await fixtureServer();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        cli,
        process.env.NODRIVER_HEADFUL === '1' ? '--headful' : '--headless',
        '--mcp-transport',
        'stdio',
        '--browser-transport',
        mode,
      ],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client(
      { name: 'nodriver-mcp-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBe(26);
      expect(tools.some((t) => t.name === 'browser_snapshot')).toBe(true);
      expect(tools.find((t) => t.name === 'browser_click')!.annotations?.readOnlyHint).toBe(false);
      expect(await call(client, 'browser_tabs')).toMatchObject({ connected: false, tabs: [] });
      const opened = await call<TabInfo>(client, 'browser_open', {
        url: fixture.base + '/page?frames=1',
      });
      const { tabId } = opened;
      expect(opened.frames.length).toBe(4);
      for (const frame of opened.frames) {
        const snapshot = await call<Snapshot>(client, 'browser_snapshot', {
          tabId,
          frameId: frame.frameId,
        });
        const button = snapshot.nodes.find((n) => n.role === 'button');
        expect(button?.ref).toEqual(expect.any(String));
        await call(client, 'browser_click', { tabId, ref: button!.ref });
      }
      const snapshot = await call<Snapshot>(client, 'browser_snapshot', { tabId });
      const closed = snapshot.nodes.find((n) => n.role === 'button' && n.name === 'Closed shadow')!;
      expect(closed.ref).toEqual(expect.any(String));
      await call(client, 'browser_click', { tabId, ref: closed.ref });
      expect(
        (await call<Snapshot>(client, 'browser_snapshot', { tabId })).nodes.some(
          (n) => n.name === 'shadow-clicked',
        ),
      ).toBe(true);
      expect(
        (await call<Snapshot>(client, 'browser_snapshot', { tabId, limit: 1 })).truncated,
      ).toBe(true);
      const other = await call<TabInfo>(client, 'browser_open', {});
      expect(
        (
          await client.callTool({
            name: 'browser_click',
            arguments: { tabId: other.tabId, ref: closed.ref },
          })
        ).isError,
      ).toBe(true);
      await call(client, 'browser_close_tab', { tabId: other.tabId });
      await call(client, 'browser_navigate', { tabId, url: fixture.base + '/mcp' });
      expect(
        (await client.callTool({ name: 'browser_click', arguments: { tabId, ref: closed.ref } }))
          .isError,
      ).toBe(true);
      const name = await find(client, tabId, '#name');
      await call(client, 'browser_fill', { tabId, ref: name, text: '中文😀' });
      expect(
        (await call<Snapshot>(client, 'browser_snapshot', { tabId })).nodes.some(
          (n) => n.name === '中文😀',
        ),
      ).toBe(true);
      await call(client, 'browser_press_key', { tabId, key: 'End' });
      const check = await find(client, tabId, '#check');
      await call(client, 'browser_check', { tabId, ref: check, checked: true });
      expect(
        (await call<Snapshot>(client, 'browser_snapshot', { tabId })).nodes.find(
          (n) => n.role === 'checkbox',
        )?.states.checked,
      ).toBe('true');
      await call(client, 'browser_select', {
        tabId,
        ref: await find(client, tabId, '#choice'),
        values: ['b'],
      });
      expect(
        (await call<Snapshot>(client, 'browser_snapshot', { tabId })).nodes.some(
          (n) => n.name === 'b',
        ),
      ).toBe(true);
      await call(client, 'browser_click', { tabId, ref: await find(client, tabId, '#delayed') });
      expect(
        (await call<{ ref: string }>(client, 'browser_wait', { tabId, selector: '#later' })).ref,
      ).toEqual(expect.any(String));
      const shot = await client.callTool({ name: 'browser_screenshot', arguments: { tabId } });
      const image = shot.content[0]!;
      expect(image.type).toBe('image');
      if (image.type === 'image')
        expect(Buffer.from(image.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
      expect(
        (await client.callTool({ name: 'browser_open', arguments: { url: 'file:///private' } }))
          .isError,
      ).toBe(true);
      const controller = new AbortController();
      const pending = client.callTool(
        { name: 'browser_wait', arguments: { tabId, selector: '#never', timeout: 5000 } },
        { signal: controller.signal },
      );
      const caught = pending.catch((e: unknown) => e);
      await sleep(60);
      controller.abort();
      expect(await caught).toBeInstanceOf(Error);
      expect(await call(client, 'browser_tabs')).toMatchObject({ connected: true });
      // A JS dialog can block a previous action, so handle it concurrently.
      const dialogRef = await find(client, tabId, '#dialog');
      const click = client.callTool({
        name: 'browser_click',
        arguments: { tabId, ref: dialogRef },
      });
      // Human-mode clicks take a variable time to reach the page; poll for the dialog.
      expect(
        await poll(
          async () =>
            (
              await call<{ tabs: Array<{ tabId: string; dialog: { type: string } | null }> }>(
                client,
                'browser_tabs',
              )
            ).tabs.find((t) => t.tabId === tabId)?.dialog?.type,
        ),
      ).toBe('alert');
      await call(client, 'browser_dialog', { tabId, accept: true });
      expect((await click).isError).not.toBe(true);
      expect(
        (await call<Snapshot>(client, 'browser_snapshot', { tabId })).nodes.some(
          (n) => n.name === 'done',
        ),
      ).toBe(true);
      await call(client, 'browser_close');
      expect(await call(client, 'browser_tabs')).toMatchObject({ connected: false, tabs: [] });
    } finally {
      await client.close();
      await fixture.server.stop();
    }
    expect(stderr).toBe('');
  });
}

test('MCP embedding: no Runtime.enable on wire; disconnect cleans owned profile', async () => {
  const fixture = await fixtureServer();
  const methods: string[] = [];
  const originalSend = PipeTransport.prototype.send;
  const wire = spyOn(PipeTransport.prototype, 'send').mockImplementation(function (
    this: PipeTransport,
    message: string,
  ) {
    methods.push(JSON.parse(message).method);
    return originalSend.call(this, message);
  });
  let profile: string | undefined;
  const start = BrowserProcess.start;
  const launch = spyOn(BrowserProcess, 'start').mockImplementation(async (options) => {
    const result = await start.call(BrowserProcess, options);
    profile = result.process.profile;
    return result;
  });
  const server = createBrowserMcpServer({
    launch: { headless: process.env.NODRIVER_HEADFUL !== '1', transport: 'pipe' },
    leaseIdleMs: 10,
    sweepIntervalMs: 5,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'embedded-test', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await server.connect(b);
    await client.connect(a);
    await client.listTools();
    expect(profile).toBeUndefined();
    await sleep(30); // A live private connection owns its lease through idle sweeps.
    const { tabId } = await call<TabInfo>(client, 'browser_open', { url: fixture.base + '/page' });
    await call(client, 'browser_snapshot', { tabId });
    await call(client, 'browser_fill', {
      tabId,
      ref: await find(client, tabId, '#input'),
      text: '测试',
    });
    expect(methods).toContain('Accessibility.getFullAXTree');
    expect(
      methods.filter((m) =>
        [
          'Runtime.enable',
          'Runtime.disable',
          'Runtime.addBinding',
          'Console.enable',
          'Debugger.enable',
        ].includes(m),
      ),
    ).toEqual([]);
    await client.close();
    await server.close();
    expect(profile).toEqual(expect.any(String));
    await expect(access(profile!)).rejects.toThrow();
  } finally {
    await client.close();
    await server.close();
    wire.mockRestore();
    launch.mockRestore();
    await fixture.server.stop();
  }
});

test('MCP disconnect leaves externally connected Chrome and its tabs alive', async () => {
  await using owner = await Browser.launch({ headless: process.env.NODRIVER_HEADFUL !== '1' });
  const server = createBrowserMcpServer({ connect: { endpoint: owner.endpoint! } });
  const client = new Client(
    { name: 'external-test', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const { tabId } = await call<TabInfo>(client, 'browser_open', {});
    await client.close();
    await server.close();
    expect(owner.closed).toBe(false);
    const tab = owner.tabs.find((t) => t.id === tabId)!;
    expect(await tab.evaluate('2+2')).toBe(4);
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP stdio EOF closes Chrome and releases persistent profile lock', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'nodriver-mcp-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      process.env.NODRIVER_HEADFUL === '1' ? '--headful' : '--headless',
      '--transport',
      'websocket',
      '--user-data-dir',
      profile,
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'eof-test', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await client.connect(transport);
    await call(client, 'browser_open');
    await access(join(profile, '.nodriver.lock'));
    const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8'))
      .trim()
      .split(/\r?\n/);
    await client.close();
    await expect(access(join(profile, '.nodriver.lock'))).rejects.toThrow();
    await access(profile);
    const endpointAlive = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    }).then(
      () => true,
      () => false,
    );
    expect(endpointAlive).toBe(false);
  } finally {
    await client.close();
    await removeTree(profile);
  }
});
