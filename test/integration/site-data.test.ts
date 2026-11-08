import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Browser, NodriverError } from '../../src/index.ts';
import { serve } from '../fixtures/serve.ts';

test('clearSiteData clears one site and keeps another logged in', async (t) => {
  const server = await serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      const write = url.searchParams.has('write');
      return new Response(
        write
          ? `<script>localStorage.setItem('k', location.host); sessionStorage.setItem('s', '1');
indexedDB.open('db').onsuccess = () => (window.ready = true);</script>`
          : '<p>plain',
        {
          headers: {
            'content-type': 'text/html',
            ...(write ? { 'set-cookie': `login=${url.hostname}; Path=/` } : {}),
          },
        },
      );
    },
  });
  t.after(() => server.stop());
  const platform = `http://platform.localhost:${server.port}`;
  const admin = `http://admin.localhost:${server.port}`;
  await using browser = await Browser.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const site = await context.newTab(platform + '/?write');
    const kept = await context.newTab(admin + '/?write');
    for (const tab of [site, kept]) await tab.waitForFunction('window.ready === true');

    const refused = await context
      .clearSiteData({ domains: ['localhost'] })
      .catch((error: unknown) => error);
    assert.ok(refused instanceof NodriverError);
    assert.match(refused.message, /openTabs/);
    assert.equal((await context.cookies()).length, 2);

    const result = await context.clearSiteData({
      domains: ['platform.localhost'],
      openTabs: 'blank',
    });
    assert.deepEqual(result.tabs, [site.id]);
    assert.deepEqual(result.cookies, [{ name: 'login', domain: 'platform.localhost', path: '/' }]);
    assert.ok(result.origins.includes(platform));
    assert.equal(site.url, 'about:blank');

    assert.deepEqual(
      (await context.cookies()).map((c) => `${c.name}@${c.domain}`),
      ['login@admin.localhost'],
    );
    assert.equal(
      await kept.evaluate("localStorage.getItem('k')"),
      `admin.localhost:${server.port}`,
    );
    await site.goto(platform + '/');
    assert.equal(await site.evaluate('localStorage.length'), 0);
    assert.equal(await site.evaluate('sessionStorage.length'), 0);
    assert.equal(await site.evaluate('indexedDB.databases().then((d) => d.length)'), 0);
    assert.equal(await kept.evaluate('indexedDB.databases().then((d) => d.length)'), 1);

    // An origin alone, closing its tab; cookies are kept when not requested.
    const closed = await context.clearSiteData({
      origins: [admin],
      types: ['localStorage'],
      openTabs: 'close',
    });
    assert.deepEqual(closed, { cookies: [], origins: [admin], tabs: [kept.id] });
    assert.equal(kept.closed, true);
    assert.equal((await context.cookies()).length, 1);
    await site.goto(admin + '/');
    assert.equal(await site.evaluate('localStorage.length'), 0);

    await assert.rejects(context.clearSiteData({}), TypeError);
    await assert.rejects(context.clearSiteData({ domains: ['a.test/x'] }), TypeError);
    await assert.rejects(context.clearSiteData({ origins: ['file:///x'] }), TypeError);
  } finally {
    await context.close();
  }
});

/** A page that writes localStorage and sessionStorage for its origin when asked with ?write. */
async function storageSite(t: { after(fn: () => unknown): void }) {
  const server = await serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      new Response(
        new URL(request.url).searchParams.has('write')
          ? `<script>localStorage.setItem('k', '1'); sessionStorage.setItem('s', '1');</script>`
          : '<p>plain',
        { headers: { 'content-type': 'text/html' } },
      ),
  });
  t.after(() => server.stop());
  return `http://127.0.0.1:${server.port}`;
}

test('an exact origin leaves another port of the same host untouched', async (t) => {
  const wanted = await storageSite(t);
  const other = await storageSite(t);
  await using browser = await Browser.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const kept = await context.newTab(other + '/?write');
    const site = await context.newTab(wanted + '/?write');
    const result = await context.clearSiteData({
      origins: [wanted],
      types: ['localStorage', 'sessionStorage'],
      openTabs: 'blank',
    });
    assert.deepEqual(result.tabs, [site.id]);
    assert.equal(kept.url, other + '/?write');
    assert.equal(await kept.evaluate("sessionStorage.getItem('s')"), '1');
    assert.equal(await kept.evaluate("localStorage.getItem('k')"), '1');
    await site.goto(wanted + '/');
    assert.equal(await site.evaluate('localStorage.length'), 0);
    assert.equal(await site.evaluate('sessionStorage.length'), 0);
  } finally {
    await context.close();
  }
});

test('sessionStorage a tab kept after navigating away is cleared by visiting the origin', async (t) => {
  const origin = await storageSite(t);
  await using browser = await Browser.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const tab = await context.newTab(origin + '/?write');
    await tab.goto('about:blank');
    await assert.rejects(
      context.clearSiteData({ origins: [origin], types: ['sessionStorage'] }),
      /sessionStorage/,
    );
    const result = await context.clearSiteData({
      origins: [origin],
      types: ['sessionStorage'],
      openTabs: 'blank',
    });
    assert.deepEqual(result.tabs, [tab.id]);
    assert.equal(tab.url, 'about:blank');
    await tab.goto(origin + '/');
    assert.equal(await tab.evaluate('sessionStorage.length'), 0);
  } finally {
    await context.close();
  }
});

for (const transport of ['pipe', 'websocket'] as const) {
  test(`${transport}: a detached page can be reattached before clearing its site data`, async (t) => {
    const origin = await storageSite(t);
    await using browser = await Browser.launch({ headless: true, transport });
    const context = browser.defaultContext;
    const first = await browser.newTab(origin + '/?write');
    await browser.cdp.send('Target.detachFromTarget', { sessionId: first.session.id! });
    assert.equal(first.closed, true);
    assert.ok(browser.pageTargets.some((info) => info.targetId === first.id));
    await assert.rejects(
      context.clearSiteData({
        origins: [origin],
        types: ['localStorage', 'sessionStorage'],
        openTabs: 'blank',
      }),
      /attachTarget/,
    );

    const adopted = await browser.attachTarget(first.id);
    assert.equal(adopted.closed, false);
    assert.notEqual(adopted, first);
    assert.notEqual(adopted.session.id, first.session.id);
    assert.deepEqual(
      await adopted.evaluate(
        "({ local: localStorage.getItem('k'), session: sessionStorage.getItem('s') })",
      ),
      { local: '1', session: '1' },
    );
    const result = await context.clearSiteData({
      origins: [origin],
      types: ['localStorage', 'sessionStorage'],
      openTabs: 'blank',
    });
    assert.deepEqual(result.tabs, [adopted.id]);
    assert.equal(adopted.url, 'about:blank');
    await adopted.goto(origin + '/');
    assert.equal(await adopted.evaluate('localStorage.length'), 0);
    assert.equal(await adopted.evaluate('sessionStorage.length'), 0);
  });
}

test('a reattach during origin collection reads sessionStorage origins from the new session', async (t) => {
  const origin = await storageSite(t);
  const other = await storageSite(t);
  await using owner = await Browser.launch({ headless: true, transport: 'websocket' });
  const page = await owner.newTab(origin + '/?write');
  await page.goto(other + '/');
  await using client = await Browser.connect({ endpoint: owner.endpoint! });
  const first = client.tabs.find((tab) => tab.id === page.id)!;
  const sendWith = first.cdp.sendWith;
  let adopted!: typeof first;
  // Delay this real command until the old session has been replaced; the page and its
  // navigation history remain in Chrome throughout.
  t.mock.method(first.cdp, 'sendWith', (async (...args: Parameters<typeof sendWith>) => {
    if (args[0] === 'Page.getNavigationHistory') {
      await client.cdp.send('Target.detachFromTarget', { sessionId: first.session.id! });
      adopted = await client.attachTarget(first.id);
    }
    return Reflect.apply(sendWith, first.cdp, args);
  }) as typeof sendWith);
  await assert.rejects(
    client.defaultContext.clearSiteData({ origins: [origin], types: ['sessionStorage'] }),
    /sessionStorage/,
  );
  assert.equal(adopted.closed, false);
  assert.notEqual(adopted, first);
  const result = await client.defaultContext.clearSiteData({
    origins: [origin],
    types: ['sessionStorage'],
    openTabs: 'blank',
  });
  assert.deepEqual(result.tabs, [page.id]);
  await adopted.goto(origin + '/');
  assert.equal(await adopted.evaluate('sessionStorage.length'), 0);
});

test('a connected client clears the origins of tabs it found and pages it did not attach', async (t) => {
  const origin = await storageSite(t);
  const site = origin.replace('127.0.0.1', 'app.localhost');
  await using browser = await Browser.launch({ headless: true, transport: 'websocket' });
  const owned = await browser.newTab(site + '/?write');
  const watcher = await Browser.connect({ endpoint: browser.endpoint! });
  try {
    const result = await watcher.defaultContext.clearSiteData({
      domains: ['localhost'],
      types: ['localStorage'],
      openTabs: 'blank',
    });
    assert.ok(result.origins.includes(site));
    await owned.goto(site + '/');
    assert.equal(await owned.evaluate('localStorage.length'), 0);
  } finally {
    await watcher.close();
  }
  await owned.goto(site + '/?write');
  const client = await Browser.connect({ endpoint: browser.endpoint!, attach: 'created' });
  try {
    const open = client.pageTargets.find((info) => info.targetId === owned.id);
    assert.ok(open);
    await assert.rejects(
      client.defaultContext.clearSiteData({ domains: ['localhost'], types: ['localStorage'] }),
      NodriverError,
    );
    assert.equal(await owned.evaluate('localStorage.length'), 1);
  } finally {
    await client.close();
  }
});
