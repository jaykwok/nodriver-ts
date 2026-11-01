import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  InputActionError,
  InputBlockedError,
  Keyboard,
  Mouse,
  TargetSession,
  type Browser,
  type Session,
  type ScopedInput,
} from '../../src/index.ts';
import { ScriptedChrome, NO_REPLY } from '../../src/testing/index.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function model(chrome: ScriptedChrome) {
  const blurred = new Set<string>();
  chrome.handle('Runtime.callFunctionOn', (params, command) => {
    if (params.functionDeclaration.includes(':read-write'))
      return { result: { type: 'object', value: { kind: 'editable', host: false } } };
    if (params.functionDeclaration.includes('isConnected'))
      return { result: { type: 'boolean', value: !blurred.has(command.sessionId!) } };
    return { result: { type: 'object', objectId: 'editor' } };
  });
  chrome.handle('Runtime.releaseObjectGroup', () => {});
  chrome.handle('Input.imeSetComposition', () => {});
  chrome.handle('Input.insertText', () => {});
  chrome.handle('Input.dispatchKeyEvent', () => {});
  chrome.handle('Input.dispatchMouseEvent', () => {});
  chrome.handle('Page.bringToFront', () => {});
  return (session: Session) => blurred.add(session.id!);
}
async function failure(promise: Promise<unknown>): Promise<InputActionError> {
  const error = await promise.catch((e) => e);
  assert.ok(error instanceof InputActionError);
  return error;
}
async function loseFocus(
  browser: Browser,
  session: Session,
  blur: (s: Session) => void,
  prepare?: (input: ScopedInput) => Promise<void>,
  cleanupTimeout = 1000,
) {
  return failure(
    browser.inputScope(session, { pageEvents: false }).run(
      async (input) => {
        await prepare?.(input);
        await input.composition.update('unfinished');
        blur(session);
        await input.composition.commit();
      },
      { executionContextId: 42, cleanupTimeout },
    ),
  );
}
async function blocked(keyboard: Keyboard) {
  const error = await failure(keyboard.insertText('must not send'));
  assert.ok(error.cause instanceof InputBlockedError);
  await error.cleanup;
  return error.cause;
}

test('composition-only failure blocks all attachments to one page, not other tabs', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{}, {}] });
  const blur = model(chrome);
  await using browser = await chrome.connect();
  const [a, b] = browser.tabs;
  const raw = await browser.attachSession(a!.id);
  const error = await loseFocus(browser, raw, blur);
  assert.equal((await error.cleanup).status, 'failed');
  assert.match(String(await blocked(a!.keyboard)), /close this page/);
  await b!.keyboard.insertText('other tab');
  await new Keyboard(await browser.attachSession(b!.id)).compose(
    async (ime) => {
      await ime.update('other composition');
      await ime.commit();
    },
    { executionContextId: 42, pageEvents: false },
  );

  await raw.detach();
  const reattached = await browser.attachSession(a!.id);
  await blocked(new Keyboard(reattached));
  chrome.emit(
    'Page.frameNavigated',
    {
      type: 'Navigation',
      frame: {
        id: a!.id,
        loaderId: 'next',
        url: 'about:blank',
        domainAndRegistry: '',
        securityOrigin: 'null',
        mimeType: 'text/html',
        secureContextType: 'InsecureScheme',
        crossOriginIsolatedContextType: 'NotIsolated',
        gatedAPIFeatures: [],
      },
    },
    reattached.id,
  );
  await browser.cdp.send('Browser.getVersion');
  await blocked(new Keyboard(reattached));
  chrome.crashTarget(a!.id);
  await reattached.ended;
  await blocked(new Keyboard(await browser.attachSession(a!.id)));

  const unknown = new Keyboard(browser.connection.session('unmapped'));
  assert.match(String(await blocked(unknown)), /ownership is unknown/);
  const destroyed = browser.cdp.waitFor('Target.targetDestroyed', (e) => e.targetId === a!.id);
  chrome.destroyTarget(a!.id);
  await destroyed;
  await unknown.insertText('no blocked page remains');
  await b!.keyboard.insertText('still usable');
  chrome.assertDone();
});

test('OOPIF failure blocks its top-level page and sibling/raw frame attachments', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{}, {}] });
  const blur = model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const [a, b] = await Promise.all(
    browser.pageTargets.map((p) => browser.attachSession(p.targetId)),
  );
  const info = {
    targetId: 'child',
    type: 'iframe',
    title: '',
    url: 'https://child.test',
    attached: true,
    canAccessOpener: false,
  };
  chrome.emit(
    'Target.attachedToTarget',
    { sessionId: 'child-session', targetInfo: info, waitingForDebugger: false },
    a!.id,
  );
  chrome.emit(
    'Target.attachedToTarget',
    {
      sessionId: 'sibling-session',
      targetInfo: { ...info, targetId: 'sibling' },
      waitingForDebugger: false,
    },
    a!.id,
  );
  await browser.cdp.send('Browser.getVersion');
  const child = browser.connection.session('child-session');
  assert.equal((await (await loseFocus(browser, child, blur)).cleanup).status, 'failed');
  await blocked(new Keyboard(a!));
  await blocked(new Keyboard(browser.connection.session('sibling-session')));
  await blocked(new Keyboard(new TargetSession(browser.connection, 'independent-child', 'child')));
  // A later direct attachment is also identified from CDP parentId, without auto-attachment.
  chrome.emit('Target.targetCreated', {
    targetInfo: { ...info, targetId: 'later-child', parentId: a!.targetId },
  });
  await browser.cdp.send('Browser.getVersion');
  await blocked(
    new Keyboard(new TargetSession(browser.connection, 'later-session', 'later-child')),
  );
  chrome.emit('Target.targetDestroyed', { targetId: 'child' });
  await browser.cdp.send('Browser.getVersion');
  await blocked(new Keyboard(a!));
  await new Keyboard(b!).insertText('different page');
  chrome.assertDone();
});

for (const hold of ['key', 'mouse', 'released'] as const) {
  test(`composition failure with ${hold} held input selects the appropriate block scope`, async () => {
    await using chrome = await ScriptedChrome.start({ pages: [{}, {}] });
    const blur = model(chrome);
    await using browser = await chrome.connect({ attach: 'none' });
    const [a, b] = await Promise.all(
      browser.pageTargets.map((p) => browser.attachSession(p.targetId)),
    );
    if (hold === 'key') await new Keyboard(b!).down('Shift');
    if (hold === 'mouse') await new Mouse(b!).down();
    const error = await loseFocus(
      browser,
      a!,
      blur,
      hold === 'released'
        ? async (input) => {
            await input.keyboard.down('Shift');
            await input.mouse.down();
          }
        : undefined,
    );
    assert.equal((await error.cleanup).status, 'failed');
    if (hold === 'released') await new Keyboard(b!).insertText('holds released');
    else {
      assert.match(String(await blocked(new Keyboard(b!))), /new connection/);
      const destroyed = browser.cdp.waitFor('Target.targetDestroyed');
      chrome.destroyTarget(a!.targetId);
      await destroyed;
      await blocked(new Keyboard(b!));
    }
    chrome.assertDone();
  });
}

for (const end of ['closed page', 'other attachment'] as const) {
  test(`a hold ended by its ${end} keeps composition failure page-scoped`, async () => {
    await using chrome = await ScriptedChrome.start({ pages: [{}, {}, {}] });
    const blur = model(chrome);
    await using browser = await chrome.connect({ attach: 'none' });
    const [a, b, c] = await Promise.all(
      browser.pageTargets.map((p) => browser.attachSession(p.targetId)),
    );
    await new Keyboard(b!).down('Shift');
    if (end === 'closed page') {
      const destroyed = browser.cdp.waitFor('Target.targetDestroyed');
      chrome.destroyTarget(b!.targetId);
      await destroyed;
    } else await new Keyboard(await browser.attachSession(b!.targetId)).up('Shift');
    const error = await loseFocus(browser, a!, blur);
    assert.equal((await error.cleanup).status, 'failed');
    assert.match(String(await blocked(new Keyboard(a!))), /close this page/);
    await new Keyboard(c!).insertText('other page');
    chrome.assertDone();
  });
}

for (const destroy of [false, true]) {
  test(`page block waits for late replies; destroyed during drain=${destroy}`, async () => {
    await using chrome = await ScriptedChrome.start({ pages: [{}, {}] });
    const blur = model(chrome),
      reply = gate(),
      sent = gate();
    chrome.handle('Runtime.evaluate', async () => {
      sent.resolve();
      await reply.promise;
      return { result: { type: 'undefined' } };
    });
    await using browser = await chrome.connect({ attach: 'none' });
    const [a, b] = await Promise.all(
      browser.pageTargets.map((p) => browser.attachSession(p.targetId)),
    );
    const late = b!.send('Runtime.evaluate', { expression: 'late raw reply' });
    await sent.promise;
    const error = await loseFocus(browser, a!, blur);
    let finished = false;
    const next = new Keyboard(b!).insertText('next').then(() => {
      finished = true;
    });
    await sleep(20);
    assert.equal(finished, false);
    assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 0);
    if (destroy) {
      const destroyed = browser.cdp.waitFor('Target.targetDestroyed');
      chrome.destroyTarget(a!.targetId);
      await destroyed;
    }
    reply.resolve();
    await late;
    assert.equal((await error.cleanup).status, 'failed');
    await next;
    if (!destroy) await blocked(new Keyboard(a!));
    else await new Keyboard(browser.connection.session('unmapped')).insertText('no stale block');
    chrome.assertDone();
  });
}

for (const otherFailure of [
  'object-release',
  'key-release',
  'unanswered',
  'unknown-owner',
] as const) {
  test(`${otherFailure} keeps composition cleanup failure connection-wide`, async () => {
    await using chrome = await ScriptedChrome.start({ pages: [{}, {}] });
    const blur = model(chrome);
    await using browser = await chrome.connect({ attach: 'none' });
    const [a, b] = await Promise.all(
      browser.pageTargets.map((p) => browser.attachSession(p.targetId)),
    );
    if (otherFailure === 'object-release')
      chrome.handle('Runtime.releaseObjectGroup', () => {
        throw new Error('release failed');
      });
    if (otherFailure === 'key-release')
      chrome.handle('Input.dispatchKeyEvent', (p) => {
        if (p.type === 'keyUp') throw new Error('key remains held');
      });
    if (otherFailure === 'unanswered') chrome.handle('Runtime.evaluate', () => NO_REPLY);
    const pending =
      otherFailure === 'unanswered'
        ? b!
            .sendWith('Runtime.evaluate', { timeout: 10 }, { expression: 'no reply' })
            .catch(() => {})
        : undefined;
    const owner = otherFailure === 'unknown-owner' ? browser.connection.session('unmapped') : a!;
    const error = await loseFocus(
      browser,
      owner,
      blur,
      otherFailure === 'key-release'
        ? async (input) => {
            await input.keyboard.down('Shift');
          }
        : undefined,
      50,
    );
    await pending;
    assert.equal((await error.cleanup).status, 'failed');
    assert.match(String(await blocked(new Keyboard(b!))), /new connection/);
    const destroyed = browser.cdp.waitFor('Target.targetDestroyed');
    chrome.destroyTarget(a!.targetId);
    await destroyed;
    await blocked(new Keyboard(b!));
    chrome.assertDone();
  });
}
