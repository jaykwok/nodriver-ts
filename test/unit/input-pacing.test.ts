import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ScriptedChrome } from '../../src/testing/index.ts';
import {
  createInputScope,
  InputActionError,
  Keyboard,
  Mouse,
  ProtocolError,
  type InputCheckpoint,
  type InputPolicy,
} from '../../src/index.ts';
import { notchPlan } from '../../src/input/human.ts';

/** A page whose mouse events are answered `latency` ms after they arrive. */
async function target() {
  const chrome = await ScriptedChrome.start();
  const browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
  chrome.handle(
    'Page.getLayoutMetrics',
    () => ({ cssVisualViewport: { clientWidth: 400, clientHeight: 300 } }) as any,
  );
  chrome.handle('Input.dispatchKeyEvent', () => {});
  chrome.handle('Input.insertText', () => {});
  const mouse: Array<{ type: string; x: number; y: number; deltaX?: number; deltaY?: number }> = [];
  const arrivals: number[] = [];
  const t = {
    chrome,
    browser,
    session,
    mouse,
    latency: 0,
    moves: () => mouse.filter((e) => e.type === 'mouseMoved'),
    /** Arrival times of moves, in performance.now() time. */
    arrivals,
    layoutReads: () => chrome.commands.filter((c) => c.method === 'Page.getLayoutMetrics').length,
    async [Symbol.asyncDispose]() {
      await browser.close();
      await chrome.close();
    },
  };
  chrome.handle('Input.dispatchMouseEvent', async ({ type, x, y, deltaX, deltaY }) => {
    mouse.push(type === 'mouseWheel' ? { type, x, y, deltaX, deltaY } : { type, x, y });
    if (type === 'mouseMoved') arrivals.push(performance.now());
    if (t.latency) await sleep(t.latency);
  });
  return t;
}
const human = (policy: InputPolicy = {}): InputPolicy => ({
  mode: 'human',
  seed: 7,
  pause: [0, 0],
  pressDelay: [0, 0],
  ...policy,
});

test('a scope keeps the acknowledged pointer position from one run to the next', async () => {
  await using t = await target();
  const scope = createInputScope(t.session, { pageEvents: false, policy: human() });
  assert.deepEqual(scope.position, { x: 0, y: 0 });
  await scope.run(async (input) => {
    await input.mouse.move(120, 80);
    assert.deepEqual(scope.position, { x: 120, y: 80 });
  });
  const previous = scope.position;
  assert.ok(Object.isFrozen(previous));
  assert.equal(Reflect.set(previous, 'x', 999), false);
  let start: unknown;
  await scope.run(async (input) => {
    start = input.mouse.position;
    await input.mouse.move(200, 100);
  });
  assert.deepEqual(start, { x: 120, y: 80, buttons: 0 });
  assert.deepEqual(scope.position, { x: 200, y: 100 });
  assert.deepEqual(previous, { x: 120, y: 80 });
  // Only the first run chose a starting point.
  assert.equal(t.layoutReads(), 1);
  assert.deepEqual(t.moves().at(-1), { type: 'mouseMoved', x: 200, y: 100 });
});

test('an explicit pointer position starts the first run there', async () => {
  await using t = await target();
  assert.throws(() => createInputScope(t.session, { pointer: { x: NaN, y: 0 } }), RangeError);
  const scope = createInputScope(t.session, {
    pageEvents: false,
    pointer: { x: 50, y: 60 },
    policy: human(),
  });
  assert.deepEqual(scope.position, { x: 50, y: 60 });
  let start: unknown;
  await scope.run(async (input) => {
    start = input.mouse.position;
    await input.mouse.wheel(0, 30);
  });
  assert.deepEqual(start, { x: 50, y: 60, buttons: 0 });
  assert.equal(t.layoutReads(), 0);
  assert.ok(t.mouse.every((e) => e.type === 'mouseWheel' && e.x === 50 && e.y === 60));
});

test('a planned delay counts the time spent waiting for the previous reply', async () => {
  await using t = await target();
  t.latency = 120;
  const mouse = new Mouse(t.session);
  mouse.behavior.configure(human({ moveSteps: [6, 6], moveDuration: [360, 360] }));
  const report = await mouse.move(300, 10, { timeout: 5000 });
  assert.equal(report.plannedMs, 360);
  assert.equal(report.sent.moves, 6);
  const gaps = t.arrivals.slice(1).map((at, i) => at - t.arrivals[i]!);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  // Each sample is due 60 ms after the previous one was sent, which the 120 ms reply already
  // covers; waiting 60 ms after each reply would space them 180 ms apart.
  assert.ok(mean < 155, `mean gap ${mean}`);
  assert.ok(report.actualMs >= 5 * 120);
});

test('lateMoves "skip" drops samples whose time has passed and always sends the last', async () => {
  await using t = await target();
  t.latency = 70;
  const plan: InputPolicy = { moveSteps: [10, 10], moveDuration: [200, 200] };
  const scope = (lateMoves: 'send' | 'skip') =>
    createInputScope(t.session, {
      pageEvents: false,
      pointer: { x: 0, y: 0 },
      policy: human({ ...plan, lateMoves }),
    });
  const skipped = await scope('skip').run((input) => input.mouse.move(300, 200).then(() => {}), {
    timeout: 5000,
  });
  assert.ok(skipped.skippedMoves > 0);
  assert.equal(skipped.sent.moves + skipped.skippedMoves, 10);
  assert.deepEqual(t.moves().at(-1), { type: 'mouseMoved', x: 300, y: 200 });
  const sent = await scope('send').run((input) => input.mouse.move(300, 200).then(() => {}), {
    timeout: 5000,
  });
  assert.equal(sent.skippedMoves, 0);
  assert.equal(sent.sent.moves, 10);
});

test('a path that starts after other work keeps its own timeline', async () => {
  await using t = await target();
  const scope = createInputScope(t.session, {
    pageEvents: false,
    pointer: { x: 0, y: 0 },
    policy: human({ moveSteps: [10, 10], moveDuration: [200, 200], lateMoves: 'skip' }),
  });
  const report = await scope.run(
    async (input) => {
      await input.mouse.move(100, 0);
      // Time spent outside input, such as reading the page, does not make the next path late.
      await sleep(400);
      await input.mouse.move(200, 0);
    },
    { timeout: 5000 },
  );
  assert.equal(report.skippedMoves, 0);
  assert.equal(report.sent.moves, 20);
});

test('moves with a button held are never skipped', async () => {
  await using t = await target();
  t.latency = 70;
  const mouse = new Mouse(t.session);
  mouse.behavior.configure(
    human({ moveSteps: [10, 10], moveDuration: [200, 200], lateMoves: 'skip' }),
  );
  const report = await mouse.drag({ x: 10, y: 10 }, { x: 100, y: 10 }, 5, { timeout: 10000 });
  const pressed = t.mouse.findIndex((e) => e.type === 'mousePressed');
  assert.equal(t.mouse.slice(pressed).filter((e) => e.type === 'mouseMoved').length, 5);
  assert.equal(report.sent.presses, 1);
  assert.equal(report.sent.releases, 1);
  // Scope moves with a held button go through a planned path, and keep every sample too.
  t.mouse.length = 0;
  const scope = createInputScope(t.session, {
    pageEvents: false,
    pointer: { x: 0, y: 0 },
    policy: human({ moveSteps: [10, 10], moveDuration: [200, 200], lateMoves: 'skip' }),
  });
  const held = await scope.run(
    async (input) => {
      await input.mouse.down();
      await input.mouse.move(300, 200);
    },
    { timeout: 5000 },
  );
  assert.equal(held.skippedMoves, 0);
  assert.equal(held.sent.moves, 10);
});

test('the report counts each kind of input sent, and the planned and actual time', async () => {
  await using t = await target();
  const mouse = new Mouse(t.session);
  const click = await mouse.click(10, 10);
  assert.deepEqual(click.sent, {
    moves: 1,
    wheels: 0,
    presses: 1,
    keys: 0,
    characters: 0,
    releases: 1,
    text: 0,
    composition: 0,
  });
  assert.equal(click.dispatched, 2);
  assert.equal(click.plannedMs, 0);
  assert.ok(click.actualMs >= 0);
  const wheel = await mouse.wheel(0, 40);
  assert.equal(wheel.sent.wheels, 1);
  assert.equal(wheel.dispatched, 0);
  const keyboard = new Keyboard(t.session);
  const chord = await keyboard.press('Shift+a');
  assert.deepEqual(
    [chord.sent.keys, chord.sent.characters, chord.sent.releases, chord.dispatched],
    [2, 1, 2, 5],
  );
  assert.equal((await keyboard.insertText('x')).sent.text, 1);
  keyboard.behavior.configure(human({ keyDelay: [20, 20] }));
  const typed = await keyboard.type('ab');
  assert.ok(typed.plannedMs >= 20);
  assert.ok(typed.actualMs >= typed.plannedMs - 5);
});

test('a reply that arrives after the action stopped waiting is a late reply', async () => {
  await using t = await target();
  t.latency = 300;
  const mouse = new Mouse(t.session);
  mouse.behavior.configure({ presentationRecovery: false });
  const error = await mouse.move(5, 5, { timeout: 100 }).catch((e: unknown) => e);
  assert.ok(error instanceof InputActionError);
  assert.equal(error.report.lateReplies, 0);
  const cleanup = await error.cleanup;
  assert.equal(cleanup.status, 'completed');
  assert.equal(cleanup.report.lateReplies, 1);
  assert.equal(cleanup.report.sent.moves, 1);
});

test('a pointer grid places every pointer coordinate on device pixels', async () => {
  await using t = await target();
  const mouse = new Mouse(t.session);
  const seen: InputCheckpoint[] = [];
  mouse.behavior.configure({ pointerGrid: { scale: 1.25 } });
  await mouse.click(10.3, 20.6, { guard: (checkpoint) => void seen.push(checkpoint) });
  assert.deepEqual(
    t.mouse.map((e) => [e.type, e.x, e.y]),
    [
      ['mouseMoved', 10.4, 20.8],
      ['mousePressed', 10.4, 20.8],
      ['mouseReleased', 10.4, 20.8],
    ],
  );
  assert.deepEqual(
    seen.flatMap((c) => (c.type === 'move' || c.type === 'mouseDown' ? [[c.x, c.y]] : [])),
    [
      [10.4, 20.8],
      [10.4, 20.8],
    ],
  );
  t.mouse.length = 0;
  mouse.behavior.configure({ pointerGrid: { scale: 1.25, phase: { x: 0.4, y: 0 } } });
  await mouse.move(10.3, 20.6);
  assert.deepEqual(t.moves(), [{ type: 'mouseMoved', x: 10, y: 20.8 }]);
  for (const pointerGrid of [{ scale: 0 }, { scale: 1, phase: { x: NaN, y: 0 } }])
    assert.throws(() => mouse.behavior.configure({ pointerGrid }), RangeError);
});

test('on a pointer grid, a planned sample that would not move the pointer is not sent', async () => {
  await using t = await target();
  const scope = createInputScope(t.session, {
    pageEvents: false,
    pointer: { x: 0, y: 0 },
    policy: human({ moveSteps: [40, 40], moveDuration: [40, 40], pointerGrid: { scale: 1 } }),
  });
  const report = await scope.run((input) => input.mouse.move(5, 3).then(() => {}));
  assert.deepEqual(scope.position, { x: 5, y: 3 });
  const moves = t.moves();
  assert.ok(moves.length < 40 && moves.length === report.sent.moves);
  assert.ok(moves.every((m) => Number.isInteger(m.x) && Number.isInteger(m.y)));
  for (let i = 1; i < moves.length; i++)
    assert.notDeepEqual([moves[i]!.x, moves[i]!.y], [moves[i - 1]!.x, moves[i - 1]!.y]);
  assert.deepEqual(moves.at(-1), { type: 'mouseMoved', x: 5, y: 3 });
});

test('reaching the point the pointer rests at moves aside by one grid step first', async () => {
  await using t = await target();
  const mouse = new Mouse(t.session);
  await mouse.move(10, 10);
  await mouse.reach(10, 10);
  mouse.behavior.configure({ pointerGrid: { scale: 2 } });
  await mouse.reach(10, 10);
  // A pointer elsewhere moves straight there.
  await mouse.reach(20, 10);
  assert.deepEqual(
    t.moves().map((m) => [m.x, m.y]),
    [
      [10, 10],
      [10.25, 10],
      [10, 10],
      [10.5, 10],
      [10, 10],
      [20, 10],
    ],
  );
});

test('wheelNotch scrolls whole notches, one axis per event', async () => {
  await using t = await target();
  assert.deepEqual(
    [...notchPlan(120, -220, 100)].map((p) => [p.deltaX, p.deltaY]),
    [
      [0, -100],
      [0, -100],
      [100, 0],
    ],
  );
  assert.equal([...notchPlan(0, 40, 100)].length, 0);
  const mouse = new Mouse(t.session);
  mouse.behavior.configure(human({ wheelProfile: 'wheel', wheelNotch: 100 }));
  const report = await mouse.wheel(0, 250);
  assert.deepEqual(
    t.mouse.filter((e) => e.type === 'mouseWheel').map((e) => [e.deltaX, e.deltaY]),
    [
      [0, 100],
      [0, 100],
      [0, 100],
    ],
  );
  assert.equal(report.sent.wheels, 3);
  assert.throws(() => mouse.behavior.configure({ wheelNotch: 100 }), TypeError);
  assert.throws(
    () => mouse.behavior.configure({ wheelProfile: 'wheel', wheelNotch: 100, scrollSteps: [2, 2] }),
    TypeError,
  );
  assert.throws(
    () => mouse.behavior.configure({ wheelProfile: 'wheel', wheelNotch: 0 }),
    RangeError,
  );
  assert.throws(() => mouse.behavior.configure({ lateMoves: 'drop' as 'skip' }), TypeError);
});

test('a scope continues from a move acknowledged during cancellation cleanup', async () => {
  await using t = await target();
  const scope = createInputScope(t.session, {
    pageEvents: false,
    pointer: { x: 10, y: 20 },
    policy: { presentationRecovery: false },
  });
  t.latency = 120;
  const error = await scope
    .run(
      async ({ mouse }) => {
        await mouse.move(80, 90);
      },
      { timeout: 40 },
    )
    .catch((e: unknown) => e);
  assert.ok(error instanceof InputActionError);
  assert.deepEqual(scope.position, { x: 10, y: 20 });
  assert.equal((await error.cleanup).status, 'completed');
  assert.deepEqual(scope.position, { x: 80, y: 90 });
  await scope.run(async ({ mouse }) => {
    assert.deepEqual(mouse.position, { x: 80, y: 90, buttons: 0 });
  });
});

test('a pointer grid also snaps a supplied start and a position kept across policy changes', async () => {
  await using t = await target();
  const scope = createInputScope(t.session, {
    pageEvents: false,
    pointer: { x: 10.3, y: 20.6 },
    policy: { pointerGrid: { scale: 1.25 } },
  });
  const checks: InputCheckpoint[] = [];
  await scope.run(
    async ({ mouse }) => {
      await mouse.down();
      await mouse.wheel(0, 10);
    },
    {
      guard: (c) => {
        checks.push(c);
      },
    },
  );
  assert.ok(t.mouse.every((e) => e.x === 10.4 && e.y === 20.8));
  assert.ok(checks.filter((c) => 'x' in c).every((c) => 'x' in c && c.x === 10.4 && c.y === 20.8));
  t.mouse.length = 0;
  scope.behavior.configure({ pointerGrid: { scale: 1 } });
  await scope.run(async ({ mouse }) => {
    await mouse.wheel(0, 10);
  });
  assert.deepEqual(
    t.mouse.map((e) => [e.x, e.y]),
    [[10, 21]],
  );
});

test('the report counts raw input requests issued from a scope callback', async () => {
  await using t = await target();
  const scope = createInputScope(t.session, { pageEvents: false });
  const report = await scope.run(async () => {
    await t.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 3 });
    await t.session.send('Input.insertText', { text: 'once' });
  });
  assert.equal(report.sent.moves, 1);
  assert.equal(report.sent.text, 1);
  assert.equal(report.dispatched, 1);
});

test('a refused first move does not retain a random point Chrome never acknowledged', async () => {
  await using t = await target();
  const scope = createInputScope(t.session, { pageEvents: false, policy: human() });
  const error = await scope
    .run(async ({ mouse }) => {
      await mouse.move(100, 100, {
        guard: (c) => {
          if (c.type === 'move') throw new Error('stop');
        },
      });
    })
    .catch((e: unknown) => e);
  assert.ok(error instanceof InputActionError);
  await error.cleanup;
  assert.deepEqual(scope.position, { x: 0, y: 0 });
  await scope.run(async ({ mouse }) => {
    assert.deepEqual(mouse.position, { x: 0, y: 0, buttons: 0 });
  });
});

test('scope position ignores a rejected move even when the error arrives during cleanup', async () => {
  await using t = await target();
  const scope = createInputScope(t.session, { pageEvents: false, pointer: { x: 12, y: 34 } });
  const controller = new AbortController();
  let sent!: () => void, reply!: () => void;
  const sending = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const replying = new Promise<void>((resolve) => {
    reply = resolve;
  });
  t.chrome.replyOnce('Input.dispatchMouseEvent', async () => {
    sent();
    await replying;
    throw new ProtocolError('Input.dispatchMouseEvent', -32000, 'refused');
  });
  const failed = scope
    .run(
      async ({ mouse }) => {
        await mouse.move(100, 200);
      },
      { signal: controller.signal },
    )
    .catch((e: unknown) => e);
  await sending;
  assert.deepEqual(scope.position, { x: 12, y: 34 });
  controller.abort();
  const error = await failed;
  assert.ok(error instanceof InputActionError);
  reply();
  const cleanup = await error.cleanup;
  assert.equal(cleanup.status, 'completed');
  assert.equal(cleanup.report.lateReplies, 1);
  assert.deepEqual(scope.position, { x: 12, y: 34 });
});

test('large wheel distances remain cancellable without allocating every notch up front', async () => {
  await using t = await target();
  const mouse = new Mouse(t.session);
  mouse.behavior.configure(human({ wheelProfile: 'wheel', wheelNotch: 1 }));
  const reason = new Error('stop before sending');
  const error = await mouse
    .wheel(0, Number.MAX_SAFE_INTEGER, {
      guard: (c) => {
        if (c.type === 'wheel') throw reason;
      },
    })
    .catch((e: unknown) => e);
  assert.ok(error instanceof InputActionError);
  assert.equal(error.cause, reason);
  assert.equal((await error.cleanup).status, 'completed');
  assert.equal(t.mouse.length, 0);
});
