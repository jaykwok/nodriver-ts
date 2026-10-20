import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Session,
  SessionEndedError,
  TimeoutError,
  type ConnectionObserver,
} from '../../src/index.ts';
import { ScriptedChrome, NO_REPLY } from '../../src/testing/index.ts';
import { poll } from '../../src/utils.ts';
import { BrowserProcess } from '../../src/browser/launcher.ts';
import { Browser } from '../../src/browser/browser.ts';
import { WebSocketTransport } from '../../src/transport/websocket.ts';

test('launch none finishes its scripted handshake without a startup Tab or headless UA probe', async (t) => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  let ownedClosed = false;
  // Substitute only the OS process boundary; Browser and its CDP handshake remain real.
  t.mock.method(BrowserProcess, 'start', async () => ({
    endpoint: chrome.endpoint,
    transport: await WebSocketTransport.connect(chrome.endpoint),
    process: {
      released: false,
      diagnostics: { exited: false },
      waitForExit: async () => true,
      close: async () => {
        ownedClosed = true;
      },
    },
  }));
  chrome.handle('Browser.close', () => {});
  const browser = await Browser.launch({ attach: 'none', headless: true, timeout: 1000 });
  assert.deepEqual(
    chrome.commands.map((c) => c.method),
    [
      'Browser.getVersion',
      'Target.getBrowserContexts',
      'Target.setDiscoverTargets',
      'Target.getTargets',
    ],
  );
  assert.deepEqual(browser.tabs, []);
  await browser.close();
  assert.equal(ownedClosed, true);
  await assert.rejects(
    Browser.launch({ attach: 'none', maskHeadless: true }),
    /does not support maskHeadless/,
  );
});

test('launch abort in the scripted handshake cleans the owned process', async (t) => {
  await using chrome = await ScriptedChrome.start();
  let ownedClosed = false;
  t.mock.method(BrowserProcess, 'start', async () => ({
    endpoint: chrome.endpoint,
    transport: await WebSocketTransport.connect(chrome.endpoint),
    process: {
      diagnostics: { exited: false },
      close: async () => {
        ownedClosed = true;
      },
    },
  }));
  const controller = new AbortController();
  chrome.handle('Target.getTargets', () => {
    controller.abort(new Error('stop launch'));
    return NO_REPLY;
  });
  await assert.rejects(
    Browser.launch({ attach: 'none', signal: controller.signal }),
    /stop launch/,
  );
  assert.equal(ownedClosed, true);
});

test('none discovers initial, later and popup targets without building Tabs or configuring domains', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  assert.deepEqual(
    chrome.commands.map((c) => c.method),
    [
      'Browser.getVersion',
      'Target.getBrowserContexts',
      'Target.setDiscoverTargets',
      'Target.getTargets',
    ],
  );
  const id = browser.pageTargets[0]!.targetId;
  const created = browser.cdp.waitFor('Target.targetCreated');
  chrome.addPage();
  await created;
  const popup = browser.cdp.waitFor('Target.targetCreated');
  chrome.emit('Target.targetCreated', {
    targetInfo: {
      ...browser.pageTargets[0]!,
      targetId: 'popup',
      openerId: id,
    },
  });
  await popup;
  const before = chrome.commands.length;
  const session = await browser.attachSession(id);
  assert.ok(session instanceof Session);
  assert.equal(session.targetId, id);
  assert.deepEqual(
    chrome.commands.slice(before).map(({ method, params }) => ({ method, params })),
    [{ method: 'Target.attachToTarget', params: { targetId: id, flatten: true } }],
  );
  assert.equal(browser.pageTargets.length, 3);
  assert.deepEqual(browser.tabs, []);
  await assert.rejects(browser.newTab(), /forbids Tab/);
  await assert.rejects(browser.attachTarget(id), /forbids Tab/);
  await assert.rejects(browser.defaultContext.newTab(), /forbids Tab/);
  assert.equal(chrome.commands.length, before + 1);
  chrome.replyOnce('Runtime.evaluate', { result: { type: 'number', value: 42 } });
  assert.equal((await session.send('Runtime.evaluate', { expression: '6 * 7' })).result.value, 42);
  chrome.assertDone();
});

test('none also becomes ready with no pages', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  await using browser = await chrome.connect({ attach: 'none' });
  assert.deepEqual(browser.tabs, []);
  assert.deepEqual(browser.pageTargets, []);
});

test('concurrent attachments are independent; explicit detach terminates only one', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  const id = browser.pageTargets[0]!.targetId;
  const [a, b] = await Promise.all([browser.attachSession(id), browser.attachSession(id)]);
  assert.notEqual(a.id, b.id);
  chrome.handle('Runtime.evaluate', () => NO_REPLY);
  const pending = assert.rejects(a.send('Runtime.evaluate', { expression: 'pending' }), {
    reason: 'detach-requested',
  });
  const waiting = assert.rejects(a.waitFor('Page.loadEventFired'), { reason: 'detach-requested' });
  const closed = a.detach();
  assert.equal(a.closed, true);
  assert.equal(a.detach(), closed);
  assert.equal(await a.ended, 'detach-requested');
  await Promise.all([closed, pending, waiting]);
  assert.equal(b.closed, false);
  assert.equal(browser.connection.pendingCount, 0);
  assert.deepEqual(chrome.commands.at(-1)!.params, { sessionId: a.id });
  const abort = AbortSignal.abort(new Error('already cancelled'));
  await assert.rejects(b.detach({ signal: abort }), /already cancelled/);
  assert.equal(b.closed, false);
  chrome.assertDone();
});

for (const reason of ['detached', 'target-destroyed', 'target-crashed', 'disconnected'] as const) {
  test(`${reason} immediately ends requests, waits and subscriptions`, async () => {
    await using chrome = await ScriptedChrome.start();
    await using browser = await chrome.connect({ attach: 'none' });
    const baseline = browser.connection.listenerCount;
    const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
    let events = 0;
    session.on('Page.loadEventFired', () => {
      events++;
    });
    session.onAny(() => {
      events++;
    });
    chrome.handle('Runtime.evaluate', () => NO_REPLY);
    const isReason = (e: unknown) =>
      e instanceof SessionEndedError && e.reason === reason && e.targetId === session.targetId;
    const pending = assert.rejects(
      session.send('Runtime.evaluate', { expression: 'pending' }),
      isReason,
    );
    const waiting = assert.rejects(session.waitFor('Page.loadEventFired'), isReason);
    if (reason === 'detached') chrome.detachSession(session.id!);
    if (reason === 'target-destroyed')
      chrome.emit('Target.targetDestroyed', { targetId: session.targetId });
    if (reason === 'target-crashed') chrome.crashTarget(session.targetId);
    if (reason === 'disconnected') chrome.disconnect();
    assert.equal(await session.ended, reason);
    await Promise.all([pending, waiting]);
    assert.equal(session.closed, true);
    assert.equal(session.endReason, reason);
    await assert.rejects(session.send('Page.reload'), isReason);
    await assert.rejects(session.waitFor('Page.loadEventFired'), isReason);
    assert.throws(() => session.on('Page.loadEventFired', () => {}), isReason);
    assert.equal(events, 0);
    if (reason !== 'disconnected') {
      await poll(async () => browser.connection.pendingCount === 0 || undefined, { timeout: 1000 });
      assert.equal(browser.connection.listenerCount, baseline);
    } else assert.equal(browser.connection.listenerCount, 0);
    chrome.assertDone();
  });
}

for (const mode of ['abort', 'timeout'] as const) {
  test(`${mode} rejects promptly, then detaches the late attachment without affecting its sibling`, async () => {
    await using chrome = await ScriptedChrome.start();
    await using browser = await chrome.connect({ attach: 'none' });
    const target = browser.pageTargets[0]!.targetId;
    const sibling = await browser.attachSession(target);
    const baseline = browser.connection.listenerCount;
    chrome.attachReplyDelayMs = 150;
    const controller = new AbortController();
    const event = browser.cdp.waitFor('Target.attachedToTarget');
    const pending = assert.rejects(
      browser.attachSession(target, {
        signal: controller.signal,
        timeout: mode === 'timeout' ? 50 : 1000,
      }),
      mode === 'abort' ? /cancelled/ : TimeoutError,
    );
    const { sessionId } = await event;
    if (mode === 'abort') controller.abort(new Error('cancelled'));
    await pending;
    assert.equal(
      chrome.commands.some((c) => c.method === 'Target.detachFromTarget'),
      false,
    );
    await poll(
      async () => chrome.commands.some((c) => c.method === 'Target.detachFromTarget') || undefined,
      { timeout: 2000 },
    );
    assert.deepEqual(chrome.commands.at(-1)!.params, { sessionId });
    await poll(async () => browser.connection.pendingCount === 0 || undefined, { timeout: 1000 });
    assert.equal(sibling.closed, false);
    assert.equal(browser.closed, false);
    assert.equal(browser.connection.listenerCount, baseline);
    chrome.assertDone();
  });
}

test('detach before an attach reply never returns a zombie session', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  chrome.attachReplyDelayMs = 100;
  const attached = browser.cdp.waitFor('Target.attachedToTarget');
  const pending = assert.rejects(browser.attachSession(browser.pageTargets[0]!.targetId), {
    reason: 'detached',
  });
  chrome.detachSession((await attached).sessionId);
  await pending;
  assert.equal(browser.connection.pendingCount, 0);
  assert.equal(browser.closed, false);
});

test('target destruction during attach rejects before the late reply', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  chrome.attachReplyDelayMs = 150;
  const id = browser.pageTargets[0]!.targetId;
  const event = browser.cdp.waitFor('Target.attachedToTarget');
  const pending = assert.rejects(browser.attachSession(id), { reason: 'target-destroyed' });
  await event;
  chrome.destroyTarget(id);
  await pending;
  await poll(
    async () => chrome.commands.some((c) => c.method === 'Target.detachFromTarget') || undefined,
    { timeout: 2000 },
  );
  assert.equal(browser.closed, false);
});

test('unanswerable cancelled attach disconnects within its independent cleanup deadline', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  chrome.handle('Target.attachToTarget', () => NO_REPLY);
  const controller = new AbortController();
  const pending = assert.rejects(
    browser.attachSession(browser.pageTargets[0]!.targetId, { signal: controller.signal }),
    /cancelled/,
  );
  controller.abort(new Error('cancelled'));
  await pending;
  await poll(async () => browser.closed || undefined, { timeout: 6500 });
  assert.equal(browser.connection.pendingCount, 0);
  assert.equal(browser.connection.listenerCount, 0);
});

test('failed late detach fails closed instead of leaving an invisible attachment', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  chrome.attachReplyDelayMs = 50;
  chrome.handle('Target.detachFromTarget', () => {
    throw new Error('cannot detach');
  });
  const controller = new AbortController();
  const attached = browser.cdp.waitFor('Target.attachedToTarget');
  const pending = assert.rejects(
    browser.attachSession(browser.pageTargets[0]!.targetId, { signal: controller.signal }),
    /cancelled/,
  );
  await attached;
  controller.abort(new Error('cancelled'));
  await pending;
  await poll(async () => browser.closed || undefined, { timeout: 1000 });
});

test('aborted explicit detach still cleans its attachment with an independent request', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
  const controller = new AbortController();
  chrome.replyOnce('Target.detachFromTarget', () => {
    controller.abort(new Error('stop detach'));
    return NO_REPLY;
  });
  await assert.rejects(session.detach({ signal: controller.signal }), /stop detach/);
  assert.equal(await session.ended, 'detach-requested');
  await poll(
    async () =>
      chrome.commands.filter((c) => c.method === 'Target.detachFromTarget').length === 2 ||
      undefined,
    { timeout: 1000 },
  );
  await poll(async () => browser.connection.pendingCount === 0 || undefined, { timeout: 1000 });
  assert.equal(browser.closed, false);
});

for (const method of [
  'Browser.getVersion',
  'Target.getBrowserContexts',
  'Target.setDiscoverTargets',
  'Target.getTargets',
  'Target.attachToTarget',
] as const) {
  for (const abort of [false, true]) {
    test(`initialization ${abort ? 'abort' : 'deadline'} includes ${method}`, async () => {
      await using chrome = await ScriptedChrome.start();
      const controller = new AbortController();
      chrome.handle(method, () => {
        if (abort) controller.abort(new Error('stop startup'));
        return NO_REPLY;
      });
      await assert.rejects(
        chrome.connect({
          attach: method === 'Target.attachToTarget' ? 'all' : 'none',
          timeout: 100,
          signal: controller.signal,
        }),
        abort ? /stop startup/ : TimeoutError,
      );
    });
  }
}

test('initialization has one total deadline across successful steps', async () => {
  await using chrome = await ScriptedChrome.start();
  chrome.handle('Target.getBrowserContexts', async () => {
    await delay(70);
    return { browserContextIds: [] };
  });
  chrome.handle('Target.setDiscoverTargets', async () => {
    await delay(70);
  });
  await assert.rejects(chrome.connect({ attach: 'none', timeout: 110 }), TimeoutError);
  assert.equal(
    chrome.commands.some((c) => c.method === 'Target.getTargets'),
    false,
  );
});

test('send observer preserves wire order including reentrancy; settlement order and trace remain independent', async () => {
  await using chrome = await ScriptedChrome.start();
  const sends: Parameters<NonNullable<ConnectionObserver['onSend']>>[0][] = [];
  const settles: number[] = [];
  const traces: string[] = [];
  await using browser = await chrome.connect({
    attach: 'none',
    observe: {
      onSend(event) {
        sends.push(event);
      },
      onSettle(event) {
        settles.push(event.seq);
      },
    },
    trace(e) {
      traces.push(e.method);
    },
  });
  const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
  let nested: Promise<unknown> | undefined;
  browser.connection.options.observe!.onSend = (event) => {
    sends.push(event);
    if (event.method === 'Runtime.evaluate') nested = session.send('Page.reload');
    throw new Error('observer errors are isolated');
  };
  chrome.handle('Runtime.evaluate', async () => {
    await delay(50);
    return { result: { type: 'number', value: 42 } };
  });
  chrome.handle('Page.reload', () => {});
  const evaluating = session.send('Runtime.evaluate', { expression: 'private payload' });
  assert.equal(sends.at(-2)!.method, 'Runtime.evaluate'); // onSend runs before send() returns
  assert.equal(sends.at(-1)!.method, 'Page.reload');
  await Promise.all([evaluating, nested]);
  assert.deepEqual(
    sends.map((s) => s.seq),
    chrome.commands.map((c) => c.id),
  );
  assert.deepEqual(
    sends.map((s) => s.method),
    chrome.commands.map((c) => c.method),
  );
  assert.equal(JSON.stringify(sends).includes('private payload'), false);
  assert.ok(sends.every((s) => Number.isFinite(s.at)));
  assert.deepEqual(
    settles.slice(-2),
    sends
      .slice(-2)
      .reverse()
      .map((s) => s.seq),
  );
  assert.deepEqual(traces.slice(-2), ['Page.reload', 'Runtime.evaluate']);
  chrome.assertDone();
});
