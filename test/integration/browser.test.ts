import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, EvaluationError, StaleElementError, TimeoutError } from '../../src/index.js';
import type { Tab } from '../../src/index.js';
import { fixtureServer } from '../fixtures/server.js';
const fixture = fixtureServer();
let browser: Browser;
const errors: unknown[] = [];
beforeAll(async () => {
  browser = await Browser.launch({
    headless: process.env.NODRIVER_HEADFUL !== '1',
    timeout: 5000,
    args: ['--site-per-process'],
    onError: (e) => errors.push(e),
  });
});
afterAll(async () => {
  if (browser) await browser.close();
  fixture.server.stop(true);
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
      expect(Object.is(await tab.evaluate('-0'), -0)).toBeTrue();
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
      await tab.keyboard.press('Control+A');
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
      expect(tab.url).toEndWith('/empty');
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
        await Bun.sleep(50);
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
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
