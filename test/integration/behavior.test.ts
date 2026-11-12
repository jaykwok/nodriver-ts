import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { Browser, InputActionError } from '../../src/index.ts';
import { fixtureServer } from '../fixtures/server.ts';
import { recordWire, forbiddenAutomaticCommands } from '../fixtures/wire.ts';
import { poll } from '../../src/utils.ts';

const selectAll = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
const policy = {
  mode: 'human' as const,
  seed: 42,
  moveDuration: [35, 35] as [number, number],
  moveSteps: [5, 5] as [number, number],
  pause: [0, 0] as [number, number],
  pressDelay: [15, 15] as [number, number],
  keyDelay: [10, 10] as [number, number],
  scrollSteps: [4, 4] as [number, number],
};

test('typing callbacks read each segment from the page while consecutive capitals share Shift', async (t) => {
  const fixture = await fixtureServer();
  t.after(() => fixture.server.stop());
  await using browser = await Browser.launch({ headless: true });
  const tab = await browser.newTab(fixture.base + '/input-events');
  const field = await tab.waitForSelector('#plain');
  const typingPolicy = {
    ...policy,
    pressDelay: [0, 0] as [number, number],
    keyDelay: [0, 0] as [number, number],
  };
  tab.setInputPolicy(typingPolicy);
  const session = await browser.attachSession(tab.id);
  const scope = browser.inputScope(session, { policy: typingPolicy, pointer: tab.mouse.position });
  const segments = ['t', 'h', 'A', 'A', 'B', '!', 'c', '中文', '👨‍👩‍👧‍👦'];
  for (const entry of ['element', 'locator', 'keyboard', 'scope'] as const) {
    await field.fill(entry === 'element' || entry === 'locator' ? 'old' : '');
    await tab.evaluate('window.__clear()');
    const seen: string[] = [];
    const options = {
      replace: true,
      onSegment: async (segment: string, index: number) => {
        expect(segment).toBe(segments[index]);
        const value = await field.evaluate((el) => (el as HTMLInputElement).value);
        expect(value).toBe(segments.slice(0, index + 1).join(''));
        seen.push(value);
      },
    };
    const report =
      entry === 'element'
        ? await field.type(segments, options)
        : entry === 'locator'
          ? await tab.locator('#plain').type(segments, options)
          : entry === 'keyboard'
            ? await tab.keyboard.type(segments, options)
            : await scope.run(async ({ keyboard, mouse }) => {
                await mouse.move(120, 80);
                await keyboard.type(segments, options);
              });
    expect(report.completedSegments).toBe(segments.length);
    expect(seen).toHaveLength(segments.length);
    expect(
      (await tab.evaluate<any[]>('window.__events'))
        .filter((e) => e.key === 'Shift')
        .map((e) => e.type),
    ).toEqual(['keydown', 'keyup']);
    if (entry === 'scope') expect(scope.position).toEqual({ x: 120, y: 80 });
  }
  await field.fill('');
  const stopped = await field
    .type('AB', {
      onSegment: async () => {
        await (await tab.waitForSelector('#target')).focus();
      },
    })
    .catch((e: unknown) => e);
  expect(stopped).toBeInstanceOf(InputActionError);
  const error = stopped as InputActionError;
  expect(error.report.completedSegments).toBe(1);
  expect((await error.cleanup).status).toBe('completed');
  expect(await field.evaluate((el) => (el as HTMLInputElement).value)).toBe('A');
  expect(tab.keyboard.pressedKeys).toEqual([]);
});

for (const transport of ['pipe', 'websocket'] as const) {
  test(`${transport}: seeded input events, graphemes, selection, chords, four frames and scroll`, async (t) => {
    // Cleanup is registered as each resource opens, so a failed launch still stops the server.
    const fixture = await fixtureServer();
    t.after(() => fixture.server.stop());
    const audit = recordWire(transport);
    t.after(() => audit.restore());
    const browser = await Browser.launch({
      transport,
      headless: process.env.NODRIVER_HEADFUL !== '1',
      args: ['--site-per-process'],
    });
    try {
      const tab = await browser.newTab(fixture.base + '/input-events');
      tab.setInputPolicy(policy);
      const input = await tab.waitForSelector('#plain');
      await input.fill('old value');
      await input.evaluate((el) => (el as HTMLInputElement).setSelectionRange(0, 3));
      const typed = await input.type('新👨‍👩‍👧‍👦é');
      expect(typed.completedSegments).toBe(3);
      expect(await input.evaluate((el) => (el as HTMLInputElement).value)).toBe('新👨‍👩‍👧‍👦é value');
      await tab.keyboard.press(selectAll);
      await input.type(['中文', '😀']);
      expect(await input.evaluate((el) => (el as HTMLInputElement).value)).toBe('中文😀');
      expect(tab.keyboard.pressedKeys).toEqual([]);
      const button = await tab.waitForSelector('#target');
      await tab.mouse.move(0, 0);
      tab.setInputPolicy(policy);
      await button.click();
      const first = tab.inputBehavior.lastReport!;
      // Recovery depends on response latency; the seed controls input events and planned delays.
      const firstTrace = first.trace.filter((event) => event.type !== 'presentationRecovery');
      await tab.mouse.move(0, 0);
      tab.setInputPolicy(policy);
      await button.click();
      expect(
        tab.inputBehavior.lastReport!.trace.filter(
          (event) => event.type !== 'presentationRecovery',
        ),
      ).toEqual(firstTrace);
      const events = await tab.evaluate<any[]>('window.__events');
      expect(
        events.some(
          (e) =>
            e.type === 'keydown' &&
            e.key?.toLowerCase() === 'a' &&
            (process.platform === 'darwin' ? e.meta : e.ctrl),
        ),
      ).toBe(true);
      expect(events.filter((e) => e.type === 'click' && e.id === 'target')).toHaveLength(2);
      expect(
        events.filter((e) => e.type === 'mousedown' && e.id === 'target').every((e) => e.trusted),
      ).toBe(true);
      const types = firstTrace.map((e) => e.type);
      const press = types.indexOf('down');
      expect(types.slice(0, press).filter((type) => type === 'move')).toHaveLength(5);
      // The seeded stream decides whether the hold carries one 1 px slip.
      expect([
        ['down', 'pause', 'pause', 'up'],
        ['down', 'pause', 'move', 'pause', 'up'],
      ]).toContainEqual(types.slice(press));
      for (const frame of tab.frames) {
        const closed = await frame.waitForSelector('#closed-input');
        await closed.fill('');
        await closed.type('四层😀');
        expect(await closed.evaluate((el) => (el as HTMLInputElement).value)).toBe('四层😀');
        const before = await frame.evaluate<number>(
          'window.__events.filter(e=>e.type==="click"&&e.id==="target").length',
        );
        await (await frame.waitForSelector('#target')).click();
        expect(
          await frame.evaluate(
            'window.__events.filter(e=>e.type==="click"&&e.id==="target").length',
          ),
        ).toBe(before + 1);
      }
      const main = await tab.waitForSelector('#target');
      await main.click();
      await tab.mouse.wheel(0, 420);
      await poll(async () => (((await tab.evaluate('scrollY')) as number) > 0 ? true : undefined), {
        timeout: 2000,
      });
      expect(tab.inputBehavior.lastReport!.trace.filter((e) => e.type === 'wheel')).toHaveLength(4);
      expect(audit.messages.filter((m) => forbiddenAutomaticCommands.includes(m.method))).toEqual(
        [],
      );
    } finally {
      await browser.close();
    }
  });
  test(`${transport}: changed hit target, cancellation, partial text and navigation never replay input`, async (t) => {
    const fixture = await fixtureServer();
    t.after(() => fixture.server.stop());
    const browser = await Browser.launch({ transport, headless: true });
    try {
      const tab = await browser.newTab(fixture.base + '/input-events');
      tab.setInputPolicy({ ...policy, pressDelay: [600, 600] });
      const button = await tab.waitForSelector('#target'),
        abort = new AbortController();
      const click = button.click({ signal: abort.signal }).catch((e) => e);
      await poll(
        async () =>
          (await tab.evaluate<boolean>('window.__events.some(e=>e.type==="mousedown")'))
            ? true
            : undefined,
        { timeout: 2000 },
      );
      abort.abort();
      const error = await click;
      expect(error).toBeInstanceOf(InputActionError);
      expect((await error.cleanup).report.trace.some((e: any) => e.type === 'up')).toBe(true);
      expect(tab.mouse.position.buttons).toBe(0);
      const input = await tab.waitForSelector('#plain');
      tab.setInputPolicy({ ...policy, keyDelay: [300, 300] });
      const stop = new AbortController(),
        typing = input.type('甲😀乙', { signal: stop.signal }).catch((e) => e);
      await poll(
        async () =>
          (await input.evaluate((el) => (el as HTMLInputElement).value.length)) > 0
            ? true
            : undefined,
        { timeout: 2000 },
      );
      stop.abort();
      const partial = await typing;
      expect(partial).toBeInstanceOf(InputActionError);
      expect(partial.report.completedSegments).toBe(1);
      await partial.cleanup;
      expect(await input.evaluate((el) => (el as HTMLInputElement).value)).toBe('甲');
      tab.setInputPolicy({ ...policy, pressDelay: [300, 300] });
      const keyAbort = new AbortController();
      const pressing = tab.keyboard.press('Control+A', { signal: keyAbort.signal }).catch((e) => e);
      await poll(async () => (tab.keyboard.pressedKeys.length ? true : undefined), {
        timeout: 1000,
      });
      keyAbort.abort();
      const keyError = await pressing;
      expect(keyError).toBeInstanceOf(InputActionError);
      await keyError.cleanup;
      expect(tab.keyboard.pressedKeys).toEqual([]);
      tab.setInputPolicy({ ...policy, moveDuration: [150, 150] });
      await tab.evaluate('window.__shiftOnMove=true');
      await expect(
        (await tab.waitForSelector('#moving')).click({ timeout: 2000 }),
      ).rejects.toThrow();
      expect(
        await tab.evaluate('window.__events.filter(e=>e.type==="click"&&e.id==="moving").length'),
      ).toBe(0);
      tab.setInputPolicy({ ...policy, keyDelay: [400, 400] });
      await input.fill('');
      const pending = input.type('导航中断', { timeout: 3000 }).catch((e) => e);
      await poll(
        async () =>
          (await input.evaluate((el) => (el as HTMLInputElement).value.length)) > 0
            ? true
            : undefined,
        { timeout: 2000 },
      );
      await tab.goto(fixture.base + '/input-events?new=1');
      expect(await pending).toBeInstanceOf(InputActionError);
      expect(await tab.evaluate('document.querySelector("#plain").value')).toBe('');
    } finally {
      await browser.close();
    }
  });
}
test('key locations, keydown suppressing its character, and guards that stop after a press', async (t) => {
  const fixture = await fixtureServer();
  t.after(() => fixture.server.stop());
  const browser = await Browser.launch({ headless: true });
  try {
    const tab = await browser.newTab(fixture.base + '/input-events');
    const input = await tab.waitForSelector('#plain');
    const value = () => input.evaluate((el) => (el as HTMLInputElement).value);
    const keys = async () =>
      (await tab.evaluate<any[]>('window.__events'))
        .filter((e) => ['keydown', 'keypress', 'keyup'].includes(e.type))
        .map((e) => `${e.type}:${e.code}:${e.location}`);
    await input.focus();
    await tab.evaluate('window.__clear()');
    for (const key of ['ControlRight', 'ShiftLeft', 'Numpad1', 'a']) await tab.keyboard.press(key);
    expect(await keys()).toEqual([
      'keydown:ControlRight:2',
      'keyup:ControlRight:2',
      'keydown:ShiftLeft:1',
      'keyup:ShiftLeft:1',
      'keydown:Numpad1:3',
      'keypress:Numpad1:3',
      'keyup:Numpad1:3',
      'keydown:KeyA:0',
      'keypress:KeyA:0',
      'keyup:KeyA:0',
    ]);
    expect(await value()).toBe('1a');
    // A keydown handler that prevents the default suppresses the character, as with a physical key.
    await tab.evaluate(
      "document.querySelector('#plain').addEventListener('keydown',e=>e.preventDefault(),{once:true})",
    );
    await tab.keyboard.press('b');
    expect(await value()).toBe('1a');

    await tab.evaluate('window.__clear()');
    const keyError = await tab.keyboard
      .press('c', {
        guard: (checkpoint) => {
          if (checkpoint.type === 'char') throw new Error('stop before the character');
        },
      })
      .catch((e) => e);
    expect(keyError).toBeInstanceOf(InputActionError);
    expect((await keyError.cleanup).status).toBe('completed');
    expect(await keys()).toEqual(['keydown:KeyC:0', 'keyup:KeyC:0']);
    expect(await value()).toBe('1a');
    expect(tab.keyboard.pressedKeys).toEqual([]);

    const point = await (await tab.waitForSelector('#target')).clickablePoint();
    await tab.evaluate('window.__clear()');
    const pressError = await tab.mouse
      .click(point.x, point.y, {
        guard: (checkpoint) => {
          if (checkpoint.type === 'mousePressed') throw new Error('stop after the press');
        },
      })
      .catch((e) => e);
    expect(pressError).toBeInstanceOf(InputActionError);
    expect((await pressError.cleanup).status).toBe('completed');
    const buttons = (await tab.evaluate<any[]>('window.__events'))
      .filter((e) => e.type === 'mousedown' || e.type === 'mouseup')
      .map((e) => `${e.type}:${e.id}`);
    expect(buttons).toEqual(['mousedown:target', 'mouseup:target']);
    expect(tab.mouse.position.buttons).toBe(0);
  } finally {
    await browser.close();
  }
});

test('a scope carries the pointer between runs and wheels whole notches', async (t) => {
  const fixture = await fixtureServer();
  t.after(() => fixture.server.stop());
  const browser = await Browser.launch({ headless: true });
  try {
    const tab = await browser.newTab(fixture.base + '/input-events');
    const session = await browser.attachSession(tab.id);
    const scope = browser.inputScope(session, {
      pointer: { x: 20, y: 20 },
      policy: { ...policy, wheelProfile: 'wheel', wheelNotch: 100, scrollSteps: undefined },
    });
    await scope.run(async (input) => {
      // The body margin: frames never come under this point, also once the page scrolls.
      await input.mouse.move(5, 5);
    });
    await tab.evaluate('window.__clear()');
    const report = await scope.run(async (input) => {
      await input.mouse.wheel(0, 250);
    });
    expect(report.sent).toMatchObject({ moves: 0, wheels: 3 });
    // Chrome answers a wheel event before the page handles it, and can merge events the page has
    // not handled yet; the page sees the three notches in whole notches.
    const events = await poll(
      async () => {
        const events = await tab.evaluate<any[]>('window.__events');
        const total = events.filter((e) => e.type === 'wheel').reduce((sum, e) => sum + e.dy, 0);
        return total >= 300 ? events : undefined;
      },
      { timeout: 5000 },
      'three wheel notches',
    );
    const wheels = events.filter((e) => e.type === 'wheel');
    expect(wheels.every((e) => e.x === 5 && e.y === 5 && e.dy > 0 && e.dy % 100 === 0)).toBe(true);
    expect(wheels.reduce((sum, e) => sum + e.dy, 0)).toBe(300);
    // The second run sent no move to put the pointer back. Chrome may move the hover after the
    // page scrolls, so only events before the first wheel event count.
    const before = events.slice(0, events.indexOf(wheels[0]));
    expect(before.filter((e) => e.type === 'mousemove')).toHaveLength(0);
  } finally {
    await browser.close();
  }
});

test(
  'CI Windows: minimized-window input recovers without replay or activation',
  {
    skip: process.platform !== 'win32' || !process.env.CI,
  },
  async (t) => {
    const fixture = await fixtureServer();
    t.after(() => fixture.server.stop());
    const browser = await Browser.launch({ headless: false });
    let windowId: number | undefined;
    try {
      const tab = await browser.newTab(fixture.base + '/input-events');
      const field = await tab.waitForSelector('#plain');
      await field.focus();
      const window = await browser.cdp.send('Browser.getWindowForTarget', { targetId: tab.id });
      windowId = window.windowId;
      const session = await browser.attachSession(tab.id);
      const scope = browser.inputScope(session, {
        pointer: { x: 20, y: 20 },
        policy: { presentationRecovery: 100 },
      });
      await browser.cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      });
      await poll(
        async () => {
          const { bounds } = await browser.cdp.send('Browser.getWindowBounds', {
            windowId: windowId!,
          });
          return bounds.windowState === 'minimized' || undefined;
        },
        { timeout: 5000 },
      );
      const report = await scope.run(
        async ({ mouse, keyboard }) => {
          await mouse.move(30, 30);
          await keyboard.press('a');
        },
        { timeout: 15000 },
      );
      expect(report.sent).toMatchObject({ moves: 1, keys: 1, characters: 1, releases: 1 });
      expect(report.presentationRecoveries).toBeGreaterThan(0);
      expect(await field.evaluate((el) => (el as HTMLInputElement).value)).toBe('a');
      expect(
        (await browser.cdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState,
      ).toBe('minimized');
      t.diagnostic(`Recovered ${report.presentationRecoveries} input requests while minimized`);
    } finally {
      if (windowId !== undefined)
        await browser.cdp
          .sendWith(
            'Browser.setWindowBounds',
            { timeout: 5000 },
            {
              windowId,
              bounds: { windowState: 'normal' },
            },
          )
          .catch(() => {});
      await browser.close();
    }
  },
);
