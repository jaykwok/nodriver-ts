import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputBehavior, InputActionError } from '../../src/input/behavior.ts';
import { Mouse, Keyboard } from '../../src/input/input.ts';
import {
  fittsDuration,
  motionPlan,
  minimumJerk,
  targetCoordinate,
  digraphWeight,
  keyInterval,
  scrollPlan,
} from '../../src/input/human.ts';
import { ScriptedChrome, type RecordedCommand } from '../../src/testing/index.ts';
import { ProtocolError } from '../../src/errors.ts';

function behavior(seed = 1) {
  const b = new InputBehavior(
    (t) => t(),
    () => {},
  );
  b.configure({
    mode: 'human',
    seed,
    moveDuration: [0, 0],
    moveSteps: [2, 2],
    pause: [0, 0],
    pressDelay: [0, 0],
    keyDelay: [0, 0],
  });
  return b;
}
test('human motion is seeded, ends exactly, and scales with distance and target width', () => {
  const a = behavior(),
    b = behavior();
  const from = { x: 10, y: 20 },
    to = { x: 800, y: 300 };
  const plan = motionPlan(from, to, () => a.random(), { width: 10 });
  assert.deepEqual(
    plan,
    motionPlan(from, to, () => b.random(), { width: 10 }),
  );
  assert.deepEqual({ x: plan.at(-1)!.x, y: plan.at(-1)!.y }, to);
  assert.ok(plan.every((p) => Number.isFinite(p.x + p.y + p.delay) && p.delay > 0));
  assert.ok(fittsDuration(500, 10) > fittsDuration(100, 10));
  assert.ok(fittsDuration(500, 10) > fittsDuration(500, 100));
  assert.equal(minimumJerk(0), 0);
  assert.equal(minimumJerk(1), 1);
  assert.ok(minimumJerk(0.001) < 1e-7);
  let corrected = false;
  for (let seed = 1; seed <= 50; seed++) {
    const b = behavior(seed);
    const p = motionPlan(from, to, () => b.random(), { steps: 2 });
    if (p.length > 2) {
      corrected = true;
      assert.ok(p.length >= 5 && p.length <= 7);
    }
    assert.equal(p.at(-1)!.x, to.x);
  }
  assert.ok(corrected);
});
test('target sampling is truncated and centered, and keyboard and wheel profiles preserve limits', () => {
  const b = behavior(12);
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const v = targetCoordinate(() => b.random(), 0.2, 0.45);
    assert.ok(v >= 0.2 && v <= 0.8);
    total += v;
    assert.ok(keyInterval(() => b.random(), [20, 80], 't', 'h') <= 80);
  }
  assert.ok(total / 1000 > 0.43 && total / 1000 < 0.49);
  assert.equal(
    targetCoordinate(() => 0, 0.45, 0.45),
    0.45,
  );
  assert.ok(digraphWeight('t', 'h') < digraphWeight('a', 't'));
  assert.equal(digraphWeight('e', 'e'), 0.65);
  for (const profile of ['trackpad', 'wheel'] as const) {
    const packets = scrollPlan(-7, 101, 9, profile);
    assert.equal(
      packets.reduce((n, p) => n + p.deltaX, 0),
      -7,
    );
    assert.equal(
      packets.reduce((n, p) => n + p.deltaY, 0),
      101,
    );
    if (profile === 'trackpad') assert.ok(packets.at(-1)!.deltaY < packets[2]!.deltaY);
  }
  assert.throws(() => b.configure({ wheelProfile: 'invalid' as 'wheel' }));
});
test('rollover overlaps only eligible keys and releases both on cancellation', async () => {
  for (const cancel of [false, true]) {
    await using chrome = await ScriptedChrome.start();
    await using browser = await chrome.connect();
    const b = behavior();
    b.random = () => 0.1;
    const keyboard = new Keyboard(browser.tabs[0]!.session, b);
    const controller = new AbortController();
    const events: string[] = [];
    chrome.handle('Input.dispatchKeyEvent', (p) => {
      events.push(`${p.type}:${p.key}`);
      if (cancel && p.type === 'rawKeyDown' && p.key === 'h') controller.abort(new Error('stop'));
    });
    const action = keyboard.type('th', { signal: controller.signal });
    if (cancel) {
      const error = await action.catch((e) => e);
      assert.ok(error instanceof InputActionError);
      assert.equal((await error.cleanup).status, 'completed');
    } else assert.equal((await action).completedSegments, 2);
    assert.ok(events.indexOf('rawKeyDown:h') < events.indexOf('keyUp:t'));
    assert.ok(events.includes('keyUp:t') && events.includes('keyUp:h'));
    assert.deepEqual(keyboard.pressedKeys, []);
  }
});
test('micro-slip uses held-button pressure and releases at its final position; hit refusal skips it', async () => {
  for (const allowed of [false, true]) {
    await using chrome = await ScriptedChrome.start();
    await using browser = await chrome.connect();
    const b = behavior();
    b.random = () => 0.1;
    const mouse = new Mouse(browser.tabs[0]!.session, b);
    chrome.handle(
      'Page.getLayoutMetrics',
      () => ({ cssVisualViewport: { clientWidth: 100, clientHeight: 100 } }) as any,
    );
    chrome.handle('Input.dispatchMouseEvent', () => {});
    await mouse.click(20, 20, { beforeSlip: async () => allowed });
    const events = chrome.commands
      .filter((c) => c.method === 'Input.dispatchMouseEvent')
      .map((c) => c.params as any);
    const slip = events.find((p) => p.type === 'mouseMoved' && p.buttons === 1);
    assert.equal(!!slip, allowed);
    if (slip) {
      assert.equal(slip.force, 0.5);
      assert.equal(events.at(-1).x, slip.x);
    }
    assert.equal(mouse.position.buttons, 0);
  }
});

test('omitted motion ranges reset to automatic planning without hidden configuration state', () => {
  const b = behavior();
  assert.deepEqual(b.policy.moveSteps, [2, 2]);
  b.configure({ mode: 'human' });
  assert.equal(b.policy.moveSteps, undefined);
  assert.equal(b.policy.moveDuration, undefined);
  assert.equal(b.policy.scrollSteps, undefined);
  assert.throws(() => b.range('moveSteps'), /automatic/);
  for (const field of ['moveSteps', 'moveDuration', 'scrollSteps'] as const)
    assert.throws(() => b.configure({ [field]: [NaN, 2] }));
  // A field set to undefined counts as omitted.
  b.configure({ mode: 'human', pause: undefined, wheelProfile: undefined, moveSteps: undefined });
  assert.deepEqual(b.policy.pause, [0, 15]);
  assert.equal(b.policy.wheelProfile, 'trackpad');
  assert.equal(b.policy.moveSteps, undefined);
});

test('rollover preserves explicit text segments and never overlaps caller-held keys', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const b = behavior();
  b.random = () => 0.1;
  const keyboard = new Keyboard(browser.tabs[0]!.session, b);
  chrome.handle('Input.dispatchKeyEvent', () => {});
  chrome.handle('Input.insertText', () => {});
  await keyboard.type(['', 'th']);
  assert.deepEqual(
    (
      chrome.commands.filter(
        (c) => c.method === 'Input.insertText',
      ) as RecordedCommand<'Input.insertText'>[]
    ).map((c) => c.params.text),
    ['', 'th'],
  );
  assert.ok(!chrome.commands.some((c) => c.method === 'Input.dispatchKeyEvent'));
  await keyboard.down('a');
  await keyboard.type('th');
  assert.deepEqual(keyboard.pressedKeys, ['a']);
  const keys = (
    chrome.commands.filter(
      (c) => c.method === 'Input.dispatchKeyEvent',
    ) as RecordedCommand<'Input.dispatchKeyEvent'>[]
  ).map((c) => `${c.params.type}:${c.params.key}`);
  assert.ok(keys.indexOf('keyUp:t') < keys.indexOf('rawKeyDown:h'));
  await keyboard.up('a');
});

test('a rejected second rollover press still releases both keys and keeps the input error', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const b = behavior();
  b.random = () => 0.1;
  const keyboard = new Keyboard(browser.tabs[0]!.session, b);
  chrome.handle('Input.dispatchKeyEvent', (p) => {
    if (p.type === 'rawKeyDown' && p.key === 'h')
      throw new ProtocolError('Input.dispatchKeyEvent', -32000, 'second press refused');
  });
  const error = await keyboard.type('th').catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.match(String(error.cause), /second press refused/);
  assert.equal((await error.cleanup).status, 'completed');
  assert.deepEqual(keyboard.pressedKeys, []);
  const releases = (
    chrome.commands.filter(
      (c) => c.method === 'Input.dispatchKeyEvent',
    ) as RecordedCommand<'Input.dispatchKeyEvent'>[]
  )
    .filter((c) => c.params.type === 'keyUp')
    .map((c) => c.params.key);
  assert.deepEqual(releases.sort(), ['h', 't']);
});

test('cancellation during held-pointer hit confirmation still releases the button', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const b = behavior();
  b.random = () => 0.1;
  const mouse = new Mouse(browser.tabs[0]!.session, b);
  const controller = new AbortController();
  chrome.handle(
    'Page.getLayoutMetrics',
    () => ({ cssVisualViewport: { clientWidth: 100, clientHeight: 100 } }) as any,
  );
  chrome.handle('Input.dispatchMouseEvent', () => {});
  const error = await mouse
    .click(20, 20, {
      signal: controller.signal,
      beforeSlip: async () => {
        controller.abort(new Error('stop during hit check'));
        return true;
      },
    })
    .catch((e) => e);
  assert.ok(error instanceof InputActionError);
  assert.equal((await error.cleanup).status, 'completed');
  const events = (
    chrome.commands.filter(
      (c) => c.method === 'Input.dispatchMouseEvent',
    ) as RecordedCommand<'Input.dispatchMouseEvent'>[]
  ).map((c) => c.params);
  assert.ok(!events.some((p) => p.type === 'mouseMoved' && p.buttons === 1));
  assert.equal(events.at(-1)!.type, 'mouseReleased');
  assert.equal(mouse.position.buttons, 0);
});

test('motion along the top and left edges stays inside the document', () => {
  let state = 9;
  const random = () => (state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 2000; i++) {
    const along = motionPlan({ x: 20, y: 3 }, { x: 900, y: 3 }, random);
    assert.ok(along.every((point) => point.y >= 0 && point.x >= 0));
    const down = motionPlan({ x: 2, y: 600 }, { x: 2, y: 10 }, random);
    assert.ok(down.every((point) => point.x >= 0 && point.y >= 0));
  }
  const outside = motionPlan({ x: 10, y: 10 }, { x: -40, y: 10 }, () => 0.5);
  assert.deepEqual(outside.at(-1), { ...outside.at(-1), x: -40, y: 10 });
});
