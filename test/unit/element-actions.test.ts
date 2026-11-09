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

/** A human-mode element whose geometry reads answer `box` in a 100 × 100 viewport. */
async function placedElement(box: () => Promise<unknown> | unknown) {
  const chrome = await ScriptedChrome.start();
  const browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  chrome.handle('Page.bringToFront', () => {});
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
  chrome.handle('DOM.resolveNode', () => ({ object: { type: 'object', objectId: 'element' } }));
  chrome.handle('Runtime.releaseObjectGroup', () => {});
  chrome.handle('Runtime.callFunctionOn', async ({ functionDeclaration: code }) => ({
    result: {
      type: 'object',
      value: code === 'function(){return this.isConnected}' ? true : await box(),
    },
  }));
  chrome.handle(
    'Page.getLayoutMetrics',
    () => ({ cssVisualViewport: { clientWidth: 100, clientHeight: 100 } }) as any,
  );
  chrome.handle('DOM.scrollIntoViewIfNeeded', () => {});
  return {
    chrome,
    tab,
    element: new Element(tab.mainFrame, 1, tab.mainFrame.generation, tab.session),
    async [Symbol.asyncDispose]() {
      await browser.close();
      await chrome.close();
    },
  };
}

test('human scrolling stops the wheel at its limit, also within a round', async () => {
  // The target never moves, so one round of wheel packets would outlast the limit.
  await using f = await placedElement(() => ({ x: 50, y: 300, w: 100, h: 100 }));
  f.tab.setInputPolicy({
    mode: 'human',
    wheelProfile: 'wheel',
    scrollSteps: [120, 120],
    pause: [0, 0],
  });
  let lastWheel = 0;
  f.chrome.handle('Input.dispatchMouseEvent', ({ type }) => {
    if (type === 'mouseWheel') lastWheel = performance.now();
  });
  const start = performance.now();
  await f.element.scrollIntoView({ timeout: 10_000 });
  assert.ok(lastWheel > start, 'the wheel scrolled');
  assert.ok(lastWheel - start < 3200, `wheel packet at ${Math.round(lastWheel - start)} ms`);
  assert.ok(f.chrome.commands.some((c) => c.method === 'DOM.scrollIntoViewIfNeeded'));
});

test('a standalone scrollIntoView keeps its timeout during the geometry reads', async () => {
  await using f = await placedElement(async () => {
    await sleep(150);
    return { x: 50, y: 50, w: 100, h: 100 };
  });
  f.tab.setInputPolicy({ mode: 'human' });
  await assert.rejects(f.element.scrollIntoView({ timeout: 20 }), TimeoutError);
});

test('a standalone scrollIntoView keeps its timeout during the pause between wheel rounds', async (t) => {
  await using f = await placedElement(() => ({ x: 50, y: 300, w: 100, h: 100 }));
  f.tab.setInputPolicy({ mode: 'human', scrollSteps: [1, 1], pause: [0, 0] });
  // The pause between rounds is then 100 ms.
  t.mock.method(f.tab.inputBehavior, 'random', () => 1);
  let wheel = 0;
  f.chrome.handle('Input.dispatchMouseEvent', ({ type }) => {
    if (type === 'mouseWheel') wheel ||= performance.now();
  });
  await assert.rejects(f.element.scrollIntoView({ timeout: 60 }), TimeoutError);
  assert.ok(wheel, 'the wheel scrolled');
  const after = performance.now() - wheel;
  assert.ok(after < 90, `rejected ${Math.round(after)} ms after the wheel`);
});

test('the wheel sends nothing once an async guard outlasts its limit', async () => {
  await using f = await placedElement(() => ({ x: 50, y: 300, w: 100, h: 100 }));
  f.tab.setInputPolicy({ mode: 'human', scrollSteps: [1, 1], pause: [0, 0] });
  // Placing the pointer is the last step before the first packet's guard.
  let placed = false;
  f.chrome.handle('Page.getLayoutMetrics', () => {
    placed = true;
    return { cssVisualViewport: { clientWidth: 100, clientHeight: 100 } } as any;
  });
  const sent: string[] = [];
  f.chrome.handle('Input.dispatchMouseEvent', ({ type }) => {
    sent.push(type);
  });
  const until = performance.now() + 80;
  await f.tab.mouse.wheel(0, 100, {
    timeout: 1000,
    until,
    guard: async () => {
      if (placed) await sleep(until - performance.now() + 20);
    },
  });
  assert.deepEqual(sent, []);
});
