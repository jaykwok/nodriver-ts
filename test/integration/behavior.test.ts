import { expect, test } from 'bun:test';
import { Browser, InputActionError } from '../../src/index.js';
import { fixtureServer } from '../fixtures/server.js';
import { recordWire, forbiddenAutomaticCommands } from '../fixtures/wire.js';
import { poll } from '../../src/utils.js';

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
for (const transport of ['pipe', 'websocket'] as const) {
  test(`${transport}: seeded input events, graphemes, selection, chords, four frames and scroll`, async () => {
    const fixture = fixtureServer(),
      audit = recordWire(transport),
      browser = await Browser.launch({
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
      await tab.mouse.move(0, 0);
      tab.setInputPolicy(policy);
      await button.click();
      expect(tab.inputBehavior.lastReport!.trace).toEqual(first.trace);
      const events = await tab.evaluate<any[]>('window.__events');
      expect(
        events.some((e) => e.type === 'keydown' && e.key?.toLowerCase() === 'a' && e.ctrl),
      ).toBeTrue();
      expect(events.filter((e) => e.type === 'click' && e.id === 'target')).toHaveLength(2);
      expect(
        events.filter((e) => e.type === 'mousedown' && e.id === 'target').every((e) => e.trusted),
      ).toBeTrue();
      expect(first.trace.filter((e) => e.type === 'move').length).toBe(5);
      expect(first.trace.map((e) => e.type).slice(-3)).toEqual(['down', 'pause', 'up']);
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
      fixture.server.stop(true);
      audit.restore();
    }
  });
  test(`${transport}: changed hit target, cancellation, partial text and navigation never replay input`, async () => {
    const fixture = fixtureServer(),
      browser = await Browser.launch({ transport, headless: true });
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
      expect(error.report.trace.some((e: any) => e.type === 'up')).toBeTrue();
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
      expect(await input.evaluate((el) => (el as HTMLInputElement).value)).toBe('甲');
      tab.setInputPolicy({ ...policy, pressDelay: [300, 300] });
      const keyAbort = new AbortController();
      const pressing = tab.keyboard.press('Control+A', { signal: keyAbort.signal }).catch((e) => e);
      await poll(async () => (tab.keyboard.pressedKeys.length ? true : undefined), {
        timeout: 1000,
      });
      keyAbort.abort();
      expect(await pressing).toBeInstanceOf(InputActionError);
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
      fixture.server.stop(true);
    }
  });
}
