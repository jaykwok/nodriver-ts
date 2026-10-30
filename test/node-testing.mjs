// Exercise the published subpath export, rather than a source-relative import.
import assert from 'node:assert/strict';
import { ScriptedChrome } from 'nodriver-ts/testing';
import {
  createInputScope,
  InputScope,
  Composition,
  createPresentationLease,
  PresentationLease,
} from 'nodriver-ts';

const chrome = await ScriptedChrome.start();
try {
  const responses = [];
  const browser = await chrome.connect({ observe: { onResponse: (e) => responses.push(e) } });
  try {
    chrome.replyOnce('Runtime.evaluate', { result: { type: 'number', value: 42 } });
    assert.equal(
      (await browser.tabs[0].cdp.send('Runtime.evaluate', { expression: 'answer' })).result.value,
      42,
    );
    const reply = responses.findLast((e) => e.method === 'Runtime.evaluate');
    assert.ok(reply);
    assert.equal(reply.late, false);
    assert.equal(reply.seq, chrome.commands.findLast((c) => c.method === 'Runtime.evaluate').id);
    assert.equal(browser.connection.unansweredCount, 0);
    const session = await browser.attachSession(browser.tabs[0].id);
    chrome.handle('Input.dispatchKeyEvent', () => {});
    chrome.handle('Input.insertText', () => {});
    const scope = createInputScope(session);
    assert.ok(scope instanceof InputScope);
    const inputReport = await scope.run(async (input) => {
      assert.ok(input.composition instanceof Composition);
      await input.keyboard.down('Shift');
      await input.keyboard.insertText('scoped');
    });
    assert.equal(inputReport.phase, 'done');
    assert.equal(inputReport.cleanup, 'completed');
    assert.equal(inputReport.completedSegments, 1);
    assert.equal(
      chrome.commands.filter((c) => c.method === 'Input.dispatchKeyEvent').at(-1).params.type,
      'keyUp',
    );
    await browser.inputScope(session).run(async (input) => {
      await input.keyboard.insertText('factory');
    });
    chrome.handle('Page.startScreencast', () => {});
    chrome.handle('Page.stopScreencast', () => {});
    const presentation = createPresentationLease(session);
    assert.ok(presentation instanceof PresentationLease);
    assert.equal((await presentation.start()).state, 'active');
    assert.equal((await presentation.close()).cleanup, 'completed');
    chrome.assertDone();
    console.log('testing subpath smoke ok');
  } finally {
    await browser.close();
  }
} finally {
  await chrome.close();
}
