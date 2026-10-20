// Exercise the published subpath export, rather than a source-relative import.
import assert from 'node:assert/strict';
import { ScriptedChrome } from 'nodriver-ts/testing';

const chrome = await ScriptedChrome.start();
try {
  const browser = await chrome.connect();
  try {
    chrome.replyOnce('Runtime.evaluate', { result: { type: 'number', value: 42 } });
    assert.equal(
      (await browser.tabs[0].cdp.send('Runtime.evaluate', { expression: 'answer' })).result.value,
      42,
    );
    chrome.assertDone();
    console.log('testing subpath smoke ok');
  } finally {
    await browser.close();
  }
} finally {
  await chrome.close();
}
