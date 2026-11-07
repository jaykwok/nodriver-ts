import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { FetchCancelledError } from '../../src/index.ts';
import { ScriptedChrome } from '../../src/testing/index.ts';

/** A page request that stays pending until the page aborts it. */
async function pendingFetch() {
  const chrome = await ScriptedChrome.start();
  const log = { started: 0, aborted: 0 };
  let abort!: () => void;
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
  chrome.handle('Runtime.callFunctionOn', async ({ functionDeclaration: code }) => {
    if (code.includes('controller?.abort()')) {
      log.aborted++;
      abort();
      return { result: { type: 'boolean', value: true } };
    }
    log.started++;
    await new Promise<void>((resolve) => (abort = resolve));
    return {
      result: { type: 'undefined' },
      exceptionDetails: {
        exceptionId: 1,
        text: 'Uncaught',
        lineNumber: 0,
        columnNumber: 0,
        exception: { type: 'object', description: 'AbortError: signal is aborted' },
      },
    };
  });
  const browser = await chrome.connect();
  return {
    tab: browser.tabs[0]!,
    log,
    async [Symbol.asyncDispose]() {
      await browser.close();
      await chrome.close();
    },
  };
}

test('an abort with any reason aborts the page request', async () => {
  for (const reason of ['stop', undefined, 0, new Error('stop')]) {
    await using f = await pendingFetch();
    const controller = new AbortController();
    const fetching = f.tab.fetch('/slow', { signal: controller.signal }).catch((e: unknown) => e);
    while (!f.log.started) await sleep(5);
    controller.abort(reason);
    const error = await fetching;
    assert.ok(error instanceof FetchCancelledError, `${String(reason)}: ${String(error)}`);
    assert.equal(error.aborted, true);
    assert.equal(f.log.aborted, 1);
  }
});

test('a timeout aborts the page request', async () => {
  await using f = await pendingFetch();
  const error = await f.tab.fetch('/slow', { timeout: 50 }).catch((e: unknown) => e);
  assert.ok(error instanceof FetchCancelledError);
  assert.equal(error.aborted, true);
  assert.equal(f.log.aborted, 1);
});
