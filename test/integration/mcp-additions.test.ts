import { expect, test } from 'bun:test';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserMcpServer } from '../../src/mcp/server.js';
import { fixtureServer } from '../fixtures/server.js';

for (const transport of ['pipe', 'websocket'] as const)
  test(`${transport}: MCP snapshots, action waits, response capture and named storage state`, async () => {
    const fixture = fixtureServer();
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
      const failed = await tool('browser_click', {
        tabId,
        ref: await find('#once'),
        waitFor: 'load',
        timeout: 500,
      });
      expect(failed.isError).toBeTrue();
      expect(JSON.stringify(failed.content)).toContain('navigation did not start');
      const hash = await call('browser_click', {
        tabId,
        ref: await find('#hash'),
        waitFor: 'load',
        snapshot: true,
        timeout: 1500,
      });
      expect(hash.navigated).toBeTrue();
      expect(hash.url).toEndWith('#next');
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
      await evaluate('localStorage.clear();');
      await call('browser_storage_state', { action: 'load', name: 'login' });
      await evaluate(
        'if (localStorage.getItem("review") !== "saved") throw new Error("state not restored");',
      );
    } finally {
      await client.close();
      await server.close();
      fixture.server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

test('MCP download wait runs beside the triggering click, before or after it', async () => {
  const attachment = { 'content-disposition': 'attachment; filename=f.txt' };
  const files = Bun.serve({
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
                await Bun.sleep(150);
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
    await Bun.sleep(50);
    await click('#file');
    expect(performance.now() - started).toBeLessThan(5_000);
    expect((await waiting).download).toMatchObject({ sequence: 1, state: 'completed' });

    // Click first: a download that began before the wait is still returned.
    await click('#file');
    await Bun.sleep(300);
    expect(
      (await call('browser_downloads', { tabId, action: 'wait', timeout: 5_000 })).download,
    ).toMatchObject({ sequence: 2, state: 'completed' });

    // A slow download reports a timeout, and the next wait resumes the same download.
    await click('#slow');
    const early = await tool('browser_downloads', { tabId, action: 'wait', timeout: 200 });
    expect(early.isError).toBeTrue();
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
    await Bun.sleep(100);
    const abortAt = performance.now();
    controller.abort(new Error('caller cancelled'));
    expect(await cancelled).toBeTrue();
    expect(performance.now() - abortAt).toBeLessThan(1_000);
    expect((await call('browser_downloads', { action: 'list' })).latestSequence).toBe(3);
  } finally {
    await client.close();
    await server.close();
    files.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
