import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScriptedChrome, type RecordedCommand } from '../../src/testing/index.ts';
import {
  createInputScope,
  InputActionError,
  keyDefinition,
  Keyboard,
  Mouse,
  type InputCheckpoint,
} from '../../src/index.ts';

async function target() {
  const chrome = await ScriptedChrome.start();
  const browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
  chrome.handle('Input.dispatchKeyEvent', () => {});
  chrome.handle('Input.dispatchMouseEvent', () => {});
  chrome.handle('Input.insertText', () => {});
  return {
    chrome,
    browser,
    session,
    async [Symbol.asyncDispose]() {
      await browser.close();
      await chrome.close();
    },
  };
}
function keyEvents(chrome: ScriptedChrome) {
  return (
    chrome.commands.filter(
      (c) => c.method === 'Input.dispatchKeyEvent',
    ) as RecordedCommand<'Input.dispatchKeyEvent'>[]
  ).map((c) => c.params);
}
const describe = (checkpoint: InputCheckpoint) =>
  checkpoint.type === 'keyDown' || checkpoint.type === 'char'
    ? `${checkpoint.type}:${checkpoint.key}`
    : checkpoint.type === 'mouseDown' || checkpoint.type === 'mousePressed'
      ? `${checkpoint.type}:${checkpoint.button}@${checkpoint.x},${checkpoint.y}`
      : checkpoint.type;

test('left, right and numpad keys carry the same location on keydown, char and keyup', async () => {
  await using t = await target();
  const keyboard = new Keyboard(t.session);
  assert.equal(keyDefinition('Control'), keyDefinition('ControlLeft'));
  assert.equal(keyDefinition('ShiftRight').location, 2);
  assert.equal(keyDefinition('Numpad5').location, 3);
  assert.equal(keyDefinition('a').location, undefined);
  await keyboard.press('ControlRight+a');
  await keyboard.press('Control');
  await keyboard.press('MetaRight');
  await keyboard.press('Numpad1');
  await keyboard.press('NumpadEnter');
  await keyboard.press('Enter');
  const events = keyEvents(t.chrome).map((e) =>
    [
      e.type,
      e.key,
      e.code,
      e.windowsVirtualKeyCode,
      e.modifiers,
      e.location ?? '-',
      e.isKeypad ? 'keypad' : '-',
      JSON.stringify(e.text ?? null),
    ].join(' '),
  );
  assert.deepEqual(events, [
    'rawKeyDown Control ControlRight 17 2 2 - null',
    'rawKeyDown a KeyA 65 2 - - null',
    'keyUp a KeyA 65 2 - - null',
    'keyUp Control ControlRight 17 0 2 - null',
    'rawKeyDown Control ControlLeft 17 2 1 - null',
    'keyUp Control ControlLeft 17 0 1 - null',
    'rawKeyDown Meta MetaRight 92 4 2 - null',
    'keyUp Meta MetaRight 92 0 2 - null',
    'rawKeyDown 1 Numpad1 97 0 - keypad null',
    'char 1 Numpad1 97 0 - keypad "1"',
    'keyUp 1 Numpad1 97 0 - keypad null',
    'rawKeyDown Enter NumpadEnter 13 0 - keypad null',
    'char Enter NumpadEnter 13 0 - keypad "\\r"',
    'keyUp Enter NumpadEnter 13 0 - keypad null',
    'rawKeyDown Enter Enter 13 0 - - null',
    'char Enter Enter 13 0 - - "\\r"',
    'keyUp Enter Enter 13 0 - - null',
  ]);
});

test('a key is held by its physical code, under the name it was pressed with', async () => {
  await using t = await target();
  const keyboard = new Keyboard(t.session);
  keyboard.behavior.configure({ typing: 'keys' });
  await keyboard.down('Control');
  assert.deepEqual(keyboard.pressedKeys, ['Control']);
  // ControlLeft names the same physical key.
  await keyboard.up('ControlLeft');
  assert.deepEqual(keyboard.pressedKeys, []);
  await keyboard.down('ShiftRight');
  await keyboard.type('A');
  await keyboard.up('ShiftRight');
  assert.deepEqual(
    keyEvents(t.chrome).map((e) => `${e.type}:${e.code}`),
    [
      'rawKeyDown:ControlLeft',
      'keyUp:ControlLeft',
      'rawKeyDown:ShiftRight',
      // The held right Shift counts: no left Shift is added for the capital.
      'rawKeyDown:KeyA',
      'char:KeyA',
      'keyUp:KeyA',
      'keyUp:ShiftRight',
    ],
  );
});

test('a scope releases each held key and button once, also after an explicit release', async () => {
  await using t = await target();
  await createInputScope(t.session, { pageEvents: false }).run(async (input) => {
    await input.keyboard.down('Shift');
    await input.keyboard.down('a');
    await input.keyboard.up('a');
    await input.mouse.down();
    await input.mouse.up();
    await input.mouse.down('right');
  });
  assert.deepEqual(
    keyEvents(t.chrome).map((e) => `${e.type}:${e.code}`),
    ['rawKeyDown:ShiftLeft', 'rawKeyDown:KeyA', 'char:KeyA', 'keyUp:KeyA', 'keyUp:ShiftLeft'],
  );
  assert.deepEqual(
    (
      t.chrome.commands.filter(
        (c) => c.method === 'Input.dispatchMouseEvent',
      ) as RecordedCommand<'Input.dispatchMouseEvent'>[]
    ).map((c) => `${c.params.type}:${c.params.button}`),
    ['mousePressed:left', 'mouseReleased:left', 'mousePressed:right', 'mouseReleased:right'],
  );
});

test('the guard sees each checkpoint, with the key or button and the pointer position', async () => {
  await using t = await target();
  const seen: string[] = [];
  const guard = (checkpoint: InputCheckpoint) => {
    seen.push(describe(checkpoint));
  };
  await new Keyboard(t.session).press('Shift+a', { guard });
  assert.deepEqual(seen, ['step', 'step', 'keyDown:Shift', 'keyDown:a', 'char:a', 'step']);
  seen.length = 0;
  await new Keyboard(t.session).insertText('text', { guard });
  assert.deepEqual(seen, ['step', 'step', 'text', 'step']);
  seen.length = 0;
  await new Mouse(t.session).click(10, 20, { guard, clickCount: 2 });
  assert.deepEqual(seen, [
    'step',
    'step',
    'move',
    'mouseDown:left@10,20',
    'mousePressed:left@10,20',
    'step',
  ]);
  const press = t.chrome.commands.findLast((c) => c.method === 'Input.dispatchMouseEvent')!;
  assert.deepEqual(
    [(press.params as { type: string }).type, (press.params as { clickCount: number }).clickCount],
    ['mouseReleased', 2],
  );
});

test('a guard that stops between keydown and char still releases the key; no character is sent', async () => {
  await using t = await target();
  const keyboard = new Keyboard(t.session);
  const stop = new Error('focus moved');
  const error = await keyboard
    .press('a', {
      guard: (checkpoint) => {
        if (checkpoint.type === 'char') throw stop;
      },
    })
    .catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.equal(error.cause, stop);
  assert.equal((await error.cleanup).status, 'completed');
  assert.deepEqual(
    keyEvents(t.chrome).map((e) => `${e.type}:${e.key}`),
    ['rawKeyDown:a', 'keyUp:a'],
  );
  assert.deepEqual(keyboard.pressedKeys, []);
});

for (const action of ['click', 'down', 'drag'] as const)
  test(`a guard that stops after the press of ${action} still releases the button`, async () => {
    await using t = await target();
    const mouse = new Mouse(t.session);
    const stop = new Error('wrong target');
    const options = {
      guard: (checkpoint: InputCheckpoint) => {
        if (checkpoint.type === 'mousePressed') throw stop;
      },
    };
    const error = await (
      action === 'click'
        ? mouse.click(5, 5, options)
        : action === 'down'
          ? mouse.down('left', options)
          : mouse.drag({ x: 5, y: 5 }, { x: 50, y: 5 }, 3, options)
    ).catch((e) => e);
    assert.ok(error instanceof InputActionError);
    assert.equal(error.cause, stop);
    assert.equal((await error.cleanup).status, 'completed');
    const events = (
      t.chrome.commands.filter(
        (c) => c.method === 'Input.dispatchMouseEvent',
      ) as RecordedCommand<'Input.dispatchMouseEvent'>[]
    ).map((c) => c.params.type);
    assert.deepEqual(events.slice(-2), ['mousePressed', 'mouseReleased']);
    assert.equal(mouse.position.buttons, 0);
  });

test('a guard that refuses the held-pointer slip stops the click and still releases the button', async () => {
  await using t = await target();
  t.chrome.handle(
    'Page.getLayoutMetrics',
    () => ({ cssVisualViewport: { clientWidth: 100, clientHeight: 100 } }) as any,
  );
  const mouse = new Mouse(t.session);
  mouse.behavior.configure({
    mode: 'human',
    moveSteps: [1, 1],
    moveDuration: [0, 0],
    pause: [0, 0],
    pressDelay: [0, 0],
  });
  // Every draw is below the slip probability.
  mouse.behavior.random = () => 0;
  const stop = new Error('no move while pressed');
  let pressed = false;
  const error = await mouse
    .click(20, 20, {
      guard: (checkpoint) => {
        if (checkpoint.type === 'mousePressed') pressed = true;
        if (checkpoint.type === 'move' && pressed) throw stop;
      },
    })
    .catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.equal(error.cause, stop);
  assert.equal((await error.cleanup).status, 'completed');
  const events = (
    t.chrome.commands.filter(
      (c) => c.method === 'Input.dispatchMouseEvent',
    ) as RecordedCommand<'Input.dispatchMouseEvent'>[]
  ).map((c) => c.params.type);
  // The refused slip is not sent.
  assert.deepEqual(events.slice(-2), ['mousePressed', 'mouseReleased']);
  assert.equal(mouse.position.buttons, 0);
});

test('a repeated key takes the key value of the modifiers held now, and keeps one release', async () => {
  await using t = await target();
  const keyboard = new Keyboard(t.session);
  await keyboard.down('a');
  await keyboard.down('Shift');
  await keyboard.down('a');
  assert.deepEqual(keyboard.pressedKeys, ['a', 'Shift']);
  await keyboard.up('a');
  await keyboard.up('Shift');
  assert.deepEqual(
    keyEvents(t.chrome).map(
      (e) => `${e.type}:${e.key}${e.autoRepeat ? ':repeat' : ''}${e.text ? `:${e.text}` : ''}`,
    ),
    [
      'rawKeyDown:a',
      'char:a:a',
      'rawKeyDown:Shift',
      'rawKeyDown:A:repeat',
      'char:A:repeat:A',
      'keyUp:A',
      'keyUp:Shift',
    ],
  );
});
