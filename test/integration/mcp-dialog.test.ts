import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { BrowserSessionManager } from '../../src/mcp/manager.ts';
import { createBrowserMcpServer } from '../../src/mcp/server.ts';
import { poll } from '../../src/utils.ts';
import { serve } from '../fixtures/serve.ts';

const page = `<!doctype html><title>Dialogs</title>
<button id="ask" onclick="globalThis.answer = confirm('Proceed?')">Ask</button>
<button id="ok" onclick="globalThis.clicks = (globalThis.clicks || 0) + 1">OK</button>`;
/** Longer than the input cleanup budget, which must not run out while a dialog is open. */
const PAST_CLEANUP_BUDGET = 5500;

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const site = await serve({
    hostname: '127.0.0.1',
    fetch: () => new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  const manager = new BrowserSessionManager({
    launch: { headless: process.env.NODRIVER_HEADFUL !== '1', transport: 'pipe' },
  });
  t.after(async () => {
    await manager.close();
    await site.stop();
  });
  const connect = async () => {
    const lease = manager.create('alice');
    const server = createBrowserMcpServer({}, { manager, principal: 'alice', leaseId: lease.id });
    const client = new Client(
      { name: 'dialogs', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    t.after(() => client.close());
    const tool = (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
      client.callTool({ name, arguments: args }, { signal }) as Promise<CallToolResult>;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await tool(name, args);
      if (result.isError) throw new Error(JSON.stringify(result.content));
      return result.structuredContent as any;
    };
    return { client, tool, call, session: manager.session('alice', lease.id) };
  };
  return { url: `http://127.0.0.1:${site.port}/`, connect };
}

test('a click that opens a dialog returns at once, holds the queues and input recovers afterwards', async (t) => {
  const { url, connect } = await fixture(t);
  const { call, tool, session } = await connect();
  const { tabId } = await call('browser_open', { url });
  const ref = async (selector: string) =>
    (await call('browser_find', { tabId, selector })).elements[0].ref as string;
  const ask = await ref('#ask'),
    ok = await ref('#ok');

  const begin = performance.now();
  const reply = await call('browser_click', { tabId, ref: ask });
  expect(performance.now() - begin).toBeLessThan(5000);
  expect(reply).toMatchObject({
    tabId,
    pending: true,
    tabClosed: false,
    dialog: { type: 'confirm', message: 'Proceed?' },
  });
  expect(reply.clicked).toBeUndefined();

  // Tools that answer dialogs bypass the queue; others wait their turn and may give up.
  const status = await call('browser_tabs');
  expect(status.queuedOperations).toBe(1);
  expect(status.tabs[0].dialog).toMatchObject({ type: 'confirm' });
  const cancel = new AbortController();
  const waiting = tool('browser_snapshot', { tabId }, cancel.signal).catch((error: Error) => error);
  await sleep(100);
  cancel.abort();
  expect(await waiting).toBeInstanceOf(Error);

  // Another lease on this browser waits for the shared allocation queue.
  const other = await connect();
  let opened = false;
  const second = other.call('browser_open').then(() => {
    opened = true;
  });
  await sleep(PAST_CLEANUP_BUDGET);
  expect(opened).toBe(false);

  await call('browser_dialog', { tabId, accept: true });
  await second;
  expect(await call('browser_click', { tabId, ref: ok })).toMatchObject({ clicked: ok });
  expect(
    (await call('browser_evaluate', { tabId, script: 'return [answer, clicks];' })).value,
  ).toEqual([true, 1]);
  const { events } = session.eventLog();
  expect(events.map((event) => event.type)).toContain('action-completed');
  expect(events.some((event) => event.type === 'action-failed')).toBe(false);
  const info = (await call('browser_tabs')).tabs.find((entry: any) => entry.tabId === tabId);
  expect(info.lastInput).toEqual({
    action: 'click',
    status: 'completed',
    events: expect.any(Number),
    completedSegments: 0,
    cleanup: 'completed',
  });
});

test('a pending click whose deadline passes fails in the background, and input recovers', async (t) => {
  const { url, connect } = await fixture(t);
  const { call, session } = await connect();
  const { tabId } = await call('browser_open', { url });
  const ref = async (selector: string) =>
    (await call('browser_find', { tabId, selector })).elements[0].ref as string;
  const ask = await ref('#ask'),
    ok = await ref('#ok');
  const reply = await call('browser_click', { tabId, ref: ask, timeout: 1000 });
  expect(reply).toMatchObject({ pending: true, dialog: { type: 'confirm' } });
  const failed = await poll(
    async () => session.eventLog().events.find((event) => event.type === 'action-failed'),
    { timeout: 5000 },
  );
  expect(failed.tabId).toBe(tabId);
  expect(failed.error).toContain('Input deadline exceeded');
  // The queues are free again, so the agent can still close what it cannot answer.
  expect((await call('browser_tabs')).queuedOperations).toBe(0);
  await sleep(PAST_CLEANUP_BUDGET);
  await call('browser_dialog', { tabId, accept: false });
  expect(await call('browser_click', { tabId, ref: ok })).toMatchObject({ clicked: ok });
  expect(
    (await call('browser_evaluate', { tabId, script: 'return [answer, clicks];' })).value,
  ).toEqual([false, 1]);
});

test('an action on a tab whose dialog is already open returns at once and closing the tab ends it', async (t) => {
  const { url, connect } = await fixture(t);
  const { call, session } = await connect();
  const { tabId } = await call('browser_open', { url });
  const ok = (await call('browser_find', { tabId, selector: '#ok' })).elements[0].ref as string;
  await call('browser_evaluate', { tabId, script: 'alert("From a script");', timeout: 100 }).catch(
    () => {},
  );
  const status = await call('browser_tabs');
  expect(status.queuedOperations).toBe(0);
  expect(status.tabs[0].dialog).toMatchObject({ type: 'alert' });
  const begin = performance.now();
  const reply = await call('browser_click', { tabId, ref: ok, timeout: 1000 });
  expect(performance.now() - begin).toBeLessThan(900);
  expect(reply).toMatchObject({ pending: true, dialog: { type: 'alert' } });
  await poll(
    async () => session.eventLog().events.find((event) => event.type === 'action-failed'),
    { timeout: 5000 },
  );
  await call('browser_close_tab', { tabId });
  const { tabId: next } = await call('browser_open', { url });
  const again = (await call('browser_find', { tabId: next, selector: '#ok' })).elements[0]
    .ref as string;
  expect(await call('browser_click', { tabId: next, ref: again })).toMatchObject({
    clicked: again,
  });
});
