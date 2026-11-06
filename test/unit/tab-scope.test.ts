import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScriptedChrome } from '../../src/testing/index.ts';

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
