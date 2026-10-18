import { describe, expect, test } from 'bun:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Browser, StaleElementError, TimeoutError } from '../../src/index.js';
import { fixtureServer } from '../fixtures/server.js';
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject');
}
describe('navigation and lifecycle failures', () => {
  test('startup exit and unexpected browser death clean pending work and owned profile', async () => {
    const startupError = await rejection(
      Browser.launch({
        headless: process.env.NODRIVER_HEADFUL !== '1',
        executablePath: process.execPath,
        timeout: 1000,
      }),
    );
    expect(String(startupError)).toContain('Chrome exited');
    for (let attempt = 0; attempt < 3; attempt++) {
      const b = await Browser.launch({
        headless: process.env.NODRIVER_HEADFUL !== '1',
        timeout: 3000,
      });
      const profile = b.process!.profile;
      try {
        const tab = await b.newTab();
        const pending = tab.evaluate('new Promise(()=>{})');
        b.process!.child.kill('SIGKILL');
        expect(await rejection(pending)).toBeInstanceOf(Error);
        expect(b.connection.pendingCount).toBe(0);
      } finally {
        await b.close();
      }
      expect(((await rejection(access(profile))) as NodeJS.ErrnoException).code).toBe('ENOENT');
      await pause(100);
      expect(((await rejection(access(profile))) as NodeJS.ErrnoException).code).toBe('ENOENT');
    }
  });
  test('BFCache with nested frames restores live execution contexts', async () => {
    const f = fixtureServer();
    const b = await Browser.launch({
      headless: process.env.NODRIVER_HEADFUL !== '1',
      timeout: 3000,
      args: ['--site-per-process'],
    });
    try {
      const t = await b.newTab(f.base + '/page?frames=1');
      await t.goto(f.base + '/empty');
      await t.go(-1);
      expect(await t.evaluate('secret')).toBe('main-secret');
      for (let i = 0; i < 100 && t.frames.length < 4; i++) await Bun.sleep(20);
      expect(t.frames.length).toBe(4);
      for (const frame of t.frames.filter((frame) => frame !== t.mainFrame))
        expect(await frame.evaluate('frameSecret')).toBeDefined();
    } finally {
      await b.close();
      f.server.stop(true);
    }
  });
  test('OOPIF moves into parent process and back, preserving correct ownership', async () => {
    const f = fixtureServer();
    const b = await Browser.launch({
      headless: process.env.NODRIVER_HEADFUL !== '1',
      timeout: 5000,
      args: ['--site-per-process'],
    });
    try {
      const t = await b.newTab(f.base + '/page?frames=1');
      const cross = t.frames.find((f) => f.url.endsWith('/frame'))!;
      const old = await cross.waitForSelector('#frame-button');
      const frameLoaded = (url: string) =>
        b.waitEvent(
          b.connection.events,
          (event) =>
            event.method === 'Page.frameStoppedLoading' &&
            (event.params as { frameId: string }).frameId === cross.id &&
            t.frames.find((frame) => frame.id === cross.id)?.url === url,
          { timeout: 5000 },
          'migrating frame document load',
        );
      const sameLoaded = frameLoaded(f.base + '/same');
      await t.evaluate('document.querySelector("#cross").src="/same"');
      await sameLoaded;
      await t.waitForFunction(
        'document.querySelector("#cross").contentDocument?.readyState==="complete"',
      );
      const same = t.frames.find((f) => f.id === cross.id)!;
      expect(same.session).toBe(t.session);
      expect(await same.evaluate('frameSecret')).toBe('same-main');
      await expect(old.text()).rejects.toBeInstanceOf(StaleElementError);
      const crossUrl = `http://localhost:${f.server.port}/frame`;
      const crossLoaded = frameLoaded(crossUrl);
      await t.evaluate((url) => {
        (document.querySelector('#cross') as HTMLIFrameElement).src = url;
      }, crossUrl);
      await crossLoaded;
      // A target/session swap can precede the new document commit. Waiting for
      // its unique element uses the read-only stale-aware query path, so this
      // assertion does not race a still-changing execution context.
      const button = await same.waitForSelector('#frame-button');
      expect(same.session).not.toBe(t.session);
      expect(await same.evaluate('frameSecret')).toBe('cross-main');
      await button.click();
    } finally {
      await b.close();
      f.server.stop(true);
    }
  });
  test('navigation timeout/cancel releases listeners; no side effect is replayed', async () => {
    const f = fixtureServer();
    const b = await Browser.launch({
      headless: process.env.NODRIVER_HEADFUL !== '1',
      timeout: 2000,
    });
    try {
      const t = await b.newTab(f.base + '/page');
      const before = b.connection.listenerCount;
      await expect(t.waitForNavigation({ timeout: 30 })).rejects.toBeInstanceOf(TimeoutError);
      expect(b.connection.listenerCount).toBe(before);
      const controller = new AbortController();
      const waiting = t.waitForNavigation({ signal: controller.signal });
      controller.abort();
      await expect(waiting).rejects.toThrow();
      expect(b.connection.listenerCount).toBe(before);
      await expect(
        t.evaluate('globalThis.once=(globalThis.once||0)+1;new Promise(()=>{})', undefined, {
          timeout: 30,
        }),
      ).rejects.toBeInstanceOf(TimeoutError);
      expect(await t.evaluate('once')).toBe(1);
      expect(b.connection.pendingCount).toBe(0);
    } finally {
      await b.close();
      f.server.stop(true);
    }
  });
  test('renderer crash rejects navigation, reload recovers', async () => {
    const f = fixtureServer();
    const b = await Browser.launch({
      headless: process.env.NODRIVER_HEADFUL !== '1',
      timeout: 2000,
    });
    try {
      const t = await b.newTab(f.base + '/page');
      const handle = await t.waitForSelector('#button');
      const wait = t.waitForNavigation();
      const crashed = t.cdp.waitFor('Inspector.targetCrashed');
      const command = t.cdp.sendWith('Page.crash', { timeout: 300 }).catch(() => {});
      await crashed;
      await expect(wait).rejects.toThrow('crashed');
      await command;
      await expect(handle.text()).rejects.toBeInstanceOf(StaleElementError);
      await t.reload();
      expect(await t.evaluate('secret')).toBe('main-secret');
    } finally {
      await b.close();
      f.server.stop(true);
    }
  });
  test('persistent profile survives close and reopens; temporary profiles are removed', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'nodriver-persistent-'));
    const marker = join(profile, 'user-marker.txt');
    await writeFile(marker, 'keep');
    try {
      for (let i = 0; i < 2; i++) {
        const b = await Browser.launch({
          headless: process.env.NODRIVER_HEADFUL !== '1',
          userDataDir: profile,
        });
        await b.newTab();
        await b.close();
        expect(await readFile(marker, 'utf8')).toBe('keep');
      }
      await expect(access(join(profile, '.nodriver.lock'))).rejects.toThrow();
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  test('20 contexts remain isolated and release their target/session subscriptions', async () => {
    const f = fixtureServer();
    const b = await Browser.launch({
      headless: process.env.NODRIVER_HEADFUL !== '1',
      timeout: 10000,
    });
    try {
      const baseline = b.connection.listenerCount;
      const contexts = await Promise.all(Array.from({ length: 20 }, () => b.newContext()));
      const tabs = await Promise.all(contexts.map((c) => c.newTab(f.base + '/page')));
      await Promise.all(tabs.map((t, i) => t.mainFrame.setStorage({ index: String(i) })));
      for (let i = 0; i < tabs.length; i++)
        expect(await tabs[i]!.mainFrame.storage()).toEqual({ index: String(i) });
      await Promise.all(contexts.map((c) => c.close()));
      for (let i = 0; i < 100 && b.tabs.length > 1; i++) await Bun.sleep(20);
      expect(b.tabs.length).toBe(1);
      expect(b.connection.pendingCount).toBe(0);
      expect(b.connection.listenerCount).toBe(baseline);
    } finally {
      await b.close();
      f.server.stop(true);
    }
  });
});
