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
  // The explicit execution context's global object, through which focus probes run.
  chrome.handle('Runtime.evaluate', () => ({ result: { type: 'object', objectId: 'global' } }));
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
  // The root notification can follow the session's; an attach sent between them ends with it.
  const crashed = browser.cdp.waitFor('Target.targetCrashed', (e) => e.targetId === a!.id);
  chrome.crashTarget(a!.id);
  await reattached.ended;
  await crashed;
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
    chrome.handle('Runtime.evaluate', async (params) => {
      // The composition's focus probes run through the explicit context's global object.
      if (params.expression === 'globalThis')
        return { result: { type: 'object', objectId: 'global' } };
      sent.resolve();
      await reply.promise;
      return { result: { type: 'undefined' } };
    });
    await using browser = await chrome.connect({ attach: 'none' });
    const [a, b] = await Promise.all(
      browser.pageTargets.map((p) => browser.attachSession(p.targetId)),
    );
    // A raw command issued inside the action belongs to it; its caller stops waiting early.
    const error = await loseFocus(browser, a!, blur, async () => {
      await a!
        .sendWith('Runtime.evaluate', { timeout: 10 }, { expression: 'late raw reply' })
        .catch(() => {});
    });
    await sent.promise;
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
    if (otherFailure === 'unanswered')
      chrome.handle('Runtime.evaluate', (params) =>
        params.expression === 'globalThis'
          ? { result: { type: 'object', objectId: 'global' } }
          : NO_REPLY,
      );
    const owner = otherFailure === 'unknown-owner' ? browser.connection.session('unmapped') : a!;
    const error = await loseFocus(
      browser,
      owner,
      blur,
      otherFailure === 'key-release'
        ? async (input) => {
            await input.keyboard.down('Shift');
          }
        : otherFailure === 'unanswered'
          ? async () => {
              // The action's own command that never gets a reply.
              await a!
                .sendWith('Runtime.evaluate', { timeout: 10 }, { expression: 'no reply' })
                .catch(() => {});
            }
          : undefined,
      50,
    );
    assert.equal((await error.cleanup).status, 'failed');
    assert.match(String(await blocked(new Keyboard(b!))), /new connection/);
    await assert.rejects(browser.inputScope(a!).recoverComposition(), InputBlockedError);
    const destroyed = browser.cdp.waitFor('Target.targetDestroyed');
    chrome.destroyTarget(a!.targetId);
    await destroyed;
    await blocked(new Keyboard(b!));
    chrome.assertDone();
  });
}

test('explicit recovery clears only the inspected page, including its attachments and child frames', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{}, {}] });
  const blur = model(chrome);
  await using browser = await chrome.connect();
  const [a, b] = browser.tabs;
  const raw = await browser.attachSession(a!.id);
  const error = await loseFocus(browser, raw, blur);
  assert.equal((await error.cleanup).status, 'failed');
  assert.equal((await (await loseFocus(browser, b!.session, blur)).cleanup).status, 'failed');
  chrome.emit(
    'Target.attachedToTarget',
    {
      sessionId: 'child-session',
      targetInfo: {
        targetId: 'child',
        type: 'iframe',
        title: '',
        url: 'https://child.test',
        attached: true,
        canAccessOpener: false,
      },
      waitingForDebugger: false,
    },
    raw.id,
  );
  await browser.cdp.send('Browser.getVersion');
  const child = browser.connection.session('child-session');
  await blocked(new Keyboard(child));
  // Caller inspection/repair is external to recovery. The acknowledgement sends no CDP.
  const before = chrome.commands.length;
  assert.equal(await browser.inputScope(raw).recoverComposition(), true);
  assert.equal(chrome.commands.length, before);
  assert.equal(await browser.inputScope(child).recoverComposition(), false);
  await a!.keyboard.insertText('tab');
  await new Keyboard(child).insertText('child');
  await new Keyboard(await browser.attachSession(a!.id)).insertText('new attachment');
  await blocked(b!.keyboard);
  assert.equal((await error.cleanup).status, 'failed');
  await assert.rejects(
    browser.inputScope(browser.connection.session('unmapped')).recoverComposition(),
    /known live page/,
  );
  await raw.detach();
  await assert.rejects(browser.inputScope(raw).recoverComposition(), /closed session/);
  chrome.assertDone();
});

test('recovery is not stopped by holds or pending replies on other pages', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{}, {}] });
  const blur = model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const [a, b] = await Promise.all(
    browser.pageTargets.map((p) => browser.attachSession(p.targetId)),
  );
  const error = await loseFocus(browser, a!, blur);
  assert.equal((await error.cleanup).status, 'failed');
  const scope = browser.inputScope(a!);
  const keyboard = new Keyboard(b!),
    mouse = new Mouse(b!),
    sent = gate(),
    reply = gate();
  await keyboard.down('Shift');
  await mouse.down();
  chrome.handle('Runtime.evaluate', async () => {
    sent.resolve();
    await reply.promise;
    return { result: { type: 'undefined' } };
  });
  const pending = b!.send('Runtime.evaluate', { expression: 'other page work' });
  await sent.promise;
  await blocked(new Keyboard(a!));
  assert.equal(await scope.recoverComposition(), true);
  // Input cleanup waits for its own replies, not for the other page's pending command.
  await new Keyboard(a!).insertText('recovered');
  reply.resolve();
  await pending;
  await mouse.up();
  await keyboard.up('Shift');
  chrome.assertDone();
});

test('recovery queued before cleanup cannot clear a failure the caller has not inspected', async () => {
  await using chrome = await ScriptedChrome.start();
  const blur = model(chrome),
    sent = gate(),
    reply = gate();
  chrome.handle('Runtime.releaseObjectGroup', async () => {
    sent.resolve();
    await reply.promise;
  });
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
  const error = await loseFocus(browser, session, blur);
  await sent.promise;
  const scope = browser.inputScope(session);
  let settled = false;
  const recovery = scope
    .recoverComposition()
    .catch((e) => e)
    .finally(() => {
      settled = true;
    });
  await sleep(20);
  assert.equal(settled, false);
  reply.resolve();
  assert.equal((await error.cleanup).status, 'failed');
  const rejected = await recovery;
  assert.ok(rejected instanceof InputBlockedError);
  assert.match(rejected.message, /failure changed/);
  await blocked(new Keyboard(session));
  assert.equal(await scope.recoverComposition(), true);
  await new Keyboard(session).insertText('recovered');
  chrome.assertDone();
});
