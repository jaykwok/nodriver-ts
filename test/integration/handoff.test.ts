import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Browser, ProfileInUseError } from '../../src/index.ts';
import { poll, removeTree } from '../../src/utils.ts';
import { recordWire } from '../fixtures/wire.ts';

const launchOptions = { headless: true, maskHeadless: false };

for (const mode of ['natural', 'forced']) {
  test(`released Chrome survives ${mode} host exit and retains its persistent profile`, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'nodriver-handoff-'));
    const record = join(profile, 'handoff.json');
    let remote: Browser | undefined;
    let info: { endpoint: string; pid: number } | undefined;
    try {
      await promisify(execFile)(
        process.execPath,
        [join(import.meta.dirname, '../fixtures/handoff-host.ts'), record, profile, mode],
        { timeout: 25_000, windowsHide: true },
      );
      info = JSON.parse(await readFile(record, 'utf8'));
      await assert.rejects(access(join(profile, '.nodriver.lock')), { code: 'ENOENT' });
      await access(join(profile, 'DevToolsActivePort'));
      // Removing the controller lock must not allow another launch beside the live Chrome.
      await assert.rejects(
        Browser.launch({ ...launchOptions, userDataDir: profile }),
        ProfileInUseError,
      );
      remote = await Browser.connect({ endpoint: info!.endpoint });
      assert.equal(await remote.tabs[0]!.evaluate('6 * 7'), 42);
      assert.equal(await remote.release(), info!.endpoint);
      await remote.close();
      remote = await Browser.connect({ endpoint: info!.endpoint });
      assert.equal(await remote.tabs[0]!.evaluate('document.readyState'), 'complete');
    } finally {
      info ??= await readFile(record, 'utf8').then(JSON.parse, () => undefined);
      if (info) {
        remote =
          remote && !remote.closed ? remote : await Browser.connect({ endpoint: info.endpoint });
        await remote.cdp.send('Browser.close').catch(() => {});
        await remote.disconnect();
        await poll(
          async () => {
            try {
              process.kill(info!.pid, 0);
              return undefined;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
              return true;
            }
          },
          { timeout: 10_000 },
          'released Chrome exit',
        );
      }
      await removeTree(profile);
    }
  });
}

test('release retains temporary profiles, pending calls reject, close never sends Browser.close', async () => {
  const browser = await Browser.launch({ ...launchOptions, detached: true });
  const profile = browser.process!.profile;
  const audit = recordWire('websocket');
  let remote: Browser | undefined;
  try {
    const tab = browser.tabs[0]!;
    const pending = assert.rejects(tab.evaluate('new Promise(() => {})'), /closed/i);
    const endpoint = await browser.release();
    await pending;
    await browser.close();
    await browser[Symbol.asyncDispose]();
    assert.equal(
      audit.messages.some((message) => message.method === 'Browser.close'),
      false,
    );
    assert.equal(browser.owned, false);
    assert.equal(browser.closed, true);
    await access(profile);
    remote = await Browser.connect({ endpoint });
    assert.equal(await remote.tabs[0]!.evaluate('40 + 2'), 42);
  } finally {
    audit.restore();
    if (browser.process!.released) {
      remote ??= await Browser.connect({ endpoint: browser.endpoint! });
      await remote.cdp.send('Browser.close').catch(() => {});
      await remote.close();
      assert.equal(await browser.process!.waitForExit(10_000), true);
      await removeTree(profile);
    } else {
      await browser.close();
    }
  }
});

test('pipe and non-detached release fail without disconnecting or changing ownership', async () => {
  await assert.rejects(
    Browser.launch({ detached: true, transport: 'pipe', executablePath: 'does-not-exist' }),
    /requires WebSocket/,
  );
  for (const transport of ['pipe', 'websocket'] as const) {
    const browser = await Browser.launch({ ...launchOptions, transport });
    try {
      await assert.rejects(
        browser.release(),
        transport === 'pipe' ? /requires WebSocket/ : /detached: true/,
      );
      assert.equal(browser.owned, true);
      assert.equal(browser.closed, false);
      assert.equal(await browser.tabs[0]!.evaluate('1 + 1'), 2);
    } finally {
      await browser.close();
    }
    await assert.rejects(access(browser.process!.profile), { code: 'ENOENT' });
  }
});

test('close wins over a later release; detached launch failures remove their lock', async () => {
  const browser = await Browser.launch({ ...launchOptions, detached: true });
  const closing = browser.close();
  await assert.rejects(browser.release(), /already closing/);
  await closing;
  await assert.rejects(access(browser.process!.profile), { code: 'ENOENT' });
  const profile = await mkdtemp(join(tmpdir(), 'nodriver-handoff-failure-'));
  try {
    await assert.rejects(
      Browser.launch({
        ...launchOptions,
        detached: true,
        userDataDir: profile,
        executablePath: process.execPath,
        timeout: 1000,
      }),
      /Chrome exited/,
    );
    await assert.rejects(access(join(profile, '.nodriver.lock')), { code: 'ENOENT' });
  } finally {
    await removeTree(profile);
  }
});

test('release rejects a context whose proxy requires the host process', async () => {
  const browser = await Browser.launch({ ...launchOptions, detached: true });
  try {
    await browser.newContext({ proxy: 'http://127.0.0.1:9' });
    await assert.rejects(browser.release(), /in-process proxy/);
    assert.equal(browser.owned, true);
    assert.equal(browser.closed, false);
  } finally {
    await browser.close();
  }
});

test('raw CDP supports target lifecycle events and acknowledged screencast frames', async () => {
  const browser = await Browser.launch(launchOptions);
  try {
    const created = browser.cdp.waitFor(
      'Target.targetCreated',
      (e) => e.targetInfo.type === 'page',
    );
    const tab = await browser.newTab();
    assert.equal((await created).targetInfo.targetId, tab.id);
    const changed = browser.cdp.waitFor(
      'Target.targetInfoChanged',
      (e) => e.targetInfo.targetId === tab.id && e.targetInfo.url.includes('handoff-events'),
    );
    await tab.goto('data:text/html,<title>handoff-events</title><h1>Recording</h1>');
    await changed;
    await tab.bringToFront();
    assert.equal(browser.frontTab, tab);
    assert.equal(await tab.evaluate('document.hasFocus()'), true);
    let frames = 0;
    const off = tab.cdp.on('Page.screencastFrame', async (event) => {
      frames++;
      await tab.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    });
    try {
      const frame = tab.cdp.waitFor('Page.screencastFrame');
      await tab.cdp.send('Page.startScreencast', { format: 'jpeg', maxWidth: 320, maxHeight: 240 });
      assert.ok((await frame).data.length > 0);
      assert.ok(frames > 0);
      await tab.cdp.send('Page.stopScreencast');
    } finally {
      off();
    }
    const destroyed = browser.cdp.waitFor('Target.targetDestroyed', (e) => e.targetId === tab.id);
    await tab.close();
    await destroyed;
  } finally {
    await browser.close();
  }
});
