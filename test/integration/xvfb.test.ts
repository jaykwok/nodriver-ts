import { test } from 'node:test';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect } from '../fixtures/expect.ts';
import { Browser } from '../../src/browser/browser.ts';
import { XvfbSession } from '../../src/optional/xvfb.ts';

const skip = process.platform !== 'linux';
const servers = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith('nodriver-xvfb-')).length;

for (const supervised of [false, true])
  test(
    `headful Chrome runs on a virtual display${supervised ? ' under the guardian' : ''}`,
    { skip },
    async () => {
      const before = await servers();
      const browser = await Browser.launch({
        headless: false,
        virtualDisplay: { screen: '1280x720x24' },
        ...(supervised
          ? { detached: true, supervised: true, transport: 'websocket' as const }
          : {}),
      });
      try {
        const tab = await browser.newTab('about:blank');
        expect(await tab.evaluate('[screen.width, screen.height]')).toEqual([1280, 720]);
        expect(await tab.evaluate('navigator.userAgent')).not.toContain('Headless');
        expect(await servers()).toBe(before + 1);
      } finally {
        await browser.close();
      }
      expect(await servers()).toBe(before);
    },
  );

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
