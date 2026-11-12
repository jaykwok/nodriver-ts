import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { spyOn } from 'jest-mock';
import { Network } from '../../src/page/network.ts';
import type { Environment, Tab } from '../../src/page/tab.ts';
import type { EventParams, Session } from '../../src/protocol/connection.ts';
import { EventHub, delay, poll } from '../../src/utils.ts';
import { BrowserMcpSession } from '../../src/mcp/session.ts';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';
import { NodriverError, ProtocolError, TimeoutError } from '../../src/errors.ts';

async function scripted() {
  const chrome = await ScriptedChrome.start();
  const errors: unknown[] = [];
  const browser = await chrome.connect({ onError: (e) => errors.push(e) }).catch(async (error) => {
    await chrome.close();
    throw error;
  });
  const tab = browser.tabs[0]!;
  const sent = (method: string, session?: Session) =>
    chrome.commands.filter((c) => c.method === method && (!session || c.sessionId === session.id));
  const until = (check: () => boolean) =>
    poll(async () => check() || undefined, { timeout: 2000 }, 'scripted condition');
  const attach = async () => {
    const session = await browser.attachSession(tab.id);
    await tab.network.configure(session);
    return session;
  };
  const dispose = async () => {
    await browser.close().finally(() => chrome.close());
  };
  return { chrome, browser, tab, errors, sent, until, attach, dispose };
}
const paused = (requestId: string, url = 'http://a.test/') =>
  ({
    requestId,
    request: { url, method: 'GET', headers: {}, initialPriority: 'High' },
    frameId: 'frame',
    resourceType: 'Fetch',
  }) as unknown as EventParams<'Fetch.requestPaused'>;
const challenge = (requestId: string) =>
  ({
    ...paused(requestId),
    authChallenge: { origin: 'http://a.test', scheme: 'basic', realm: 'a' },
  }) as unknown as EventParams<'Fetch.authRequired'>;

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
  expect(secondDone).toBe(false);
  expect(commands).toEqual(['Network.enable']);
  const error = new Error('enable rejected');
  const outcomes = Promise.allSettled([first, second, headers]);
  fail(error);
  for (const outcome of await outcomes)
    expect(outcome).toEqual({ status: 'rejected', reason: error });
  const retry = network.enable();
  finish();
  await retry;
  // The headers failed with the setup, so they are not part of the retried state.
  expect(commands).toEqual(['Network.enable', 'Network.enable']);
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

test('setExtraHeaders validates first and keeps only what Chrome accepted', async () => {
  const { chrome, tab, sent, attach, dispose } = await scripted();
  try {
    chrome.handle('Network.enable', () => undefined);
    chrome.handle('Network.setExtraHTTPHeaders', () => undefined);
    const invalid: Array<Record<string, string>> = [
      { 'bad name': 'x' },
      { '': 'x' },
      { 'x-test': 'a\r\nb: c' },
    ];
    for (const headers of invalid)
      await expect(tab.network.setExtraHeaders(headers)).rejects.toBeInstanceOf(TypeError);
    expect(sent('Network.enable')).toEqual([]);
    expect(tab.network.networkEnabled).toBe(false);
    // Chrome accepts any text here and sends its UTF-8 bytes.
    await tab.network.setExtraHeaders({ 'x-name': '中文' });
    chrome.replyOnce('Network.setExtraHTTPHeaders', () => {
      throw new Error('Invalid header value');
    });
    await expect(tab.network.setExtraHeaders({ 'x-name': 'trailing\n' })).rejects.toThrow(
      'Invalid header value',
    );
    const extra = await attach();
    expect(sent('Network.setExtraHTTPHeaders', extra).map((c) => c.params)).toEqual([
      { headers: { 'x-name': '中文' } },
    ]);
  } finally {
    await dispose();
  }
});

test('cache and offline state survive only an accepted change', async () => {
  const { chrome, tab, sent, attach, dispose } = await scripted();
  try {
    chrome.handle('Network.enable', () => undefined);
    const refuse = () => {
      throw new Error('refused');
    };
    chrome.replyOnce('Network.setCacheDisabled', refuse);
    chrome.replyOnce('Network.emulateNetworkConditions', refuse);
    await expect(tab.network.setCacheEnabled(false)).rejects.toThrow('refused');
    await expect(tab.network.setOffline(true)).rejects.toThrow('refused');
    const extra = await attach();
    await tab.network.enable();
    expect(sent('Network.enable', extra)).toHaveLength(1);
    expect(sent('Network.setCacheDisabled', extra)).toEqual([]);
    expect(sent('Network.emulateNetworkConditions', extra)).toEqual([]);
  } finally {
    await dispose();
  }
});

test('a session joining during setExtraHeaders ends up with the new headers', async () => {
  const { chrome, tab, sent, until, attach, dispose } = await scripted();
  try {
    chrome.handle('Network.enable', () => undefined);
    chrome.handle('Network.setExtraHTTPHeaders', () => undefined);
    let release: (() => void) | undefined;
    chrome.replyOnce(
      'Network.setExtraHTTPHeaders',
      () => new Promise((resolve) => (release = () => resolve())),
    );
    const update = tab.network.setExtraHeaders({ 'x-test': 'next' });
    await until(() => !!release);
    const extra = await attach();
    release!();
    await update;
    expect(sent('Network.setExtraHTTPHeaders', extra).at(-1)!.params).toEqual({
      headers: { 'x-test': 'next' },
    });
  } finally {
    await dispose();
  }
});

test('a refused configure step is reported and the session setup carries on', async () => {
  const { chrome, browser, tab, errors, sent, dispose } = await scripted();
  try {
    const refusing = new Set<string | undefined>();
    chrome.handle('Network.enable', (_, command) => {
      if (refusing.has(command.sessionId)) throw new Error('Network.enable refused');
      return undefined;
    });
    chrome.handle('Fetch.enable', () => undefined);
    chrome.handle('Page.addScriptToEvaluateOnNewDocument', () => ({ identifier: 'script' }));
    await tab.network.enable();
    await tab.network.route(/never/, () => {});
    await tab.addInitScript('0');
    const noNetwork = await browser.attachSession(tab.id);
    refusing.add(noNetwork.id);
    await tab.configureSession(noNetwork);
    expect(sent('Fetch.enable', noNetwork)).toHaveLength(1);
    expect(sent('Page.addScriptToEvaluateOnNewDocument', noNetwork)).toHaveLength(1);
    expect(errors.map(String)).toEqual([expect.stringContaining('Network.enable refused')]);
    // The next enable() retries what failed, and only that.
    refusing.clear();
    await tab.network.enable();
    expect(sent('Network.enable', noNetwork)).toHaveLength(2);
    expect(sent('Network.enable', tab.session)).toHaveLength(1);

    chrome.handle('Fetch.enable', () => {
      throw new Error('Fetch.enable refused');
    });
    const noFetch = await browser.attachSession(tab.id);
    await tab.configureSession(noFetch);
    expect(sent('Network.enable', noFetch)).toHaveLength(1);
    expect(sent('Page.addScriptToEvaluateOnNewDocument', noFetch)).toHaveLength(1);
    expect(errors.map(String)).toEqual([
      expect.stringContaining('Network.enable refused'),
      expect.stringContaining('Fetch.enable refused'),
    ]);
  } finally {
    await dispose();
  }
});

test('a refused environment override costs a session no init scripts and still rejects', async () => {
  const { chrome, browser, tab, sent, dispose } = await scripted();
  try {
    chrome.handle('Page.addScriptToEvaluateOnNewDocument', () => ({ identifier: 'script' }));
    (tab as unknown as { environment: Environment }).environment = { timezone: 'UTC' };
    await tab.addInitScript('0');
    chrome.handle('Emulation.setTimezoneOverride', () => {
      throw new Error('override refused');
    });
    const session = await browser.attachSession(tab.id);
    await expect(tab.configureSession(session)).rejects.toThrow('override refused');
    expect(sent('Page.addScriptToEvaluateOnNewDocument', session)).toHaveLength(1);
  } finally {
    await dispose();
  }
});

test('configure ignores sessions that are closed or close during setup', async () => {
  const { chrome, browser, tab, errors, dispose } = await scripted();
  try {
    chrome.handle('Network.enable', (_, command) => {
      if (command.sessionId === tab.session.id) return undefined;
      chrome.detachSession(command.sessionId!);
      return NO_REPLY;
    });
    await tab.network.enable();
    const closing = await browser.attachSession(tab.id);
    await tab.network.configure(closing);
    expect(closing.closed).toBe(true);
    const closed = await browser.attachSession(tab.id);
    await closed.detach();
    await tab.network.configure(closed);
    expect(errors).toEqual([]);
  } finally {
    await dispose();
  }
});

test('each responses subscription retries a failed enable; none repeats a good one', async () => {
  const { chrome, tab, errors, sent, until, dispose } = await scripted();
  try {
    chrome.handle('Network.enable', () => undefined);
    chrome.replyOnce('Network.enable', () => {
      throw new Error('enable refused');
    });
    tab.network.responses.on(() => {});
    await until(() => errors.length === 1);
    expect(tab.network.networkEnabled).toBe(false);
    tab.network.responses.on(() => {});
    await until(() => tab.network.networkEnabled && sent('Network.enable').length === 2);
    await tab.network.enable();
    tab.network.responses.on(() => {});
    await tab.network.enable();
    expect(sent('Network.enable')).toHaveLength(2);
    expect(errors).toHaveLength(1);
  } finally {
    await dispose();
  }
});

test('a failed call leaves an earlier Network request standing', async () => {
  const fake = (refuse: boolean) => {
    const sent: string[] = [];
    const session = {
      closed: false,
      disconnected: new EventHub<Error>(),
      on: () => () => {},
      send: async (method: string) => {
        sent.push(method);
        if (refuse) throw new ProtocolError(method, -32000, 'refused');
        return {};
      },
    };
    return { session, sent, as: session as unknown as Session };
  };
  const errors: unknown[] = [];
  const network = new Network({ reportError: (e: unknown) => errors.push(e) } as unknown as Tab);
  const first = fake(false);
  await network.configure(first.as);
  await network.enable();
  // The only enabled session goes away, as with a cross-process navigation.
  first.session.closed = true;
  first.session.disconnected.emit(new Error('replaced'));
  const refusing = fake(true);
  await network.configure(refusing.as);
  await expect(network.setOffline(true)).rejects.toBeInstanceOf(ProtocolError);
  expect(network.networkEnabled).toBe(true);
  const next = fake(false);
  await network.configure(next.as);
  expect(next.sent).toEqual(['Network.enable']);
  expect(errors).toHaveLength(1);
  network.dispose();
});

test('a Fetch command Chrome refuses reopens the route for the handler and fallback', async () => {
  const { chrome, tab, errors, sent, until, dispose } = await scripted();
  try {
    chrome.handle('Fetch.enable', () => undefined);
    chrome.handle('Fetch.continueRequest', () => undefined);
    chrome.handle('Fetch.failRequest', () => undefined);
    chrome.handle('Fetch.fulfillRequest', () => {
      throw new Error('Invalid http status code or phrase');
    });
    let caught: unknown;
    let open: boolean | undefined;
    await tab.network.route(/caught$/, async (route) => {
      caught = await route.fulfill({ status: 0 }).catch((e: unknown) => e);
      open = !route.done;
    });
    await tab.network.route(/thrown$/, (route) => route.fulfill({ status: 0 }));
    await tab.network.route(/retried$/, (route) =>
      route.fulfill({ status: 0 }).catch(() => route.abort('BlockedByClient')),
    );
    chrome.emit('Fetch.requestPaused', paused('a', 'http://a.test/caught'), tab.session.id);
    await until(() => sent('Fetch.continueRequest').length === 1);
    expect(caught).toBeInstanceOf(ProtocolError);
    expect(open).toBe(true);
    expect(sent('Fetch.continueRequest')[0]!.params).toEqual({ requestId: 'a' });
    expect(errors).toEqual([]);

    chrome.emit('Fetch.requestPaused', paused('b', 'http://a.test/thrown'), tab.session.id);
    await until(() => sent('Fetch.failRequest').length === 1);
    expect(sent('Fetch.failRequest')[0]!.params).toEqual({
      requestId: 'b',
      errorReason: 'Aborted',
    });
    expect(errors).toHaveLength(1);

    chrome.emit('Fetch.requestPaused', paused('c', 'http://a.test/retried'), tab.session.id);
    await until(() => sent('Fetch.failRequest').length === 2);
    expect(sent('Fetch.failRequest')[1]!.params).toEqual({
      requestId: 'c',
      errorReason: 'BlockedByClient',
    });
    expect(errors).toHaveLength(1);
  } finally {
    await dispose();
  }
});

test('a Fetch command without a verdict from Chrome keeps the route claimed', async (t) => {
  const { chrome, tab, errors, sent, until, dispose } = await scripted();
  try {
    // Only the unanswered Fetch command needs a short deadline, not the startup handshake.
    const send: Session['send'] = (method, ...params) =>
      tab.session.sendWith(
        method,
        method === 'Fetch.continueRequest' ? { timeout: 50 } : {},
        ...params,
      );
    t.mock.method(tab.session, 'send', send);
    chrome.handle('Fetch.enable', () => undefined);
    chrome.handle('Fetch.continueRequest', () => NO_REPLY);
    chrome.handle('Fetch.failRequest', () => undefined);
    let first: unknown;
    let second: unknown;
    await tab.network.route(/./, async (route) => {
      first = await route.continue().catch((e: unknown) => e);
      second = await route.abort().catch((e: unknown) => e);
    });
    chrome.emit('Fetch.requestPaused', paused('a'), tab.session.id);
    await until(() => second !== undefined);
    expect(first).toBeInstanceOf(TimeoutError);
    expect(second).toBeInstanceOf(NodriverError);
    expect(String(second)).toContain('already handled');
    expect(sent('Fetch.failRequest')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await dispose();
  }
});

for (const message of ['Invalid InterceptionId.', 'Fetch domain is not enabled'])
  test(`"${message}" means the request is gone, not that the route failed`, async () => {
    const { chrome, browser, tab, errors, sent, until, dispose } = await scripted();
    try {
      const gone = () => {
        throw new Error(message);
      };
      chrome.handle('Fetch.enable', () => undefined);
      chrome.handle('Fetch.continueRequest', gone);
      chrome.handle('Fetch.fulfillRequest', gone);
      chrome.handle('Fetch.continueWithAuth', gone);
      let answered: boolean | undefined;
      await tab.network.route(/answered$/, async (route) => {
        await route.fulfill({});
        answered = route.done;
      });
      await tab.network.authenticate({ username: 'user', password: 'pass' });
      chrome.emit('Fetch.requestPaused', paused('a', 'http://a.test/answered'), tab.session.id);
      chrome.emit('Fetch.requestPaused', paused('b', 'http://a.test/fallback'), tab.session.id);
      chrome.emit('Fetch.authRequired', challenge('c'), tab.session.id);
      await until(() => answered === true && sent('Fetch.continueWithAuth').length === 1);
      await browser.connection.drain({ timeout: 2000 });
      await delay(10);
      expect(sent('Fetch.continueRequest')).toHaveLength(1);
      expect(sent('Fetch.failRequest')).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await dispose();
    }
  });

test('a failed route() leaves no handler and restores Fetch on every session', async () => {
  const { chrome, tab, errors, sent, until, attach, dispose } = await scripted();
  try {
    const extra = await attach();
    let refuse = true;
    chrome.handle('Fetch.enable', (_, command) => {
      if (refuse && command.sessionId === extra.id) throw new Error('Fetch.enable refused');
      return undefined;
    });
    chrome.handle('Fetch.disable', () => undefined);
    chrome.handle('Fetch.continueRequest', () => undefined);
    let handled = 0;
    await expect(tab.network.route(/./, () => void handled++)).rejects.toThrow(
      'Fetch.enable refused',
    );
    expect(sent('Fetch.disable', tab.session)).toHaveLength(1);
    expect(sent('Fetch.disable', extra)).toHaveLength(1);
    chrome.emit('Fetch.requestPaused', paused('a'), tab.session.id);
    await until(() => sent('Fetch.continueRequest').length === 1);
    expect(handled).toBe(0);
    expect(errors).toEqual([]);

    // Another route keeps Fetch on, so undoing this one disables nothing.
    refuse = false;
    await tab.network.route(/kept/, () => {});
    refuse = true;
    await expect(tab.network.route(/./, () => void handled++)).rejects.toThrow(
      'Fetch.enable refused',
    );
    expect(sent('Fetch.disable')).toHaveLength(2);
    // The same session refuses the undo too; that is reported, not thrown over the first error.
    expect(errors.map(String)).toEqual([expect.stringContaining('Fetch.enable refused')]);
  } finally {
    await dispose();
  }
});

test('a failed authenticate() keeps the previous credentials', async () => {
  const { chrome, tab, sent, until, dispose } = await scripted();
  try {
    chrome.handle('Fetch.enable', () => undefined);
    chrome.handle('Fetch.continueWithAuth', () => undefined);
    await tab.network.authenticate({ username: 'first', password: 'pass' });
    chrome.replyOnce('Fetch.enable', () => {
      throw new Error('Fetch.enable refused');
    });
    await expect(
      tab.network.authenticate({ username: 'second', password: 'pass' }),
    ).rejects.toThrow('Fetch.enable refused');
    chrome.emit('Fetch.authRequired', challenge('a'), tab.session.id);
    await until(() => sent('Fetch.continueWithAuth').length === 1);
    expect(sent('Fetch.continueWithAuth')[0]!.params).toMatchObject({
      authChallengeResponse: { username: 'first' },
    });
  } finally {
    await dispose();
  }
});

test('every session-wide operation tolerates a session that closes under it', async () => {
  const { chrome, tab, errors, sent, attach, dispose } = await scripted();
  try {
    const close = (command: { sessionId?: string }) => {
      if (command.sessionId === tab.session.id) return undefined;
      chrome.detachSession(command.sessionId!);
      return NO_REPLY;
    };
    chrome.handle('Network.enable', () => undefined);
    chrome.handle('Network.setExtraHTTPHeaders', (_, command) => close(command));
    chrome.handle('Network.setCacheDisabled', (_, command) => close(command));
    chrome.handle('Network.emulateNetworkConditions', (_, command) => close(command));
    chrome.handle('Fetch.enable', (_, command) => close(command));
    chrome.handle('Fetch.disable', (_, command) => close(command));
    const operations: Array<() => Promise<unknown>> = [
      () => tab.network.setExtraHeaders({ 'x-test': '1' }),
      () => tab.network.setCacheEnabled(false),
      () => tab.network.setOffline(true),
      () => tab.network.authenticate({ username: 'user', password: 'pass' }),
      () => tab.network.authenticate(),
    ];
    for (const operation of operations) {
      const extra = await attach();
      await operation();
      expect(extra.closed).toBe(true);
    }
    const routed = await attach();
    const unroute = await tab.network.route(/./, () => {});
    expect(routed.closed).toBe(true);
    const unrouted = await attach();
    await unroute();
    expect(unrouted.closed).toBe(true);
    expect(sent('Fetch.disable', tab.session)).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    await dispose();
  }
});

test('route matching never touches the caller RegExp and keeps its meaning', async () => {
  const { chrome, tab, sent, until, dispose } = await scripted();
  try {
    chrome.handle('Fetch.enable', () => undefined);
    chrome.handle('Fetch.continueRequest', () => undefined);
    const global = /global/g;
    const sticky = /http:\/\/sticky/y;
    const ignoreCase = /IGNORE/i;
    global.lastIndex = 3;
    sticky.lastIndex = 9;
    const hits: string[] = [];
    const hit = (route: { request: { requestId: string } }) => {
      hits.push(route.request.requestId);
    };
    await tab.network.route(global, hit);
    await tab.network.route(sticky, hit);
    await tab.network.route(ignoreCase, hit);
    const urls = [
      'http://a.test/global',
      'http://a.test/global',
      'http://sticky.test/',
      'http://a.test/http://sticky',
      'http://a.test/ignore',
    ];
    for (const [i, url] of urls.entries())
      chrome.emit('Fetch.requestPaused', paused(String(i), url), tab.session.id);
    await until(() => sent('Fetch.continueRequest').length === urls.length);
    expect(hits).toEqual(['0', '1', '2', '4']);
    expect(global.lastIndex).toBe(3);
    expect(sticky.lastIndex).toBe(9);
  } finally {
    await dispose();
  }
});
