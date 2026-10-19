import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { Browser } from '../../src/index.ts';
import { fixtureServer } from '../fixtures/server.ts';
import { appendFile } from 'node:fs/promises';
import { forbiddenAutomaticCommands, recordWire } from '../fixtures/wire.ts';

for (const transport of ['websocket', 'pipe'] as const) {
  test(`${transport}: native environment across documents, OOPIF and temporary Workers`, async () => {
    const fixture = await fixtureServer();
    const audit = recordWire(transport);
    const browser = await Browser.launch({
      transport,
      args: ['--site-per-process'],
      headless: process.env.NODRIVER_HEADFUL !== '1',
    });
    try {
      const tab = await browser.newTab(fixture.base + '/audit');
      expect(tab.frames.length).toBe(4);
      const samples = [];
      for (const frame of tab.frames) {
        const plain = await frame.inspectEnvironment();
        expect(plain.worker).toBeUndefined();
        expect(plain.document.webgl).toBeUndefined();
        const before = await frame.evaluate<string[]>('Object.getOwnPropertyNames(globalThis)');
        const report = await frame.inspectEnvironment({ worker: true, webgl: true });
        samples.push(report);
        expect(report.frameId).toBe(frame.id);
        expect(report.url).toBe(frame.url);
        expect(report.document.userAgent).toBe(await frame.evaluate('navigator.userAgent'));
        expect(report.document.webdriver).toBe(false);
        expect(report.document.screen.width).toBeGreaterThan(0);
        expect(report.document.viewport.width).toBeGreaterThan(0);
        expect(report.document.webgl).toBeDefined();
        expect(report.worker?.status).toBe('ok');
        expect(report.differences).toEqual([]);
        expect(await frame.evaluate('Object.getOwnPropertyNames(globalThis)')).toEqual(before);
      }
      // An explicit document override need not propagate to Workers. Report the
      // observed mismatch instead of silently patching either environment.
      await tab.setEnvironment({ userAgent: 'Diagnostic-UA/1.0' });
      const changed = await tab.inspectEnvironment({ worker: true });
      expect(changed.document.userAgent).toBe('Diagnostic-UA/1.0');
      expect(changed.worker?.status).toBe('ok');
      console.log('Environment override observation', {
        transport,
        differences: changed.differences,
      });
      expect(audit.messages.filter((m) => forbiddenAutomaticCommands.includes(m.method))).toEqual(
        [],
      );
      const observation = {
        platform: process.platform,
        browser: browser.version.product,
        transport,
        headless: process.env.NODRIVER_HEADFUL !== '1',
        samples,
        override: changed,
      };
      if (process.env.NODRIVER_ENV_REPORT)
        await appendFile(process.env.NODRIVER_ENV_REPORT, JSON.stringify(observation) + '\n');
      console.log('Native environment', {
        browser: browser.version.product,
        transport,
        headless: observation.headless,
        userAgent: samples[0]!.document.userAgent,
        screen: samples[0]!.document.screen,
        differences: samples.map((r) => r.differences.length),
        forbidden: 0,
      });
    } finally {
      await browser.close();
      await fixture.server.stop();
      audit.restore();
    }
  });
}

test('Worker sampling obeys CSP and disposes temporary Worker/blob resources', async () => {
  const fixture = await fixtureServer();
  const browser = await Browser.launch({
    transport: 'pipe',
    headless: process.env.NODRIVER_HEADFUL !== '1',
  });
  try {
    const tab = await browser.newTab(fixture.base + '/empty');
    await tab.evaluate(`globalThis.resources={created:0,terminated:0,urls:0,revoked:0};
      const OriginalWorker=Worker;globalThis.Worker=class extends OriginalWorker{
        constructor(...args){super(...args);resources.created++}
        terminate(){resources.terminated++;super.terminate()}
      };
      const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=(blob)=>{resources.urls++;return create(blob)};
      URL.revokeObjectURL=(url)=>{resources.revoked++;revoke(url)};`);
    expect((await tab.inspectEnvironment({ worker: true, world: 'main' })).worker?.status).toBe(
      'ok',
    );
    expect(await tab.evaluate('resources')).toEqual({
      created: 1,
      terminated: 1,
      urls: 1,
      revoked: 1,
    });
    // A Worker that never responds exercises the browser-side cleanup deadline.
    await tab.evaluate(`Worker.prototype.postMessage=function(){};`);
    const timed = await tab.inspectEnvironment({ worker: true, world: 'main', timeout: 1000 });
    expect(timed.worker).toEqual({
      status: 'unavailable',
      error: 'Dedicated Worker sampling timed out',
    });
    expect(await tab.evaluate('resources')).toEqual({
      created: 2,
      terminated: 2,
      urls: 2,
      revoked: 2,
    });
    const controller = new AbortController();
    const pending = tab.inspectEnvironment({
      worker: true,
      world: 'main',
      timeout: 1000,
      signal: controller.signal,
    });
    // Wait until the browser owns a live Worker before cancelling the caller.
    await tab.waitForFunction('resources.created===3');
    controller.abort(new Error('cancel active Worker sample'));
    await expect(pending).rejects.toThrow('cancel active Worker sample');
    await tab.waitForFunction('resources.terminated===3&&resources.revoked===3', undefined, {
      timeout: 2000,
    });
    await tab.goto(fixture.base + '/worker-blocked');
    const blocked = await tab.inspectEnvironment({ worker: true, world: 'main' });
    expect(blocked.worker?.status).toBe('unavailable');
    expect(blocked.differences).toEqual([]);
    expect((await tab.inspectEnvironment({ worker: true })).worker?.status).toBe('unavailable');
  } finally {
    await browser.close();
    await fixture.server.stop();
  }
});
