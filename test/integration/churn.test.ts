import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { spyOn } from 'jest-mock';
import { Browser, StaleElementError } from '../../src/index.ts';
import { PipeTransport } from '../../src/transport/pipe.ts';
import { WebSocketTransport } from '../../src/transport/websocket.ts';
import { poll } from '../../src/utils.ts';
import { fixtureServer } from '../fixtures/server.ts';

for (const transport of ['websocket', 'pipe'] as const) {
  test(`${transport}: repeated frame/session/navigation churn stays bounded`, async () => {
    const cycles = Number(process.env.NODRIVER_CHURN_CYCLES ?? 12);
    if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 10000)
      throw new RangeError('Invalid churn cycles');
    const prototype = transport === 'pipe' ? PipeTransport.prototype : WebSocketTransport.prototype;
    const send = prototype.send;
    const forbidden: string[] = [];
    let commands = 0;
    const spy = spyOn(prototype, 'send').mockImplementation(function (
      this: never,
      message: string,
    ) {
      const method = (JSON.parse(message) as { method: string }).method;
      commands++;
      if (
        [
          'Runtime.enable',
          'Runtime.disable',
          'Runtime.addBinding',
          'Console.enable',
          'Debugger.enable',
          'Page.addScriptToEvaluateOnNewDocument',
        ].includes(method)
      )
        forbidden.push(method);
      return send.call(this, message);
    });
    const fixture = await fixtureServer();
    const errors: unknown[] = [];
    let browser: Browser | undefined;
    let completed = 0;
    try {
      browser = await Browser.launch({
        transport,
        args: ['--site-per-process'],
        headless: process.env.NODRIVER_HEADFUL !== '1',
        onError: (e) => errors.push(e),
      });
      const tab = await browser.newTab(fixture.base + '/empty');
      const listeners = browser.connection.listenerCount;
      const sessions = () =>
        (Reflect.get(browser!.connection, 'sessions') as Map<string, unknown>).size;
      const baselineSessions = sessions();
      for (let i = 0; i < cycles; i++) {
        await tab.evaluate(
          (url) =>
            new Promise<void>((resolve) => {
              const iframe = document.createElement('iframe');
              iframe.id = 'churn';
              iframe.src = url;
              iframe.onload = () => resolve();
              document.body.append(iframe);
            }),
          fixture.base.replace('127.0.0.1', 'localhost') + '/audit?level=churn',
        );
        const frame = await poll(
          async () => tab.frames.find((f) => f.url.includes('level=churn')),
          { timeout: 5000 },
        );
        expect(await frame.evaluate('location.href')).toBe(frame.url);
        const handle = await frame.evaluateHandle('document.body');
        await tab.evaluate('document.querySelector("#churn").remove()');
        await poll(
          async () =>
            tab.framesManager.frames.size === 1 &&
            tab.framesManager.sessions.size === 1 &&
            sessions() === baselineSessions
              ? true
              : undefined,
          { timeout: 5000 },
          'frame/session reclamation',
        );
        await expect(handle.jsonValue()).rejects.toBeInstanceOf(StaleElementError);
        await handle.dispose();
        if (i % 4 === 0) {
          const context = await browser.newContext();
          try {
            const history = await context.newTab(fixture.base + '/audit');
            expect(history.frames.length).toBe(4);
            await history.goto(fixture.base + '/empty');
            await history.go(-1);
            await poll(
              async () =>
                history.frames.length === 4 && history.framesManager.setup.size === 0
                  ? true
                  : undefined,
              { timeout: 5000 },
              'BFCache frame restoration',
            ).catch(async (error) => {
              console.log('BFCache mismatch', {
                i,
                frames: [...history.framesManager.frames.values()].map((f) => ({
                  id: f.id,
                  url: f.url,
                  parent: f.parentId,
                  session: f.session.id,
                  closed: f.session.closed,
                  detached: f.detached,
                })),
                sessions: [...history.framesManager.sessions].map((s) => ({
                  id: s.id,
                  closed: s.closed,
                })),
                tree: await history.cdp.send('Page.getFrameTree'),
              });
              throw error;
            });
            expect(history.frames.length).toBe(4);
            for (const restored of history.frames)
              expect(await restored.evaluate('typeof __audit')).toBe('object');
            await history.goto(fixture.base + '/empty');
          } finally {
            await context.close();
          }
        }
        await poll(
          async () =>
            browser!.connection.pendingCount === 0 &&
            browser!.connection.listenerCount === listeners &&
            sessions() === baselineSessions &&
            tab.framesManager.frames.size === 1 &&
            tab.framesManager.setup.size === 0
              ? true
              : undefined,
          { timeout: 5000 },
          'baseline resource counts',
        ).catch((error) => {
          console.log('Churn resource mismatch', {
            i,
            baselineSessions,
            sessions: sessions(),
            listeners,
            actualListeners: browser!.connection.listenerCount,
            pending: browser!.connection.pendingCount,
            frames: tab.framesManager.frames.size,
            setup: tab.framesManager.setup.size,
            frameSessions: tab.framesManager.sessions.size,
          });
          throw error;
        });
        completed++;
      }
      expect(forbidden).toEqual([]);
      expect(errors).toEqual([]);
      console.log('Bounded churn', {
        transport,
        browser: browser.version.product,
        headless: process.env.NODRIVER_HEADFUL !== '1',
        cycles,
        commands,
        frames: tab.framesManager.frames.size,
        sessions: sessions(),
        listeners,
        pending: browser.connection.pendingCount,
        forbidden: forbidden.length,
      });
    } catch (error) {
      console.log('Churn failure diagnostics', {
        transport,
        completed,
        browser: browser?.version.product,
        chromeStderr: browser?.process ? Reflect.get(browser.process, 'stderr') : undefined,
      });
      throw error;
    } finally {
      await browser?.close();
      await fixture.server.stop();
      spy.mockRestore();
    }
  });
}
