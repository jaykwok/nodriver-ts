import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Browser } from '../../src/index.ts';

const [record, profile, mode] = process.argv.slice(2);
const signals = process.listenerCount('SIGTERM');
const browser = await Browser.launch({
  detached: true,
  headless: true,
  maskHeadless: false,
  userDataDir: profile,
  handleSignals: true,
});
// Record before release so the parent can clean up even if the regression makes this host hang.
await writeFile(record!, JSON.stringify({ endpoint: browser.endpoint, pid: browser.process!.pid }));
assert.equal(browser.process!.child.stderr, null);
if (mode === 'forced') await browser.disconnect(); // Ownership can be released after disconnect.
const releasing = browser.release();
await browser.close(); // Also exercises concurrent close and release.
assert.equal(await releasing, browser.endpoint);
assert.equal(await browser.release(), browser.endpoint);
assert.equal(browser.owned, false);
assert.equal(process.listenerCount('SIGTERM'), signals);
await browser.process!.close(); // The former process owner must also be harmless.
await browser[Symbol.asyncDispose]();
if (mode === 'forced') process.exit(0);
// Otherwise allow natural exit: a retained child/socket reference would hang this process.
