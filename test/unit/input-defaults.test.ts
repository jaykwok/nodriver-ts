import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScriptedChrome } from '../../src/testing/index.ts';

test('browser and context default input policies reach later tabs; tabs keep their own', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect({ inputPolicy: { mode: 'human', keyDelay: [5, 6] } });
  const startup = browser.tabs[0]!;
  assert.equal(startup.inputBehavior.policy.mode, 'human');
  assert.deepEqual(startup.inputBehavior.policy.keyDelay, [5, 6]);
  startup.setInputPolicy({ mode: 'instant' });

  const context = await browser.newContext({ inputPolicy: { mode: 'human', seed: 7 } });
  const inContext = await context.newTab();
  assert.equal(inContext.inputBehavior.policy.seed, 7);
  assert.deepEqual(inContext.inputBehavior.policy.keyDelay, [35, 110]);

  browser.setDefaultInputPolicy({ mode: 'instant', pause: [1, 2] });
  const later = await browser.newTab();
  assert.equal(later.inputBehavior.policy.mode, 'instant');
  assert.deepEqual(later.inputBehavior.policy.pause, [1, 2]);
  // Open tabs keep their policy; a context's own default still wins over the browser's.
  assert.equal(startup.inputBehavior.policy.mode, 'instant');
  assert.equal((await context.newTab()).inputBehavior.policy.mode, 'human');
  context.setDefaultInputPolicy(undefined);
  assert.equal((await context.newTab()).inputBehavior.policy.mode, 'instant');

  // An invalid policy is refused before anything is created.
  const created = chrome.commands.filter((c) => c.method === 'Target.createBrowserContext').length;
  await assert.rejects(browser.newContext({ inputPolicy: { mode: 'fast' as 'human' } }), TypeError);
  assert.throws(() => browser.setDefaultInputPolicy({ keyDelay: [9, 1] }), RangeError);
  assert.equal(
    chrome.commands.filter((c) => c.method === 'Target.createBrowserContext').length,
    created,
  );
  assert.equal(browser.defaultInputPolicy?.mode, 'instant');
});
