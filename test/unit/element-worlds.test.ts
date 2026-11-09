import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Element, TimeoutError } from '../../src/index.ts';
import { ScriptedChrome, NO_REPLY, type RecordedCommand } from '../../src/testing/index.ts';
import { delay } from '../../src/utils.ts';

test('element evaluation selects a world without changing subsequent built-in probes', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 8 }));
  chrome.handle('Runtime.evaluate', (p) => ({
    result: { type: 'object', objectId: `123.${p.contextId}.1` },
  }));
  chrome.handle('DOM.describeNode', () => ({ node: { backendNodeId: 99 } }) as any);
  chrome.handle('DOM.resolveNode', (p) => ({
    object: { type: 'object', objectId: `123.${p!.executionContextId ?? 7}.${p!.backendNodeId}` },
  }));
  chrome.handle('Runtime.releaseObjectGroup', () => {});
  chrome.handle('Runtime.callFunctionOn', (p) => ({
    result: {
      type: 'object',
      value:
        p.functionDeclaration === 'function(){return this.isConnected}'
          ? true
          : p.functionDeclaration.includes('textContent')
            ? 'text'
            : p.objectId?.split('.')[1] === '7'
              ? 'page expando'
              : undefined,
    },
  }));
  const element = new Element(tab.mainFrame, 12, tab.mainFrame.generation, tab.session);
  assert.equal(await element.evaluate((el) => (el as any).frameworkState), undefined);
  assert.equal(
    await element.evaluate((el) => (el as any).frameworkState, undefined, { world: 'main' }),
    'page expando',
  );
  assert.equal(await element.text(), 'text');
  const elementResolves = (
    chrome.commands.filter(
      (c) => c.method === 'DOM.resolveNode',
    ) as RecordedCommand<'DOM.resolveNode'>[]
  ).filter((c) => c.params?.backendNodeId === 12);
  assert.deepEqual(
    elementResolves.map((c) => c.params?.executionContextId),
    [8, 7, 8],
  );
  assert.ok(!chrome.commands.some((c) => c.method === 'Runtime.enable'));
  const groups = elementResolves.map((c) => c.params?.objectGroup);
  assert.equal(new Set(groups).size, 3);
  for (const group of groups)
    assert.ok(
      chrome.commands.some(
        (c) =>
          c.method === 'Runtime.releaseObjectGroup' &&
          (c as RecordedCommand<'Runtime.releaseObjectGroup'>).params?.objectGroup === group,
      ),
    );
  await assert.rejects(
    element.evaluate((el) => el.id, undefined, { world: 'invalid' as 'main' }),
    TypeError,
  );
});

test('an element callback past its deadline releases its handle and is not replayed', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 8 }));
  chrome.handle('DOM.resolveNode', () => ({ object: { type: 'object', objectId: '123.8.12' } }));
  chrome.handle('Runtime.releaseObjectGroup', () => {});
  // The deadline passes once the callback is sent, however long the steps before it take.
  const deadline = new AbortController();
  chrome.handle('Runtime.callFunctionOn', (p) => {
    if (p.functionDeclaration === 'function(){return this.isConnected}')
      return { result: { type: 'boolean', value: true } };
    if (p.functionDeclaration.includes('el.click'))
      deadline.abort(new TimeoutError('Element callback timed out'));
    return NO_REPLY;
  });
  const element = new Element(tab.mainFrame, 12, tab.mainFrame.generation, tab.session);
  await assert.rejects(
    element.evaluate((el) => el.click(), undefined, { signal: deadline.signal }),
    TimeoutError,
  );
  assert.equal(
    chrome.commands.filter(
      (c) =>
        c.method === 'Runtime.callFunctionOn' &&
        (c as RecordedCommand<'Runtime.callFunctionOn'>).params?.functionDeclaration.includes(
          'el.click',
        ),
    ).length,
    1,
  );
  assert.equal(chrome.commands.filter((c) => c.method === 'Runtime.releaseObjectGroup').length, 1);
  let calls = 0;
  const later = new AbortController();
  await assert.rejects(
    element.withObject(
      async () => {
        calls++;
        later.abort(new TimeoutError('Element callback timed out'));
        await new Promise(() => {});
      },
      { signal: later.signal },
    ),
    TimeoutError,
  );
  assert.equal(calls, 1);
});

test('an element read inside an input action keeps its own deadline and signal', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 8 }));
  chrome.handle('DOM.resolveNode', () => ({ object: { type: 'object', objectId: '123.8.12' } }));
  chrome.handle('Runtime.releaseObjectGroup', () => {});
  chrome.handle('Page.bringToFront', () => {});
  const stop = new Error('read cancelled');
  const cancel = new AbortController();
  chrome.handle('Runtime.callFunctionOn', (p) => {
    if (p.functionDeclaration === 'function(){return this.isConnected}')
      return { result: { type: 'boolean', value: true } };
    cancel.abort(stop);
    // Answered late: the action still drains the reply of every command it sent.
    return delay(50).then(() => ({ result: { type: 'string', value: 'late' } }));
  });
  const element = new Element(tab.mainFrame, 12, tab.mainFrame.generation, tab.session);
  let failure: unknown;
  await tab.inputBehavior.action('probe', { timeout: 30_000 }, async () => {
    failure = await element
      .evaluate((el) => el.id, undefined, { signal: cancel.signal })
      .catch((error: unknown) => error);
  });
  assert.equal(failure, stop);
});
