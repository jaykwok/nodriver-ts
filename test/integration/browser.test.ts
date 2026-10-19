import { serve } from '../fixtures/serve.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { removeTree } from '../../src/utils.ts';
import { after, before, describe, test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, EvaluationError, StaleElementError, TimeoutError } from '../../src/index.ts';
import type { Tab } from '../../src/index.ts';
import { fixtureServer } from '../fixtures/server.ts';

const selectAll = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
const fixture = await fixtureServer();
let browser: Browser;
const errors: unknown[] = [];
before(async () => {
  browser = await Browser.launch({
    headless: process.env.NODRIVER_HEADFUL !== '1',
    timeout: 15_000,
    args: ['--site-per-process'],
    onError: (e) => errors.push(e),
  });
});
after(async () => {
  if (browser) await browser.close();
  await fixture.server.stop();
  if (errors.length) console.error('background errors:', errors);
});
async function page(fn: (tab: Tab) => Promise<void>, url = '/page') {
  const tab = await browser.newTab(fixture.base + url);
  try {
    await fn(tab);
  } finally {
    await tab.close();
  }
}
describe('browser and page', () => {
  test('main/isolated worlds, non-JSON values, exceptions, handles', async () =>
    page(async (tab) => {
      expect(tab.context).toBe(browser.defaultContext);
      expect(browser.defaultContext.tabs).toContain(tab);
      expect(await tab.evaluate('secret')).toBe('main-secret');
      expect(await tab.evaluate('typeof secret', undefined, { world: 'isolated' })).toBe(
        'undefined',
      );
      expect(await tab.evaluate('undefined')).toBeUndefined();
      expect(await tab.evaluate('NaN')).toBeNaN();
      expect(await tab.evaluate('123n')).toBe(123n);
      expect(Object.is(await tab.evaluate('-0'), -0)).toBe(true);
      expect(await tab.evaluate((n) => n, Infinity)).toBe(Infinity);
      await expect(tab.evaluate('throw new Error("fixture-error")')).rejects.toBeInstanceOf(
        EvaluationError,
      );
      const handle = await tab.evaluateHandle<{ answer: number }>('({answer:42})');
      expect(await handle.jsonValue()).toEqual({ answer: 42 });
      expect(await tab.evaluate((value) => value.answer, handle)).toBe(42);
      await handle.dispose();
      await expect(handle.jsonValue()).rejects.toBeInstanceOf(StaleElementError);
      const primitive = await tab.evaluateHandle<bigint>('123n');
      expect(await tab.evaluate((n) => n, primitive)).toBe(123n);
      await primitive.dispose();
    }));
  test('CSS, XPath, shortest text and closed shadow DOM', async () =>
    page(async (tab) => {
      expect(await (await tab.waitForSelector({ xpath: '//*[@id="button"]' })).text()).toBe(
        'Click',
      );
      expect(await (await tab.waitForSelector({ text: 'needle' })).html()).toBe('<b>needle</b>');
      expect(await tab.query('#closed-button', { pierce: false })).toBeUndefined();
      const closed = await tab.waitForSelector('#closed-button');
      await closed.click();
      expect(await closed.text()).toBe('shadow-clicked');
      await (await tab.waitForSelector('#closed-input')).fill('闭合 😀');
      expect(
        await (
          await tab.waitForSelector('#closed-input')
        ).evaluate((el) => (el as HTMLInputElement).value),
      ).toBe('闭合 😀');
      await tab.evaluate(
        'document.body.insertAdjacentHTML("beforeend", "<p>long prefix unique-match long suffix</p>")',
      );
      await closed.evaluate((el) => {
        el.textContent = 'unique-match';
      });
      expect((await tab.query({ text: 'unique-match' }))!.backendNodeId).toBe(closed.backendNodeId);
      await closed.evaluate((el) => el.remove());
      await expect(closed.text()).rejects.toBeInstanceOf(StaleElementError);
    }));
  test('reliable clicks, scrolling, Unicode, contenteditable, select and keyboard', async () =>
    page(async (tab) => {
      await (await tab.waitForSelector('#button')).click();
      expect(await tab.evaluate('clicks')).toBe(1);
      await (await tab.waitForSelector('#input')).fill('你好 😀');
      expect(await tab.evaluate('inputs')).toEqual(['你好 😀']);
      await (await tab.waitForSelector('#input')).fill('replacement');
      expect(await tab.evaluate('document.querySelector("#input").value')).toBe('replacement');
      await tab.keyboard.press(selectAll);
      await tab.keyboard.insertText('最后');
      expect(await tab.evaluate('document.querySelector("#input").value')).toBe('最后');
      await (await tab.waitForSelector('#editable')).fill('可编辑');
      expect(await (await tab.waitForSelector('#editable')).text()).toBe('可编辑');
      expect(await (await tab.waitForSelector('#select')).select(['a', 'b'])).toEqual(['a', 'b']);
      const bottom = await tab.waitForSelector('#bottom');
      await bottom.click();
      expect(await bottom.text()).toBe('bottom-clicked');
    }));
  test('occluded elements time out without a click', async () =>
    page(async (tab) => {
      await tab.evaluate(
        'document.body.insertAdjacentHTML("beforeend",\'<div id="cover"></div>\')',
      );
      await expect(
        (await tab.waitForSelector('#button')).click({ timeout: 150 }),
      ).rejects.toBeInstanceOf(TimeoutError);
      expect(await tab.evaluate('clicks')).toBe(0);
    }));
  test('redirect, same-document, history and pre-registered navigation waits', async () =>
    page(async (tab) => {
      await tab.goto(fixture.base + '/redirect');
      expect(tab.url).toContain('redirected=1');
      const button = await tab.waitForSelector('#button');
      await Promise.all([tab.waitForNavigation(), (await tab.waitForSelector('#spa')).click()]);
      expect(tab.url).toContain('#changed');
      expect(await button.text()).toBe('Click');
      await Promise.all([tab.waitForNavigation(), (await tab.waitForSelector('#link')).click()]);
      expect(tab.url).toMatch(/\/empty$/);
      await expect(button.text()).rejects.toBeInstanceOf(StaleElementError);
      await tab.go(-1);
      expect(tab.url).toContain('#changed');
      expect(await tab.evaluate('secret')).toBe('main-secret');
      await tab.reload();
      expect(await tab.evaluate('secret')).toBe('main-secret');
    }));
  test('same-process frames and genuine nested OOPIF contexts and input', async () =>
    page(async (tab) => {
      await tab.waitForFunction('document.querySelectorAll("iframe").length===2');
      for (
        let i = 0;
        i < 100 &&
        tab.frames.filter(
          (f) => f.url.includes('/frame') || f.url.includes('/nested') || f.url.includes('/same'),
        ).length < 3;
        i++
      )
        await sleep(50);
      console.log(
        'frame sessions',
        tab.frames.map((f) => ({
          url: f.url,
          id: f.id,
          parent: f.parentId,
          session: f.session.id,
        })),
      );
      const same = tab.frames.find((f) => f.url.endsWith('/same'))!;
      const cross = tab.frames.find((f) => f.url.endsWith('/frame'))!;
      const nested = tab.frames.find((f) => f.url.endsWith('/nested'))!;
      expect(same).toBeDefined();
      expect(cross).toBeDefined();
      expect(nested).toBeDefined();
      expect(same.session.id).toBe(tab.session.id);
      expect(cross.session.id).not.toBe(tab.session.id);
      expect(nested.session.id).not.toBe(cross.session.id);
      expect(await same.evaluate('frameSecret')).toBe('same-main');
      expect(await cross.evaluate('frameSecret')).toBe('cross-main');
      expect(await nested.evaluate('frameSecret')).toBe('nested-main');
      expect(await tab.query('#frame-button')).toBeUndefined();
      const sameButton = await same.waitForSelector('#same-button');
      await sameButton.click();
      expect(await sameButton.text()).toBe('same-clicked');
      const crossButton = await cross.waitForSelector('#frame-button');
      await crossButton.click();
      expect(await crossButton.text()).toBe('clicked');
      await (await cross.waitForSelector('#frame-input')).fill('跨站中文');
      expect(await cross.evaluate('document.querySelector("input").value')).toBe('跨站中文');
      const nestedButton = await nested.waitForSelector('#nested-button');
      await nestedButton.click();
      expect(await nestedButton.text()).toBe('nested-clicked');
    }, '/page?frames=1'));
  test('contexts isolate cookies and localStorage; snapshot and restore', async () => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      const p = await a.newTab(fixture.base + '/page');
      const q = await b.newTab(fixture.base + '/page');
      await a.setCookies([{ name: 'session', value: 'A', url: fixture.base }]);
      expect((await a.cookies())[0]!.value).toBe('A');
      expect(await b.cookies()).toEqual([]);
      await p.mainFrame.setStorage({ key: 'A' });
      expect(await q.mainFrame.storage()).toEqual({});
      const state = await a.storageState();
      await b.restoreStorage(state);
      await q.reload();
      expect(await q.mainFrame.storage()).toEqual({ key: 'A' });
      expect((await b.cookies())[0]!.value).toBe('A');
    } finally {
      await a.close();
      await b.close();
    }
  });
  test('storage restore never follows a cross-origin redirect or writes another origin', async () => {
    const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
    const destination = await serve({ hostname: '127.0.0.1', port: 0, fetch: () => html('<p>B') });
    const dest = `http://127.0.0.1:${destination.port}`;
    let rootHits = 0;
    const source = await serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== '/') return html('<p>A');
        rootHits++;
        return Response.redirect(dest, 302);
      },
    });
    const origin = `http://127.0.0.1:${source.port}`;
    const context = await browser.newContext();
    try {
      const b = await context.newTab(dest + '/page');
      await b.mainFrame.setStorage({ existing: 'b' });
      await context.restoreStorage({
        cookies: [],
        origins: [{ origin, localStorage: { token: 'synthetic' } }],
      });
      expect(rootHits).toBe(0);
      expect(await b.mainFrame.storage()).toEqual({ existing: 'b' });
      const a = await context.newTab(origin + '/page');
      expect(await a.mainFrame.storage()).toEqual({ token: 'synthetic' });
      // The origin check and the writes share one script: a mismatched document is untouched.
      await expect(b.mainFrame.setStorage({ token: 'x' }, 'local', true, origin)).rejects.toThrow(
        EvaluationError,
      );
      await expect(b.mainFrame.storage('local', origin)).rejects.toThrow(EvaluationError);
      expect(await b.mainFrame.storage()).toEqual({ existing: 'b' });
    } finally {
      await context.close();
      await source.stop();
      await destination.stop();
    }
  });
  test('storageState covers iframes and closed tabs, but not partitioned storage', async () => {
    const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
    const child = await serve({ hostname: '0.0.0.0', port: 0, fetch: () => html('<p>child') });
    const same = `http://127.0.0.1:${child.port}`;
    const cross = `http://localhost:${child.port}`;
    const top = await serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        html(`<iframe src="${same}/frame"></iframe><iframe src="${cross}/frame"></iframe>`),
    });
    const origin = `http://127.0.0.1:${top.port}`;
    const context = await browser.newContext();
    const target = await browser.newContext();
    try {
      const tab = await context.newTab(origin + '/page');
      await tab.mainFrame.setStorage({ top: '1' });
      const frame = (url: string) => tab.frames.find((f) => f.url === url)!;
      // Same-site (port differs): the iframe sees its origin's first-party storage.
      await frame(same + '/frame').setStorage({ child: '1' });
      // Cross-site: Chrome partitions this under the top-level site.
      await frame(cross + '/frame').setStorage({ partitioned: '1' });
      const expected = [
        { origin, localStorage: { top: '1' } },
        { origin: same, localStorage: { child: '1' } },
      ];
      const sorted = (state: { origins: Array<{ origin: string }> }) =>
        [...state.origins].sort((x, y) => x.origin.localeCompare(y.origin));
      const before = await context.storageState();
      expect(sorted(before)).toEqual(sorted({ origins: expected }));
      await tab.close();
      const after = await context.storageState();
      expect(sorted(after)).toEqual(sorted({ origins: expected }));
      await target.restoreStorage(after);
      const check = await target.newTab(same + '/frame');
      expect(await check.mainFrame.storage()).toEqual({ child: '1' });
      await check.goto(origin + '/page');
      expect(await check.mainFrame.storage()).toEqual({ top: '1' });
    } finally {
      await context.close();
      await target.close();
      await top.stop();
      await child.stop();
    }
  });
  test('screenshot, PDF, upload, download and popup', async () =>
    page(async (tab) => {
      const directory = await mkdtemp(join(tmpdir(), 'nodriver-test-'));
      try {
        const input = join(directory, 'input.txt');
        await writeFile(input, 'fixture');
        await (await tab.waitForSelector('#file')).upload([input]);
        expect(await tab.evaluate('document.querySelector("#file").files[0].name')).toBe(
          'input.txt',
        );
        expect((await tab.screenshot({ fullPage: true })).subarray(1, 4).toString()).toBe('PNG');
        expect((await tab.pdf()).subarray(0, 4).toString()).toBe('%PDF');
        await tab.context.setDownloadDirectory(directory);
        const download = tab.waitForDownload();
        await (await tab.waitForSelector('#download')).click();
        const result = await download;
        expect(await readFile(await result.path(), 'utf8')).toContain('下载');
        await result.saveAs(join(directory, 'saved.txt'));
        const popup = tab.waitForPopup();
        await (await tab.waitForSelector('#popup')).click();
        const opened = await popup;
        expect(opened.context).toBe(tab.context);
        await opened.close();
      } finally {
        await removeTree(directory);
      }
    }));
  test('network interception and response events', async () =>
    page(async (tab) => {
      const remove = await tab.network.route(/\/mock$/, (r) =>
        r.fulfill({ headers: { 'content-type': 'application/json' }, body: '{"mock":true}' }),
      );
      expect(await tab.evaluate('fetch("/mock").then(r=>r.json())')).toEqual({ mock: true });
      await remove();
      const response = tab.network.waitForResponse((r) => r.event.response.url.endsWith('/json'));
      expect(await tab.evaluate('fetch("/json").then(r=>r.json())')).toEqual({ value: 42 });
      expect(JSON.parse((await (await response).body()).toString())).toEqual({ value: 42 });
    }));
  test('external connection close preserves browser process and tabs', async () => {
    const external = await Browser.connect({ endpoint: browser.endpoint! });
    const tab = await external.newTab();
    await external.close();
    expect(await browser.cdp.send('Browser.getVersion')).toBeDefined();
    const original = browser.tabs.find((t) => t.id === tab.id);
    expect(original).toBeDefined();
    await original?.close();
  });
  test('pipe transport launch/roundtrip/cleanup; close is idempotent', async () => {
    const pipe = await Browser.launch({
      headless: process.env.NODRIVER_HEADFUL !== '1',
      transport: 'pipe',
    });
    const profile = pipe.process!.profile;
    const tab = await pipe.newTab(fixture.base + '/page');
    expect(await tab.evaluate('6*7')).toBe(42);
    await Promise.all([pipe.close(), pipe.close()]);
    await expect(access(profile)).rejects.toThrow();
  });
  test('no unexpected asynchronous configuration errors', () => {
    expect(errors).toEqual([]);
  });
});
