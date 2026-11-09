import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { test } from 'node:test';
import { Browser, ProtocolError } from '../../src/index.ts';
import { BrowserProcess } from '../../src/browser/launcher.ts';
import { WebSocketTransport } from '../../src/transport/websocket.ts';
import { ScriptedChrome } from '../../src/testing/index.ts';
import { poll } from '../../src/utils.ts';

test('a page that closes during the initial attachment does not fail connect()', async () => {
  await using chrome = await ScriptedChrome.start();
  const page = {
    type: 'page',
    title: '',
    url: 'about:blank',
    attached: false,
    canAccessOpener: false,
  };
  // The popup is listed, then closes before the library attaches to it.
  chrome.handle('Target.getTargets', () => ({
    targetInfos: [
      { ...page, targetId: 'page-1' },
      { ...page, targetId: 'popup' },
    ],
  }));
  const errors: unknown[] = [];
  await using browser = await chrome.connect({ onError: (error) => errors.push(error) });
  assert.deepEqual(
    browser.tabs.map((tab) => tab.id),
    ['page-1'],
  );
  assert.deepEqual(errors, []);
});

test('reattaching a detached page replaces its closed Tab and shares concurrent attaches', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://app.test/' }] });
  await using browser = await chrome.connect();
  const first = browser.tabs[0]!;
  const frame = first.mainFrame;
  assert.equal(await browser.attachTarget(first.id), first);
  await browser.cdp.send('Target.detachFromTarget', { sessionId: first.session.id! });
  assert.equal(first.closed, true);
  assert.ok(browser.pageTargets.some((info) => info.targetId === first.id));
  const before = chrome.commands.filter((c) => c.method === 'Target.attachToTarget').length;
  chrome.attachReplyDelayMs = 30;

  const [adopted, concurrent] = await Promise.all([
    browser.attachTarget(first.id),
    browser.attachTarget(first.id),
  ]);
  assert.equal(adopted.closed, false);
  assert.notEqual(adopted, first);
  assert.notEqual(adopted.session.id, first.session.id);
  assert.equal(concurrent, adopted);
  assert.equal(await browser.attachTarget(first.id), adopted);
  assert.equal(adopted.context, first.context);
  assert.equal(adopted.url, 'https://app.test/');
  assert.deepEqual(browser.tabs, [adopted]);
  assert.equal(frame.detached, true);
  assert.deepEqual(first.frames, []);
  assert.equal(
    chrome.commands.filter((c) => c.method === 'Target.attachToTarget').length,
    before + 1,
  );
  assert.ok(!chrome.commands.some((c) => c.method === 'Target.closeTarget'));
  chrome.assertDone();
});

test('a failed reattach leaves the page available for another attempt', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const first = browser.tabs[0]!;
  await browser.cdp.send('Target.detachFromTarget', { sessionId: first.session.id! });
  chrome.replyOnce('Target.attachToTarget', () => {
    throw new ProtocolError('Target.attachToTarget', -32000, 'Injected reattach failure');
  });
  await assert.rejects(browser.attachTarget(first.id), /Injected reattach failure/);
  assert.deepEqual(browser.tabs, []);
  assert.deepEqual(first.frames, []);
  assert.ok(browser.pageTargets.some((info) => info.targetId === first.id));

  const adopted = await browser.attachTarget(first.id);
  assert.equal(adopted.closed, false);
  assert.notEqual(adopted, first);
  assert.equal(adopted.id, first.id);
  assert.notEqual(adopted.session.id, first.session.id);
  assert.deepEqual(browser.tabs, [adopted]);
  chrome.assertDone();
});

test('a failed close() can be retried, and release() stays refused once closing began', async (t) => {
  await using chrome = await ScriptedChrome.start();
  let attempts = 0;
  t.mock.method(BrowserProcess, 'start', async () => ({
    endpoint: chrome.endpoint,
    transport: await WebSocketTransport.connect(chrome.endpoint),
    process: {
      released: false,
      detached: true,
      diagnostics: { exited: false },
      captureDiagnostics: async () => {},
      waitForExit: async () => true,
      close: async () => {
        if (++attempts === 1) throw new Error('Chrome is still running');
      },
    },
  }));
  chrome.handle('Browser.close', () => {});
  const browser = await Browser.launch({ attach: 'none', headless: true, timeout: 1000 });
  await assert.rejects(browser.close(), /still running/);
  await assert.rejects(browser.release(), /already closing/);
  await browser.close();
  assert.equal(attempts, 2);
});

test('release() refuses a browser on a virtual display before giving anything up', async (t) => {
  await using chrome = await ScriptedChrome.start();
  let released = 0;
  t.mock.method(BrowserProcess, 'start', async () => ({
    endpoint: chrome.endpoint,
    transport: await WebSocketTransport.connect(chrome.endpoint),
    process: {
      released: false,
      detached: true,
      virtualDisplay: true,
      diagnostics: { exited: false },
      captureDiagnostics: async () => {},
      waitForExit: async () => true,
      release: async () => {
        released++;
      },
      close: async () => {},
    },
  }));
  chrome.handle('Browser.close', () => {});
  const browser = await Browser.launch({ attach: 'none', headless: true, timeout: 1000 });
  await assert.rejects(browser.release(), /virtual display/);
  assert.equal(released, 0);
  assert.equal(browser.owned, true);
  assert.equal(browser.closed, false);
  await browser.close();
});

test('a lost connection stops the forwarders of the contexts Chrome disposes with it', async () => {
  await using chrome = await ScriptedChrome.start();
  const browser = await chrome.connect();
  const context = await browser.newContext({ proxy: 'http://user:secret@127.0.0.1:9' });
  const port = Number(new URL(context.proxy!.url).port);
  const reachable = () =>
    new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
  assert.equal(await reachable(), true);
  await browser.disconnect();
  await poll(async () => !(await reachable()) || undefined, { timeout: 2000 }, 'forwarder close');
});
