import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ProtocolError, TimeoutError } from '../../src/index.ts';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

test('a tab scope closes a popup of its tab that is still attaching', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const scope = browser.tabScope();
  const tab = await scope.newTab();
  chrome.attachReplyDelayMs = 5_000;
  const popup = chrome.addPage({ openerId: tab.id });
  const other = chrome.addPage();
  // Discovery reaches the browser before close() runs; the attach replies stay pending.
  while (!browser.targetInfo.has(popup) || !browser.targetInfo.has(other))
    await new Promise((resolve) => setTimeout(resolve, 10));
  const result = await scope.close();
  assert.deepEqual(new Set(result.closed), new Set([tab.id, popup]));
  const closed = chrome.commands
    .filter((command) => command.method === 'Target.closeTarget')
    .map((command) => (command.params as { targetId: string }).targetId);
  assert.deepEqual(new Set(closed), new Set([tab.id, popup]));
  chrome.attachReplyDelayMs = 0;
});

test('an adopted tab and its later popups belong to a context scope', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const context = await browser.newContext();
  const existing = await context.newTab();
  const other = await context.newTab();
  const scope = context.tabScope();
  scope.adopt(existing);
  const popup = chrome.addPage({ openerId: existing.id, browserContextId: context.id });
  await browser.waitForTab((tab) => tab.id === popup);
  assert.deepEqual(new Set(scope.tabs.map((tab) => tab.id)), new Set([existing.id, popup]));
  assert.throws(() => scope.adopt(browser.tabs[0]!), TypeError);
  const result = await scope.close();
  assert.deepEqual(new Set(result.closed), new Set([existing.id, popup]));
  assert.equal(other.closed, false);
  assert.throws(() => scope.adopt(other), /closed/);
});

test('closing a scope waits for a tab that was still opening and closes it', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  let late = '';
  chrome.handle('Target.createTarget', async () => {
    await sleep(20);
    late = chrome.addPage();
    return { targetId: late };
  });
  chrome.handle('Target.closeTarget', async ({ targetId }) => {
    await sleep(150);
    // As in Chrome, the close is answered before the target is gone.
    setTimeout(() => chrome.destroyTarget(targetId), 100);
    return { success: true };
  });
  const scope = browser.tabScope();
  const opening = scope.newTab().catch((error: unknown) => error);
  const result = await scope.close();
  assert.deepEqual(result.closed, [late]);
  assert.ok(!browser.tabs.some((tab) => tab.id === late), 'its Tab ended with the page');
  assert.match(String(await opening), /closed while the tab was opening/);
  assert.equal(await scope.close(), result);
  for (let i = 0; i < 50 && browser.targetInfo.has(late); i++) await sleep(10);
  assert.ok(!browser.pageTargets.some((info) => info.targetId === late));
});

test('a popup opened while newTab navigates belongs to the scope', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const scope = browser.tabScope();
  let popup = '';
  chrome.handle('Page.navigate', async ({ url }, command) => {
    const frameId = browser.tabs.find((tab) => tab.session.id === command.sessionId)!.id;
    popup = chrome.addPage({ openerId: frameId });
    await browser.waitForTab((tab) => tab.id === popup);
    const loaderId = 'navigation';
    chrome.emit(
      'Page.frameNavigated',
      {
        type: 'Navigation',
        frame: {
          id: frameId,
          loaderId,
          url,
          domainAndRegistry: '',
          securityOrigin: 'https://app.test',
          mimeType: 'text/html',
          secureContextType: 'Secure',
          crossOriginIsolatedContextType: 'NotIsolated',
          gatedAPIFeatures: [],
        },
      },
      command.sessionId,
    );
    chrome.emit(
      'Page.lifecycleEvent',
      { frameId, loaderId, name: 'load', timestamp: 1 },
      command.sessionId,
    );
    return { frameId, loaderId };
  });
  const root = await scope.newTab('https://app.test/');
  assert.ok(scope.tabs.some((tab) => tab.id === popup));
  scope.keep(root);
  const result = await scope.close();
  assert.deepEqual(result, { closed: [popup], kept: [root.id], borrowed: [] });
  assert.equal(root.closed, false);
});

test('a borrowed tab stays open while popups it opens during the scope close with it', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const start = browser.tabs[0]!;
  const before = chrome.addPage({ openerId: start.id });
  await browser.waitForTab((tab) => tab.id === before);
  const scope = browser.tabScope();
  scope.borrow(start);
  assert.deepEqual(scope.tabs, [], 'a borrowed tab is not closed with the scope');
  const popup = chrome.addPage({ openerId: start.id });
  const nested = await browser.waitForTab((tab) => tab.id === popup);
  const grandchild = chrome.addPage({ openerId: nested.id });
  await browser.waitForTab((tab) => tab.id === grandchild);
  // Reported by Chrome but not yet attached when the scope closes.
  chrome.attachReplyDelayMs = 5_000;
  const attaching = chrome.addPage({ openerId: start.id });
  while (!browser.targetInfo.has(attaching)) await sleep(5);
  const result = await scope.close();
  chrome.attachReplyDelayMs = 0;
  assert.deepEqual(new Set(result.closed), new Set([popup, grandchild, attaching]));
  assert.deepEqual(result.borrowed, [start.id]);
  assert.equal(start.closed, false);
  assert.ok(browser.targetInfo.has(before), 'a popup from before the scope is not owned');
  // After the scope, the tab's popups are no longer collected.
  const later = chrome.addPage({ openerId: start.id });
  await browser.waitForTab((tab) => tab.id === later);
  assert.ok(browser.targetInfo.has(later));
});

test('borrow, adopt and keep move a tab between roles', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  const scope = browser.tabScope();
  scope.adopt(tab);
  scope.borrow(tab);
  assert.deepEqual(scope.tabs, []);
  scope.keep(tab);
  const ignored = chrome.addPage({ openerId: tab.id });
  await browser.waitForTab((t) => t.id === ignored);
  scope.borrow(tab);
  const owned = chrome.addPage({ openerId: tab.id });
  await browser.waitForTab((t) => t.id === owned);
  assert.deepEqual(await scope.close(), { closed: [owned], kept: [], borrowed: [tab.id] });
  assert.throws(() => scope.borrow(tab), /closed/);
  const other = await browser.newContext();
  assert.throws(() => other.tabScope().borrow(tab), TypeError);
});

test('newTab closes a tab Chrome creates after the caller stopped waiting', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  let late = '';
  chrome.handle('Target.createTarget', async () => {
    await sleep(150);
    late = chrome.addPage();
    return { targetId: late };
  });
  const started = performance.now();
  await assert.rejects(browser.newTab('about:blank', undefined, { timeout: 40 }), TimeoutError);
  assert.ok(performance.now() - started < 140);
  const controller = new AbortController();
  const aborted = browser.defaultContext.newTab('about:blank', { signal: controller.signal });
  controller.abort(new Error('stop'));
  await assert.rejects(aborted, /stop/);
  const closes = () => chrome.commands.filter((c) => c.method === 'Target.closeTarget').length;
  for (let i = 0; i < 100 && closes() < 2; i++) await sleep(10);
  assert.equal(closes(), 2);
  assert.ok(!browser.pageTargets.some((info) => info.targetId === late));
});

test('one timeout covers opening a scope tab and its first navigation', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  let created = '';
  chrome.handle('Target.createTarget', async () => {
    await sleep(60);
    return { targetId: (created = chrome.addPage()) };
  });
  // The page never commits.
  chrome.handle('Page.navigate', () => ({ frameId: 'never', loaderId: 'never' }));
  const scope = browser.tabScope();
  const started = performance.now();
  await assert.rejects(scope.newTab('https://app.test/', { timeout: 200 }), TimeoutError);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 190 && elapsed < 600, String(elapsed));
  // The tab that did not load is closed, and the scope reports it.
  assert.deepEqual(await scope.close(), { closed: [created], kept: [], borrowed: [] });
  assert.deepEqual(scope.tabs, []);
});

test('a tab Chrome creates after the command timeout is closed too', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ timeout: 150 });
  let late = '';
  chrome.handle('Target.createTarget', async () => {
    await sleep(300);
    return { targetId: (late = chrome.addPage()) };
  });
  await assert.rejects(browser.newTab('about:blank', undefined, { timeout: 40 }), TimeoutError);
  const closed = () =>
    chrome.commands.some(
      ({ method, params }) =>
        method === 'Target.closeTarget' && (params as { targetId: string }).targetId === late,
    );
  for (let i = 0; i < 100 && !(late && closed()); i++) await sleep(10);
  assert.ok(late && closed(), 'the late tab was closed');
});

test('a newTab that stops does not wait for its tab to close', async () => {
  for (const through of ['browser', 'scope'] as const) {
    await using chrome = await ScriptedChrome.start();
    await using browser = await chrome.connect();
    const scope = browser.tabScope();
    const controller = new AbortController();
    const release = gate();
    chrome.handle('Page.navigate', () => {
      controller.abort(new Error('stop'));
      return NO_REPLY;
    });
    chrome.handle('Target.closeTarget', async ({ targetId }) => {
      await release.promise;
      chrome.destroyTarget(targetId);
      return { success: true };
    });
    const timer = setTimeout(() => release.resolve(), 600);
    const options = { timeout: 5_000, signal: controller.signal };
    const started = performance.now();
    await assert.rejects(
      through === 'browser'
        ? browser.newTab('https://app.test/', undefined, options)
        : scope.newTab('https://app.test/', options),
      /stop/,
    );
    assert.ok(performance.now() - started < 400, through);
    // The scope still waits for that close, and reports it.
    const result = await scope.close();
    assert.equal(result.closed.length, through === 'scope' ? 1 : 0);
    clearTimeout(timer);
    release.resolve();
  }
});

test('closing a scope waits for a tab Chrome creates after newTab stopped waiting', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const create = gate();
  let late = '';
  chrome.handle('Target.createTarget', async () => {
    await create.promise;
    return { targetId: (late = chrome.addPage()) };
  });
  const scope = browser.tabScope();
  await assert.rejects(scope.newTab('about:blank', { timeout: 40 }), TimeoutError);
  let settled = false;
  const closing = scope.close().finally(() => (settled = true));
  await sleep(50);
  assert.equal(settled, false, 'close() waits for the creation');
  create.resolve();
  assert.deepEqual(await closing, { closed: [late], kept: [], borrowed: [] });
  assert.ok(!browser.targetInfo.has(late));
});

test('a popup still attaching stays owned when its opener changes role', async () => {
  for (const role of ['borrow', 'keep'] as const) {
    await using chrome = await ScriptedChrome.start();
    await using browser = await chrome.connect();
    const tab = browser.tabs[0]!;
    const scope = browser.tabScope();
    scope.adopt(tab);
    chrome.attachReplyDelayMs = 100;
    const popup = chrome.addPage({ openerId: tab.id });
    while (!browser.targetInfo.has(popup)) await sleep(5);
    scope[role](tab);
    await browser.waitForTab((t) => t.id === popup);
    chrome.attachReplyDelayMs = 0;
    assert.deepEqual(await scope.close(), {
      closed: [popup],
      kept: role === 'keep' ? [tab.id] : [],
      borrowed: role === 'borrow' ? [tab.id] : [],
    });
    assert.equal(tab.closed, false);
  }
});

test('a page keeps its role in the scope when it is attached again', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const scope = browser.tabScope();
  const root = browser.tabs[0]!;
  scope.adopt(root);
  const id = chrome.addPage({ openerId: root.id });
  const popup = await browser.waitForTab((tab) => tab.id === id);
  scope.borrow(popup);
  chrome.detachSession(popup.session.id!);
  while (!popup.closed) await sleep(5);
  const attached = await browser.attachTarget(id);
  assert.notEqual(attached, popup);
  assert.deepEqual(await scope.close(), { closed: [root.id], kept: [], borrowed: [id] });
  assert.equal(attached.closed, false);
});

test('closing a scope waits for a tab Chrome does not create no longer than the command timeout', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ timeout: 150 });
  chrome.handle('Target.createTarget', () => NO_REPLY);
  const scope = browser.tabScope();
  const opening = scope.newTab().catch((error: unknown) => error);
  const started = performance.now();
  await assert.rejects(
    scope.close(),
    (error: unknown) => error instanceof AggregateError && error.errors[0] instanceof TimeoutError,
  );
  assert.ok(performance.now() - started < 1_000);
  assert.ok((await opening) instanceof TimeoutError);
});

test('closing a scope stops waiting at the command timeout and closes a tab still attaching later', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  await using browser = await chrome.connect({ attach: 'created', timeout: 150 });
  chrome.attachReplyDelayMs = 650;
  const scope = browser.tabScope();
  const opening = scope.newTab('about:blank', { timeout: 5_000 }).catch((error: unknown) => error);
  const attaching = () => chrome.commands.find(({ method }) => method === 'Target.attachToTarget');
  while (!attaching()) await sleep(5);
  const id = (attaching()!.params as { targetId: string }).targetId;
  const started = performance.now();
  const error = await scope.close().catch((error: unknown) => error);
  assert.ok(performance.now() - started < 400);
  assert.ok(error instanceof AggregateError, String(error));
  assert.ok(error.errors.every((e) => e instanceof TimeoutError));
  // Once attached, the tab still closes, and its newTab() call is told.
  assert.match(String(await opening), /closed while the tab was opening/);
  assert.ok(!browser.tabs.some((tab) => tab.id === id));
  for (let i = 0; i < 50 && browser.targetInfo.has(id); i++) await sleep(10);
  assert.ok(!browser.targetInfo.has(id));
  chrome.attachReplyDelayMs = 0;
});

test('a tab that fails to close after the scope stopped waiting is reported', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  await using browser = await chrome.connect({ attach: 'created', timeout: 150 });
  const reported: unknown[] = [];
  browser.errors.on((error) => void reported.push(error));
  chrome.attachReplyDelayMs = 300;
  chrome.handle('Target.closeTarget', () => {
    throw new ProtocolError('Target.closeTarget', -32000, 'Injected close failure');
  });
  const scope = browser.tabScope();
  const opening = scope.newTab('about:blank', { timeout: 5_000 }).catch((error: unknown) => error);
  while (!chrome.commands.some(({ method }) => method === 'Target.attachToTarget')) await sleep(5);
  await assert.rejects(scope.close(), AggregateError);
  assert.deepEqual(reported, []);
  assert.match(String(await opening), /closed while the tab was opening/);
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), /Injected close failure/);
  chrome.attachReplyDelayMs = 0;
});

test('a tab that cannot be closed after newTab failed is reported, and the failure stands', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const reported: unknown[] = [];
  browser.errors.on((error) => void reported.push(error));
  chrome.handle('Page.navigate', () => {
    throw new ProtocolError('Page.navigate', -32000, 'Injected navigation failure');
  });
  chrome.handle('Target.closeTarget', () => {
    throw new ProtocolError('Target.closeTarget', -32000, 'Injected close failure');
  });
  await assert.rejects(browser.newTab('https://app.test/'), /Injected navigation failure/);
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), /Injected close failure/);
});

test('a scope tab that cannot be closed after newTab failed is reported while the scope is open', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  await using browser = await chrome.connect();
  const reported: unknown[] = [];
  browser.errors.on((error) => void reported.push(error));
  chrome.handle('Page.navigate', () => {
    throw new ProtocolError('Page.navigate', -32000, 'Injected navigation failure');
  });
  const failing = chrome.handle('Target.closeTarget', () => {
    throw new ProtocolError('Target.closeTarget', -32000, 'Injected close failure');
  });
  const scope = browser.tabScope();
  await assert.rejects(scope.newTab('https://app.test/'), /Injected navigation failure/);
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), /Injected close failure/);
  // The page stays owned, and close() closes it.
  failing();
  assert.equal((await scope.close()).closed.length, 1);
  assert.equal(reported.length, 1);
});

test('a scope tab Chrome creates too late is reported when it cannot be closed', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  await using browser = await chrome.connect();
  const reported: unknown[] = [];
  browser.errors.on((error) => void reported.push(error));
  const create = gate();
  chrome.handle('Target.createTarget', async () => {
    await create.promise;
    return { targetId: chrome.addPage() };
  });
  const failing = chrome.handle('Target.closeTarget', () => {
    throw new ProtocolError('Target.closeTarget', -32000, 'Injected close failure');
  });
  const scope = browser.tabScope();
  await assert.rejects(scope.newTab('about:blank', { timeout: 30 }), TimeoutError);
  create.resolve();
  for (let i = 0; i < 100 && !reported.length; i++) await sleep(10);
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), /Injected close failure/);
  failing();
  assert.equal((await scope.close()).closed.length, 1);
});

test('a close failure that scope.close() waits for is reported only in its result', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  await using browser = await chrome.connect();
  const reported: unknown[] = [];
  browser.errors.on((error) => void reported.push(error));
  chrome.attachReplyDelayMs = 200;
  chrome.handle('Target.closeTarget', () => {
    throw new ProtocolError('Target.closeTarget', -32000, 'Injected close failure');
  });
  const scope = browser.tabScope();
  const opening = scope.newTab().catch((error: unknown) => error);
  while (!chrome.commands.some(({ method }) => method === 'Target.attachToTarget')) await sleep(5);
  // close() closes the tab once attached; newTab() shares that close.
  const error = await scope.close().catch((error: unknown) => error);
  assert.ok(error instanceof AggregateError, String(error));
  assert.equal(error.errors.length, 1);
  assert.match(String(error.errors[0]), /Injected close failure/);
  assert.match(String(await opening), /closed while the tab was opening/);
  assert.deepEqual(reported, []);
  chrome.attachReplyDelayMs = 0;
});
