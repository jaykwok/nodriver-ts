import { expect, test } from 'bun:test';
import { Browser } from '../../src/index.js';
import { fixtureServer } from '../fixtures/server.js';
import { recordWire, forbiddenAutomaticCommands } from '../fixtures/wire.js';

test('headless mask, pointer pressure, screen offsets and key-event typing stay consistent', async () => {
  const headless = process.env.NODRIVER_HEADFUL !== '1';
  const fixture = fixtureServer(),
    audit = recordWire('pipe'),
    browser = await Browser.launch({ transport: 'pipe', headless });
  try {
    const tab = await browser.newTab(fixture.base + '/input-events');
    const ua = await tab.evaluate<string>('navigator.userAgent');
    expect(ua).not.toContain('Headless');
    const served = await tab.evaluate<{ headers: Record<string, string> }>(
      "fetch('/signals/ip').then(r=>r.json())",
    );
    expect(served.headers['user-agent']).toBe(ua);
    const brands = await tab.evaluate<Array<{ brand: string }>>('navigator.userAgentData.brands');
    expect(brands.length).toBeGreaterThan(0);
    expect(brands.some((b) => b.brand.includes('Headless'))).toBeFalse();

    tab.setInputPolicy({ mode: 'human', seed: 7, pause: [0, 0], keyDelay: [5, 5] });
    await tab.evaluate(
      "window.__p=[];for(const t of ['pointerdown','pointerup'])document.addEventListener(t,e=>__p.push({t,pressure:e.pressure,sx:e.screenX-e.clientX,wx:screenX,trusted:e.isTrusted}),true)",
    );
    await (await tab.waitForSelector('#target')).click();
    const pointer = await tab.evaluate<any[]>('__p');
    expect(pointer.map((p) => [p.t, p.pressure, p.trusted])).toEqual([
      ['pointerdown', 0.5, true],
      ['pointerup', 0, true],
    ]);
    expect(pointer[0].sx).toBeGreaterThanOrEqual(pointer[0].wx);

    const input = await tab.waitForSelector('#plain');
    await tab.evaluate('window.__clear()');
    await input.type('A b!');
    expect(await input.evaluate((el) => (el as HTMLInputElement).value)).toBe('A b!');
    const keys = (await tab.evaluate<any[]>('window.__events'))
      .filter((e) => e.type === 'keydown' || e.type === 'keyup')
      .map((e) => `${e.type}:${e.code}:${e.key}`);
    expect(keys).toEqual([
      'keydown:ShiftLeft:Shift',
      'keydown:KeyA:A',
      'keyup:KeyA:A',
      'keyup:ShiftLeft:Shift',
      'keydown:Space: ',
      'keyup:Space: ',
      'keydown:KeyB:b',
      'keyup:KeyB:b',
      'keydown:ShiftLeft:Shift',
      'keydown:Digit1:!',
      'keyup:Digit1:!',
      'keyup:ShiftLeft:Shift',
    ]);
    expect(audit.messages.filter((m) => forbiddenAutomaticCommands.includes(m.method))).toEqual([]);
  } finally {
    await browser.close();
    fixture.server.stop(true);
    audit.restore();
  }
});
