import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Browser, NodriverError } from '../../src/index.ts';
import { serve } from '../fixtures/serve.ts';

test('clearSiteData clears one site and keeps another logged in', async () => {
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
    await server.stop();
  }
});
