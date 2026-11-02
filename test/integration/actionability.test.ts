import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Browser, InputActionError, TimeoutError } from '../../src/index.ts';

const page = (body: string) => 'data:text/html,' + encodeURIComponent(body);

test('click reaches text controls, shadow hosts and buttons with icon components; a disabled fieldset refuses it', async () => {
  await using browser = await Browser.launch({ headless: true });
  const tab = await browser.newTab(
    page(`<!doctype html><body style="margin:20px">
<input id="text" style="display:block;width:200px;height:30px" value="abc">
<textarea id="area" style="display:block;width:200px;height:40px">x</textarea>
<x-host id="host" style="display:block;width:200px;height:30px"></x-host>
<button id="icon" style="display:block;width:200px;height:30px"><x-icon></x-icon></button>
<fieldset disabled><button id="fieldset" style="display:block;width:200px;height:30px">no</button></fieldset>
<script>
customElements.define('x-host', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button style="width:200px;height:30px">inner</button>'; }
});
customElements.define('x-icon', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<span style="display:inline-block;width:180px;height:24px"></span>'; }
});
window.clicks = [];
for (const id of ['text', 'area', 'host', 'icon', 'fieldset'])
  document.getElementById(id).addEventListener('click', () => clicks.push(id));
</script>`),
  );
  for (const id of ['text', 'area', 'host', 'icon'])
    await (await tab.waitForSelector('#' + id)).click({ timeout: 5000 });
  const refused = await (
    await tab.waitForSelector('#fieldset')
  )
    .click({ timeout: 1000 })
    .catch((error: unknown) => error);
  assert.ok(refused instanceof InputActionError);
  // The control never becomes enabled, so no click is dispatched before the deadline.
  assert.ok(refused.cause instanceof TimeoutError);
  assert.deepEqual(await tab.evaluate('clicks'), ['text', 'area', 'host', 'icon']);
});

test('a confirm() opened by a click holds its cleanup until the dialog is answered', async () => {
  await using browser = await Browser.launch({ headless: true });
  const tab = await browser.newTab(
    page(
      `<button id=b style="width:200px;height:40px" onclick="window.answers=(window.answers||[]).concat(confirm('sure?'))">go</button>`,
    ),
  );
  const button = await tab.waitForSelector('#b');
  const opened = tab.session.waitFor('Page.javascriptDialogOpening', undefined, { timeout: 10000 });
  const click = button
    .click({ timeout: 2000, cleanupTimeout: 1000 })
    .catch((error: unknown) => error);
  await opened;
  // Longer than the action deadline and the cleanup budget together.
  await sleep(4000);
  assert.equal(browser.input.blocked, undefined);
  await tab.handleDialog(true);
  const error = await click;
  assert.ok(error instanceof InputActionError);
  const { status, report } = await error.cleanup;
  assert.equal(status, 'completed');
  assert.ok(report.trace.some((entry) => entry.type === 'dialogWait'));
  assert.equal(browser.input.blocked, undefined);
  // Managed input continues on the same connection.
  const second = tab.session.waitFor('Page.javascriptDialogOpening', undefined, { timeout: 10000 });
  const again = button.click({ timeout: 5000 });
  await second;
  await tab.handleDialog(false);
  await again;
  assert.deepEqual(await tab.evaluate('window.answers'), [true, false]);
});

test('a held Shift does not change characters typed without Shift', async () => {
  await using browser = await Browser.launch({ headless: true });
  const tab = await browser.newTab(page('<input id=field>'));
  const field = await tab.waitForSelector('#field');
  await field.click();
  await tab.keyboard.down('Shift');
  await tab.keyboard.type('aB1!');
  await tab.keyboard.up('Shift');
  assert.equal(await field.evaluate((el) => (el as HTMLInputElement).value), 'aB1!');
});
