import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Browser, NodriverError } from '../../src/index.ts';

const opener =
  'data:text/html,' +
  encodeURIComponent(
    `<button style="width:200px;height:40px" onclick="window.open('about:blank')">open</button>`,
  );

test('a tab scope closes its tabs and their popups and leaves other and kept tabs open', async () => {
  await using browser = await Browser.launch({ headless: true });
  const unrelated = await browser.newTab();
  const scope = browser.tabScope();
  const work = await scope.newTab();
  const popup = work.waitForPopup({ timeout: 10_000 });
  await work.goto(opener);
  await (await work.waitForSelector('button')).click();
  const first = await popup;
  // A popup of a popup is owned too.
  const second = first.waitForPopup({ timeout: 10_000 });
  await first.goto(opener);
  await (await first.waitForSelector('button')).click();
  const nested = await second;
  const manual = await scope.newTab();
  scope.keep(manual);
  assert.deepEqual(
    new Set(scope.tabs.map((tab) => tab.id)),
    new Set([work.id, first.id, nested.id]),
  );
  // A tab still opening when close() starts is closed, and its caller is told.
  const late = scope.newTab().catch((error: unknown) => error);
  const result = await scope.close();
  assert.ok((await late) instanceof NodriverError);
  assert.ok([work, first, nested].every((tab) => tab.closed && result.closed.includes(tab.id)));
  assert.deepEqual(result.kept, [manual.id]);
  assert.equal(unrelated.closed, false);
  assert.equal(manual.closed, false);
  assert.equal(browser.tabs.length, 3); // startup tab, unrelated, manual
  assert.equal(await scope.close(), await scope.close());
  await assert.rejects(scope.newTab(), NodriverError);
});
