// Built-package raw-session acceptance, including the minimum supported Node.js 24.22.0.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
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
const timeline = [];
const started = performance.now();
const record = (event, fields = {}) =>
  timeline.push({ event, elapsedMs: performance.now() - started, ...fields });
const observe = (connection) => ({
  onSend(e) {
    record('send', { connection, method: e.method, seq: e.seq, sessionId: e.sessionId });
  },
  onSettle(e) {
    record('settle', { connection, seq: e.seq, durationMs: e.durationMs, error: e.error });
  },
});
const ownerObserver = observe('owner');
const remoteObserver = observe('remote');
const owner = await Browser.launch({
  headless: true,
  detached: true,
  attach: 'none',
  observe: {
    onSend(e) {
      commands.push(e.method);
      ownerObserver.onSend(e);
    },
    onSettle: ownerObserver.onSettle,
  },
});
owner.process.child.once('exit', (code, signal) => record('process-exit', { code, signal }));
owner.process.child.once('close', (code, signal) => record('process-close', { code, signal }));
const report = {
  node: process.version,
  platform: process.platform,
  browser: owner.version,
  pid: owner.process.pid,
  timeline,
};
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
  record('released');
  remote = await Browser.connect({ endpoint, attach: 'none', observe: remoteObserver });
  remote.connection.disconnected.on((error) => record('disconnected', { error: String(error) }));
  assert.deepEqual(remote.tabs, []);
  const page = await remote.cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await remote.attachSession(page.targetId);
  assert.equal((await attached.send('Runtime.evaluate', { expression: '42' })).result.value, 42);
  assert.equal(commands.includes('Page.enable'), false);
} finally {
  try {
    if (owner.process.released) {
      remote ??= await Browser.connect({
        endpoint: owner.endpoint,
        attach: 'none',
        observe: remoteObserver,
      });
      record('browser-close-request');
      await remote.cdp.send('Browser.close').then(
        () => record('browser-close-ack'),
        (error) => record('browser-close-error', { error: String(error) }),
      );
      await remote.close();
      record('client-closed');
      const waitStart = performance.now();
      const exited = await owner.process.waitForExit(10000);
      let pidState = 'alive';
      try {
        process.kill(owner.process.pid, 0);
      } catch (error) {
        pidState = error.code === 'ESRCH' ? 'absent' : String(error);
      }
      report.shutdown = {
        exited,
        waitMs: performance.now() - waitStart,
        pidState,
        childExitCode: owner.process.child.exitCode,
        childSignalCode: owner.process.child.signalCode,
        diagnostics: owner.process.diagnostics,
      };
      // Retain the original 10-second assertion; diagnostics must not turn a timeout
      // into a passing retry or kill a browser whose ownership was handed off.
      assert.equal(
        exited,
        true,
        `Released Chrome did not exit: ${JSON.stringify(report.shutdown)}`,
      );
      const profile = resolve(owner.process.profile);
      const withinTmp = relative(resolve(tmpdir()), profile);
      assert.ok(
        owner.process.temporary &&
          withinTmp &&
          withinTmp !== '..' &&
          !withinTmp.startsWith(`..${sep}`) &&
          !isAbsolute(withinTmp),
        'Only the owned temporary profile may be removed',
      );
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      report.profileRemoved = true;
    } else await owner.close();
  } finally {
    const output = resolve(
      process.env.NODRIVER_RAW_SESSION_REPORT ?? 'test-results/raw-session.json',
    );
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
}
console.log(
  `raw-session built-package acceptance ok: ${process.version}, ${owner.version.product}`,
);
