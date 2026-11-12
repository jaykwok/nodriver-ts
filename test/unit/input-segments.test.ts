import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createInputScope,
  InputActionError,
  Keyboard,
  ProtocolError,
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
