import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createBrowserMcpServer } from '../../src/mcp/server.ts';
import { decodePng } from '../../src/mcp/png.ts';
import { fixtureServer } from '../fixtures/server.ts';
import { poll } from '../../src/utils.ts';

test('MCP snapshot boxes match the page layout across scrolled, same-process and cross-process frames', async () => {
  const fixture = await fixtureServer();
  const server = createBrowserMcpServer({
    launch: { headless: process.env.NODRIVER_HEADFUL !== '1' },
  });
  const client = new Client(
    { name: 'geometry', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
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
    const { tabId } = await call('browser_open', { url: fixture.base + '/page?frames' });
    const frames: Array<{ frameId: string; parentId: string | null; url: string }> = await poll(
      async () => {
        const { tabs } = await call('browser_tabs');
        const list = tabs.find((t: any) => t.tabId === tabId).frames;
        return list.length >= 4 ? list : undefined;
      },
      { timeout: 10000 },
    );
    await call('browser_evaluate', { tabId, script: 'scrollTo(0, 100)' });
    const evaluate = (frameId: string | undefined, script: string) =>
      call('browser_evaluate', { tabId, frameId, script }).then((r) => r.result);
    /** Top-left of a frame's viewport in the tab viewport, from the page's own layout. */
    const origin = async (frameId: string): Promise<{ x: number; y: number }> => {
      const frame = frames.find((f) => f.frameId === frameId)!;
      if (!frame.parentId) return { x: 0, y: 0 };
      const parent = await origin(frame.parentId);
      const index = frames
        .filter((f) => f.parentId === frame.parentId)
        .findIndex((f) => f.frameId === frameId);
      const own = await evaluate(
        frame.parentId,
        `const e = document.querySelectorAll('iframe')[${index}], r = e.getBoundingClientRect(), s = getComputedStyle(e);
         return { x: r.left + e.clientLeft + parseFloat(s.paddingLeft), y: r.top + e.clientTop + parseFloat(s.paddingTop) };`,
      );
      return { x: parent.x + own.x, y: parent.y + own.y };
    };
    for (const [selector, match] of [
      ['#button', (url: string) => url.includes('/page')],
      ['#same-button', (url: string) => url.endsWith('/same')],
      ['#frame-button', (url: string) => url.endsWith('/frame')],
      ['#nested-button', (url: string) => url.endsWith('/nested')],
    ] as const) {
      const frame = frames.find((f) => match(f.url))!;
      const frameId = frame.parentId ? frame.frameId : undefined;
      const rect = await evaluate(
        frameId,
        `const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height };`,
      );
      const base = await origin(frame.frameId);
      const { elements } = await call('browser_find', { tabId, frameId, selector });
      const snapshot = await call('browser_snapshot', { tabId, frameId, interactiveOnly: true });
      const node = snapshot.nodes.find((n: any) => n.ref === elements[0].ref);
      expect(node).toBeDefined();
      for (const [key, value] of Object.entries({
        x: base.x + rect.x,
        y: base.y + rect.y,
        width: rect.width,
        height: rect.height,
      }))
        expect(Math.abs(node.box[key] - value)).toBeLessThanOrEqual(1);
    }
    const visible = await call('browser_snapshot', {
      tabId,
      interactiveOnly: true,
      viewportOnly: true,
    });
    expect(visible.nodes.some((n: any) => n.name === 'bottom')).toBe(false);

    const marked = await tool('browser_screenshot', { tabId, marks: 'interactive' });
    expect(marked.isError).toBeFalsy();
    const { legend } = marked.structuredContent as any;
    expect(legend.some((entry: any) => entry.role === 'button' && entry.name === 'Click')).toBe(
      true,
    );
    const image = decodePng(Buffer.from((marked.content[0] as any).data, 'base64'));
    const dpr = await evaluate(undefined, 'return devicePixelRatio');
    expect(image.width).toBe(Math.round(visible.viewport.width * dpr));
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fixture.server.stop();
  }
});
