import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Protocol } from 'devtools-protocol';
import { ScriptedChrome, NO_REPLY } from '../../src/testing/index.ts';
import {
  ActionabilityError,
  Keyboard,
  InputActionError,
  InputBlockedError,
  TimeoutError,
} from '../../src/index.ts';
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
type Focus = { kind: 'editable' | 'none' | 'unknown'; host: boolean };
const declared = (chrome: ScriptedChrome, text: string) =>
  chrome.commands.filter(
    (c) =>
      c.method === 'Runtime.callFunctionOn' &&
      (c.params as { functionDeclaration: string }).functionDeclaration.includes(text),
  );
/**
 * `classify` answers the editability probe for each element, `inner` the probe that continues in
 * a closed shadow root, `collapsed` the selection probe before a forced cancel.
 */
function model(
  chrome: ScriptedChrome,
  classify: (objectId: string) => Focus = () => ({ kind: 'editable', host: false }),
  inner: () => Protocol.Runtime.RemoteObject = () => ({
    type: 'object',
    subtype: 'null',
    value: null,
  }),
  collapsed: () => boolean = () => true,
) {
  let focused = true,
    worlds = 0;
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 100 + ++worlds }));
  // The probe world's global object; probes on it return the focused element.
  chrome.handle('Runtime.evaluate', () => ({
    result: { type: 'object', objectId: `world-${worlds}` },
  }));
  chrome.handle('Runtime.callFunctionOn', (params) => {
    if (params.functionDeclaration.includes(':read-write'))
      return { result: { type: 'object', value: classify(params.objectId!) } };
    if (params.functionDeclaration.includes("'mismatch'")) return { result: inner() };
    if (params.functionDeclaration.includes('isCollapsed'))
      return { result: { type: 'boolean', value: collapsed() } };
    if (params.functionDeclaration.includes('isConnected'))
      return { result: { type: 'boolean', value: focused } };
    return { result: { type: 'object', objectId: 'focus' } };
  });
  chrome.handle('Runtime.releaseObjectGroup', () => {});
  chrome.handle('Input.imeSetComposition', () => {});
  chrome.handle('Input.insertText', () => {});
  return () => {
    focused = false;
  };
}
test('explicit composition uses UTF-16 selections and one commit; normal type remains insertText', async () => {
  await using chrome = await ScriptedChrome.start();
  model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const keyboard = new Keyboard(session);
  const report = await keyboard.compose(async (ime) => {
    await ime.update('中文');
    await ime.update('é👨‍👩‍👧‍👦', { selectionStart: 2, selectionEnd: 13 });
    await ime.commit();
  });
  assert.equal(report.completedSegments, 1);
  assert.equal(report.cleanup, 'completed');
  const commands = chrome.commands.filter((c) => c.method.startsWith('Input.'));
  assert.deepEqual(
    commands.map((c) => c.method),
    ['Input.imeSetComposition', 'Input.imeSetComposition', 'Input.insertText'],
  );
  assert.deepEqual(commands[1]!.params, { text: 'é👨‍👩‍👧‍👦', selectionStart: 2, selectionEnd: 13 });
  await keyboard.type('中文');
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.imeSetComposition').length, 2);
});
test('unfinished and explicit-cancel composition both cancel once, invalid ranges send no composition', async () => {
  await using chrome = await ScriptedChrome.start();
  model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const keyboard = new Keyboard(session);
  await keyboard.compose(async (ime) => {
    await ime.update('你好');
  });
  await keyboard.compose(async (ime) => {
    await ime.update('😀');
    await ime.cancel();
    await ime.cancel();
  });
  const error = await keyboard
    .compose(async (ime) => {
      await ime.update('😀', { selectionEnd: 3 });
    })
    .catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.ok(error.cause instanceof RangeError);
  await error.cleanup;
  const texts = chrome.commands
    .filter((c) => c.method === 'Input.imeSetComposition')
    .map((c) => (c.params as { text: string }).text);
  assert.deepEqual(texts, ['你好', '', '😀', '']);
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 0);
});
test('the end of a composition is watched until cleanup, except where its events cannot be seen', async () => {
  for (const kind of ['editable', 'unknown'] as const) {
    await using chrome = await ScriptedChrome.start();
    model(chrome, () => ({ kind, host: false }));
    await using browser = await chrome.connect({ attach: 'none' });
    const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
    await new Keyboard(session).compose(async (ime) => {
      await ime.update('中');
    });
    const at = (command: unknown) => chrome.commands.indexOf(command as never);
    const cancel = chrome.commands.find(
      (c) => c.method === 'Input.imeSetComposition' && (c.params as { text: string }).text === '',
    );
    const [added, read, removed] = [
      "addEventListener('compositionend'",
      'return this.ended',
      "removeEventListener('compositionend'",
    ].map((text) => declared(chrome, text));
    if (kind === 'unknown') {
      assert.deepEqual([added!.length, read!.length, removed!.length], [0, 0, 0]);
      assert.ok(cancel);
      continue;
    }
    assert.deepEqual([added!.length, read!.length, removed!.length], [1, 1, 1]);
    assert.ok(at(added![0]) < at(read![0]));
    assert.ok(at(read![0]) < at(cancel));
    assert.ok(at(cancel) < at(removed![0]));
    assert.ok(
      at(removed![0]) <
        at(chrome.commands.findLast((c) => c.method === 'Runtime.releaseObjectGroup')),
    );
  }
});
test('focus loss blocks commit and does not cancel a different editor', async () => {
  await using chrome = await ScriptedChrome.start();
  const blur = model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const error = await browser
    .inputScope(session)
    .run(async (input) => {
      await input.composition.update('未提交');
      blur();
      await input.composition.commit();
    })
    .catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.match(String(error.cause), /lost focus/);
  assert.equal((await error.cleanup).status, 'failed');
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 0);
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.imeSetComposition').length, 1);
});

for (const ending of ['update', 'commit', 'cancel', 'return', 'abort'] as const) {
  test(`forceCancel cleans the current focus after ${ending}, without allowing input after focus loss`, async () => {
    await using chrome = await ScriptedChrome.start();
    const blur = model(chrome);
    await using browser = await chrome.connect({ attach: 'none' });
    const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
    const controller = new AbortController(),
      reason = new Error('stop');
    const result = await browser
      .inputScope(session, { pageEvents: false })
      .run(
        async (input) => {
          await input.composition.update('中');
          blur();
          if (ending === 'update') await input.composition.update('不得写入');
          if (ending === 'commit') await input.composition.commit('不得写入');
          if (ending === 'cancel') {
            await input.composition.cancel();
            await input.composition.cancel();
          }
          if (ending === 'abort') controller.abort(reason);
        },
        { forceCancel: true, signal: controller.signal },
      )
      .catch((e) => e);
    if (ending === 'update' || ending === 'commit' || ending === 'abort') {
      assert.ok(result instanceof InputActionError);
      if (ending === 'abort') assert.equal(result.cause, reason);
      else assert.ok(result.cause instanceof ActionabilityError);
      assert.equal((await result.cleanup).status, 'completed');
    } else assert.equal(result.cleanup, 'completed');
    assert.deepEqual(
      chrome.commands.filter((c) => c.method === 'Input.imeSetComposition').map((c) => c.params),
      [
        { text: '中', selectionStart: 1, selectionEnd: 1 },
        { text: '', selectionStart: 0, selectionEnd: 0 },
      ],
    );
    assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 0);
    await new Keyboard(session).insertText('后续');
  });
}

for (const current of ['selection', 'not editable', 'cross-origin']) {
  test(`forceCancel refuses an empty cancel at a current focus with ${current}`, async () => {
    await using chrome = await ScriptedChrome.start();
    let moved = false;
    const blur = model(
      chrome,
      () =>
        !moved
          ? { kind: 'editable', host: false }
          : {
              kind:
                current === 'not editable'
                  ? 'none'
                  : current === 'cross-origin'
                    ? 'unknown'
                    : 'editable',
              host: false,
            },
      undefined,
      () => current !== 'selection',
    );
    await using browser = await chrome.connect({ attach: 'none' });
    const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
    const error = await browser
      .inputScope(session, { pageEvents: false })
      .run(
        async (input) => {
          await input.composition.update('中');
          blur();
          moved = true;
          await input.composition.commit();
        },
        { forceCancel: true },
      )
      .catch((e) => e);
    assert.ok(error instanceof InputActionError);
    const cleanup = await error.cleanup;
    assert.equal(cleanup.status, 'failed');
    assert.match(cleanup.report.cleanupErrors.join(), /Composition cancel refused/);
    // Without a composition, Chrome's empty update would delete the selected text.
    assert.equal(chrome.commands.filter((c) => c.method === 'Input.imeSetComposition').length, 1);
    const probes = chrome.commands.filter(
      (c) =>
        c.method === 'Runtime.callFunctionOn' &&
        (c.params as { functionDeclaration: string }).functionDeclaration.includes('isCollapsed'),
    );
    assert.equal(probes.length, current === 'selection' ? 1 : 0);
    await assert.rejects(new Keyboard(session).insertText('后续'), InputActionError);
  });
}

test('forceCancel sends no cancellation if focus was lost before the first update', async () => {
  await using chrome = await ScriptedChrome.start();
  const blur = model(chrome, () => {
    blur();
    return { kind: 'editable', host: false };
  });
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const keyboard = new Keyboard(session);
  const error = await keyboard
    .compose(
      async (ime) => {
        await ime.update('中');
      },
      { forceCancel: true },
    )
    .catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.ok(error.cause instanceof ActionabilityError);
  assert.equal((await error.cleanup).status, 'completed');
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.imeSetComposition').length, 0);
  await keyboard.insertText('后续');
});
test('abort cancels composition, preserves reason and never repeats a commit', async () => {
  await using chrome = await ScriptedChrome.start();
  model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const controller = new AbortController(),
    reason = new Error('stop'),
    ready = gate();
  const pending = browser
    .inputScope(session)
    .run(
      async (input) => {
        await input.composition.update('中文');
        ready.resolve();
        await input.wait(5000);
      },
      { signal: controller.signal },
    )
    .catch((e) => e);
  await ready.promise;
  controller.abort(reason);
  const error = await pending;
  assert.ok(error instanceof InputActionError);
  assert.equal(error.cause, reason);
  assert.equal((await error.cleanup).status, 'completed');
  assert.deepEqual(
    chrome.commands
      .filter((c) => c.method === 'Input.imeSetComposition')
      .map((c) => (c.params as { text: string }).text),
    ['中文', ''],
  );
});
test('lost commit ACK is not replayed; second commit is refused after successful commit', async () => {
  await using chrome = await ScriptedChrome.start();
  model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const keyboard = new Keyboard(session),
    reply = gate();
  chrome.replyOnce('Input.insertText', async () => {
    await reply.promise;
  });
  const error = await keyboard
    .compose(
      async (ime) => {
        await ime.update('一次');
        await ime.commit();
      },
      { timeout: 70 },
    )
    .catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.ok(error.cause instanceof TimeoutError);
  reply.resolve();
  assert.equal((await error.cleanup).status, 'completed');
  const duplicate = await keyboard
    .compose(async (ime) => {
      await ime.update('一次');
      await ime.commit();
      await ime.commit();
    })
    .catch((e) => e);
  assert.ok(duplicate instanceof InputActionError);
  await duplicate.cleanup;
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 2);
});

test('late composition update holds the queue through cancellation and its ACK', async () => {
  await using chrome = await ScriptedChrome.start();
  model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const keyboard = new Keyboard(session),
    reply = gate(),
    sent = gate(),
    controller = new AbortController();
  chrome.replyOnce('Input.imeSetComposition', async () => {
    sent.resolve();
    await reply.promise;
  });
  const pending = keyboard
    .compose(
      async (ime) => {
        await ime.update('更新');
        await ime.commit();
      },
      { signal: controller.signal },
    )
    .catch((e) => e);
  await sent.promise;
  controller.abort();
  const error = await pending;
  assert.ok(error instanceof InputActionError);
  const next = keyboard.insertText('后续');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 0);
  reply.resolve();
  assert.equal((await error.cleanup).status, 'completed');
  await next;
  assert.deepEqual(
    chrome.commands
      .filter((c) => c.method === 'Input.imeSetComposition')
      .map((c) => (c.params as { text: string }).text),
    ['更新', ''],
  );
});

for (const forceCancel of [false, true]) {
  test(`unacknowledged composition cancellation fails cleanup without retries or later input; forceCancel=${forceCancel}`, async () => {
    await using chrome = await ScriptedChrome.start();
    model(chrome);
    chrome.handle('Input.imeSetComposition', (params) => (params.text ? undefined : NO_REPLY));
    await using browser = await chrome.connect({ attach: 'none' });
    const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
    const keyboard = new Keyboard(session);
    const error = await keyboard
      .compose(
        async (ime) => {
          await ime.update('取消');
        },
        { cleanupTimeout: 40, forceCancel },
      )
      .catch((e) => e);
    assert.ok(error instanceof InputActionError);
    assert.equal((await error.cleanup).status, 'failed');
    // Let the scripted peer's object-release replies arrive before counting the missing cancel ACK.
    await browser.cdp.send('Browser.getVersion');
    const blocked = await keyboard.insertText('不得写入').catch((e) => e);
    assert.ok(blocked instanceof InputActionError);
    assert.ok(blocked.cause instanceof InputBlockedError);
    assert.equal(browser.connection.unansweredCount, 1);
    assert.equal(chrome.commands.filter((c) => c.method === 'Input.imeSetComposition').length, 2);
    assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 0);
  });
}

test('focus probes run in a reused isolated world; pageEvents false sends no enable', async () => {
  await using chrome = await ScriptedChrome.start();
  model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const targetId = [...browser.targetInfo.keys()][0]!;
  const session = await browser.attachSession(targetId);
  const keyboard = new Keyboard(session);
  for (let i = 0; i < 2; i++)
    await keyboard.compose(
      async (ime) => {
        await ime.update('中文');
        await ime.commit();
      },
      { pageEvents: false },
    );
  await browser.inputScope(session, { pageEvents: false }).run(async (input) => {
    await input.composition.update('一');
    await input.composition.commit();
  });
  const methods = chrome.commands.filter((c) => c.sessionId === session.id).map((c) => c.method);
  assert.deepEqual(
    methods.filter((m) => m.endsWith('.enable') || m.startsWith('DOM.')),
    [],
  );
  assert.deepEqual(
    chrome.commands.filter((c) => c.method === 'Page.createIsolatedWorld').map((c) => c.params),
    [{ frameId: targetId }],
  );
  assert.deepEqual(
    chrome.commands.filter((c) => c.method === 'Runtime.evaluate').map((c) => c.params),
    [{ expression: 'globalThis', contextId: 101, objectGroup: 'nodriver-composition-world' }],
  );
  // Every capture runs on the world's global object, never by numeric context ID.
  const captures = chrome.commands.filter(
    (c) =>
      c.method === 'Runtime.callFunctionOn' &&
      (c.params as { objectId?: string }).objectId !== 'focus',
  );
  assert.equal(captures.length, 3);
  for (const c of captures) assert.equal((c.params as { objectId?: string }).objectId, 'world-1');
});

test('an explicit execution context is probed through its global object; Page events stay on by default', async () => {
  await using chrome = await ScriptedChrome.start();
  model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  await new Keyboard(session).compose(
    async (ime) => {
      await ime.update('中文');
    },
    { executionContextId: 42 },
  );
  assert.equal(chrome.commands.filter((c) => c.method === 'Page.enable').length, 1);
  assert.equal(chrome.commands.filter((c) => c.method === 'Page.createIsolatedWorld').length, 0);
  const evaluations = chrome.commands.filter((c) => c.method === 'Runtime.evaluate');
  assert.deepEqual(
    evaluations.map((c) => (c.params as { contextId?: number }).contextId),
    [42],
  );
  const [capture] = chrome.commands.filter((c) => c.method === 'Runtime.callFunctionOn');
  assert.equal((capture!.params as { objectId?: string }).objectId, 'world-0');
  assert.equal((capture!.params as { executionContextId?: number }).executionContextId, undefined);
});

test('a forced cancel probes the explicit context through the handle resolved first', async () => {
  await using chrome = await ScriptedChrome.start();
  const blur = model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  await new Keyboard(session).compose(
    async (ime) => {
      await ime.update('中文');
      blur();
    },
    { executionContextId: 42, forceCancel: true },
  );
  // A numeric context ID can name a newer document's context; the handle cannot.
  assert.equal(chrome.commands.filter((c) => c.method === 'Runtime.evaluate').length, 1);
  const probes = chrome.commands.filter(
    (c) =>
      c.method === 'Runtime.callFunctionOn' &&
      (c.params as { functionDeclaration: string }).functionDeclaration.includes(
        'document.activeElement',
      ),
  );
  assert.equal(probes.length, 2);
  for (const probe of probes) {
    assert.equal((probe.params as { objectId?: string }).objectId, 'world-0');
    assert.equal((probe.params as { executionContextId?: number }).executionContextId, undefined);
  }
  assert.deepEqual(
    chrome.commands
      .filter((c) => c.method === 'Input.imeSetComposition')
      .map((c) => (c.params as { text: string }).text),
    ['中文', ''],
  );
});

test('a probe world gone with its document or released is replaced', async () => {
  await using chrome = await ScriptedChrome.start();
  model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const keyboard = new Keyboard(session);
  const compose = () =>
    keyboard.compose(
      async (ime) => {
        await ime.update('中文');
        await ime.commit();
      },
      { pageEvents: false },
    );
  await compose();
  for (const message of [
    'Cannot find context with specified id',
    'Could not find object with given id',
  ]) {
    chrome.replyOnce('Runtime.callFunctionOn', () => {
      throw new Error(message);
    });
    await compose();
  }
  assert.equal(chrome.commands.filter((c) => c.method === 'Page.createIsolatedWorld').length, 3);
});

test('a probe context destroyed with its document reads as lost focus', async () => {
  await using chrome = await ScriptedChrome.start();
  model(chrome);
  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  chrome.handle('Runtime.callFunctionOn', (params) => {
    if (params.functionDeclaration.includes(':read-write'))
      return { result: { type: 'object', value: { kind: 'editable', host: false } } };
    if (params.objectId === 'focus') throw new Error('Cannot find context with specified id');
    return { result: { type: 'object', objectId: 'focus' } };
  });
  const error = await new Keyboard(session)
    .compose(async (ime) => {
      await ime.update('中文');
    })
    .catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.match(String(error.cause), /lost focus or its document changed/);
  await error.cleanup;
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.imeSetComposition').length, 0);
});

function node(shadowRoots: Array<{ shadowRootType: 'closed' | 'open' | 'user-agent' }> = []) {
  return {
    node: {
      nodeId: 0,
      backendNodeId: 1,
      nodeType: 1,
      nodeName: 'X-EDITOR',
      localName: 'x-editor',
      nodeValue: '',
      shadowRoots: shadowRoots.map((root, i) => ({
        ...root,
        nodeId: 0,
        backendNodeId: 10 + i,
        nodeType: 11,
        nodeName: '#document-fragment',
        localName: '',
        nodeValue: '',
      })),
    },
  };
}
async function compose(
  chrome: ScriptedChrome,
  options: { cleanupTimeout?: number; timeout?: number } = {},
) {
  const browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession([...browser.targetInfo.keys()][0]!);
  const result = await new Keyboard(session)
    .compose(async (ime) => {
      await ime.update('中文');
      await ime.commit();
    }, options)
    .catch((e: unknown) => e);
  return { browser, result };
}

test('composition without an editable focus fails before any composition command', async () => {
  await using chrome = await ScriptedChrome.start();
  // A user-agent shadow root, as on native controls, is not a closed root to look into.
  model(chrome, () => ({ kind: 'none', host: true }));
  chrome.handle('DOM.describeNode', () => node([{ shadowRootType: 'user-agent' }]));
  const { browser, result: error } = await compose(chrome);
  await using _ = browser;
  assert.ok(error instanceof InputActionError);
  assert.ok(error.cause instanceof ActionabilityError);
  assert.match(error.cause.message, /editable focused element/);
  assert.equal((await error.cleanup).status, 'completed');
  assert.equal(chrome.commands.filter((c) => c.method.startsWith('Input.')).length, 0);
  assert.equal(chrome.commands.filter((c) => c.method === 'DOM.resolveNode').length, 0);
  const [describe] = chrome.commands.filter((c) => c.method === 'DOM.describeNode');
  assert.deepEqual(describe!.params, { objectId: 'focus', depth: 0, pierce: true });
});

test('focus inside a closed shadow root is resolved and checked on the inner element', async () => {
  await using chrome = await ScriptedChrome.start();
  model(
    chrome,
    (objectId) =>
      objectId === 'focus' ? { kind: 'none', host: true } : { kind: 'editable', host: false },
    () => ({ type: 'object', objectId: 'inner' }),
  );
  chrome.handle('DOM.describeNode', () => node([{ shadowRootType: 'closed' }]));
  chrome.handle('DOM.resolveNode', () => ({ object: { type: 'object', objectId: 'root' } }));
  const { browser, result: report } = await compose(chrome);
  await using _ = browser;
  assert.equal((report as { completedSegments: number }).completedSegments, 1);
  const [resolve] = chrome.commands.filter((c) => c.method === 'DOM.resolveNode');
  assert.deepEqual(
    { ...(resolve!.params as object), objectGroup: undefined },
    { backendNodeId: 10, executionContextId: 101, objectGroup: undefined },
  );
  const calls = chrome.commands.filter((c) => c.method === 'Runtime.callFunctionOn');
  const descend = calls.find((c) => (c.params as { objectId?: string }).objectId === 'root')!;
  // The host goes along so that a root resolved into another world is rejected unrun.
  assert.deepEqual((descend.params as { arguments?: unknown }).arguments, [{ objectId: 'focus' }]);
  const checks = calls.filter((c) =>
    (c.params as { functionDeclaration: string }).functionDeclaration.includes('isConnected'),
  );
  assert.ok(checks.length >= 2);
  for (const c of checks) assert.equal((c.params as { objectId?: string }).objectId, 'inner');
});

test('a closed root that holds no focus leaves the host, which is checked for editability', async () => {
  await using chrome = await ScriptedChrome.start();
  model(chrome, () => ({ kind: 'none', host: true }));
  chrome.handle('DOM.describeNode', () => node([{ shadowRootType: 'closed' }]));
  chrome.handle('DOM.resolveNode', () => ({ object: { type: 'object', objectId: 'root' } }));
  const { browser, result: error } = await compose(chrome);
  await using _ = browser;
  assert.ok(error instanceof InputActionError);
  assert.match(String(error.cause), /editable focused element/);
  await error.cleanup;
});

test('focus in a cross-origin frame has unknown editability: composed and noted', async () => {
  await using chrome = await ScriptedChrome.start();
  model(chrome, () => ({ kind: 'unknown', host: false }));
  const { browser, result: report } = await compose(chrome);
  await using _ = browser;
  const { trace, events, completedSegments } = report as {
    trace: Array<{ type: string }>;
    events: number;
    completedSegments: number;
  };
  assert.equal(completedSegments, 1);
  assert.deepEqual(
    trace.map((entry) => entry.type),
    ['compositionFocusUnknown', 'compositionUpdate', 'compositionCommit'],
  );
  // The note is not an input event.
  assert.equal(events, 2);
});

test('a world mismatch reads as a changed document; timeouts are not unknown focus', async () => {
  for (const mismatch of [
    (): Protocol.Runtime.RemoteObject => ({ type: 'string', value: 'mismatch' }),
    () => {
      throw new Error('Argument should belong to the same JavaScript world as target object');
    },
  ]) {
    await using chrome = await ScriptedChrome.start();
    model(chrome, () => ({ kind: 'none', host: true }), mismatch);
    chrome.handle('DOM.describeNode', () => node([{ shadowRootType: 'closed' }]));
    chrome.handle('DOM.resolveNode', () => ({ object: { type: 'object', objectId: 'root' } }));
    const { browser, result: error } = await compose(chrome);
    await using _ = browser;
    assert.ok(error instanceof InputActionError);
    assert.match(String(error.cause), /lost focus or its document changed/);
    assert.equal(chrome.commands.filter((c) => c.method.startsWith('Input.')).length, 0);
    await error.cleanup;
  }
  await using chrome = await ScriptedChrome.start();
  model(chrome, () => ({ kind: 'none', host: true }));
  chrome.handle('DOM.describeNode', () => NO_REPLY);
  const { browser, result: error } = await compose(chrome, { timeout: 100 });
  await using _ = browser;
  assert.ok(error instanceof InputActionError);
  assert.ok(error.cause instanceof TimeoutError);
  assert.equal(chrome.commands.filter((c) => c.method.startsWith('Input.')).length, 0);
  await error.cleanup;
});
