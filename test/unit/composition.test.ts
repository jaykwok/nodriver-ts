import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScriptedChrome, NO_REPLY } from '../../src/testing/index.ts';
import { Keyboard, InputActionError, InputBlockedError, TimeoutError } from '../../src/index.ts';
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
function model(chrome: ScriptedChrome) {
  let focused = true;
  chrome.handle('DOM.getDocument', () => ({
    root: {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      localName: '',
      nodeValue: '',
    },
  }));
  chrome.handle('DOM.resolveNode', () => ({ object: { type: 'object', objectId: 'document' } }));
  chrome.handle('Runtime.callFunctionOn', (params) =>
    params.objectId === 'document'
      ? { result: { type: 'object', objectId: 'focus' } }
      : { result: { type: 'boolean', value: focused } },
  );
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

test('unacknowledged composition cancellation fails cleanup without retries or later input', async () => {
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
      { cleanupTimeout: 40 },
    )
    .catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.equal((await error.cleanup).status, 'failed');
  const blocked = await keyboard.insertText('不得写入').catch((e) => e);
  assert.ok(blocked instanceof InputActionError);
  assert.ok(blocked.cause instanceof InputBlockedError);
  assert.equal(browser.connection.unansweredCount, 1);
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.imeSetComposition').length, 2);
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 0);
});
