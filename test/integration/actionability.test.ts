import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Browser, InputActionError, StaleElementError, TimeoutError } from '../../src/index.ts';

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

test('setChecked clicks the label of a hidden control, refuses radio unchecking and checks the guard', async () => {
  await using browser = await Browser.launch({ headless: true });
  const tab = await browser.newTab(
    page(`<!doctype html><body style="margin:20px">
<input type=checkbox id=plain>
<label id=styled style="display:block;width:200px;height:30px"><input type=checkbox id=hidden style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"><span>styled</span></label>
<input type=checkbox id=gone style="display:none"><label for=gone style="display:block;width:200px;height:30px">gone</label>
<input type=checkbox id=covered style="width:30px;height:30px"><div style="position:relative;top:-34px;width:40px;height:40px;background:#fff"></div>
<input type=radio name=r id=radio checked>
<script>window.clicks=[];document.addEventListener('click',(e)=>clicks.push(e.target.id||e.target.tagName))</script>`),
  );
  const element = (id: string) => tab.waitForSelector('#' + id);
  assert.deepEqual(await (await element('plain')).setChecked(true), {
    changed: true,
    clicked: 'control',
  });
  assert.deepEqual(await (await element('plain')).setChecked(true), { changed: false });
  assert.deepEqual(await (await element('hidden')).setChecked(true), {
    changed: true,
    clicked: 'label',
  });
  assert.deepEqual(await (await element('gone')).setChecked(true), {
    changed: true,
    clicked: 'label',
  });
  // No label: the obstruction makes the click fail within the budget, and nothing is clicked.
  const covered = await (
    await element('covered')
  )
    .setChecked(true, { timeout: 1000 })
    .catch((error: unknown) => error);
  assert.ok(covered instanceof InputActionError);
  const radio = await (await element('radio')).setChecked(false).catch((error: unknown) => error);
  assert.ok(radio instanceof InputActionError);
  assert.match(String(radio.cause), /radio cannot be unchecked/);
  const guarded = await (
    await element('plain')
  )
    .setChecked(false, {
      guard: () => {
        throw new Error('stop');
      },
    })
    .catch((error: unknown) => error);
  assert.ok(guarded instanceof InputActionError);
  assert.equal(
    await (await element('plain')).evaluate((el) => (el as HTMLInputElement).checked),
    true,
  );
  const clicks = (await tab.evaluate('clicks')) as string[];
  assert.ok(!clicks.includes('covered') && !clicks.includes('radio'));
});

test('type with replace selects the value first and types over it, in both modes', async () => {
  await using browser = await Browser.launch({ headless: true, inputPolicy: { mode: 'human' } });
  const tab = await browser.newTab(
    page(`<input id=field value=old><div id=editor contenteditable>old <b>text</b></div>
<script>window.keys=[];field.addEventListener('keydown',(e)=>keys.push(e.key))</script>`),
  );
  const field = await tab.waitForSelector('#field');
  await field.type('new', { replace: true });
  assert.equal(await field.evaluate((el) => (el as HTMLInputElement).value), 'new');
  assert.deepEqual(await tab.evaluate('keys'), ['n', 'e', 'w']);
  await field.type('', { replace: true });
  assert.equal(await field.evaluate((el) => (el as HTMLInputElement).value), '');
  tab.setInputPolicy({ mode: 'instant' });
  await field.type('one');
  await field.type('two', { replace: true });
  assert.equal(await field.evaluate((el) => (el as HTMLInputElement).value), 'two');
  const editor = await tab.waitForSelector('#editor');
  await editor.type('fresh', { replace: true });
  assert.equal(await editor.text(), 'fresh');
});

test('a locator acts on the re-rendered element and never repeats input it already sent', async () => {
  await using browser = await Browser.launch({ headless: true });
  const tab = await browser.newTab(
    page(`<div id=app></div><script>
window.clicks = []; window.downs = 0; let rendered = 0;
function render() {
  const id = ++rendered;
  app.innerHTML = '<button style="width:200px;height:40px">go</button>';
  const button = app.firstChild;
  button.addEventListener('click', () => clicks.push(id));
  button.addEventListener('mousedown', () => downs++);
  // The first button is replaced as soon as the pointer reaches it, before any press.
  if (id === 1) button.addEventListener('pointerover', () => render(), { once: true });
}
render();
</script>`),
  );
  const button = tab.locator('#app button');
  await button.click({ timeout: 5000 });
  assert.deepEqual(await tab.evaluate('clicks'), [2]);
  assert.equal(await button.count(), 1);
  assert.equal(await button.text(), 'go');

  // A failure after the press was sent is reported, not retried.
  const failed = await button
    .click({
      timeout: 5000,
      guard: async () => {
        if ((await tab.evaluate<number>('window.downs')) > 1)
          throw new StaleElementError('replaced');
      },
    })
    .catch((error: unknown) => error);
  assert.ok(failed instanceof InputActionError);
  assert.ok(failed.report.dispatched > 0);
  assert.equal(await tab.evaluate('window.downs'), 2);
});
