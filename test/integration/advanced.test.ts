import { describe, test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { Browser } from '../../src/index.ts';
import { fixtureServer } from '../fixtures/server.ts';
describe('environment and interaction boundaries', () => {
  test('viewport, timezone, scoped query, element screenshot and disabled controls', async (t) => {
    const f = await fixtureServer();
    t.after(() => f.server.stop());
    const b = await Browser.launch({
      headless: process.env.NODRIVER_HEADFUL !== '1',
      timeout: 15_000,
    });
    try {
      const t = await b.newTab();
      await t.setEnvironment({
        viewport: { width: 1100, height: 800, deviceScaleFactor: 2 },
        timezone: 'Asia/Tokyo',
        locale: 'zh-CN',
      });
      await t.goto(f.base + '/page');
      expect(await t.evaluate('innerWidth')).toBe(1100);
      expect(await t.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe(
        'Asia/Tokyo',
      );
      const parent = await t.waitForSelector('#target');
      expect(await (await parent.query('b'))!.text()).toBe('needle');
      expect(await parent.query('#button')).toBeUndefined();
      expect(
        (await (await t.waitForSelector('#button')).screenshot()).subarray(1, 4).toString(),
      ).toBe('PNG');
      await t.evaluate('document.querySelector("#button").disabled=true');
      await expect((await t.waitForSelector('#button')).click({ timeout: 50 })).rejects.toThrow();
      expect(await t.evaluate('clicks')).toBe(0);
      await t.setContent('<input type="checkbox" id="check"><p>replacement</p>');
      const checkbox = await t.waitForSelector('#check');
      await checkbox.setChecked(true);
      await checkbox.setChecked(false);
      expect(await checkbox.evaluate((el) => (el as HTMLInputElement).checked)).toBe(false);
    } finally {
      await b.close();
    }
  });
  test('init scripts run before page and OOPIF scripts; transformed iframe click', async (t) => {
    const f = await fixtureServer();
    t.after(() => f.server.stop());
    const errors: unknown[] = [];
    const b = await Browser.launch({
      headless: process.env.NODRIVER_HEADFUL !== '1',
      timeout: 15_000,
      args: ['--site-per-process'],
      onError: (e) => errors.push(e),
    });
    try {
      const t = await b.newTab();
      await t.addInitScript('globalThis.initMarker="boot"');
      await t.goto(f.base + '/page?frames=1');
      expect(await t.evaluate('initMarker')).toBe('boot');
      const cross = t.frames.find((f) => f.url.endsWith('/frame'))!;
      expect(await cross.evaluate('initMarker')).toBe('boot');
      await t.evaluate(
        'document.querySelector("#cross").style.transform="scale(0.8) rotate(3deg)"',
      );
      const button = await cross.waitForSelector('#frame-button');
      await button.click({ timeout: 2000 });
      expect(await button.text()).toBe('clicked');
      await t.evaluate('document.body.insertAdjacentHTML("beforeend",\'<div id="cover"></div>\')');
      await expect(button.click({ timeout: 100 })).rejects.toThrow();
      expect(errors).toEqual([]);
    } finally {
      await b.close();
    }
  });
});
