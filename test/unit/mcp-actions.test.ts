import { expect, test } from 'bun:test';
import { BrowserMcpSession } from '../../src/mcp/session.js';
import type { Tab } from '../../src/page/tab.js';
import { EventHub } from '../../src/utils.js';

test('load waits fail when navigation never starts or completes, without replaying the action', async () => {
  const events = new EventHub<{ method: string; frameId: string }>();
  const changes = new EventHub<any>();
  const tab = {
    id: 'tab',
    url: 'https://fixture.test/',
    closed: false,
    mainFrame: { id: 'frame', generation: 0 },
    framesManager: { changes },
    session: {
      on: (method: string, listener: (event: any) => void) =>
        events.on((e) => {
          if (e.method === method) listener(e);
        }),
    },
  } as unknown as Tab;
  const session = new BrowserMcpSession({});
  const options = { waitFor: 'load' as const, timeout: 40, signal: new AbortController().signal };
  let actions = 0;
  await expect(
    session.act(tab, options, async () => {
      actions++;
    }),
  ).rejects.toThrow('navigation');
  await expect(
    session.act(tab, options, async () => {
      actions++;
      events.emit({ method: 'Page.frameStartedLoading', frameId: 'frame' });
    }),
  ).rejects.toThrow('navigation');
  expect(actions).toBe(2);
  expect(events.size).toBe(0);
  expect(changes.size).toBe(0);
  const sameDocument = await session.act(tab, options, async () => {
    changes.emit({ frame: tab.mainFrame, sameDocument: true });
  });
  expect(sameDocument.summary.loading).toBeFalse();
  expect(changes.size).toBe(0);
  await session.dispose();
});
