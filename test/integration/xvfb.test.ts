import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect } from '../fixtures/expect.ts';
import { Browser } from '../../src/browser/browser.ts';
import { XvfbSession } from '../../src/optional/xvfb.ts';

const skip = process.platform !== 'linux';
const servers = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith('nodriver-xvfb-')).length;

const variants = [
  { name: '', options: {} },
  { name: ' when detached', options: { detached: true, transport: 'websocket' as const } },
  {
    name: ' under the guardian',
    options: { detached: true, supervised: true, transport: 'websocket' as const },
  },
];
for (const { name, options } of variants)
  test(`headful Chrome runs on a virtual display${name}`, { skip }, async () => {
    const before = await servers();
    const browser = await Browser.launch({
      headless: false,
      virtualDisplay: { screen: '1280x720x24' },
      ...options,
    });
    try {
      const tab = await browser.newTab('about:blank');
      expect(await tab.evaluate('[screen.width, screen.height]')).toEqual([1280, 720]);
      expect(await tab.evaluate('navigator.userAgent')).not.toContain('Headless');
      expect(await servers()).toBe(before + 1);
      if ('detached' in options) {
        // Refused before anything is given up: the browser stays owned and connected.
        await assert.rejects(browser.release(), /virtual display/);
        await assert.rejects(browser.process!.release(), /virtual display/);
        expect(browser.owned).toBe(true);
        expect(await tab.evaluate('1 + 1')).toBe(2);
      }
    } finally {
      await browser.close();
    }
    expect(await servers()).toBe(before);
  });

test('a virtual display accepts its own cookie', { skip }, async () => {
  const session = await XvfbSession.start();
  try {
    const browser = await Browser.launch({ headless: false, env: session.env });
    try {
      const tab = await browser.newTab('about:blank');
      expect(await tab.evaluate('screen.width')).toBe(1920);
    } finally {
      await browser.close();
    }
  } finally {
    await session.stop();
  }
});
