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
