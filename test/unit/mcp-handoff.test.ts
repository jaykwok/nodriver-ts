import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect } from '../fixtures/expect.ts';
import { Browser } from '../../src/browser/browser.ts';
import { framePoint, type RemoteHandoffAudit } from '../../src/mcp/handoff.ts';
import { createBrowserMcpHttpService } from '../../src/mcp/http.ts';
import { createBrowserMcpServer } from '../../src/mcp/server.ts';
import type { BrowserSessionManagerOptions } from '../../src/mcp/manager.ts';
import { ScriptedChrome } from '../../src/testing/index.ts';

const origin = 'http://127.0.0.1:3100';
const metadata = {
  offsetTop: 0,
  pageScaleFactor: 1,
  deviceWidth: 800,
  deviceHeight: 600,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
};

test('a position in a frame maps to the tab viewport', () => {
  expect(framePoint(0.5, 0.25, metadata)).toEqual({ x: 400, y: 150 });
  expect(framePoint(1, 1, { ...metadata, offsetTop: 40 })).toEqual({ x: 800, y: 640 });
});

async function fixture(
  t: TestContext,
  options: Partial<BrowserSessionManagerOptions> = {},
  remote: object = { linkInResult: true },
) {
  const chrome = await ScriptedChrome.start();
  const audit: RemoteHandoffAudit[] = [];
  chrome.handle('Page.bringToFront', () => {});
  chrome.handle('Page.startScreencast', () => {});
  chrome.handle('Page.stopScreencast', () => {});
  chrome.handle('Page.screencastFrameAck', () => {});
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
  chrome.handle('Input.dispatchMouseEvent', () => {});
  chrome.handle('Input.dispatchKeyEvent', () => {});
  chrome.handle('Input.insertText', () => {});
  chrome.handle('Page.navigate', () => ({ frameId: 'f' }));
  const browser = await chrome.connect();
  t.mock.method(Browser, 'launch', async () => browser);
  const service = createBrowserMcpHttpService({
    tokens: { ['x'.repeat(32)]: 'alice' },
    browser: {
      ...options,
      remoteHandoff: { audit: (entry: RemoteHandoffAudit) => audit.push(entry), ...remote },
    },
  });
  const manager = service.manager;
  const { id } = manager.create('alice');
  const server = createBrowserMcpServer(
    {},
    { manager, principal: 'alice', leaseId: id, handoffOrigin: () => origin },
  );
  const client = new Client(
    { name: 'tools', version: '1' },
    {
      capabilities: { elicitation: { url: {} } },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => {
    await client.close();
    await service.close();
    await browser.close().catch(() => {});
    await chrome.close();
  });
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { reply, data: reply.structuredContent as Record<string, any> };
  };
  const { data: opened } = await tool('browser_open', {});
  const session = manager.session('alice', id);
  const get = (path: string, headers: Record<string, string> = {}) =>
    service.fetch(new Request(origin + path, { headers: { host: '127.0.0.1:3100', ...headers } }));
  const post = (path: string, cookie: string, body?: unknown, headers = {}) =>
    service.fetch(
      new Request(origin + path, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3100',
          cookie,
          origin,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body ?? {}),
      }),
    );
  /** Exchanges the link's token for the viewer cookie. */
  const open = async (url: string) => {
    const response = await get(url.slice(origin.length));
    expect(response.status).toBe(200);
    const header = response.headers.get('set-cookie')!;
    return { response, header, cookie: header.split(';')[0]! };
  };
  return {
    chrome,
    browser,
    tool,
    client,
    manager,
    session,
    leaseId: id,
    tabId: opened.tabId as string,
    get,
    post,
    open,
    audit,
    service,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const start = async (f: Fixture, extra: Record<string, unknown> = {}) => {
  const { data } = await f.tool('browser_handoff', { tabId: f.tabId, mode: 'remote', ...extra });
  return data as { handoffId: string; expiresAt: number; url: string };
};
const frame = (f: Fixture, sessionId = 1) => {
  const tab = f.browser.tabs.find((t) => t.id === f.tabId)!;
  f.chrome.emit(
    'Page.screencastFrame',
    { data: Buffer.from('jpeg').toString('base64'), metadata, sessionId },
    tab.session.id,
  );
};
const count = (f: Fixture, method: string) =>
  f.chrome.commands.filter((c) => c.method === method).length;

test('a link works once and leaves a strict, path-bound cookie without a redirect', async (t) => {
  const f = await fixture(t);
  const { url, handoffId } = await start(f);
  const { response, header } = await f.open(url);
  expect(header).toMatch(new RegExp(`HttpOnly; SameSite=Strict; Path=/handoff/${handoffId}$`));
  const page = await response.text();
  expect(page).toContain(`content="0;url=/handoff/${handoffId}"`);
  expect(page).not.toContain('token');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect((await f.get(url.slice(origin.length))).status).toBe(403);
});

test('a wrong token, missing cookie or other handoff gets nothing', async (t) => {
  const f = await fixture(t);
  const { url, handoffId } = await start(f);
  const path = `/handoff/${handoffId}`;
  expect((await f.get(`${path}?token=wrong`)).status).toBe(403);
  expect((await f.get(path)).status).toBe(403);
  expect((await f.get(`${path}/frames`)).status).toBe(403);
  expect((await f.get(`${path}/viewer.js`)).status).toBe(403);
  expect((await f.post(`${path}/done`, 'nodriver_handoff=forged')).status).toBe(403);
  expect((await f.get('/handoff/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  // The wrong attempts did not use up the link.
  await f.open(url);
});

test('the viewer page is locked down and its script is a separate file', async (t) => {
  const f = await fixture(t);
  const { url, handoffId } = await start(f);
  const { cookie } = await f.open(url);
  const page = await f.get(`/handoff/${handoffId}`, { cookie });
  const csp = page.headers.get('content-security-policy')!;
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-inline');
  const body = await page.text();
  expect(body).toContain(`src="/handoff/${handoffId}/viewer.js"`);
  expect(body).not.toMatch(/<script>|onclick=|<style/);
  const script = await f.get(`/handoff/${handoffId}/viewer.js`, { cookie });
  expect(script.headers.get('content-type')).toContain('javascript');
});

test('cross-origin and cross-site requests are refused', async (t) => {
  const f = await fixture(t);
  const { url, handoffId } = await start(f);
  const { cookie } = await f.open(url);
  const input = `/handoff/${handoffId}/input`;
  const key = { kind: 'text', text: 'x' };
  expect((await f.post(input, cookie, key, { origin: 'http://evil.test' })).status).toBe(403);
  const noOrigin = await f.service.fetch(
    new Request(origin + input, {
      method: 'POST',
      headers: { host: '127.0.0.1:3100', cookie, 'content-type': 'application/json' },
      body: JSON.stringify(key),
    }),
  );
  expect(noOrigin.status).toBe(403);
  expect(
    (await f.get(`/handoff/${handoffId}/frames`, { cookie, 'sec-fetch-site': 'cross-site' }))
      .status,
  ).toBe(403);
  expect(count(f, 'Input.insertText')).toBe(0);
  const badHost = await f.service.fetch(
    new Request('http://evil.test/handoff/' + handoffId, { headers: { host: 'evil.test' } }),
  );
  expect(badHost.status).toBe(403);
});

test('frames are acknowledged only after the viewer has read them', async (t) => {
  const f = await fixture(t);
  const { url, handoffId } = await start(f);
  const { cookie } = await f.open(url);
  const controller = new AbortController();
  const stream = await f.service.fetch(
    new Request(`${origin}/handoff/${handoffId}/frames`, {
      headers: { host: '127.0.0.1:3100', cookie },
      signal: controller.signal,
    }),
  );
  expect(stream.headers.get('content-type')).toBe('text/event-stream');
  const reader = stream.body!.getReader();
  frame(f);
  await sleep(30);
  expect(count(f, 'Page.screencastFrameAck')).toBe(0);
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain('event: frame');
  // Reading the frame is not enough: asking for what follows shows it was consumed.
  await sleep(10);
  expect(count(f, 'Page.screencastFrameAck')).toBe(0);
  const next = reader.read();
  await sleep(30);
  expect(count(f, 'Page.screencastFrameAck')).toBe(1);
  await f.post(`/handoff/${handoffId}/done`, cookie);
  expect(new TextDecoder().decode((await next).value)).toContain('"reason":"completed"');
  expect(count(f, 'Page.stopScreencast')).toBe(1);
});

test('input maps to CDP in order, with the frame geometry', async (t) => {
  const f = await fixture(t);
  const { url, handoffId } = await start(f);
  const { cookie } = await f.open(url);
  const input = `/handoff/${handoffId}/input`;
  // Pointer input needs a frame to be relative to; text does not.
  const early = await f.post(input, cookie, { kind: 'mouse', action: 'move', x: 0, y: 0 });
  expect(early.status).toBe(409);
  const stream = await f.get(`/handoff/${handoffId}/frames`, { cookie });
  const reader = stream.body!.getReader();
  frame(f);
  await reader.read();
  const send = async (event: unknown) =>
    expect((await f.post(input, cookie, event)).status).toBe(204);
  await send({ kind: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 'left', clickCount: 1 });
  await send({ kind: 'wheel', x: 0.25, y: 0, deltaX: 0, deltaY: 120 });
  await send({ kind: 'key', action: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' });
  await send({ kind: 'key', action: 'up', key: 'a', code: 'KeyA', keyCode: 65 });
  await send({ kind: 'text', text: '中文' });
  const sent = (f.chrome.commands as Array<{ method: string; params: unknown }>).filter((c) =>
    c.method.startsWith('Input.'),
  );
  expect(sent.map((c): unknown[] => [c.method, c.params])).toEqual([
    [
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: 400,
        y: 300,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
      },
    ],
    [
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: 200, y: 0, deltaX: 0, deltaY: 120, modifiers: 0 },
    ],
    [
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyDown', key: 'a', text: 'a', windowsVirtualKeyCode: 65 }),
    ],
    ['Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp', key: 'a' })],
    ['Input.insertText', { text: '中文' }],
  ]);
  expect((await f.post(input, cookie, { kind: 'exec', code: 'x' })).status).toBe(400);
  await reader.cancel();
});

test('other tools are refused during a handoff, and work again after it', async (t) => {
  const f = await fixture(t);
  const { handoffId, url } = await start(f);
  const { reply, data } = await f.tool('browser_snapshot', { tabId: f.tabId });
  expect(reply.isError).toBe(true);
  expect(data.error).toBe('HandoffActiveError');
  expect(data.message).toContain(handoffId);
  expect((await f.tool('browser_handoff', { tabId: f.tabId, mode: 'remote' })).reply.isError).toBe(
    true,
  );
  expect((await f.tool('browser_tabs')).reply.isError).toBeFalsy();
  const { cookie } = await f.open(url);
  const waited = await f.tool('browser_handoff_wait', { handoffId, timeout: 20 });
  expect(waited.data).toMatchObject({ state: 'active', connected: true });
  await f.post(`/handoff/${handoffId}/done`, cookie);
  const ended = await f.tool('browser_handoff_wait', { handoffId, timeout: 1000 });
  expect(ended.data).toMatchObject({ state: 'ended', reason: 'completed', tabId: f.tabId });
  expect((await f.tool('browser_tabs')).reply.isError).toBeFalsy();
  expect(f.session.remote).toBeUndefined();
  // The cookie of an ended handoff opens nothing.
  expect((await f.get(`/handoff/${handoffId}`, { cookie })).status).toBe(403);
});

test('cancel and expiry end a handoff, and the lease stays retained until then', async (t) => {
  const f = await fixture(t, { leaseIdleMs: 200 });
  const first = await start(f);
  const lease = () => f.manager.list('alice').find((l) => l.id === f.leaseId)!;
  expect(lease().active).toBe(1);
  await sleep(250);
  await f.manager.sweep();
  expect(lease()).toBeDefined();
  const cancelled = await f.tool('browser_handoff_wait', {
    handoffId: first.handoffId,
    cancel: true,
  });
  expect(cancelled.data).toMatchObject({ state: 'ended', reason: 'cancelled' });
  expect(lease().active).toBe(0);
  const expiring = await start(f, { resumeCondition: { url: 'https://never/*', timeout: 30 } });
  await sleep(80);
  expect(
    (await f.tool('browser_handoff_wait', { handoffId: expiring.handoffId, timeout: 1 })).data,
  ).toMatchObject({ state: 'ended', reason: 'expired' });
});

test('a resume condition ends the handoff when the page reaches it', async (t) => {
  const f = await fixture(t);
  let found = false;
  f.chrome.handle('Runtime.evaluate', () => ({ result: { type: 'boolean', value: found } }));
  const { handoffId } = await start(f, {
    resumeCondition: { url: '*about:blank*', selector: '#signed-in', timeout: 60_000 },
  });
  await sleep(20);
  expect((await f.tool('browser_handoff_wait', { handoffId, timeout: 1 })).data.state).toBe(
    'active',
  );
  found = true;
  expect((await f.tool('browser_handoff_wait', { handoffId, timeout: 2000 })).data).toMatchObject({
    state: 'ended',
    reason: 'condition',
  });
});

test('the audit log has the lifecycle and the input count, never the input', async (t) => {
  const f = await fixture(t);
  const { url, handoffId } = await start(f);
  const { cookie } = await f.open(url);
  await f.post(`/handoff/${handoffId}/input`, cookie, { kind: 'text', text: 'hunter2' });
  await f.post(`/handoff/${handoffId}/done`, cookie);
  expect(f.audit.map((e) => e.event)).toEqual(['started', 'connected', 'ended']);
  expect(f.audit[2]).toMatchObject({ reason: 'completed', inputs: 1, principal: 'alice' });
  expect(JSON.stringify(f.audit)).not.toContain('hunter2');
  const { events } = f.session.eventLog();
  const types = events.map((e) => e.type);
  for (const type of ['handoff-started', 'handoff-connected', 'handoff-ended'])
    expect(types).toContain(type);
});

test('by default the link goes through URL elicitation, not into the result', async (t) => {
  const f = await fixture(t, {}, {});
  let shown: string | undefined;
  let action: 'accept' | 'decline' = 'accept';
  f.client.setRequestHandler('elicitation/create', async (request) => {
    shown = (request.params as { url?: string }).url;
    return { action };
  });
  const { data, reply } = await f.tool('browser_handoff', { tabId: f.tabId, mode: 'remote' });
  expect(shown).toMatch(/\/handoff\/[0-9a-f-]+\?token=/);
  expect(JSON.stringify(reply)).not.toContain('token=');
  expect(data.url).toBeUndefined();
  expect(data.handoffId).toEqual(expect.any(String));
  await f.tool('browser_handoff_wait', { handoffId: data.handoffId, cancel: true });
  action = 'decline';
  const declined = await f.tool('browser_handoff', { tabId: f.tabId, mode: 'remote' });
  expect(declined.data.completed).toBe(false);
  expect(f.session.remote).toBeUndefined();
});

test('remote handoff stays off unless the host enables it', async (t) => {
  const browser = {} as Browser;
  t.mock.method(Browser, 'launch', async () => browser);
  const service = createBrowserMcpHttpService({ tokens: { ['y'.repeat(32)]: 'bob' } });
  t.after(() => service.close());
  const server = createBrowserMcpServer(
    {},
    {
      manager: service.manager,
      principal: 'bob',
      leaseId: service.manager.create('bob').id,
    },
  );
  const client = new Client(
    { name: 'tools', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).not.toContain('browser_handoff_wait');
});
