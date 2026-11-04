import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from '../fixtures/expect.ts';
import { Browser, ProtocolError, type Route, type Tab } from '../../src/index.ts';
import { fixtureServer } from '../fixtures/server.ts';
import { delay } from '../../src/utils.ts';

const headless = process.env.NODRIVER_HEADFUL !== '1';

async function page(run: (tab: Tab, errors: unknown[]) => Promise<void>) {
  const fixture = await fixtureServer();
  const browser = await Browser.launch({ headless });
  const errors: unknown[] = [];
  browser.errors.on((error) => {
    errors.push(error);
  });
  try {
    await run(await browser.newTab(fixture.base + '/empty'), errors);
  } finally {
    await browser.close();
    await fixture.server.stop();
  }
}

/** A route handler that keeps its request paused until release(), then answers it. */
function hold(answer: (route: Route) => Promise<void>) {
  let enter!: (route: Route) => void;
  let open!: () => void;
  let finish!: () => void;
  const entered = new Promise<Route>((resolve) => (enter = resolve));
  const gate = new Promise<void>((resolve) => (open = resolve));
  const finished = new Promise<void>((resolve) => (finish = resolve));
  return {
    entered,
    handler: async (route: Route) => {
      enter(route);
      await gate;
      await answer(route).finally(finish);
    },
    release: () => {
      open();
      return finished;
    },
  };
}

test('an answer Chrome refuses leaves the request to the handler and the fallback', () =>
  page(async (tab, errors) => {
    let refusal: unknown;
    await tab.network.route(/\/json\?caught$/, async (route) => {
      refusal = await route.fulfill({ status: 0 }).catch((e: unknown) => e);
    });
    await tab.network.route(/\/json\?retried$/, (route) =>
      route.fulfill({ status: 0 }).catch(() => route.fulfill({ body: 'second answer' })),
    );
    await tab.network.route(/\/json\?thrown$/, (route) => route.fulfill({ status: 0 }));
    expect(await tab.evaluate('fetch("/json?caught").then((r) => r.json())')).toEqual({
      value: 42,
    });
    expect(refusal).toBeInstanceOf(ProtocolError);
    expect(await tab.evaluate('fetch("/json?retried").then((r) => r.text())')).toBe(
      'second answer',
    );
    expect(errors).toEqual([]);
    expect(await tab.evaluate('fetch("/json?thrown").then(() => "loaded", () => "failed")')).toBe(
      'failed',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ProtocolError);
  }));

test('answering a request the page cancelled is not an error', () =>
  page(async (tab, errors) => {
    const held = hold((route) => route.continue());
    await tab.network.route(/\/json\?cancelled$/, held.handler);
    await tab.evaluate(`void (globalThis.controller = new AbortController(),
      globalThis.pending = fetch('/json?cancelled', { signal: controller.signal })
        .catch((error) => error.name))`);
    const route = await held.entered;
    expect(await tab.evaluate('controller.abort(), pending')).toBe('AbortError');
    await delay(100);
    await held.release();
    // A rejected answer reaches `errors` a few microtasks after the handler settles.
    await delay(50);
    expect(route.done).toBe(true);
    expect(errors).toEqual([]);
  }));

test('unroute releases a paused request; the late answer is not an error', () =>
  page(async (tab, errors) => {
    const held = hold((route) => route.abort());
    const unroute = await tab.network.route(/\/json\?released$/, held.handler);
    await tab.evaluate(`void (globalThis.pending = fetch('/json?released').then((r) => r.json()))`);
    await held.entered;
    await unroute();
    expect(await tab.evaluate('pending')).toEqual({ value: 42 });
    await held.release();
    await delay(50);
    expect(errors).toEqual([]);
  }));

test('extra headers reach the wire only once Chrome accepts them', async () => {
  const seen: unknown[] = [];
  const server = createServer((request, response) => {
    // Chrome requests the favicon too, sending non-Latin-1 header text there as '?'.
    if (request.url === '/') seen.push(request.headers['x-name']);
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await Browser.launch({ headless });
  try {
    const tab = await browser.newTab(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await expect(
      tab.network.setExtraHeaders({ 'x-name': 'bad\r\ninjected: 1' }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(tab.network.networkEnabled).toBe(false);
    // Chrome sends text as UTF-8 bytes, which Node's parser reads as Latin-1.
    const bytes = Buffer.from('中文').toString('latin1');
    await tab.network.setExtraHeaders({ 'x-name': '中文' });
    await tab.reload();
    expect(seen.at(-1)).toBe(bytes);
    // `Headers` trims this value, but Chrome validates it as given.
    await expect(tab.network.setExtraHeaders({ 'x-name': 'trailing\n' })).rejects.toBeInstanceOf(
      ProtocolError,
    );
    await tab.reload();
    expect(seen.at(-1)).toBe(bytes);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
