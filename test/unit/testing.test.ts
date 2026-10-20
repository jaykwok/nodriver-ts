import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Browser, ProtocolError, TimeoutError } from '../../src/index.ts';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';

test('scripted Chrome builds real Browser, Tab and Session objects with a strict handshake', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  assert.ok(browser instanceof Browser);
  assert.equal(browser.tabs.length, 1);
  const tab = browser.tabs[0]!;
  assert.equal(tab.url, 'about:blank');
  assert.equal(tab.mainFrame.session, tab.cdp);
  chrome.replyOnce('Page.captureScreenshot', { data: Buffer.from('frame').toString('base64') });
  assert.equal((await tab.screenshot()).toString(), 'frame');
  assert.equal(chrome.commands.at(-1)!.method, 'Page.captureScreenshot');
  assert.equal(chrome.commands.at(-1)!.sessionId, tab.cdp.id);
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 8 }));
  chrome.replyOnce('Runtime.evaluate', { result: { type: 'number', value: 42 } });
  assert.equal(await tab.evaluate('answer', undefined, { world: 'isolated' }), 42);
  assert.equal(
    chrome.commands.some((c) => c.method === 'Runtime.enable'),
    false,
  );
  chrome.assertDone();
});

test('queued and persistent typed handlers see params, route by session, and preserve wire records', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{}, {}] });
  await using browser = await chrome.connect();
  const [a, b] = browser.tabs;
  const off = chrome.handle('Runtime.evaluate', (params, command) => {
    assert.equal(params.expression, 'secret()');
    params.expression = 'mutated in handler';
    return { result: { type: 'string', value: command.sessionId } };
  });
  chrome.replyOnce('Runtime.evaluate', { result: { type: 'number', value: 7 } });
  const responses = await Promise.all([
    a!.cdp.send('Runtime.evaluate', { expression: 'queued' }),
    b!.cdp.send('Runtime.evaluate', { expression: 'secret()' }),
  ]);
  assert.equal(responses[0]!.result.value, 7);
  assert.equal(responses[1]!.result.value, b!.cdp.id);
  const recorded = chrome.commands.at(-1)!;
  assert.deepEqual(recorded.params, { expression: 'secret()' });
  off();
  chrome.replyOnce('Runtime.evaluate', () => {
    throw new ProtocolError('Runtime.evaluate', -32001, 'scripted failure', 'details');
  });
  await assert.rejects(
    a!.cdp.send('Runtime.evaluate', { expression: 'fail' }),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === -32001 && error.data === 'details',
  );
  chrome.assertDone();
});

test('unexpected methods fail explicitly and unused scripts are detectable', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  await assert.rejects(
    browser.tabs[0]!.cdp.send('Runtime.evaluate', { expression: 'not scripted' }),
    /Unscripted command Runtime.evaluate/,
  );
  chrome.replyOnce('Page.captureScreenshot', { data: '' });
  assert.throws(() => chrome.assertDone(), /Page.captureScreenshot: 1.*Runtime.evaluate/);
  assert.equal(chrome.unexpectedCommands.length, 1);
});

test('scripted no-reply commands support real timeouts, aborts, and abrupt disconnection', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  chrome.handle('Runtime.evaluate', () => NO_REPLY);
  await assert.rejects(
    tab.cdp.sendWith('Runtime.evaluate', { timeout: 30 }, { expression: 'timeout' }),
    TimeoutError,
  );
  const controller = new AbortController();
  const cancelled = assert.rejects(
    tab.cdp.sendWith('Runtime.evaluate', { signal: controller.signal }, { expression: 'abort' }),
    /cancel/,
  );
  controller.abort(new Error('cancel'));
  await cancelled;
  const pending = assert.rejects(
    tab.cdp.send('Runtime.evaluate', { expression: 'disconnect' }),
    /closed/i,
  );
  const waiting = assert.rejects(tab.cdp.waitFor('Page.loadEventFired'), /closed/i);
  chrome.disconnect();
  await Promise.all([pending, waiting]);
  assert.equal(browser.closed, true);
  assert.equal(browser.connection.pendingCount, 0);
});

test('target creation, contexts, crash and destroy events update real browser objects', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  await using browser = await chrome.connect();
  const ready = browser.waitForTab();
  const id = chrome.addPage({ url: 'https://fixture.test/' });
  const tab = await ready;
  assert.equal(tab.id, id);
  const crashed = tab.cdp.waitFor('Inspector.targetCrashed');
  chrome.crashTarget(id);
  await crashed;
  assert.equal(tab.crashed, true);
  const destroyed = browser.cdp.waitFor('Target.targetDestroyed');
  chrome.destroyTarget(id);
  await destroyed;
  assert.equal(tab.closed, true);
  assert.equal(browser.tabs.length, 0);
  const context = await browser.newContext();
  const other = await context.newTab();
  assert.equal(other.context, context);
  await context.close();
  assert.equal(other.closed, true);
  chrome.assertDone();
});

test('raw events are session scoped and a delayed response never crosses a reconnect', async () => {
  await using chrome = await ScriptedChrome.start();
  const browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  const ready = tab.cdp.waitFor('Page.loadEventFired');
  chrome.emit('Page.loadEventFired', { timestamp: 12 }, tab.cdp.id);
  assert.equal((await ready).timestamp, 12);
  let finish!: (result: { result: { type: 'number'; value: number } }) => void;
  let seen!: () => void;
  const received = new Promise<void>((resolve) => {
    seen = resolve;
  });
  chrome.replyOnce(
    'Runtime.evaluate',
    () =>
      new Promise((resolve) => {
        finish = resolve;
        seen();
      }),
  );
  const pending = assert.rejects(
    tab.cdp.send('Runtime.evaluate', { expression: 'late' }),
    /closed/i,
  );
  await received;
  await browser.close();
  await pending;
  await using reconnected = await chrome.connect();
  finish({ result: { type: 'number', value: 99 } });
  chrome.replyOnce('Runtime.evaluate', { result: { type: 'number', value: 42 } });
  assert.equal(
    (await reconnected.tabs[0]!.cdp.send('Runtime.evaluate', { expression: 'current' })).result
      .value,
    42,
  );
  chrome.assertDone();
});

test('startup can be scripted to fail and closing the fixture rejects outstanding work', async () => {
  const chrome = await ScriptedChrome.start();
  try {
    chrome.replyOnce('Browser.getVersion', () => {
      throw new Error('handshake failure');
    });
    await assert.rejects(chrome.connect(), /handshake failure/);
    await using browser = await chrome.connect();
    chrome.handle('Runtime.evaluate', () => NO_REPLY);
    const pending = assert.rejects(
      browser.tabs[0]!.cdp.send('Runtime.evaluate', { expression: 'pending' }),
      /closed/i,
    );
    await chrome.close();
    await pending;
  } finally {
    await chrome.close();
  }
});
