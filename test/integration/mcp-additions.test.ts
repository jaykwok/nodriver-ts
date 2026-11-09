import { serve } from '../fixtures/serve.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserMcpServer } from '../../src/mcp/server.ts';
import { BrowserSessionManager } from '../../src/mcp/manager.ts';
import { fixtureServer } from '../fixtures/server.ts';

for (const transport of ['pipe', 'websocket'] as const)
  test(`${transport}: MCP snapshots, action waits, response capture and named storage state`, async () => {
    const fixture = await fixtureServer();
    const directory = await mkdtemp(join(tmpdir(), 'nodriver-mcp-additions-'));
    const server = createBrowserMcpServer({
      launch: { transport, headless: process.env.NODRIVER_HEADFUL !== '1' },
      stateDir: directory,
    });
    const client = new Client(
      { name: 'additions', version: '1' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const tool = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await tool(name, args);
      if (result.isError) throw new Error(JSON.stringify(result.content));
      return result.structuredContent as any;
    };
    try {
      await server.connect(b);
      await client.connect(a);
      const { tabId } = await call('browser_open', { url: fixture.base + '/mcp' });
      const evaluate = (script: string) => call('browser_evaluate', { tabId, script });
      await evaluate(
        `document.body.insertAdjacentHTML('beforeend', '<input type="password" value="private-secret"><a id="hash" href="#next">Next</a><button id="once" onclick="globalThis.clicks=(globalThis.clicks||0)+1">Once</button>');`,
      );
      const { elements } = await call('browser_find', { tabId, selector: '#name' });
      expect(elements[0]).toMatchObject({ role: 'textbox', tag: 'input', visible: true });
      await call('browser_fill', { tabId, ref: elements[0].ref, text: 'Ada' });
      const snapshot = await tool('browser_snapshot', { tabId, interactiveOnly: true });
      expect(JSON.stringify(snapshot)).not.toContain('private-secret');
      expect((snapshot.content[0] as { text: string }).text).toContain('value="Ada"');
      const subtree = await call('browser_snapshot', {
        tabId,
        root: elements[0].ref,
        interactiveOnly: true,
      });
      expect(subtree.nodes).toHaveLength(1);
      expect(subtree.nodes[0].ref).toBe(elements[0].ref);
      const first = await call('browser_snapshot', { tabId, interactiveOnly: true, limit: 1 });
      expect(first.nextOffset).toBe(1);
      const second = await call('browser_snapshot', {
        tabId,
        interactiveOnly: true,
        offset: 1,
        limit: 1,
      });
      expect(second.nodes[0].ref).not.toBe(first.nodes[0].ref);
      const find = async (selector: string) =>
        (await call('browser_find', { tabId, selector })).elements[0].ref;
      // The timeout covers the click as well as the wait for a navigation that never starts,
      // which uses all of it.
      const failed = await tool('browser_click', {
        tabId,
        ref: await find('#once'),
        waitFor: 'load',
        timeout: 3000,
      });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toContain('navigation did not start');
      const hash = await call('browser_click', {
        tabId,
        ref: await find('#hash'),
        waitFor: 'load',
        snapshot: true,
        timeout: 1500,
      });
      expect(hash.navigated).toBe(true);
      expect(hash.url).toMatch(/#next$/);
      expect(hash.snapshot.nodes.length).toBeGreaterThan(0);
      await evaluate('if (globalThis.clicks !== 1) throw new Error("action replayed");');
      await call('browser_network', { tabId, action: 'start' });
      await evaluate('await fetch("/signals/ip");');
      const network = await call('browser_network', { tabId, filter: '/signals/ip' });
      expect(network.entries).toHaveLength(1);
      expect(network.entries[0].status).toBe(200);
      const image = await tool('browser_screenshot', {
        tabId,
        format: 'jpeg',
        quality: 50,
        scale: 0.5,
      });
      expect(image.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
      await evaluate('localStorage.setItem("review", "saved");');
      const saved = await call('browser_storage_state', { action: 'save', name: 'login' });
      expect(saved.origins).toBe(1);
      // A server without an authenticated principal keeps its names under "private".
      await access(join(directory, 'private', 'login.json'));
      await evaluate('localStorage.clear();');
      await call('browser_storage_state', { action: 'load', name: 'login' });
      await evaluate(
        'if (localStorage.getItem("review") !== "saved") throw new Error("state not restored");',
      );
    } finally {
      await client.close();
      await server.close();
      await fixture.server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

test('MCP snapshots mask a password field whose other attributes mention "type"', async () => {
  const site = await serve({
    hostname: '127.0.0.1',
    fetch: () =>
      new Response(
        `<!doctype html><title>Forms</title>
<input aria-label="secret" name="type" type="password" value="hunter2">
<input aria-label="reversed" type="password" name="type" value="swordfish">
<input aria-label="visible" name="type" value="plain-value">`,
        { headers: { 'content-type': 'text/html' } },
      ),
  });
  const server = createBrowserMcpServer({
    launch: { headless: process.env.NODRIVER_HEADFUL !== '1', transport: 'pipe' },
  });
  const client = new Client(
    { name: 'masks', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const opened = (await client.callTool({
      name: 'browser_open',
      arguments: { url: `http://127.0.0.1:${site.port}/` },
    })) as CallToolResult;
    const { tabId } = opened.structuredContent as { tabId: string };
    const snapshot = (await client.callTool({
      name: 'browser_snapshot',
      arguments: { tabId, interactiveOnly: true },
    })) as CallToolResult;
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('swordfish');
    expect(text).toContain('plain-value');
    const { nodes } = snapshot.structuredContent as {
      nodes: Array<{ name: string; value?: string }>;
    };
    expect(nodes.find((node) => node.name === 'secret')?.value).toBe('••••');
    expect(nodes.find((node) => node.name === 'reversed')?.value).toBe('••••');
  } finally {
    await client.close();
    await server.close();
    await site.stop();
  }
});

test('MCP storage state names belong to the authenticated principal', async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), 'nodriver-mcp-principals-'));
  const manager = new BrowserSessionManager({
    launch: { headless: process.env.NODRIVER_HEADFUL !== '1', transport: 'pipe' },
    stateDir: directory,
  });
  const clients: Client[] = [];
  const connect = async (principal: string) => {
    const { id } = manager.create(principal);
    const server = createBrowserMcpServer({}, { manager, principal, leaseId: id });
    const client = new Client(
      { name: principal, version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    clients.push(client);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const tool = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
    const { tabId } = (await tool('browser_open', { url: fixture.base + '/mcp' }))
      .structuredContent as { tabId: string };
    const evaluate = async (script: string) =>
      ((await tool('browser_evaluate', { tabId, script })).structuredContent as { value: unknown })
        .value;
    return { tool, evaluate };
  };
  try {
    const alice = await connect('alice'),
      bob = await connect('bob');
    await alice.evaluate('localStorage.setItem("owner", "alice");');
    expect(
      (await alice.tool('browser_storage_state', { action: 'save', name: 'login' })).isError,
    ).toBeFalsy();
    await access(join(directory, 'alice', 'login.json'));
    const refused = await bob.tool('browser_storage_state', { action: 'load', name: 'login' });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ message: 'No saved state named login' });
    expect(await bob.evaluate('return localStorage.getItem("owner");')).toBeNull();

    // Both may use the same name without touching each other's state.
    await bob.evaluate('localStorage.setItem("owner", "bob");');
    await bob.tool('browser_storage_state', { action: 'save', name: 'login' });
    await alice.evaluate('localStorage.clear();');
    await alice.tool('browser_storage_state', { action: 'load', name: 'login' });
    expect(await alice.evaluate('return localStorage.getItem("owner");')).toBe('alice');
    await bob.evaluate('localStorage.clear();');
    await bob.tool('browser_storage_state', { action: 'load', name: 'login' });
    expect(await bob.evaluate('return localStorage.getItem("owner");')).toBe('bob');
  } finally {
    for (const client of clients) await client.close();
    await manager.close();
    await fixture.server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP download wait runs beside the triggering click, before or after it', async () => {
  const attachment = { 'content-disposition': 'attachment; filename=f.txt' };
  const files = await serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/file') return new Response('fixture', { headers: attachment });
      if (path === '/slow')
        return new Response(
          new ReadableStream({
            async start(controller) {
              for (let i = 0; i < 8; i++) {
                controller.enqueue(new Uint8Array(1024));
                await sleep(150);
              }
              controller.close();
            },
          }),
          { headers: attachment },
        );
      return new Response('<a id="file" href="/file">File</a> <a id="slow" href="/slow">Slow</a>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const directory = await mkdtemp(join(tmpdir(), 'nodriver-mcp-downloads-'));
  const server = createBrowserMcpServer({
    launch: { headless: process.env.NODRIVER_HEADFUL !== '1' },
    downloadDir: directory,
  });
  const client = new Client(
    { name: 'downloads', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const tool = (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    client.callTool({ name, arguments: args }, { signal }) as Promise<CallToolResult>;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tool(name, args);
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent as any;
  };
  try {
    await server.connect(b);
    await client.connect(a);
    const { tabId } = await call('browser_open', { url: `http://127.0.0.1:${files.port}/` });
    const ref = async (selector: string) =>
      (await call('browser_find', { tabId, selector })).elements[0].ref;
    const click = (selector: string) =>
      ref(selector).then((r) => call('browser_click', { tabId, ref: r, waitFor: 'none' }));

    // Wait first: the click must not queue behind it.
    const started = performance.now();
    const waiting = call('browser_downloads', { tabId, action: 'wait', timeout: 10_000 });
    await sleep(50);
    await click('#file');
    expect(performance.now() - started).toBeLessThan(5_000);
    expect((await waiting).download).toMatchObject({ sequence: 1, state: 'completed' });

    // Click first: a download that began before the wait is still returned.
    await click('#file');
    await sleep(300);
    expect(
      (await call('browser_downloads', { tabId, action: 'wait', timeout: 5_000 })).download,
    ).toMatchObject({ sequence: 2, state: 'completed' });

    // A slow download reports a timeout, and the next wait resumes the same download.
    await click('#slow');
    const early = await tool('browser_downloads', { tabId, action: 'wait', timeout: 200 });
    expect(early.isError).toBe(true);
    expect(JSON.stringify(early.content)).toContain('still in progress');
    expect(
      (await call('browser_downloads', { tabId, action: 'wait', timeout: 10_000 })).download,
    ).toMatchObject({ sequence: 3, state: 'completed' });
    const list = await call('browser_downloads', { action: 'list' });
    expect(list.latestSequence).toBe(3);
    expect(list.downloads).toHaveLength(3);
    expect(
      (await call('browser_downloads', { tabId, action: 'wait', after: 1, timeout: 1000 })).download
        .sequence,
    ).toBe(2);

    // Cancellation ends the wait promptly and leaves the tools usable.
    const controller = new AbortController();
    const cancelled = tool(
      'browser_downloads',
      { tabId, action: 'wait', timeout: 10_000 },
      controller.signal,
    ).then(
      () => false,
      () => true,
    );
    await sleep(100);
    const abortAt = performance.now();
    controller.abort(new Error('caller cancelled'));
    expect(await cancelled).toBe(true);
    expect(performance.now() - abortAt).toBeLessThan(1_000);
    expect((await call('browser_downloads', { action: 'list' })).latestSequence).toBe(3);
  } finally {
    await client.close();
    await server.close();
    await files.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
