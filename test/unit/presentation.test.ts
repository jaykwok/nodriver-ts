import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';
import { NodriverError, TimeoutError, type PresentationReport } from '../../src/index.ts';

const frame = (sessionId: number, data: string) => ({
  data,
  metadata: {
    offsetTop: 0,
    pageScaleFactor: 1,
    deviceWidth: 1,
    deviceHeight: 1,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
    timestamp: 0,
  },
  sessionId,
});

async function target() {
  const chrome = await ScriptedChrome.start();
  const browser = await chrome.connect({ attach: 'none' });
  const targetId = browser.pageTargets[0]!.targetId;
  const session = await browser.attachSession(targetId);
  return { chrome, browser, session };
}

test('presentation lease starts, acknowledges frames, and stops exactly once', async () => {
  const { chrome, browser, session } = await target();
  try {
    chrome.handle('Page.startScreencast', () => undefined);
    chrome.handle('Page.stopScreencast', () => undefined);
    chrome.handle('Page.screencastFrameAck', () => undefined);
    const lease = browser.presentationLease(session);
    const active = await lease.start();
    assert.equal(active.state, 'active');
    const received = session.waitFor('Page.screencastFrame');
    chrome.emit('Page.screencastFrame', frame(1, 'aGVsbG8='), session.id);
    await received;
    const closed = await lease.close();
    await lease.close();
    assert.equal(closed.state, 'stopped');
    assert.equal(closed.frames, 1);
    assert.equal(closed.acknowledgedFrames, 1);
    assert.equal(
      chrome.commands.filter((command) => command.method === 'Page.startScreencast').length,
      1,
    );
    assert.equal(
      chrome.commands.filter((command) => command.method === 'Page.stopScreencast').length,
      1,
    );
    assert.equal(
      chrome.commands.some((command) => command.method === 'Page.bringToFront'),
      false,
    );
  } finally {
    await browser.close();
    await chrome.close();
  }
});

test('presentation lease enforces frame and byte budgets', async () => {
  const { chrome, browser, session } = await target();
  try {
    chrome.handle('Page.startScreencast', () => undefined);
    chrome.handle('Page.stopScreencast', () => undefined);
    chrome.handle('Page.screencastFrameAck', () => undefined);
    const byFrame = browser.presentationLease(session, { maxFrames: 1 });
    await byFrame.start();
    chrome.emit('Page.screencastFrame', frame(1, 'YQ=='), session.id);
    chrome.emit('Page.screencastFrame', frame(2, 'Yg=='), session.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const frameReport = await byFrame.close();
    assert.equal(frameReport.reason, 'frame-limit');
    assert.equal(frameReport.frames, 1);
    assert.equal(frameReport.droppedFrames, 1);

    const byBytes = browser.presentationLease(session, { maxBytes: 1 });
    await byBytes.start();
    chrome.emit('Page.screencastFrame', frame(3, 'aGVsbG8='), session.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const byteReport = await byBytes.close();
    assert.equal(byteReport.reason, 'byte-limit');
    assert.equal(byteReport.frames, 0);
    assert.equal(byteReport.droppedFrames, 1);
  } finally {
    await browser.close();
    await chrome.close();
  }
});

test('presentation lease bounds start, abort, and disconnected cleanup', async () => {
  const { chrome, browser, session } = await target();
  try {
    chrome.handle('Page.startScreencast', () => new Promise(() => {}));
    chrome.handle('Page.stopScreencast', () => undefined);
    const lease = browser.presentationLease(session, { startTimeout: 10 });
    await assert.rejects(lease.start(), TimeoutError);
    const report = await lease.close();
    assert.equal(report.reason, 'start-failed');
    assert.equal(report.state, 'failed');

    const controller = new AbortController();
    const aborted = browser.presentationLease(session, { signal: controller.signal });
    controller.abort(new Error('cancel presentation'));
    await assert.rejects(aborted.start(), /cancel presentation/);
    assert.equal((await aborted.close()).reason, 'aborted');

    chrome.handle('Page.startScreencast', () => undefined);
    const disconnected = browser.presentationLease(session);
    await disconnected.start();
    chrome.disconnect();
    const disconnectedReport = await disconnected.close();
    assert.equal(disconnectedReport.state, 'disconnected');
    assert.equal(disconnectedReport.reason, 'disconnected');
  } finally {
    await browser.close().catch(() => {});
    await chrome.close();
  }
});

test('presentation lease bounds ACK concurrency and total duration', async () => {
  const { chrome, browser, session } = await target();
  try {
    chrome.handle('Page.startScreencast', () => undefined);
    chrome.handle('Page.stopScreencast', () => undefined);
    chrome.handle(
      'Page.screencastFrameAck',
      async () => await new Promise<void>((resolve) => setTimeout(resolve, 30)),
    );
    const listeners = browser.connection.listenerCount;
    const lease = browser.presentationLease(session, { maxInFlightAcks: 1 });
    await lease.start();
    chrome.emit('Page.screencastFrame', frame(4, 'YQ=='), session.id);
    chrome.emit('Page.screencastFrame', frame(5, 'Yg=='), session.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const ackReport = await lease.close();
    assert.equal(ackReport.reason, 'ack-limit');
    assert.equal(ackReport.droppedFrames, 1);
    assert.equal(browser.connection.listenerCount, listeners);

    const timed = browser.presentationLease(session, { maxDuration: 10 });
    await timed.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const timedReport = await timed.close();
    assert.equal(timedReport.reason, 'duration-limit');
    assert.equal(timedReport.state, 'timed-out');

    chrome.handle('Page.screencastFrameAck', () => NO_REPLY);
    const ackTimeout = browser.presentationLease(session, { ackTimeout: 10, stopTimeout: 50 });
    await ackTimeout.start();
    chrome.emit('Page.screencastFrame', frame(6, 'YQ=='), session.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const ackTimeoutReport = await ackTimeout.close();
    assert.equal(ackTimeoutReport.reason, 'ack-timeout');
    assert.equal(ackTimeoutReport.ackErrors, 1);

    chrome.handle('Page.stopScreencast', () => NO_REPLY);
    const stopFailure = browser.presentationLease(session, { stopTimeout: 10 });
    await stopFailure.start();
    const stopFailureReport = await stopFailure.close();
    assert.equal(stopFailureReport.reason, 'closed');
    assert.equal(stopFailureReport.state, 'failed');
    assert.equal(stopFailureReport.cleanup, 'failed');
  } finally {
    await browser.close();
    await chrome.close();
  }
});

test('presentation leases are exclusive per session', async () => {
  const { chrome, browser, session } = await target();
  try {
    chrome.handle('Page.startScreencast', () => undefined);
    chrome.handle('Page.stopScreencast', () => undefined);
    chrome.handle('Page.screencastFrameAck', () => undefined);
    const first = browser.presentationLease(session);
    const second = browser.presentationLease(session);

    await first.start();
    await assert.rejects(second.start(), (error: unknown) => {
      assert.ok(error instanceof NodriverError);
      assert.match(String(error), /already has an active lease/);
      return true;
    });
    const received = session.waitFor('Page.screencastFrame');
    chrome.emit('Page.screencastFrame', frame(7, 'YQ=='), session.id);
    await received;
    const firstReport = await first.close();
    assert.equal(firstReport.acknowledgedFrames, 1);

    await second.start();
    const secondReport = await second.close();
    assert.equal(secondReport.state, 'stopped');
    assert.equal(
      chrome.commands.filter((command) => command.method === 'Page.screencastFrameAck').length,
      1,
    );
  } finally {
    await browser.close();
    await chrome.close();
  }
});

test('presentation lease acknowledges frames received before start reply', async () => {
  const { chrome, browser, session } = await target();
  try {
    chrome.handle('Page.startScreencast', async () => {
      chrome.emit('Page.screencastFrame', frame(8, 'YQ=='), session.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    chrome.handle('Page.stopScreencast', () => undefined);
    chrome.handle('Page.screencastFrameAck', () => undefined);
    const lease = browser.presentationLease(session);
    await lease.start();
    const report = await lease.close();
    assert.equal(report.frames, 1);
    assert.equal(report.acknowledgedFrames, 1);
    assert.equal(report.droppedFrames, 0);
  } finally {
    await browser.close();
    await chrome.close();
  }
});

test('presentation lease bounds an early frame when start fails', async () => {
  const { chrome, browser, session } = await target();
  try {
    chrome.handle('Page.startScreencast', () => {
      chrome.emit('Page.screencastFrame', frame(10, 'YQ=='), session.id);
      return NO_REPLY;
    });
    chrome.handle('Page.stopScreencast', () => undefined);
    chrome.handle('Page.screencastFrameAck', () => undefined);
    const lease = browser.presentationLease(session, { startTimeout: 10, stopTimeout: 50 });
    await assert.rejects(lease.start(), TimeoutError);
    const report = await lease.close();
    assert.equal(report.state, 'failed');
    assert.equal(report.reason, 'start-failed');
    assert.equal(report.frames, 1);
    assert.equal(report.acknowledgedFrames, 1);
    assert.equal(report.cleanup, 'completed');
  } finally {
    await browser.close();
    await chrome.close();
  }
});

test('presentation lease freezes its report when ACK cleanup times out', async () => {
  const { chrome, browser, session } = await target();
  try {
    chrome.handle('Page.startScreencast', () => undefined);
    chrome.handle('Page.stopScreencast', () => undefined);
    chrome.handle('Page.screencastFrameAck', () => NO_REPLY);
    const lease = browser.presentationLease(session, { ackTimeout: 200, stopTimeout: 10 });
    await lease.start();
    const received = session.waitFor('Page.screencastFrame');
    chrome.emit('Page.screencastFrame', frame(9, 'YQ=='), session.id);
    await received;

    const report = await lease.close();
    assert.equal(report.state, 'stopped');
    assert.equal(report.cleanup, 'timed-out');
    assert.equal(report.inFlightAcks, 1);
    assert.equal(report.closed, true);
    const snapshot = structuredClone(lease.report);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(lease.report, snapshot);
  } finally {
    await browser.close();
    await chrome.close();
  }
});

test('presentation lease passes screencast parameters and rejects timer overflow', async () => {
  const { chrome, browser, session } = await target();
  try {
    chrome.handle('Page.startScreencast', () => undefined);
    chrome.handle('Page.stopScreencast', () => undefined);
    const screencast = {
      format: 'jpeg',
      quality: 30,
      maxWidth: 320,
      maxHeight: 240,
      everyNthFrame: 2,
    } as const;
    const lease = browser.presentationLease(session, { screencast });
    await lease.start();
    await lease.close();
    const [start] = chrome.commands.filter((c) => c.method === 'Page.startScreencast');
    assert.deepEqual(start!.params, screencast);
    for (const options of [
      { maxDuration: 2 ** 31 },
      { stopTimeout: Number.MAX_SAFE_INTEGER },
      { screencast: { quality: 101 } },
      { screencast: { format: 'webp' as 'png' } },
      { screencast: { everyNthFrame: 0 } },
      { screencast: { maxWidth: 1.5 } },
      { screencast: { scale: 1 } as object },
    ])
      assert.throws(
        () => browser.presentationLease(session, options),
        (e: unknown) => e instanceof RangeError || e instanceof TypeError,
      );
    assert.doesNotThrow(() => browser.presentationLease(session, { maxDuration: 2 ** 31 - 1 }));
  } finally {
    await browser.close();
    await chrome.close();
  }
});

test('presentation lease start on an ended session keeps the original reason', async () => {
  const { chrome, browser, session } = await target();
  try {
    chrome.crashTarget(session.targetId);
    await session.ended;
    const lease = browser.presentationLease(session);
    const error = await lease.start().catch((e) => e);
    assert.ok(error instanceof NodriverError);
    assert.equal(error.name, 'DisconnectedError');
    assert.equal(error.cause, session.closeReason);
    assert.equal((error.cause as { reason?: string }).reason, 'target-crashed');
    assert.match(lease.report.error!, /target-crashed/);
  } finally {
    await browser.close();
    await chrome.close();
  }
});

test('a failed stop keeps the reason the lease ended for', async () => {
  const { chrome, browser, session } = await target();
  try {
    chrome.handle('Page.startScreencast', () => undefined);
    chrome.handle('Page.screencastFrameAck', () => undefined);
    chrome.handle('Page.stopScreencast', () => {
      throw new Error('stop refused');
    });
    const assertStopFailure = (report: PresentationReport, reason: string) => {
      assert.equal(report.reason, reason);
      assert.equal(report.state, 'failed');
      assert.equal(report.cleanup, 'failed');
      assert.equal(report.cleanupErrors.length, 1);
      assert.match(report.cleanupErrors[0]!, /stop refused/);
    };

    const byFrames = browser.presentationLease(session, { maxFrames: 1 });
    await byFrames.start();
    chrome.emit('Page.screencastFrame', frame(11, 'YQ=='), session.id);
    chrome.emit('Page.screencastFrame', frame(12, 'Yg=='), session.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertStopFailure(await byFrames.close(), 'frame-limit');

    const byDuration = browser.presentationLease(session, { maxDuration: 10 });
    await byDuration.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertStopFailure(await byDuration.close(), 'duration-limit');

    const controller = new AbortController();
    const byAbort = browser.presentationLease(session, { signal: controller.signal });
    await byAbort.start();
    controller.abort(new Error('cancel presentation'));
    assertStopFailure(await byAbort.close(), 'aborted');

    chrome.replyOnce('Page.startScreencast', () => {
      throw new Error('start refused');
    });
    const byStart = browser.presentationLease(session);
    await assert.rejects(byStart.start(), /start refused/);
    const report = await byStart.close();
    assertStopFailure(report, 'start-failed');
    assert.match(report.error!, /start refused/);
  } finally {
    await browser.close();
    await chrome.close();
  }
});
