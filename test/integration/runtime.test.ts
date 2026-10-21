import { describe, test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { spyOn } from 'jest-mock';
import { Browser, StaleElementError } from '../../src/index.ts';
import { WebSocketTransport } from '../../src/transport/websocket.ts';
import { PipeTransport } from '../../src/transport/pipe.ts';
import { fixtureServer } from '../fixtures/server.ts';

for (const transport of ['pipe', 'websocket'] as const) {
  test(`${transport}: main-world DOM reads meet page hooks; isolated reads share observable DOM`, async () => {
    const fixture = await fixtureServer();
    const audit = recordWire(transport);
    const browser = await Browser.launch({ transport, headless: true });
    try {
      const tab = await browser.newTab(`${fixture.base}/page`);
      expect(await tab.evaluate('navigator.userAgent')).toBe(browser.version.userAgent);
      expect(browser.baseEnvironment.userAgent).toBeUndefined();
      await tab.evaluate(`globalThis.__hookCount=0;globalThis.__mutationCount=0;
        const original=Document.prototype.querySelector;
        Document.prototype.querySelector=function(...args){__hookCount++;return Reflect.apply(original,this,args)};
        new MutationObserver(records=>__mutationCount+=records.length).observe(document,{attributes:true,subtree:true});`);
      expect(await tab.evaluate("document.querySelector('#input').id")).toBe('input');
      expect(await tab.evaluate('__hookCount')).toBe(1);
      expect(
        await tab.evaluate("document.querySelector('#input').id", undefined, { world: 'isolated' }),
      ).toBe('input');
      expect(await tab.query('#input')).not.toBeNull();
      expect(await tab.evaluate('__hookCount')).toBe(1);
      await tab.evaluate(
        "document.querySelector('#input').setAttribute('data-observed','yes')",
        undefined,
        { world: 'isolated' },
      );
      await tab.waitForFunction('__mutationCount > 0');
      expect(
        await tab.evaluate("document.getElementById('input').getAttribute('data-observed')"),
      ).toBe('yes');
      expect(audit.messages.some((m) => m.method === 'Runtime.enable')).toBe(false);
    } finally {
      await browser.close();
      await fixture.server.stop();
      audit.restore();
    }
  });
}

function recordWire(transport: 'websocket' | 'pipe') {
  const prototype =
    transport === 'websocket' ? WebSocketTransport.prototype : PipeTransport.prototype;
  // A test that failed before restore() leaves its spy installed; wrapping it would recurse.
  (prototype.send as { mockRestore?: () => void }).mockRestore?.();
  const original = prototype.send;
  const messages: Array<{ method: string; sessionId?: string; params?: Record<string, unknown> }> =
    [];
  const spy = spyOn(prototype, 'send').mockImplementation(function (this: never, message: string) {
    messages.push(JSON.parse(message));
    return original.call(this, message);
  });
  return { messages, restore: () => spy.mockRestore() };
}
interface Sample {
  stackReads: number;
  nameReads: number;
  mutations: number;
  clicks: number;
  moves: number;
  globals: string[];
  properties: string[];
  webdriver: boolean;
  ownWebdriver: boolean;
  nativeGetter: boolean;
  consoleUnchanged: boolean;
  getterUnchanged: boolean;
  userAgent: string;
}

describe('Runtime remains disabled and helpers avoid main-world patches', () => {
  for (const transport of ['websocket', 'pipe'] as const) {
    test(`${transport}: all frame worlds, input, popup, navigation and reconnect`, async (t) => {
      const audit = recordWire(transport);
      const fixture = await fixtureServer();
      const errors: unknown[] = [];
      let browser: Browser | undefined;
      let stage = 'launch';
      try {
        browser = await Browser.launch({
          transport,
          headless: process.env.NODRIVER_HEADFUL !== '1',
          args: ['--site-per-process', '--disable-blink-features=IdleDetection'],
          onError: (e) => errors.push(e),
        });
        stage = 'open audit fixture';
        const tab = await browser.newTab(fixture.base + '/audit');
        expect(tab.frames.length).toBe(4);
        expect(new Set(tab.frames.map((f) => f.session.id)).size).toBe(3);
        const runtimeEvents: string[] = [];
        const off = browser.connection.events.on((e) => {
          if (e.method.startsWith('Runtime.')) runtimeEvents.push(e.method);
        });
        for (const frame of tab.frames) {
          stage = `frame audit: ${frame.url}`;
          const before = await frame.evaluate<Sample>('__audit.sample()');
          await frame.evaluate('__audit.arm()');
          expect(await frame.evaluate('typeof __audit', undefined, { world: 'isolated' })).toBe(
            'undefined',
          );
          const handle = await frame.evaluateHandle<{ location: string }>(
            '({location:location.href})',
          );
          expect(await frame.evaluate((value) => value.location, handle)).toBe(frame.url);
          await handle.dispose();
          await (await frame.waitForSelector('#closed-input')).fill('中文😀');
          await (await frame.waitForSelector('#probe-button')).click();
          const sample = await frame.evaluate<Sample>('__audit.sample()');
          expect(sample).toMatchObject({
            stackReads: before.stackReads,
            nameReads: before.nameReads,
            mutations: 0,
            clicks: 1,
            globals: [],
            properties: [],
            webdriver: false,
            ownWebdriver: false,
            nativeGetter: true,
            consoleUnchanged: true,
            getterUnchanged: true,
          });
          expect(sample.moves).toBeGreaterThan(0);
          await frame.evaluate('__audit.log()');
        }
        stage = 'navigate away';
        const stale = await tab.evaluateHandle('document.body');
        await tab.goto(fixture.base + '/empty');
        await expect(stale.jsonValue()).rejects.toBeInstanceOf(StaleElementError);
        await stale.dispose();
        stage = 'history back';
        await tab.go(-1);
        await tab.evaluate('__audit.log()');
        stage = 'reload';
        await tab.reload();
        expect(await tab.evaluate('typeof __audit')).toBe('object');
        stage = 'popup';
        const popup = tab.waitForPopup();
        await tab.evaluate(
          'document.querySelector("#probe-button").addEventListener("click",()=>window.open("/audit?level=popup"),{once:true})',
        );
        await (await tab.waitForSelector('#probe-button')).click();
        const child = await popup;
        await child.waitForFunction('typeof __audit==="object"');
        expect(await child.evaluate('navigator.webdriver')).toBe(false);
        await child.close();
        if (browser.endpoint) {
          stage = 'reconnect';
          const external = await Browser.connect({ endpoint: browser.endpoint });
          try {
            const attached = external.tabs.find((t) => t.id === tab.id)!;
            expect(await attached.evaluate('typeof __audit')).toBe('object');
          } finally {
            await external.close();
          }
        }
        off();
        expect(runtimeEvents).toEqual([]);
        expect(errors).toEqual([]);
        await browser.close();
        const forbidden = audit.messages.filter((m) =>
          [
            'Runtime.enable',
            'Runtime.disable',
            'Runtime.addBinding',
            'Console.enable',
            'Debugger.enable',
            'Page.addScriptToEvaluateOnNewDocument',
          ].includes(m.method),
        );
        expect(forbidden).toEqual([]);
        expect(audit.messages.some((m) => m.method === 'DOM.resolveNode')).toBe(true);
        expect(audit.messages.some((m) => m.method === 'Runtime.callFunctionOn')).toBe(true);
        console.log('Runtime wire audit', {
          transport,
          commands: audit.messages.length,
          forbidden: forbidden.length,
        });
      } catch (error) {
        t.diagnostic(
          JSON.stringify({
            transport,
            stage,
            browser: browser?.version.product,
            lastCommands: audit.messages.slice(-20).map(({ method, sessionId }) => ({
              method,
              sessionId,
            })),
          }),
        );
        throw error;
      } finally {
        await browser?.close();
        await fixture.server.stop();
        audit.restore();
      }
    });
  }
  test('positive control observes explicitly enabled Runtime and native webdriver', async () => {
    const audit = recordWire('websocket');
    const fixture = await fixtureServer();
    const browser = await Browser.launch({
      automationControlled: true,
      headless: process.env.NODRIVER_HEADFUL !== '1',
    });
    try {
      const tab = await browser.newTab(fixture.base + '/audit?level=control');
      expect(await tab.evaluate('navigator.webdriver')).toBe(true);
      const events: string[] = [];
      const off = browser.connection.events.on((e) => {
        if (e.method.startsWith('Runtime.')) events.push(e.method);
      });
      // Intentional raw-CDP opt-in in a separate browser; never done by the library.
      await tab.cdp.send('Runtime.enable');
      await tab.evaluate('__audit.log()');
      expect(events).toContain('Runtime.executionContextCreated');
      expect(events).toContain('Runtime.consoleAPICalled');
      expect(audit.messages.filter((m) => m.method === 'Runtime.enable').length).toBe(1);
      const sample = await tab.evaluate<Sample>('__audit.sample()');
      console.log('Runtime positive control', {
        stackReads: sample.stackReads,
        nameReads: sample.nameReads,
        browser: browser.version.product,
      });
      // Modern V8 may suppress console getters even with Runtime enabled. Prove
      // the page-side getter works, without pretending a zero is a detection win.
      await tab.evaluate('__audit.readStack()');
      expect((await tab.evaluate<Sample>('__audit.sample()')).stackReads).toBe(
        sample.stackReads + 1,
      );
      off();
    } finally {
      await browser.close();
      await fixture.server.stop();
      audit.restore();
    }
  });
});
