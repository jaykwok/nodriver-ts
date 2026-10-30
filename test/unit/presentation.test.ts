import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';
import { NodriverError, TimeoutError } from '../../src/index.ts';

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
    chrome.emit('Page.screencastFrame', frame(1, 'aGVsbG8='), session.id);
    await new Promise((resolve) => setImmediate(resolve));
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
    assert.equal(stopFailureReport.reason, 'stop-failed');
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
    chrome.emit('Page.screencastFrame', frame(7, 'YQ=='), session.id);
    await new Promise((resolve) => setImmediate(resolve));
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
    chrome.emit('Page.screencastFrame', frame(9, 'YQ=='), session.id);
    await new Promise((resolve) => setImmediate(resolve));

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
