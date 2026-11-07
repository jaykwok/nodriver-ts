import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Element, InputActionError, Keyboard, TimeoutError, type Tab } from '../../src/index.ts';
import { ScriptedChrome } from '../../src/testing/index.ts';
import { CONTROL, LABEL, scriptDom } from '../fixtures/scripted-dom.ts';

async function scriptedElement() {
  const chrome = await ScriptedChrome.start();
  let tab!: Tab;
  const dom = scriptDom(chrome, () => tab.mainFrame.id);
  const browser = await chrome.connect({ timeout: 2000 });
  tab = browser.tabs[0]!;
  const element = new Element(tab.mainFrame, CONTROL, tab.mainFrame.generation, tab.session);
  return {
    chrome,
    dom,
    tab,
    element,
    async [Symbol.asyncDispose]() {
      await browser.close();
      await chrome.close();
    },
  };
}
const actionFailure = async (operation: Promise<unknown>) => {
  const error = await operation.catch((error: unknown) => error);
  assert.ok(error instanceof InputActionError, String(error));
  return error;
};

test('setChecked checks an unchecked radio and refuses only to uncheck one', async () => {
  await using f = await scriptedElement();
  f.dom.control.radio = true;
  assert.deepEqual(await f.element.setChecked(true), { changed: true, clicked: 'control' });
  assert.deepEqual(f.dom.pressed, [CONTROL]);
  assert.deepEqual(await f.element.setChecked(true), { changed: false });
  const error = await actionFailure(f.element.setChecked(false));
  assert.match(String(error.cause), /radio cannot be unchecked/);
  assert.equal(error.report.dispatched, 0);
  assert.deepEqual(f.dom.pressed, [CONTROL]);
});

test('setChecked clicks the rendered label of a control a click cannot reach', async () => {
  await using f = await scriptedElement();
  f.dom.control.rendered = false;
  f.dom.useLabel = true;
  assert.deepEqual(await f.element.setChecked(true), { changed: true, clicked: 'label' });
  assert.deepEqual(f.dom.pressed, [LABEL]);
});

test('setChecked never clicks the label of a disabled control', async () => {
  await using f = await scriptedElement();
  Object.assign(f.dom.control, { rendered: false, disabled: true });
  f.dom.useLabel = true;
  const error = await actionFailure(f.element.setChecked(true, { timeout: 150 }));
  assert.ok(error.cause instanceof TimeoutError);
  assert.equal(error.report.dispatched, 0);
  assert.deepEqual(f.dom.pressed, []);
});

test('setChecked waits for a disabled control, within its deadline', async () => {
  await using f = await scriptedElement();
  f.dom.control.disabled = true;
  setTimeout(() => (f.dom.control.disabled = false), 60);
  assert.deepEqual(await f.element.setChecked(true, { timeout: 2000 }), {
    changed: true,
    clicked: 'control',
  });
  assert.deepEqual(f.dom.pressed, [CONTROL]);
});

test('setChecked reports a click that did not change the state, without repeating it', async () => {
  await using f = await scriptedElement();
  f.dom.clickChanges = false;
  const error = await actionFailure(f.element.setChecked(true, { timeout: 3000 }));
  assert.match(String(error.cause), /not repeated/);
  assert.deepEqual(f.dom.pressed, [CONTROL]);
});

test('dispatched counts every sent press, release and key', async () => {
  await using f = await scriptedElement();
  const report = await new Keyboard(f.tab.cdp).press('a');
  assert.equal(report.dispatched, 2);
  const keys = f.chrome.commands.filter(({ method }) => method === 'Input.dispatchKeyEvent');
  assert.equal(keys.length, 2);
});

test('every locator action queries again and reaches the element', async () => {
  await using f = await scriptedElement();
  const { dom } = f;
  const locator = f.tab.locator('input', { pierce: false });
  assert.equal(await locator.count(), 1);
  assert.equal((await locator.element()).backendNodeId, CONTROL);
  await locator.click();
  assert.deepEqual(dom.pressed, [CONTROL]);
  assert.deepEqual(await locator.hover(), { x: 10, y: 10 });
  await locator.fill('filled');
  await locator.type('t');
  assert.deepEqual(dom.typed, ['filled', 't']);
  dom.control.checked = false;
  assert.deepEqual(await locator.setChecked(true), { changed: true, clicked: 'control' });
  assert.equal(await locator.text(), 'text');
  assert.equal(await locator.attribute('name'), 'value');
  assert.equal(dom.queries, 9);
});

test('a locator runs an action again when the element was replaced before any input', async () => {
  await using f = await scriptedElement();
  f.dom.replaceBeforeInput = true;
  await f.tab.locator('input', { pierce: false }).click({ timeout: 3000 });
  assert.equal(f.dom.queries, 2);
  assert.deepEqual(f.dom.pressed, [CONTROL]);
});

test('a locator never repeats an action once input was sent', async () => {
  await using f = await scriptedElement();
  f.dom.replaceOnPress = true;
  const error = await actionFailure(
    f.tab.locator('input', { pierce: false }).click({ timeout: 3000 }),
  );
  assert.ok(error.report.dispatched > 0);
  assert.equal(f.dom.queries, 1);
  assert.deepEqual(f.dom.pressed, [CONTROL]);
});

test('one locator timeout covers finding the element and reading it', async () => {
  await using f = await scriptedElement();
  f.dom.readDelay = 400;
  for (const read of [
    () => f.tab.locator('input', { pierce: false }).text({ timeout: 80 }),
    () => f.tab.locator('input', { pierce: false }).attribute('name', { timeout: 80 }),
  ]) {
    const started = performance.now();
    await assert.rejects(read(), TimeoutError);
    assert.ok(performance.now() - started < 300);
  }
});

test('a locator read stops on abort, and waits within its timeout for a match', async () => {
  await using f = await scriptedElement();
  f.dom.readDelay = 400;
  const controller = new AbortController();
  const stopped = f.tab.locator('input', { pierce: false }).text({ signal: controller.signal });
  await sleep(40);
  controller.abort(new Error('stop'));
  await assert.rejects(stopped, /stop/);
  f.dom.readDelay = 0;
  f.chrome.replyOnce('Runtime.getProperties', { result: [] });
  assert.equal(
    await f.tab.locator('input', { pierce: false }).attribute('name', { timeout: 2000 }),
    'value',
  );
  f.chrome.handle('Runtime.getProperties', () => ({ result: [] }));
  await assert.rejects(
    f.tab.locator('input', { pierce: false }).text({ timeout: 80 }),
    TimeoutError,
  );
});

test('element reads accept a timeout and signal', async () => {
  await using f = await scriptedElement();
  f.dom.readDelay = 400;
  await assert.rejects(f.element.text({ timeout: 40 }), TimeoutError);
  await assert.rejects(f.element.attribute('name', { timeout: 40 }), TimeoutError);
  await assert.rejects(f.element.html({ signal: AbortSignal.abort(new Error('stop')) }), /stop/);
  f.dom.readDelay = 0;
  assert.equal(await f.element.text({ timeout: 1000 }), 'text');
  assert.equal(await f.element.attribute('name'), 'value');
});

test('setChecked does not press a label once its control becomes disabled', async () => {
  await using f = await scriptedElement();
  Object.assign(f.dom.control, { rendered: false });
  f.dom.useLabel = true;
  f.chrome.handle('Input.dispatchMouseEvent', ({ type }) => {
    if (type === 'mouseMoved') f.dom.control.disabled = true;
    if (type === 'mousePressed') f.dom.pressed.push(LABEL);
  });
  const error = await actionFailure(f.element.setChecked(true, { timeout: 1000 }));
  assert.match(String(error.cause), /became disabled/);
  assert.equal(f.dom.control.disabled, true, 'the pointer reached the label');
  assert.deepEqual(f.dom.pressed, []);
  assert.equal(error.report.dispatched, 0);
});
