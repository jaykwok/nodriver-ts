import { expect, test, spyOn } from 'bun:test';
import { Network } from '../../src/page/network.js';
import type { Tab } from '../../src/page/tab.js';
import type { Session } from '../../src/protocol/connection.js';
import { EventHub } from '../../src/utils.js';
import { BrowserMcpSession } from '../../src/mcp/session.js';

test('concurrent Network users wait for the same enable and share failures before retrying', async () => {
  const commands: string[] = [];
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const session = {
    closed: false,
    disconnected: new EventHub<Error>(),
    on: () => () => {},
    send: (method: string) => {
      commands.push(method);
      if (method === 'Network.enable')
        return new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      return Promise.resolve({});
    },
  } as unknown as Session;
  const network = new Network({ reportError: () => {} } as unknown as Tab);
  await network.configure(session);
  const first = network.enable();
  let secondDone = false;
  const second = network.enable().then(() => {
    secondDone = true;
  });
  const headers = network.setExtraHeaders({ 'x-test': 'ready' });
  await Promise.resolve();
  await Promise.resolve();
  expect(secondDone).toBeFalse();
  expect(commands).toEqual(['Network.enable']);
  const error = new Error('enable rejected');
  const outcomes = Promise.allSettled([first, second, headers]);
  fail(error);
  for (const outcome of await outcomes)
    expect(outcome).toEqual({ status: 'rejected', reason: error });
  const retry = network.enable();
  finish();
  await retry;
  expect(commands).toEqual(['Network.enable', 'Network.enable', 'Network.setExtraHTTPHeaders']);
  network.dispose();
});

test('failed MCP response capture releases its listener and permits a fresh start', async () => {
  const session = new BrowserMcpSession({});
  const responses = new EventHub();
  let attempts = 0;
  const tab = {
    network: {
      responses,
      enable: async () => {
        if (++attempts === 1) throw new Error('enable rejected');
      },
    },
  } as unknown as Tab;
  const lookup = spyOn(session, 'tab').mockReturnValue(tab);
  try {
    await expect(session.capture('tab', 'start')).rejects.toThrow('enable rejected');
    expect(responses.size).toBe(0);
    expect(() => session.captured('tab', undefined, 10)).toThrow('capture is off');
    await session.capture('tab', 'start');
    expect(attempts).toBe(2);
    expect(responses.size).toBe(1);
  } finally {
    await session.dispose();
    lookup.mockRestore();
  }
  expect(responses.size).toBe(0);
});
