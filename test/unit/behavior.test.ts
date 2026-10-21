import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { InputBehavior, InputCoordinator, InputActionError } from '../../src/input/behavior.ts';
import { Mouse, Keyboard } from '../../src/input/input.ts';
import type { Session } from '../../src/protocol/connection.ts';

test('input seed is generated once per behavior and configure preserves its stream unless explicit', async () => {
  let draws = 0;
  const create = () =>
    new InputBehavior(
      (task) => task(),
      () => {},
      undefined,
      undefined,
      () => {
        draws++;
        return 123;
      },
    );
  const first = create(),
    other = create();
  expect(draws).toBe(2); // A deterministic generator seam, no probabilistic uniqueness assertion.
  expect(first.policy.seed).toBe(123);
  first.configure({ mode: 'human' });
  const initial = first.random();
  const state = first.randomState;
  first.configure({ mode: 'human', pause: [0, 0] });
  expect(first.randomState).toBe(state);
  expect(first.random()).not.toBe(initial);
  expect(other.random()).toBe(initial);
  first.configure({ mode: 'instant' });
  const continued = first.randomState;
  first.configure({ mode: 'human' });
  expect(first.randomState).toBe(continued);
  first.configure({ mode: 'human', seed: 123 });
  expect(first.random()).toBe(initial);
  const before = first.randomState;
  const report = await first.action('probe', {}, async () => {
    first.random();
  });
  expect(report.seed).toBe(123);
  expect(report.randomState).toBe(before);
  const replay = create();
  replay.configure({ seed: report.randomState });
  replay.random();
  expect(replay.randomState).toBe(first.randomState);
  expect(draws).toBe(3);
  const native = new InputBehavior(
    (task) => task(),
    () => {},
  );
  expect(Number.isInteger(native.policy.seed)).toBe(true);
  expect(native.policy.seed).toBeGreaterThanOrEqual(0);
  expect(native.policy.seed).toBeLessThanOrEqual(0xffff_ffff);
  const coordinator = new InputCoordinator();
  const queued = new InputBehavior(
    (task) => coordinator.run(task),
    () => {},
    undefined,
    undefined,
    () => 9,
  );
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const firstAction = queued.action('first', {}, async () => {
    started();
    await gate;
    queued.random();
  });
  await active;
  expect(() => queued.configure({ seed: 1 })).toThrow('during an action');
  const nextAction = queued.action('queued', {}, async () => {});
  release();
  await firstAction;
  const nextReport = await nextAction;
  expect(nextReport.randomState).toBe(queued.randomState);
  expect(nextReport.randomState).not.toBe(9); // State is captured on lock acquisition, not submission.
});
test('input policy validates ranges and a browser coordinator serializes tasks with reentrant calls', async () => {
  const queue = new InputCoordinator(),
    behavior = new InputBehavior(
      (task) => queue.run(task),
      () => {},
    );
  expect(() => behavior.configure({ keyDelay: [20, 10] })).toThrow();
  expect(() => behavior.configure({ moveSteps: [0, 4] })).toThrow();
  expect(() => behavior.configure({ targetInset: 0.6 })).toThrow();
  const events: string[] = [];
  await Promise.all([
    queue.run(async () => {
      events.push('a');
      await queue.run(async () => {
        events.push('nested');
      });
      await sleep(10);
      events.push('b');
    }),
    queue.run(async () => {
      events.push('c');
    }),
  ]);
  expect(events).toEqual(['a', 'nested', 'b', 'c']);
});
test('seeded paths and scroll conserve coordinates and deltas; timeout prevents input', async () => {
  const messages: any[] = [];
  const session = {
    closed: false,
    send: async (method: string, params: any) => {
      messages.push({ method, ...params });
      return {};
    },
  } as unknown as Session;
  const behavior = new InputBehavior(
      (t) => t(),
      () => {},
    ),
    mouse = new Mouse(session, behavior);
  behavior.configure({
    mode: 'human',
    seed: 12,
    moveSteps: [4, 4],
    moveDuration: [0, 0],
    pause: [0, 0],
    scrollSteps: [3, 3],
  });
  await mouse.move(120, 60);
  expect(mouse.position).toEqual({ x: 120, y: 60, buttons: 0 });
  expect(messages.filter((m) => m.type === 'mouseMoved')).toHaveLength(4);
  await mouse.wheel(7, 101);
  expect(
    messages.filter((m) => m.type === 'mouseWheel').reduce((a, m) => a + m.deltaY, 0),
  ).toBeCloseTo(101);
  const count = messages.length;
  await expect(mouse.click(1, 2, { timeout: 0 })).rejects.toBeInstanceOf(InputActionError);
  expect(messages).toHaveLength(count);
});
test('button and modifier release are attempted even when a press protocol response fails', async () => {
  const events: any[] = [];
  const session = {
    closed: false,
    send: async (method: string, params: any) => {
      events.push({ method, ...params });
      if (['mousePressed', 'keyDown', 'rawKeyDown'].includes(params.type))
        throw new Error('Response failed after dispatch');
      return {};
    },
  } as unknown as Session;
  const mouse = new Mouse(session),
    keyboard = new Keyboard(session);
  await expect(mouse.click(1, 2)).rejects.toBeInstanceOf(InputActionError);
  expect(mouse.position.buttons).toBe(0);
  expect(events.some((e) => e.type === 'mouseReleased')).toBe(true);
  await expect(keyboard.press('Control+A')).rejects.toBeInstanceOf(InputActionError);
  expect(keyboard.pressedKeys).toEqual([]);
  expect(events.some((e) => e.type === 'keyUp')).toBe(true);
});
