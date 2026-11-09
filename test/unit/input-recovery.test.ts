import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';
import { InputActionError, Mouse, ProtocolError, TimeoutError } from '../../src/index.ts';
import { InputBehavior } from '../../src/input/behavior.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function target(presentationRecovery: number | false) {
  const chrome = await ScriptedChrome.start();
  const browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
  const mouse = new Mouse(session);
  mouse.behavior.configure({ presentationRecovery });
  const count = (method: string) => chrome.commands.filter((c) => c.method === method).length;
  return {
    chrome,
    browser,
    session,
    mouse,
    screenshots: () => count('Page.captureScreenshot'),
    inputs: () => count('Input.dispatchMouseEvent'),
    async [Symbol.asyncDispose]() {
      await browser.close();
      await chrome.close();
    },
  };
}

test('a stalled input command gets one frame and is never sent again', async () => {
  await using t = await target(20);
  const drawn = gate();
  t.chrome.handle('Page.captureScreenshot', () => {
    drawn.resolve();
    return { data: '' };
  });
  // Like a minimized window, the page answers input only once it draws.
  t.chrome.handle('Input.dispatchMouseEvent', async () => {
    await drawn.promise;
  });
  const report = await t.mouse.move(5, 5);
  assert.equal(report.presentationRecoveries, 1);
  assert.ok(report.trace.some((entry) => entry.type === 'presentationRecovery'));
  assert.equal(t.screenshots(), 1);
  assert.equal(t.inputs(), 1);
  const shot = t.chrome.commands.find((c) => c.method === 'Page.captureScreenshot')!;
  assert.equal(shot.sessionId, t.session.id);
  t.chrome.assertDone();
});

test('a command a frame does not release is recovered once; cleanup waits for the frame', async () => {
  await using t = await target(20);
  const answer = gate(),
    drawn = gate();
  t.chrome.handle('Input.dispatchMouseEvent', async () => {
    await answer.promise;
  });
  t.chrome.handle('Page.captureScreenshot', async () => {
    await drawn.promise;
    return { data: '' };
  });
  const error = await t.mouse.move(1, 1, { timeout: 150, cleanupTimeout: 2000 }).catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.ok(error.cause instanceof TimeoutError);
  assert.equal(t.screenshots(), 1);
  let done = false;
  const cleanup = error.cleanup.then((result) => {
    done = true;
    return result;
  });
  answer.resolve();
  await sleep(50);
  assert.equal(done, false);
  drawn.resolve();
  const result = await cleanup;
  assert.equal(result.status, 'completed');
  assert.equal(result.report.presentationRecoveries, 1);
  assert.equal(t.screenshots(), 1);
  assert.equal(t.inputs(), 1);
});

test('a command left unanswered by a cancelled action is still recovered during cleanup', async () => {
  await using t = await target(40);
  const sent = gate(),
    drawn = gate();
  t.chrome.handle('Page.captureScreenshot', () => {
    drawn.resolve();
    return { data: '' };
  });
  t.chrome.handle('Input.dispatchMouseEvent', async () => {
    sent.resolve();
    await drawn.promise;
  });
  const controller = new AbortController();
  const failure = t.mouse.move(1, 1, { signal: controller.signal, cleanupTimeout: 2000 });
  await sent.promise;
  const reason = new Error('stop');
  controller.abort(reason);
  const error = await failure.catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.equal(error.cause, reason);
  assert.equal(error.report.presentationRecoveries, 0);
  const result = await error.cleanup;
  assert.equal(result.status, 'completed');
  assert.equal(result.report.presentationRecoveries, 1);
  assert.equal(t.inputs(), 1);
  // The next action is not blocked.
  t.chrome.handle('Input.dispatchMouseEvent', () => {});
  await t.mouse.move(2, 2);
});

test('no frame is requested while a dialog holds replies, nor when recovery is off', async () => {
  await using t = await target(20);
  const answer = gate();
  t.chrome.handle('Page.captureScreenshot', () => {
    answer.resolve();
    return { data: '' };
  });
  t.chrome.handle('Input.dispatchMouseEvent', async () => {
    await answer.promise;
  });
  t.chrome.emit(
    'Page.javascriptDialogOpening',
    { url: 'about:blank', frameId: 'f', message: 'hi', type: 'alert', hasBrowserHandler: true },
    t.session.id,
  );
  const move = t.mouse.move(1, 1);
  await sleep(100);
  assert.equal(t.screenshots(), 0);
  t.chrome.emit(
    'Page.javascriptDialogClosed',
    { frameId: 'f', result: true, userInput: '' },
    t.session.id,
  );
  assert.equal((await move).presentationRecoveries, 1);

  t.mouse.behavior.configure({ presentationRecovery: false });
  const reply = gate();
  t.chrome.handle('Input.dispatchMouseEvent', async () => {
    await reply.promise;
  });
  const stalled = t.mouse.move(2, 2);
  await sleep(100);
  reply.resolve();
  assert.equal((await stalled).presentationRecoveries, 0);
  assert.equal(t.screenshots(), 1);
});

test('commands answered in time request no frame', async () => {
  await using t = await target(20);
  t.chrome.handle('Input.dispatchMouseEvent', () => {});
  await t.mouse.click(3, 3);
  await sleep(60);
  assert.equal(t.screenshots(), 0);
  t.chrome.assertDone();
  // Only Input commands are watched.
  t.chrome.handle('Page.getLayoutMetrics', () => NO_REPLY);
  t.mouse.behavior.configure({ mode: 'human', presentationRecovery: 20 });
  const error = await new Mouse(t.session, t.mouse.behavior)
    .move(9, 9, { timeout: 100, cleanupTimeout: 100 })
    .catch((e) => e);
  assert.ok(error instanceof InputActionError);
  await error.cleanup;
  assert.equal(t.screenshots(), 0);
});

test('presentationRecovery accepts false or 10–60000 ms', () => {
  const behavior = new InputBehavior(
    (task) => task(),
    () => {},
  );
  assert.equal(behavior.policy.presentationRecovery, 250);
  behavior.configure({ presentationRecovery: false });
  assert.equal(behavior.policy.presentationRecovery, false);
  behavior.configure({ presentationRecovery: 10 });
  for (const value of [9, 60001, Number.NaN, true, '250'])
    assert.throws(
      () => behavior.configure({ presentationRecovery: value as number }),
      /presentationRecovery/,
    );
  behavior.configure({});
  assert.equal(behavior.policy.presentationRecovery, 250);
});

test('input to an out-of-process frame recovers through a session of its page', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  const page = await browser.attachSession(browser.pageTargets[0]!.targetId);
  chrome.emit(
    'Target.attachedToTarget',
    {
      sessionId: 'frame-session',
      targetInfo: {
        targetId: 'frame',
        type: 'iframe',
        title: '',
        url: 'https://frame.test/',
        attached: true,
        canAccessOpener: false,
      },
      waitingForDebugger: false,
    },
    page.id,
  );
  // The event is handled once a later reply arrives.
  await browser.cdp.send('Browser.getVersion');
  const frame = browser.connection.session('frame-session');
  const drawn = gate();
  chrome.handle('Input.dispatchMouseEvent', async () => {
    await drawn.promise;
  });
  chrome.handle('Page.captureScreenshot', (_, command) => {
    // Chrome captures only top-level targets.
    if (command.sessionId !== page.id)
      throw new ProtocolError(
        'Page.captureScreenshot',
        -32000,
        'Command can only be executed on top-level targets',
      );
    drawn.resolve();
    return { data: '' };
  });
  const mouse = new Mouse(frame);
  mouse.behavior.configure({ presentationRecovery: 20 });
  const report = await mouse.move(1, 1, { timeout: 2000 });
  assert.equal(report.presentationRecoveries, 1);
  const shots = chrome.commands.filter((c) => c.method === 'Page.captureScreenshot');
  assert.deepEqual(
    shots.map((c) => c.sessionId),
    [page.id],
  );
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.dispatchMouseEvent').length, 1);
});

/** A scope on one browser connection, and a page on another that its callback sends input to. */
async function crossConnection() {
  const scoped = await ScriptedChrome.start();
  const other = await ScriptedChrome.start();
  const scopedBrowser = await scoped.connect({ attach: 'none' });
  const otherBrowser = await other.connect({ attach: 'none' });
  const scopePage = await scopedBrowser.attachSession(scopedBrowser.pageTargets[0]!.targetId);
  const page = await otherBrowser.attachSession(otherBrowser.pageTargets[0]!.targetId);
  const scope = scopedBrowser.inputScope(scopePage, {
    pageEvents: false,
    policy: { presentationRecovery: 20 },
  });
  return {
    scoped,
    other,
    otherBrowser,
    page,
    scope,
    async [Symbol.asyncDispose]() {
      await scopedBrowser.close();
      await otherBrowser.close();
      await scoped.close();
      await other.close();
    },
  };
}

test('raw input on another connection recovers through that connection’s page session', async () => {
  await using t = await crossConnection();
  t.other.emit(
    'Target.attachedToTarget',
    {
      sessionId: 'frame-session',
      targetInfo: {
        targetId: 'frame',
        type: 'iframe',
        title: '',
        url: 'https://frame.test/',
        attached: true,
        canAccessOpener: false,
      },
      waitingForDebugger: false,
    },
    t.page.id,
  );
  await t.otherBrowser.cdp.send('Browser.getVersion');
  const frame = t.otherBrowser.connection.session('frame-session');
  const drawn = gate();
  t.other.handle('Input.dispatchMouseEvent', async () => {
    await drawn.promise;
  });
  t.other.handle('Page.captureScreenshot', (_, command) => {
    if (command.sessionId !== t.page.id)
      throw new ProtocolError(
        'Page.captureScreenshot',
        -32000,
        'Command can only be executed on top-level targets',
      );
    drawn.resolve();
    return { data: '' };
  });
  const report = await t.scope.run(
    async () => {
      await frame.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    },
    { timeout: 2000 },
  );
  assert.equal(report.presentationRecoveries, 1);
  const shots = t.other.commands.filter((c) => c.method === 'Page.captureScreenshot');
  assert.deepEqual(
    shots.map((c) => c.sessionId),
    [t.page.id],
  );
  assert.equal(t.scoped.commands.filter((c) => c.method === 'Page.captureScreenshot').length, 0);
});

test('a dialog on another connection pauses recovery of raw input sent there', async () => {
  await using t = await crossConnection();
  t.other.emit(
    'Page.javascriptDialogOpening',
    { url: 'about:blank', frameId: 'frame', message: '', type: 'alert', hasBrowserHandler: true },
    t.page.id,
  );
  await t.otherBrowser.cdp.send('Browser.getVersion');
  let dialog = true,
    duringDialog = 0;
  const sent = gate(),
    drawn = gate();
  t.other.handle('Input.dispatchMouseEvent', async () => {
    sent.resolve();
    await drawn.promise;
  });
  t.other.handle('Page.captureScreenshot', () => {
    if (dialog) duringDialog++;
    else drawn.resolve();
    return { data: '' };
  });
  const running = t.scope.run(
    async () => {
      await t.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    },
    { timeout: 2000 },
  );
  await sent.promise;
  await sleep(80);
  dialog = false;
  t.other.emit(
    'Page.javascriptDialogClosed',
    { frameId: 'frame', result: true, userInput: '' },
    t.page.id,
  );
  const report = await running;
  assert.equal(duringDialog, 0);
  assert.equal(report.presentationRecoveries, 1);
});
