// Built-package raw-session acceptance, including the minimum supported Node.js 24.22.0.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Browser, SessionEndedError } from 'nodriver-ts';
import { ScriptedChrome } from 'nodriver-ts/testing';

const chrome = await ScriptedChrome.start();
try {
  const browser = await chrome.connect({ attach: 'none' });
  try {
    const target = browser.pageTargets[0].targetId;
    const session = await browser.attachSession(target);
    chrome.replyOnce('Runtime.evaluate', { result: { type: 'number', value: 42 } });
    assert.equal((await session.send('Runtime.evaluate', { expression: '42' })).result.value, 42);
    chrome.attachReplyDelayMs = 100;
    const controller = new AbortController();
    const late = assert.rejects(
      browser.attachSession(target, { signal: controller.signal }),
      /cancelled/,
    );
    controller.abort(new Error('cancelled'));
    await late;
    for (
      let i = 0;
      i < 100 && !chrome.commands.some((c) => c.method === 'Target.detachFromTarget');
      i++
    )
      await delay(20);
    assert.ok(chrome.commands.some((c) => c.method === 'Target.detachFromTarget'));
    assert.equal(session.closed, false);
    const pending = assert.rejects(session.waitFor('Page.loadEventFired'), SessionEndedError);
    chrome.crashTarget(target);
    assert.equal(await session.ended, 'target-crashed');
    await pending;
    chrome.assertDone();
  } finally {
    await browser.close();
  }
} finally {
  await chrome.close();
}

const commands = [];
const owner = await Browser.launch({
  headless: true,
  detached: true,
  attach: 'none',
  observe: {
    onSend(e) {
      commands.push(e.method);
    },
  },
});
let remote;
try {
  assert.deepEqual(commands, [
    'Browser.getVersion',
    'Target.getBrowserContexts',
    'Target.setDiscoverTargets',
    'Target.getTargets',
  ]);
  const { targetId } = await owner.cdp.send('Target.createTarget', { url: 'about:blank' });
  const session = await owner.attachSession(targetId);
  assert.equal((await session.send('Runtime.evaluate', { expression: '42' })).result.value, 42);
  const crashEvent = owner.cdp.waitFor('Target.targetCrashed', (e) => e.targetId === targetId);
  const crashing = assert.rejects(session.send('Page.crash'), SessionEndedError);
  assert.equal(await session.ended, 'target-crashed');
  await Promise.all([crashing, crashEvent]);
  const fresh = await owner.attachSession(targetId);
  await fresh.send('Page.reload');
  await owner.cdp.send('Target.closeTarget', { targetId });
  await fresh.ended;
  const endpoint = await owner.release();
  remote = await Browser.connect({ endpoint, attach: 'none' });
  assert.deepEqual(remote.tabs, []);
  const page = await remote.cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await remote.attachSession(page.targetId);
  assert.equal((await attached.send('Runtime.evaluate', { expression: '42' })).result.value, 42);
  assert.equal(commands.includes('Page.enable'), false);
  console.log(
    `raw-session built-package acceptance ok: ${process.version}, ${owner.version.product}`,
  );
} finally {
  if (owner.process.released) {
    remote ??= await Browser.connect({ endpoint: owner.endpoint, attach: 'none' });
    await remote.cdp.send('Browser.close').catch(() => {});
    await remote.close();
    assert.equal(await owner.process.waitForExit(10000), true);
    await rm(owner.process.profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } else await owner.close();
}
