import { expect, test } from 'bun:test';
import { Browser } from '../../src/index.js';
import { recordWire } from '../fixtures/wire.js';

for (const transport of ['pipe', 'websocket'] as const)
  test(`${transport}: cached queries observe dynamically added and removed closed shadow roots`, async () => {
    const audit = recordWire(transport);
    const browser = await Browser.launch({
      transport,
      headless: process.env.NODRIVER_HEADFUL !== '1',
    });
    try {
      const tab = await browser.newTab();
      await tab.setContent('<div id="host"></div><p>plain</p>');
      expect(await tab.query('#inside')).toBeUndefined();
      const scans = () =>
        audit.messages.filter((m) => m.method === 'DOM.getDocument' && m.params?.depth === -1)
          .length;
      const before = scans();
      await tab.query('p');
      await tab.query('p');
      expect(scans()).toBe(before);
      await tab.evaluate(() => {
        document.querySelector('#host')!.attachShadow({ mode: 'closed' }).innerHTML =
          '<button id="inside">inside</button>';
      });
      expect(await (await tab.query('#inside'))?.text()).toBe('inside');
      await tab.evaluate(() => document.querySelector('#host')!.remove());
      expect(await tab.query('#inside')).toBeUndefined();
      const afterRemoval = scans();
      await tab.query('p');
      expect(scans()).toBe(afterRemoval);
      await tab.evaluate(() => {
        const host = document.createElement('section');
        host.attachShadow({ mode: 'closed' }).innerHTML = '<button id="inserted">inserted</button>';
        document.body.append(host);
      });
      expect(await (await tab.query('#inserted'))?.text()).toBe('inserted');
    } finally {
      await browser.close();
      audit.restore();
    }
  });
