import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Browser, SessionEndedError, type ConnectionObserver } from '../../src/index.ts';
import { poll, removeTree } from '../../src/utils.ts';

test('raw launch, crash, target close and handoff preserve the minimal wire contract', async (t) => {
  const sends: Parameters<NonNullable<ConnectionObserver['onSend']>>[0][] = [];
  const browser = await Browser.launch({
    headless: true,
    attach: 'none',
    detached: true,
    observe: {
      onSend: (e) => {
        sends.push(e);
      },
    },
  });
  t.diagnostic(browser.version.product);
  let remote: Browser | undefined;
  try {
    assert.deepEqual(browser.tabs, []);
    assert.deepEqual(
      sends.map((s) => s.method),
      [
        'Browser.getVersion',
        'Target.getBrowserContexts',
        'Target.setDiscoverTargets',
        'Target.getTargets',
      ],
    );
    // A none launch need not wait for Chrome's startup page.
    const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
    const before = sends.length;
    const session = await browser.attachSession(targetId);
    assert.deepEqual(
      sends.slice(before).map((s) => s.method),
      ['Target.attachToTarget'],
    );
    assert.equal(
      (await session.send('Runtime.evaluate', { expression: '6 * 7' })).result.value,
      42,
    );
    const pending = assert.rejects(
      session.send('Runtime.evaluate', {
        expression: 'new Promise(() => {})',
        awaitPromise: true,
      }),
      SessionEndedError,
    );
    const waiting = assert.rejects(session.waitFor('Page.loadEventFired'), SessionEndedError);
    const crashedTarget = browser.cdp.waitFor(
      'Target.targetCrashed',
      (e) => e.targetId === targetId,
    );
    const crash = assert.rejects(session.send('Page.crash'), SessionEndedError);
    assert.equal(await session.ended, 'target-crashed');
    await Promise.all([pending, waiting, crash, crashedTarget]);
    assert.equal(session.closed, true);
    const recovered = await browser.attachSession(targetId);
    await recovered.send('Page.reload');
    await poll(
      async () => {
        try {
          return (
            (await recovered.send('Runtime.evaluate', { expression: '21 * 2' })).result.value ===
              42 || undefined
          );
        } catch {
          return undefined;
        }
      },
      { timeout: 5000 },
    );
    const lost = assert.rejects(
      recovered.send('Runtime.evaluate', {
        expression: 'new Promise(() => {})',
        awaitPromise: true,
      }),
      SessionEndedError,
    );
    await browser.cdp.send('Target.closeTarget', { targetId });
    assert.ok(['detached', 'target-destroyed'].includes(await recovered.ended));
    await lost;
    assert.equal(browser.closed, false);
    const endpoint = await browser.release();
    await browser.close();
    remote = await Browser.connect({ endpoint, attach: 'none' });
    assert.deepEqual(remote.tabs, []);
    const fresh = await remote.cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await remote.attachSession(fresh.targetId);
    assert.equal((await attached.send('Runtime.evaluate', { expression: '42' })).result.value, 42);
    assert.equal(
      sends.some((s) =>
        /^(Page.enable|Page.setLifecycleEventsEnabled|Target.setAutoAttach|Runtime.enable)$/.test(
          s.method,
        ),
      ),
      false,
    );
  } finally {
    if (browser.process!.released) {
      remote ??= await Browser.connect({ endpoint: browser.endpoint!, attach: 'none' });
      await remote.cdp.send('Browser.close').catch(() => {});
      await remote.close();
      assert.equal(await browser.process!.waitForExit(10000), true);
      await removeTree(browser.process!.profile);
    } else await browser.close();
  }
});

test('closing the last window in background mode does not mean browser disconnected', async (t) => {
  // --no-startup-window starts Chrome in background mode; a real headful window is used
  // on Windows/macOS or when DISPLAY is available, headless on Linux CI without X.
  const headless = process.platform === 'linux' && !process.env.DISPLAY;
  await using browser = await Browser.launch({
    attach: 'none',
    headless,
    args: ['--no-startup-window', '--keep-alive-for-test'],
  });
  t.diagnostic(`${browser.version.product}; headless=${headless}`);
  const { targetId } = await browser.cdp.send('Target.createTarget', {
    url: 'about:blank',
    newWindow: true,
  });
  const session = await browser.attachSession(targetId);
  const destroyed = browser.cdp.waitFor('Target.targetDestroyed', (e) => e.targetId === targetId);
  for (const page of browser.pageTargets)
    await browser.cdp.send('Target.closeTarget', { targetId: page.targetId });
  await destroyed;
  await session.ended;
  assert.equal(browser.pageTargets.length, 0);
  assert.equal(browser.closed, false);
  assert.equal(browser.process!.diagnostics.exited, false);
  await browser.cdp.send('Browser.getVersion');
  const fresh = await browser.cdp.send('Target.createTarget', {
    url: 'about:blank',
    newWindow: true,
  });
  const attached = await browser.attachSession(fresh.targetId);
  assert.equal((await attached.send('Runtime.evaluate', { expression: '42' })).result.value, 42);
});

test('aborting launch during CDP initialization cleans its owned process and lock', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'nodriver-raw-abort-'));
  const controller = new AbortController();
  try {
    await assert.rejects(
      Browser.launch({
        headless: true,
        attach: 'none',
        detached: true,
        userDataDir: profile,
        signal: controller.signal,
        observe: {
          onSend(e) {
            if (e.method === 'Target.getBrowserContexts')
              controller.abort(new Error('cancel startup'));
          },
        },
      }),
      /cancel startup/,
    );
    await assert.rejects(access(join(profile, '.nodriver.lock')), { code: 'ENOENT' });
    // Relaunching the same profile proves Chrome no longer owns it.
    await using replacement = await Browser.launch({
      headless: true,
      attach: 'none',
      userDataDir: profile,
    });
    assert.equal(replacement.closed, false);
  } finally {
    await removeTree(profile);
  }
});
