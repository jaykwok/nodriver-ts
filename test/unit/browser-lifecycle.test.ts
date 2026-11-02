import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Browser } from '../../src/index.ts';
import { BrowserProcess } from '../../src/browser/launcher.ts';
import { WebSocketTransport } from '../../src/transport/websocket.ts';
import { ScriptedChrome } from '../../src/testing/index.ts';

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
