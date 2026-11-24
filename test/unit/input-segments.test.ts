import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  characterKey,
  createInputScope,
  InputActionError,
  Keyboard,
  ProtocolError,
  requiresShift,
  TimeoutError,
  type KeyboardTypeOptions,
} from '../../src/index.ts';
import { ScriptedChrome, type RecordedCommand } from '../../src/testing/index.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function target() {
  const chrome = await ScriptedChrome.start();
  const browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
  chrome.handle('Input.dispatchKeyEvent', () => {});
  chrome.handle('Input.insertText', () => {});
  return {
    chrome,
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
function inserted(chrome: ScriptedChrome) {
  return (
    chrome.commands.filter(
      (c) => c.method === 'Input.insertText',
    ) as RecordedCommand<'Input.insertText'>[]
  ).map((c) => c.params.text);
}

test('segment callbacks await acknowledgement and readback before sending the next segment', async () => {
  await using t = await target();
  const keyboard = new Keyboard(t.session);
  const sent = deferred();
  const reply = deferred();
  const reading = deferred();
  const read = deferred();
  const segments = ['one', '', '中文', '👨‍👩‍👧‍👦'];
  const seen: Array<[string, number]> = [];
  t.chrome.replyOnce('Input.insertText', async () => {
    sent.resolve();
    await reply.promise;
  });
  const options: KeyboardTypeOptions = {
    onSegment: async (segment, index) => {
      seen.push([segment, index]);
      assert.equal(keyboard.behavior.current!.report.completedSegments, index + 1);
      assert.deepEqual(inserted(t.chrome), segments.slice(0, index + 1));
      if (index === 0) {
        reading.resolve();
        await read.promise;
      }
    },
  };
  const typing = keyboard.type(segments, options);
  await sent.promise;
  assert.deepEqual(seen, []);
  reply.resolve();
  await reading.promise;
  assert.deepEqual(inserted(t.chrome), ['one']);
  read.resolve();
  assert.equal((await typing).completedSegments, 4);
  assert.deepEqual(
    seen,
    segments.map((segment, index) => [segment, index]),
  );
});

test('string callbacks follow whole graphemes; array boundaries are captured at submission', async () => {
  await using t = await target();
  const keyboard = new Keyboard(t.session);
  const seen: string[] = [];
  const options: KeyboardTypeOptions = { onSegment: (segment) => void seen.push(segment) };
  await keyboard.type('Aé👨‍👩‍👧‍👦', options);
  assert.deepEqual(seen, ['A', 'é', '👨‍👩‍👧‍👦']);
  const segments = ['first', 'second'];
  await keyboard.type(segments, {
    onSegment: () => {
      segments[1] = 'changed';
      segments.push('extra');
    },
  });
  assert.deepEqual(inserted(t.chrome).slice(-2), ['first', 'second']);
  const before = seen.length;
  assert.equal((await keyboard.type('', options)).completedSegments, 0);
  assert.equal((await keyboard.type([], options)).completedSegments, 0);
  assert.equal(seen.length, before);
});

for (const mode of ['instant', 'human'] as const)
  for (const callbacks of [false, true])
    test(`${mode}: consecutive shifted segments share Shift, callbacks=${callbacks}`, async () => {
      await using t = await target();
      const keyboard = new Keyboard(t.session);
      keyboard.behavior.configure({ mode, typing: 'keys', pressDelay: [0, 0], keyDelay: [0, 0] });
      const holds: string[][] = [];
      const report = await keyboard.type(['A', 'B', '!', 'c', 'D', 'E', '中', 'F'], {
        onSegment: callbacks
          ? async () => {
              holds.push(keyboard.pressedKeys);
            }
          : undefined,
      });
      const keys = keyEvents(t.chrome);
      assert.deepEqual(
        keys.filter((e) => e.code === 'ShiftLeft').map((e) => e.type),
        ['rawKeyDown', 'keyUp', 'rawKeyDown', 'keyUp', 'rawKeyDown', 'keyUp'],
      );
      assert.deepEqual(
        keys.filter((e) => e.type === 'char').map((e) => [e.text, e.modifiers]),
        [
          ['A', 8],
          ['B', 8],
          ['!', 8],
          ['c', 0],
          ['D', 8],
          ['E', 8],
          ['F', 8],
        ],
      );
      assert.deepEqual(inserted(t.chrome), ['中']);
      if (callbacks) assert.deepEqual(holds, [['Shift'], ['Shift'], [], [], ['Shift'], [], [], []]);
      assert.deepEqual(keyboard.pressedKeys, []);
      assert.equal(report.completedSegments, 8);
      assert.equal(report.sent.keys, 10);
      assert.equal(report.sent.releases, 10);
      assert.equal(report.cleanup, 'completed');
    });

test('a caller-held right Shift survives segment callbacks and preserves lowercase text', async () => {
  await using t = await target();
  const keyboard = new Keyboard(t.session);
  keyboard.behavior.configure({ typing: 'keys' });
  await keyboard.down('ShiftRight');
  await keyboard.type('ABc中', {
    onSegment: () => assert.deepEqual(keyboard.pressedKeys, ['ShiftRight']),
  });
  assert.deepEqual(inserted(t.chrome), ['c', '中']);
  assert.deepEqual(keyboard.pressedKeys, ['ShiftRight']);
  assert.equal(keyEvents(t.chrome).filter((e) => e.key === 'Shift').length, 1);
  await keyboard.up('ShiftRight');
});

test('callbacks prevent rollover so each lowercase segment can be read in isolation', async () => {
  await using t = await target();
  const keyboard = new Keyboard(t.session);
  keyboard.behavior.configure({ mode: 'human', pressDelay: [0, 0], keyDelay: [0, 0] });
  keyboard.behavior.random = () => 0.1;
  const read: string[] = [];
  await keyboard.type('th', {
    onSegment: () => {
      assert.deepEqual(keyboard.pressedKeys, []);
      read.push(
        keyEvents(t.chrome)
          .filter((e) => e.type === 'char')
          .map((e) => e.text)
          .join(''),
      );
    },
  });
  assert.deepEqual(read, ['t', 'th']);
  assert.deepEqual(
    keyEvents(t.chrome).map((e) => `${e.type}:${e.key}`),
    ['rawKeyDown:t', 'char:t', 'keyUp:t', 'rawKeyDown:h', 'char:h', 'keyUp:h'],
  );
});

for (const asynchronous of [false, true])
  test(`a callback failure preserves completed segments and releases shared Shift, async=${asynchronous}`, async () => {
    await using t = await target();
    const keyboard = new Keyboard(t.session);
    keyboard.behavior.configure({ typing: 'keys' });
    const stop = new Error('readback failed');
    const error = await keyboard
      .type('AB', {
        onSegment: () => {
          if (asynchronous) return Promise.reject(stop);
          throw stop;
        },
      })
      .catch((e: unknown) => e);
    assert.ok(error instanceof InputActionError);
    assert.equal(error.cause, stop);
    assert.equal(error.report.completedSegments, 1);
    assert.equal((await error.cleanup).status, 'completed');
    assert.deepEqual(keyboard.pressedKeys, []);
    assert.deepEqual(
      keyEvents(t.chrome).map((e) => `${e.type}:${e.key}`),
      ['rawKeyDown:Shift', 'rawKeyDown:A', 'char:A', 'keyUp:A', 'keyUp:Shift'],
    );
  });

for (const stop of ['abort', 'timeout'] as const)
  test(`a pending scope segment callback is bounded by its child ${stop} and cannot resume typing`, async () => {
    await using t = await target();
    const scope = createInputScope(t.session, { pageEvents: false, policy: { typing: 'keys' } });
    const controller = new AbortController();
    const entered = deferred();
    const gate = deferred();
    let keyboard!: Keyboard;
    let callbacks = 0;
    const typing = scope.run(
      async (input) => {
        keyboard = input.keyboard;
        await keyboard.type('AB', {
          timeout: stop === 'timeout' ? 150 : 2000,
          signal: controller.signal,
          onSegment: async () => {
            callbacks++;
            entered.resolve();
            await gate.promise;
          },
        });
      },
      { timeout: 4000 },
    );
    const failure = typing.catch((e: unknown) => e);
    await entered.promise;
    assert.deepEqual(keyboard.pressedKeys, ['Shift']);
    const reason = new Error('stop readback');
    if (stop === 'abort') controller.abort(reason);
    const error = await failure;
    assert.ok(error instanceof InputActionError);
    if (stop === 'abort') assert.equal(error.cause, reason);
    else assert.match(String(error.cause), /timed out|deadline/i);
    assert.equal((await error.cleanup).status, 'completed');
    assert.equal(error.report.completedSegments, 1);
    assert.deepEqual(keyboard.pressedKeys, []);
    // Cleanup and the queue do not wait for user code that ignores cancellation.
    await scope.run(async (input) => {
      await input.keyboard.insertText('next');
    });
    gate.reject(new Error('late readback rejection'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(callbacks, 1);
    assert.deepEqual(
      keyEvents(t.chrome)
        .filter((e) => e.type === 'char')
        .map((e) => e.text),
      ['A'],
    );
  });

for (const failed of ['char', 'keyUp'] as const)
  test(`a failed ${failed} never calls the segment completion callback`, async () => {
    await using t = await target();
    const keyboard = new Keyboard(t.session);
    keyboard.behavior.configure({ typing: 'keys' });
    t.chrome.handle('Input.dispatchKeyEvent', (p) => {
      if (p.type === failed && p.code === 'KeyA')
        throw new ProtocolError('Input.dispatchKeyEvent', -32000, 'refused');
    });
    let calls = 0;
    const error = await keyboard
      .type('AB', {
        onSegment: () => {
          calls++;
        },
      })
      .catch((e: unknown) => e);
    assert.ok(error instanceof InputActionError);
    await error.cleanup;
    assert.equal(calls, 0);
    assert.deepEqual(keyboard.pressedKeys, []);
    assert.ok(!keyEvents(t.chrome).some((e) => e.code === 'KeyB'));
  });

test('scope callback indices belong to each type call even when the report already has text', async () => {
  await using t = await target();
  const indices: number[] = [];
  const report = await createInputScope(t.session, { pageEvents: false }).run(
    async ({ keyboard }) => {
      await keyboard.insertText('prefix');
      for (const text of ['ab', 'cd'])
        await keyboard.type(text, { onSegment: (_segment, index) => void indices.push(index) });
    },
  );
  assert.deepEqual(indices, [0, 1, 0, 1]);
  assert.equal(report.completedSegments, 5);
});

for (const asynchronous of [false, true])
  test(`onSegment returning false cleanly ends typing, releases owned Shift and skips trailing pause, async=${asynchronous}`, async () => {
    await using t = await target();
    const keyboard = new Keyboard(t.session);
    keyboard.behavior.configure({
      mode: 'human',
      typing: 'keys',
      pressDelay: [0, 0],
      keyDelay: [500, 500],
    });
    const seen: Array<[string, number, string[]]> = [];
    const started = performance.now();
    const report = await keyboard.type(['(', 'A', 'B'], {
      onSegment: (segment, index) => {
        seen.push([segment, index, keyboard.pressedKeys]);
        const decision = index === 0 ? false : true;
        return asynchronous ? Promise.resolve(decision) : decision;
      },
    });
    const elapsed = performance.now() - started;
    assert.equal(report.status, 'completed');
    assert.equal(report.cleanup, 'completed');
    assert.equal(report.completedSegments, 1);
    assert.equal(report.plannedMs, 0);
    assert.ok(elapsed < 400, `trailing keyDelay was not skipped (${elapsed}ms)`);
    assert.deepEqual(seen, [['(', 0, ['Shift']]]);
    assert.deepEqual(keyboard.pressedKeys, []);
    assert.deepEqual(
      keyEvents(t.chrome).map((e) => `${e.type}:${e.key}`),
      ['rawKeyDown:Shift', 'rawKeyDown:(', 'char:(', 'keyUp:(', 'keyUp:Shift'],
    );
  });

test('onSegment returning false preserves caller-held Shift and works inside an InputScope', async () => {
  await using t = await target();
  const scope = createInputScope(t.session, { pageEvents: false, policy: { typing: 'keys' } });
  const report = await scope.run(async ({ keyboard }) => {
    await keyboard.down('ShiftRight');
    const typed = await keyboard.type('ABC', {
      onSegment: (_seg, index) => (index === 1 ? false : true),
    });
    assert.equal(typed.status, 'completed');
    assert.deepEqual(keyboard.pressedKeys, ['ShiftRight']);
  });
  assert.equal(report.status, 'completed');
  assert.equal(report.completedSegments, 2);
  assert.deepEqual(
    keyEvents(t.chrome)
      .filter((e) => e.type === 'char')
      .map((e) => e.text),
    ['A', 'B'],
  );
});

test('commandTimeout separates per-command stalls from multi-segment typing and onSegment readback', async () => {
  await using t = await target();
  const keyboard = new Keyboard(t.session);
  keyboard.behavior.configure({
    mode: 'human',
    typing: 'keys',
    pressDelay: [0, 0],
    keyDelay: [30, 30],
    presentationRecovery: false,
  });
  // Total typing + onSegment readback takes > 180ms while each CDP command is fast -> succeeds with commandTimeout: 100.
  const ok = await keyboard.type('abc', {
    timeout: 5000,
    commandTimeout: 100,
    onSegment: async () => {
      await new Promise((resolve) => setTimeout(resolve, 45));
    },
  });
  assert.equal(ok.status, 'completed');
  assert.equal(ok.completedSegments, 3);
  // A single stalled dispatchKeyEvent fails at commandTimeout (60ms) well before total timeout (5000ms).
  t.chrome.replyOnce('Input.dispatchKeyEvent', async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  const started = performance.now();
  const error = await keyboard
    .type('ab', { timeout: 5000, commandTimeout: 60 })
    .catch((e: unknown) => e);
  const elapsed = performance.now() - started;
  assert.ok(error instanceof InputActionError);
  assert.ok(error.cause instanceof TimeoutError);
  assert.ok(elapsed < 1000, `commandTimeout took ${elapsed}ms`);
  assert.equal((await error.cleanup).status, 'completed');
});

test('characterKey and requiresShift match physical-key typing as a single source of truth', () => {
  assert.equal(requiresShift('A'), true);
  assert.equal(requiresShift('('), true);
  assert.equal(requiresShift('!'), true);
  assert.equal(requiresShift('a'), false);
  assert.equal(requiresShift('9'), false);
  assert.equal(requiresShift(' '), false);
  assert.equal(requiresShift('\n'), false);
  assert.equal(requiresShift('\t'), false);
  assert.equal(requiresShift('中'), false);
  assert.equal(requiresShift('AB'), false);
  assert.equal(requiresShift(''), false);

  const paren = characterKey('(');
  assert.ok(paren);
  assert.equal(paren.shift, true);
  assert.equal(paren.definition.code, 'Digit9');
  assert.equal(paren.definition.shiftKey, '(');
  assert.ok(Object.isFrozen(paren));
  assert.ok(Object.isFrozen(paren.definition));

  const space = characterKey(' ');
  assert.ok(space);
  assert.equal(space.shift, false);
  assert.equal(space.definition.code, 'Space');

  assert.equal(characterKey('中'), undefined);
  assert.equal(characterKey('\n'), undefined);
  assert.equal(characterKey('AB'), undefined);
});

test('callback keyDelay runs through action.pace and counts in InputReport.plannedMs', async () => {
  await using t = await target();
  const calls: Array<[string, string, number]> = [];
  const scope = createInputScope(t.session, {
    pageEvents: false,
    policy: {
      mode: 'human',
      typing: 'keys',
      pressDelay: [0, 0],
      keyDelay: (prev, next, index) => {
        calls.push([prev, next, index]);
        return next === '' ? 0 : prev === ' ' ? 40 : 15;
      },
    },
  });
  const report = await scope.run(async ({ keyboard }) => {
    await keyboard.type('a b');
  });
  assert.deepEqual(calls, [
    ['a', ' ', 0],
    [' ', 'b', 1],
  ]);
  assert.equal(report.plannedMs, 55);
  // Per-call override via KeyboardTypeOptions.keyDelay
  const overrideCalls: Array<[string, string, number]> = [];
  const overridden = await scope.run(async ({ keyboard }) => {
    await keyboard.type('xy', {
      keyDelay: (prev, next, index) => {
        overrideCalls.push([prev, next, index]);
        return 25;
      },
    });
  });
  assert.deepEqual(overrideCalls, [['x', 'y', 0]]);
  assert.equal(overridden.plannedMs, 25);
  // Invalid callback return value fails cleanly as InputActionError.
  const bad = await scope
    .run(async ({ keyboard }) => {
      await keyboard.type('ab', { keyDelay: () => -5 });
    })
    .catch((e: unknown) => e);
  assert.ok(bad instanceof InputActionError);
  assert.ok(bad.cause instanceof RangeError);
  assert.equal((await bad.cleanup).status, 'completed');
});

test('normal keyUp respects commandTimeout while cleanup drains its late reply without blocking', async () => {
  await using t = await target();
  const keyboard = new Keyboard(t.session);
  keyboard.behavior.configure({
    typing: 'keys',
    presentationRecovery: false,
  });
  let keyUpReply!: () => void;
  const keyUpHeld = new Promise<void>((resolve) => {
    keyUpReply = resolve;
  });
  t.chrome.handle('Input.dispatchKeyEvent', async (params) => {
    if (params.type === 'keyUp') await keyUpHeld;
  });
  const started = performance.now();
  const pending = keyboard
    .type('x', { commandTimeout: 40, timeout: 5000, cleanupTimeout: 1000 })
    .catch((e: unknown) => e);
  const error = await pending;
  const elapsed = performance.now() - started;
  assert.ok(error instanceof InputActionError);
  assert.ok(error.cause instanceof TimeoutError);
  assert.ok(elapsed < 400, `normal keyUp bypassed commandTimeout (${elapsed}ms)`);
  assert.equal(error.report.cleanup, 'pending');
  // Late reply arrives within cleanupTimeout -> cleanup succeeds and connection stays unblocked.
  keyUpReply();
  const cleanup = await error.cleanup;
  assert.equal(cleanup.status, 'completed');
  assert.equal(cleanup.report.lateReplies, 1);
  t.chrome.handle('Input.dispatchKeyEvent', () => {});
  const next = await keyboard.type('y');
  assert.equal(next.status, 'completed');
});

test('beforeSend rejecting rawKeyDown or mousePressed never sends an orphan release', async () => {
  await using chrome = await ScriptedChrome.start();
  const denied = new Error('blocked before wire');
  let block = true;
  await using browser = await chrome.connect({
    attach: 'none',
    beforeSend(method, params) {
      if (!block) return;
      const type = (params as { type?: string } | undefined)?.type;
      if (
        (method === 'Input.dispatchKeyEvent' && type === 'rawKeyDown') ||
        (method === 'Input.dispatchMouseEvent' && type === 'mousePressed')
      )
        throw denied;
    },
  });
  chrome.handle('Input.dispatchKeyEvent', () => {});
  chrome.handle('Input.dispatchMouseEvent', () => {});
  const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
  const keyboard = new Keyboard(session);
  keyboard.behavior.configure({ typing: 'keys' });
  const keyErr = await keyboard.type('a').catch((e: unknown) => e);
  assert.ok(keyErr instanceof InputActionError);
  assert.equal(keyErr.cause, denied);
  assert.equal((await keyErr.cleanup).status, 'completed');
  assert.deepEqual(keyboard.pressedKeys, []);
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.dispatchKeyEvent').length, 0);
  const scope = createInputScope(session, { pageEvents: false });
  const mouseErr = await scope
    .run(async ({ mouse }) => {
      await mouse.down('left');
    })
    .catch((e: unknown) => e);
  assert.ok(mouseErr instanceof InputActionError);
  assert.equal(mouseErr.cause, denied);
  assert.equal((await mouseErr.cleanup).status, 'completed');
  assert.equal(chrome.commands.filter((c) => c.method === 'Input.dispatchMouseEvent').length, 0);
  // Connection and coordinator holds stay completely clean.
  block = false;
  assert.equal((await keyboard.type('a')).status, 'completed');
});

test('callback keyDelay disables digraph rollover so every pair uses the callback', async () => {
  await using t = await target();
  const calls: Array<[string, string, number]> = [];
  const keyboard = new Keyboard(t.session);
  keyboard.behavior.configure({
    mode: 'human',
    typing: 'keys',
    pressDelay: [0, 0],
    keyDelay: (prev, next, index) => {
      calls.push([prev, next, index]);
      return next === '' ? 0 : 12;
    },
  });
  // Force random < 0.15 which would normally trigger rollover on "th".
  keyboard.behavior.random = () => 0.05;
  const report = await keyboard.type('th');
  assert.deepEqual(calls, [['t', 'h', 0]]);
  assert.equal(report.plannedMs, 12);
  assert.deepEqual(
    keyEvents(t.chrome).map((e) => `${e.type}:${e.key}`),
    ['rawKeyDown:t', 'char:t', 'keyUp:t', 'rawKeyDown:h', 'char:h', 'keyUp:h'],
  );
});

test('onSegment context.pace runs inter-key pause before pre-next-key guard, deducts readback time, and releases Shift on early stop or throw', async () => {
  await using t = await target();
  const order: string[] = [];
  const delayCalls: Array<[string, string, number]> = [];
  const scope = createInputScope(t.session, {
    pageEvents: false,
    policy: {
      mode: 'human',
      typing: 'keys',
      pressDelay: [0, 0],
      keyDelay: (prev, next, i) => {
        delayCalls.push([prev, next, i]);
        return 45;
      },
    },
  });

  // 1. Full completion: readback -> ctx.pace() (second no-arg call is no-op; last segment is 0ms) -> guard -> next key
  const full = await scope.run(async ({ keyboard }) => {
    await keyboard.type('ab', {
      async onSegment(segment, index, ctx) {
        order.push(`read:${segment}:${String(ctx.next)}`);
        await new Promise((r) => setTimeout(r, 15)); // Readback time deducted by action.pace()
        await ctx.pace();
        await ctx.pace(); // Idempotent second no-arg call
        order.push(`guard-after-pause:${index}`);
      },
    });
  });
  assert.equal(full.status, 'completed');
  // Only index 0 had ctx.next !== undefined, so keyDelay ran once (45ms), NOT after last segment!
  assert.deepEqual(delayCalls, [['a', 'b', 0]]);
  assert.equal(full.plannedMs, 45);
  assert.deepEqual(order, [
    'read:a:b',
    'guard-after-pause:0',
    'read:b:undefined',
    'guard-after-pause:1',
  ]);

  // 2. Clean early stop (return false) AFTER ctx.pace() on consecutive shifted pair "AB" releases Shift cleanly
  let keyboardRef!: Keyboard;
  const earlyStop = await scope.run(async ({ keyboard }) => {
    keyboardRef = keyboard;
    await keyboard.type('AB', {
      keyDelay: () => 20,
      async onSegment(_seg, index, ctx) {
        assert.deepEqual(keyboard.pressedKeys, ['Shift']);
        if (ctx.next !== undefined) {
          await ctx.pace();
          // Simulate editor change detected during pause -> clean stop before 'B'!
          if (index === 0) return false;
        }
      },
    });
  });
  assert.equal(earlyStop.status, 'completed');
  assert.equal(earlyStop.completedSegments, 1);
  assert.equal(earlyStop.plannedMs, 20);
  assert.deepEqual(keyboardRef.pressedKeys, []);

  // 3. Guard throwing AFTER ctx.pace() interrupts before next segment's Shift/keyDown and releases held Shift
  const beforeSub3 = keyEvents(t.chrome).length;
  const guardBoom = new Error('focus lost during pause');
  const interrupted = await scope
    .run(async ({ keyboard }) => {
      await keyboard.type('aB', {
        keyDelay: () => 20,
        async onSegment(_seg, _index, ctx) {
          if (ctx.next !== undefined) {
            await ctx.pace();
            throw guardBoom;
          }
        },
      });
    })
    .catch((e: unknown) => e);
  assert.ok(interrupted instanceof InputActionError);
  assert.equal(interrupted.cause, guardBoom);
  assert.equal((await interrupted.cleanup).status, 'completed');
  assert.deepEqual(keyboardRef.pressedKeys, []);
  // Only 'a' was dispatched in sub-case 3; neither Shift nor 'B' was ever pressed!
  const sub3Events = keyEvents(t.chrome).slice(beforeSub3);
  assert.equal(
    sub3Events.some((e) => e.code === 'KeyB' || e.key === 'Shift'),
    false,
  );

  // 4. Invalid explicit pace(ms) rejects with RangeError
  for (const badMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const err = await scope
      .run(async ({ keyboard }) => {
        await keyboard.type('a', {
          async onSegment(_s, _i, ctx) {
            await ctx.pace(badMs);
          },
        });
      })
      .catch((e: unknown) => e);
    assert.ok(err instanceof InputActionError);
    assert.ok(err.cause instanceof RangeError);
    await err.cleanup;
  }
});
