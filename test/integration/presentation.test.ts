import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Browser,
  type ConnectionObserver,
  type PresentationLease,
  type Session,
} from '../../src/index.ts';
import { delay, poll } from '../../src/utils.ts';

const headful = process.env.NODRIVER_HEADFUL === '1';
const pageUrl =
  'data:text/html,' +
  encodeURIComponent(`<!doctype html><title>Presentation fixture</title>
    <style>body { background: white; } div { width: 120px; height: 120px;
    animation: paint .3s linear infinite alternate; }
    @keyframes paint { from { background: red; } to { background: blue; } }</style>
    <h1>Presentation fixture</h1><div></div>`);

async function page(browser: Browser) {
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
  const session = await browser.attachSession(targetId);
  // Navigate after attaching so readiness follows an acknowledged navigation.
  const { errorText } = await session.send('Page.navigate', { url: pageUrl });
  assert.equal(errorText, undefined);
  // A target and its frame tree can exist before the first document is ready for screencast.
  await poll(
    async () => {
      const { frameTree } = await session.sendWith('Page.getFrameTree', { timeout: 5000 });
      if (frameTree.frame.url !== pageUrl) return undefined;
      const { result } = await session.sendWith(
        'Runtime.evaluate',
        { timeout: 5000 },
        { expression: 'document.readyState === "complete"', returnByValue: true },
      );
      return result.value === true || undefined;
    },
    { timeout: 5000 },
    'presentation fixture document',
  );
  return { targetId, session };
}

async function waitForFrames(lease: PresentationLease) {
  await poll(
    async () => lease.report.acknowledgedFrames > 0 || undefined,
    { timeout: 5000 },
    'acknowledged presentation frames',
  );
}

function leaseOptions() {
  return { maxDuration: 10_000, maxFrames: 120, maxBytes: 16 * 1024 * 1024 };
}

async function pageState(session: Session) {
  const { result } = await session.sendWith(
    'Runtime.evaluate',
    { timeout: 5000 },
    {
      expression: '({ visibility: document.visibilityState, focused: document.hasFocus() })',
      returnByValue: true,
    },
  );
  return result.value as { visibility: string; focused: boolean };
}

for (const transport of ['websocket', 'pipe'] as const) {
  test(`${transport}: native presentation frames, exclusive ownership and stop cleanup`, async (t) => {
    const sends: Parameters<NonNullable<ConnectionObserver['onSend']>>[0][] = [];
    await using browser = await Browser.launch({
      headless: !headful,
      attach: 'none',
      transport,
      observe: { onSend: (event) => sends.push(event) },
    });
    const { session } = await page(browser);
    const baseline = browser.connection.listenerCount;
    const lease = browser.presentationLease(session, leaseOptions());
    const next = browser.presentationLease(session, leaseOptions());
    const startIndex = sends.length;
    try {
      await lease.start();
      await assert.rejects(next.start(), /already has an active lease/);
      await waitForFrames(lease);
      const report = await lease.close();
      assert.equal(report.state, 'stopped');
      assert.equal(report.cleanup, 'completed');
      assert.equal(report.frames, report.acknowledgedFrames);
      assert.equal(report.inFlightAcks, 0);
      assert.equal(report.ackErrors, 0);
      assert.deepEqual(report.cleanupErrors, []);
      assert.equal(browser.connection.listenerCount, baseline);
      const methods = sends.slice(startIndex).map((event) => event.method);
      assert.equal(methods.filter((method) => method === 'Page.startScreencast').length, 1);
      assert.equal(methods.filter((method) => method === 'Page.stopScreencast').length, 1);
      assert.equal(
        methods.filter((method) => method === 'Page.screencastFrameAck').length,
        report.frames,
      );
      assert.ok(
        methods.every((method) =>
          ['Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck'].includes(
            method,
          ),
        ),
      );
      await delay(150);
      assert.deepEqual(lease.report, report);
      assert.deepEqual(await lease.close(), report);
      assert.equal(sends.length, startIndex + methods.length);
      t.diagnostic(`${browser.version.product}; headful=${headful}; ${JSON.stringify(report)}`);

      await next.start();
      await waitForFrames(next);
      assert.equal((await next.close()).cleanup, 'completed');
      assert.equal(browser.connection.listenerCount, baseline);
      assert.equal(browser.connection.pendingCount, 0);
      assert.equal(browser.connection.unansweredCount, 0);
    } finally {
      await lease.close();
      await next.close();
      await session.detach();
    }
  });

  test(`${transport}: native presentation cancellation and session detach`, async () => {
    await using browser = await Browser.launch({ headless: !headful, attach: 'none', transport });
    const { session } = await page(browser);
    const controller = new AbortController();
    const lease = browser.presentationLease(session, {
      ...leaseOptions(),
      signal: controller.signal,
    });
    try {
      await lease.start();
      await waitForFrames(lease);
      controller.abort(new Error('End presentation'));
      const report = await lease.close();
      assert.equal(report.reason, 'aborted');
      assert.equal(report.cleanup, 'completed');
      assert.equal(report.inFlightAcks, 0);
    } finally {
      await lease.close();
    }

    const detached = browser.presentationLease(session, leaseOptions());
    try {
      await detached.start();
      await waitForFrames(detached);
      await session.detach();
      const report = await detached.close();
      assert.equal(report.state, 'disconnected');
      assert.equal(report.cleanup, 'disconnected');
      assert.equal(report.active, false);
    } finally {
      await detached.close();
      await session.detach();
    }
  });

  for (const mode of ['background', 'minimized'] as const) {
    test(
      `${transport}: native presentation in a ${mode} window leaves target unfocused`,
      { skip: !headful && 'Set NODRIVER_HEADFUL=1 to exercise desktop window states' },
      async (t) => {
        const sends: Parameters<NonNullable<ConnectionObserver['onSend']>>[0][] = [];
        await using browser = await Browser.launch({
          headless: false,
          attach: 'none',
          transport,
          windowSize: { width: 640, height: 480 },
          observe: { onSend: (event) => sends.push(event) },
        });
        const { session, targetId } = await page(browser);
        const cover = await browser.cdp.send('Target.createTarget', {
          url: 'data:text/html,<title>Foreground fixture</title><h1>Foreground fixture</h1>',
        });
        await browser.cdp.send('Target.activateTarget', { targetId: cover.targetId });
        const { windowId } = await browser.cdp.send('Browser.getWindowForTarget', { targetId });
        assert.equal(
          (await browser.cdp.send('Browser.getWindowForTarget', { targetId: cover.targetId }))
            .windowId,
          windowId,
        );
        if (mode === 'minimized') {
          await browser.cdp.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'minimized' },
          });
          await poll(
            async () =>
              (await browser.cdp.send('Browser.getWindowBounds', { windowId })).bounds
                .windowState === 'minimized' || undefined,
            { timeout: 5000 },
            'minimized presentation window',
          );
        }
        await poll(
          async () => !(await pageState(session)).focused || undefined,
          { timeout: 5000 },
          'unfocused background target',
        );
        const before = await pageState(session);
        const startIndex = sends.length;
        const lease = browser.presentationLease(session, leaseOptions());
        try {
          await lease.start();
          await waitForFrames(lease);
          const during = await pageState(session);
          assert.equal(during.focused, false);
          if (mode === 'minimized') {
            assert.equal(
              (await browser.cdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState,
              'minimized',
            );
          }
          const report = await lease.close();
          assert.equal(report.cleanup, 'completed');
          assert.equal(report.inFlightAcks, 0);
          assert.equal(report.frames, report.acknowledgedFrames);
          const after = await pageState(session);
          assert.equal(after.focused, false);
          assert.equal(
            sends
              .slice(startIndex)
              .some(
                (event) =>
                  ['Page.bringToFront', 'Target.activateTarget', 'Runtime.enable'].includes(
                    event.method,
                  ) || event.method.startsWith('Input.'),
              ),
            false,
          );
          t.diagnostic(
            JSON.stringify({
              browser: browser.version.product,
              mode,
              before,
              during,
              after,
              report,
            }),
          );
        } finally {
          await lease.close();
          await session.detach();
        }
      },
    );
  }
}
