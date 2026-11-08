import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Protocol } from 'devtools-protocol';
import {
  ClearSiteDataError,
  NodriverError,
  ProtocolError,
  TimeoutError,
  type Browser,
  type Tab,
} from '../../src/index.ts';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';

const one = 'http://127.0.0.1:1000';
const two = 'http://127.0.0.1:2000';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

/** Scripts the commands of clearSiteData() and records what reached each tab. */
function scriptSiteData(chrome: ScriptedChrome, browser: () => Browser) {
  const log = {
    navigated: [] as Array<{ session?: string; url: string }>,
    sessionStorage: [] as Array<{ session?: string; origin: string }>,
    cleared: [] as Array<{ session?: string; origin: string; storageTypes: string }>,
    deleted: [] as string[],
    bypass: [] as boolean[],
    fetch: [] as string[],
    cookies: [] as Protocol.Network.Cookie[],
    history: new Map<string, string[]>(),
  };
  let loader = 0;
  chrome.handle('Page.getNavigationHistory', (_params, command) => ({
    currentIndex: 0,
    entries: (log.history.get(command.sessionId!) ?? []).map((url, id) => ({
      id,
      url,
      userTypedURL: url,
      title: '',
      transitionType: 'typed' as const,
    })),
  }));
  chrome.handle('Page.navigate', ({ url }, command) => {
    log.navigated.push({ session: command.sessionId, url });
    const tab = browser().tabs.find((candidate) => candidate.session.id === command.sessionId)!;
    const frameId = tab.mainFrame.id;
    const loaderId = `load-${++loader}`;
    setImmediate(() => {
      chrome.emit(
        'Page.frameNavigated',
        {
          type: 'Navigation',
          frame: {
            id: frameId,
            loaderId,
            url,
            domainAndRegistry: '',
            securityOrigin: '://',
            mimeType: 'text/html',
            secureContextType: 'InsecureScheme',
            crossOriginIsolatedContextType: 'NotIsolated',
            gatedAPIFeatures: [],
          },
        },
        command.sessionId,
      );
      chrome.emit(
        'Page.lifecycleEvent',
        { frameId, loaderId, name: 'load', timestamp: 0 },
        command.sessionId,
      );
    });
    return { frameId, loaderId };
  });
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
  chrome.handle('Runtime.callFunctionOn', ({ arguments: args }, command) => {
    const { kind, origin } = args![0]!.value as { kind: string; origin: string };
    assert.equal(kind, 'session');
    log.sessionStorage.push({ session: command.sessionId, origin });
    return { result: { type: 'undefined' } };
  });
  chrome.handle('Storage.clearDataForOrigin', ({ origin, storageTypes }, command) => {
    log.cleared.push({ session: command.sessionId, origin, storageTypes });
  });
  chrome.handle('Storage.getCookies', () => ({ cookies: log.cookies }));
  chrome.handle('Network.deleteCookies', ({ name, domain }) => {
    log.deleted.push(`${name}@${domain}`);
    log.cookies = log.cookies.filter((c) => c.name !== name || c.domain !== domain);
  });
  chrome.handle('Network.setBypassServiceWorker', ({ bypass }) => {
    log.bypass.push(bypass);
  });
  chrome.handle('Fetch.enable', () => {
    log.fetch.push('enable');
  });
  chrome.handle('Fetch.disable', () => {
    log.fetch.push('disable');
  });
  return log;
}
const jarCookie = (name: string, domain: string, partitionKey?: unknown) =>
  ({ name, domain, path: '/', partitionKey }) as Protocol.Network.Cookie;
const byUrl = (browser: Browser, url: string): Tab =>
  browser.tabs.find((tab) => tab.url.startsWith(url))!;

test('an exact origin leaves another port of its host untouched', async () => {
  await using chrome = await ScriptedChrome.start({
    pages: [{ url: `${one}/` }, { url: `${two}/` }],
  });
  let browser!: Browser;
  const log = scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const wanted = byUrl(browser, one);
  const other = byUrl(browser, two);
  const result = await browser.defaultContext.clearSiteData({
    origins: [one],
    types: ['localStorage', 'sessionStorage'],
    openTabs: 'blank',
  });
  assert.deepEqual(result.tabs, [wanted.id]);
  assert.deepEqual(result.origins, [one]);
  assert.ok(log.navigated.every(({ session }) => session === wanted.session.id));
  assert.ok(log.sessionStorage.every(({ origin }) => origin === one));
  assert.deepEqual(
    log.cleared.map(({ origin }) => origin),
    [one],
  );
  assert.equal(other.url, `${two}/`);
});

test('cookies follow the host of an origin and the subdomains of a domain', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  let browser!: Browser;
  const log = scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const context = browser.defaultContext;
  const jar = () => [
    jarCookie('host', 'app.example.test'),
    jarCookie('sub', 'deep.app.example.test'),
    jarCookie('parent', '.example.test'),
    jarCookie('other', 'other.test'),
    jarCookie('partitioned', 'cdn.test', { topLevelSite: 'https://app.example.test' }),
  ];
  log.cookies = jar();
  await context.clearSiteData({ origins: ['https://app.example.test:8443'], types: ['cookies'] });
  assert.deepEqual(log.deleted, ['host@app.example.test', 'partitioned@cdn.test']);

  log.deleted.length = 0;
  log.cookies = jar();
  await context.clearSiteData({ domains: ['app.example.test'], types: ['cookies'] });
  assert.deepEqual(log.deleted, [
    'host@app.example.test',
    'sub@deep.app.example.test',
    'partitioned@cdn.test',
  ]);
});

test('a connected tab has its origin recorded before it is blanked or closed', async () => {
  for (const openTabs of ['blank', 'close'] as const) {
    await using chrome = await ScriptedChrome.start({
      pages: [{ url: 'http://app.localhost:8080/' }, { url: 'about:blank' }],
    });
    let browser!: Browser;
    const log = scriptSiteData(chrome, () => browser);
    await using connected = await chrome.connect();
    browser = connected;
    const result = await browser.defaultContext.clearSiteData({
      domains: ['localhost'],
      types: ['localStorage'],
      openTabs,
    });
    assert.ok(result.origins.includes('http://app.localhost:8080'));
    assert.ok(log.cleared.some(({ origin }) => origin === 'http://app.localhost:8080'));
  }
});

test('an origin only in a tab history is cleared for a domain', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: 'about:blank' }] });
  let browser!: Browser;
  const log = scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  log.history.set(browser.tabs[0]!.session.id!, ['http://app.localhost:8080/login', 'about:blank']);
  await browser.defaultContext.clearSiteData({ domains: ['localhost'], types: ['localStorage'] });
  assert.ok(log.cleared.some(({ origin }) => origin === 'http://app.localhost:8080'));
});

test('sessionStorage a tab kept after leaving an origin is refused by default, then cleared', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: `${one}/` }] });
  let browser!: Browser;
  const log = scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const tab = browser.tabs[0]!;
  await tab.goto('about:blank');
  log.navigated.length = 0;
  const context = browser.defaultContext;

  await assert.rejects(
    context.clearSiteData({ origins: [one], types: ['sessionStorage'] }),
    (error: unknown) => error instanceof NodriverError && /sessionStorage/.test(error.message),
  );
  assert.deepEqual(log.sessionStorage, []);
  // Other types are safe: a tab that left the origin cannot write its data.
  await context.clearSiteData({ origins: [one], types: ['localStorage'] });
  assert.deepEqual(log.navigated, []);

  const result = await context.clearSiteData({
    origins: [one],
    types: ['sessionStorage'],
    openTabs: 'blank',
  });
  assert.deepEqual(result.tabs, [tab.id]);
  assert.deepEqual(log.sessionStorage, [{ session: tab.session.id, origin: one }]);
  assert.deepEqual(
    log.navigated.map(({ url }) => url),
    ['about:blank', `${one}/`, 'about:blank'],
  );
  // The tab keeps no interception or service worker bypass afterwards.
  assert.deepEqual(log.bypass, [true, false]);
  assert.deepEqual(log.fetch, ['enable', 'disable']);
  assert.equal(tab.url, 'about:blank');
});

test('closing a tab discards its sessionStorage without visiting the origin', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: `${one}/` }] });
  let browser!: Browser;
  const log = scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const tab = browser.tabs[0]!;
  await tab.goto('about:blank');
  log.navigated.length = 0;
  await browser.defaultContext.clearSiteData({
    origins: [one],
    types: ['sessionStorage'],
    openTabs: 'close',
  });
  assert.equal(tab.closed, true);
  assert.deepEqual(log.navigated, []);
});

test('pages not attached by this client count as open pages of the site', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: `${one}/` }] });
  let browser!: Browser;
  scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect({ attach: 'created' });
  browser = connected;
  assert.equal(browser.tabs.length, 0);
  const [page] = browser.pageTargets;
  const context = browser.defaultContext;
  const clears = () =>
    chrome.commands.filter((c) => c.method === 'Storage.clearDataForOrigin').length;

  await assert.rejects(
    context.clearSiteData({ origins: [one], types: ['localStorage'] }),
    (error: unknown) => error instanceof NodriverError && error.message.includes(`${one}/`),
  );
  await assert.rejects(
    context.clearSiteData({ origins: [one], types: ['localStorage'], openTabs: 'blank' }),
    /attachTarget/,
  );
  assert.equal(clears(), 0);
  assert.ok(browser.pageTargets.some((info) => info.targetId === page!.targetId));

  const result = await context.clearSiteData({
    origins: [one],
    types: ['localStorage'],
    openTabs: 'close',
  });
  assert.deepEqual(result.tabs, [page!.targetId]);
  assert.equal(clears(), 1);
  assert.ok(
    chrome.commands.some(
      (c) =>
        c.method === 'Target.closeTarget' &&
        (c.params as { targetId: string }).targetId === page!.targetId,
    ),
  );
});

test('an unattached page of another context does not block a context', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  let browser!: Browser;
  scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect({ attach: 'created' });
  browser = connected;
  const context = await browser.newContext();
  chrome.addPage({ url: `${one}/`, browserContextId: 'foreign-context' });
  while (!browser.pageTargets.length) await new Promise((resolve) => setTimeout(resolve, 5));
  await context.clearSiteData({ origins: [one], types: ['localStorage'] });

  // The default context knows its own ID, or recognises other contexts by Chrome's list.
  chrome.replyOnce('Target.getBrowserContexts', {
    browserContextIds: ['foreign-context'],
    defaultBrowserContextId: 'default-context',
  });
  await browser.defaultContext.clearSiteData({ origins: [one], types: ['localStorage'] });
  chrome.replyOnce('Target.getBrowserContexts', { browserContextIds: ['foreign-context'] });
  await browser.defaultContext.clearSiteData({ origins: [one], types: ['localStorage'] });
});

const clears = (chrome: ScriptedChrome) =>
  chrome.commands.filter((c) => c.method === 'Storage.clearDataForOrigin').length;
const closed = (chrome: ScriptedChrome) =>
  chrome.commands
    .filter((c) => c.method === 'Target.closeTarget')
    .map((c) => (c.params as { targetId: string }).targetId);

test('a page that opens during the call is left alone, attached or not', async () => {
  for (const attach of ['all', 'created'] as const) {
    await using chrome = await ScriptedChrome.start({ pages: [{ url: 'about:blank' }] });
    let browser!: Browser;
    scriptSiteData(chrome, () => browser);
    await using connected = await chrome.connect({ attach });
    browser = connected;
    if (attach === 'created') await browser.newTab();
    let added = '';
    chrome.handle('Page.getNavigationHistory', async () => {
      if (!added) {
        // waitForTab() sees only tabs created after it is called.
        const tab = attach === 'all' ? browser.waitForTab((tab) => tab.id === added) : undefined;
        added = chrome.addPage({ url: `${one}/` });
        while (!browser.targetInfo.has(added)) await sleep(2);
        await tab;
      }
      return { currentIndex: 0, entries: [] };
    });
    const result = await browser.defaultContext.clearSiteData({
      origins: [one],
      types: ['localStorage', 'sessionStorage'],
      openTabs: 'close',
    });
    assert.deepEqual(result.tabs, [], attach);
    assert.deepEqual(closed(chrome), [], attach);
    assert.ok(browser.targetInfo.has(added), attach);
  }
});

test('a page open when the call starts stays covered when this client attaches it meanwhile', async () => {
  for (const openTabs of ['fail', 'blank'] as const) {
    await using chrome = await ScriptedChrome.start({ pages: [{ url: `${one}/` }] });
    let browser!: Browser;
    const log = scriptSiteData(chrome, () => browser);
    await using connected = await chrome.connect({ attach: 'created' });
    browser = connected;
    const [page] = browser.pageTargets;
    await browser.newTab();
    let attached: Tab | undefined;
    chrome.handle('Page.getNavigationHistory', async () => {
      attached ??= await browser.attachTarget(page!.targetId);
      return { currentIndex: 0, entries: [] };
    });
    const outcome = await browser.defaultContext
      .clearSiteData({ origins: [one], types: ['localStorage'], openTabs })
      .catch((error: unknown) => error);
    if (openTabs === 'fail') {
      assert.ok(outcome instanceof NodriverError, String(outcome));
      assert.equal(clears(chrome), 0);
      continue;
    }
    // Attached by the time the call decides, it is blanked as a tab.
    assert.deepEqual((outcome as { tabs: string[] }).tabs, [page!.targetId]);
    assert.ok(log.navigated.some(({ session }) => session === attached!.session.id));
    assert.equal(attached!.url, 'about:blank');
  }
});

test('a tab detached during the call still counts, and is closed by its target ID', async () => {
  for (const openTabs of ['fail', 'close'] as const) {
    await using chrome = await ScriptedChrome.start({ pages: [{ url: `${one}/` }] });
    let browser!: Browser;
    scriptSiteData(chrome, () => browser);
    await using connected = await chrome.connect();
    browser = connected;
    const tab = browser.tabs[0]!;
    const sessionId = tab.session.id!;
    chrome.handle('Page.getNavigationHistory', () => {
      if (!tab.closed) chrome.detachSession(sessionId);
      return { currentIndex: 0, entries: [] };
    });
    const outcome = await browser.defaultContext
      .clearSiteData({ origins: [one], types: ['localStorage'], openTabs })
      .catch((error: unknown) => error);
    assert.equal(tab.closed, true, 'the session was detached');
    if (openTabs === 'fail') {
      assert.ok(outcome instanceof NodriverError, String(outcome));
      assert.equal(clears(chrome), 0);
      assert.ok(browser.targetInfo.has(tab.id));
      continue;
    }
    assert.deepEqual((outcome as { tabs: string[] }).tabs, [tab.id]);
    // The storage commands then run in a temporary tab, which is closed as well.
    assert.equal(closed(chrome)[0], tab.id);
    assert.ok(!browser.targetInfo.has(tab.id));
  }
});

test('a page reattached while its history is read is collected through its new session', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: `${two}/` }] });
  let browser!: Browser;
  const log = scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const first = browser.tabs[0]!;
  let adopting: Promise<Tab> | undefined;
  browser.cdp.on('Target.detachedFromTarget', ({ sessionId }) => {
    if (sessionId !== first.session.id) return;
    adopting = browser.attachTarget(first.id).then((tab) => {
      log.history.set(tab.session.id!, [one, two]);
      return tab;
    });
  });
  chrome.replyOnce('Page.getNavigationHistory', () => {
    chrome.detachSession(first.session.id!);
    return NO_REPLY;
  });

  await assert.rejects(
    browser.defaultContext.clearSiteData({ origins: [one], types: ['sessionStorage'] }),
    /sessionStorage/,
  );
  const adopted = await adopting!;
  assert.notEqual(adopted, first);
  assert.equal(adopted.closed, false);
  assert.ok(
    chrome.commands.some(
      (c) => c.method === 'Page.getNavigationHistory' && c.sessionId === adopted.session.id,
    ),
  );
});

test('a page still being attached when the call starts is waited for and handled as a tab', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  let browser!: Browser;
  scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  chrome.attachReplyDelayMs = 100;
  const id = chrome.addPage({ url: `${one}/` });
  while (!browser.targetInfo.has(id)) await sleep(2);
  assert.equal(browser.tabs.length, 0, 'the attach is still in progress');
  const result = await browser.defaultContext.clearSiteData({
    origins: [one],
    types: ['localStorage'],
    openTabs: 'blank',
  });
  assert.deepEqual(result.tabs, [id]);
  assert.equal(browser.tabs.find((tab) => tab.id === id)?.url, 'about:blank');
});

test('closing skips a page that closed by itself', async () => {
  await using chrome = await ScriptedChrome.start({
    pages: [{ url: `${one}/` }, { url: `${one}/other` }],
  });
  let browser!: Browser;
  scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const [first, second] = browser.tabs.map((tab) => tab.id);
  const gone = new Set<string>();
  chrome.handle('Target.closeTarget', ({ targetId }) => {
    if (gone.has(targetId))
      throw new ProtocolError('Target.closeTarget', -32602, 'No target with given id found');
    // Closing the first page also closes the second, as a page closing its popup would.
    for (const id of targetId === first ? [first!, second!] : [targetId]) {
      chrome.destroyTarget(id);
      gone.add(id);
    }
    return { success: true };
  });
  const result = await browser.defaultContext.clearSiteData({
    origins: [one],
    types: ['localStorage'],
    openTabs: 'close',
  });
  assert.deepEqual(new Set(result.tabs), new Set([first, second]));
  assert.equal(browser.tabs.length, 0);
});

test('a visit restores the service worker bypass when its route fails to start or stop', async () => {
  for (const failing of ['Fetch.enable', 'Fetch.disable'] as const) {
    await using chrome = await ScriptedChrome.start({ pages: [{ url: `${one}/` }] });
    let browser!: Browser;
    const log = scriptSiteData(chrome, () => browser);
    await using connected = await chrome.connect();
    browser = connected;
    const tab = browser.tabs[0]!;
    await tab.goto('about:blank');
    chrome.handle(failing, () => {
      throw new ProtocolError(failing, -32000, 'Injected failure');
    });
    await assert.rejects(
      browser.defaultContext.clearSiteData({
        origins: [one],
        types: ['sessionStorage'],
        openTabs: 'blank',
      }),
      /Injected failure/,
    );
    assert.equal(tab.closed, false);
    assert.deepEqual(log.bypass, [true, false], failing);
  }
});

test('a call that stops reports what it did, and a refusal still did nothing', async () => {
  await using chrome = await ScriptedChrome.start({
    pages: [{ url: `${one}/a` }, { url: `${one}/b` }],
  });
  let browser!: Browser;
  scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const [first, second] = browser.tabs;
  const refused = await browser.defaultContext
    .clearSiteData({ origins: [one], types: ['localStorage'] })
    .catch((error: unknown) => error);
  assert.ok(refused instanceof NodriverError && !(refused instanceof ClearSiteDataError));

  // The second tab never finishes leaving the site.
  chrome.handle('Page.navigate', ({ url }, command) => {
    if (command.sessionId === second!.session.id) return NO_REPLY;
    const frameId = first!.mainFrame.id;
    setImmediate(() => {
      chrome.emit(
        'Page.frameNavigated',
        {
          type: 'Navigation',
          frame: {
            id: frameId,
            loaderId: 'blank',
            url,
            domainAndRegistry: '',
            securityOrigin: '://',
            mimeType: 'text/html',
            secureContextType: 'InsecureScheme',
            crossOriginIsolatedContextType: 'NotIsolated',
            gatedAPIFeatures: [],
          },
        },
        command.sessionId,
      );
      chrome.emit(
        'Page.lifecycleEvent',
        { frameId, loaderId: 'blank', name: 'load', timestamp: 0 },
        command.sessionId,
      );
    });
    return { frameId, loaderId: 'blank' };
  });
  const started = performance.now();
  const error = await browser.defaultContext
    .clearSiteData({ origins: [one], types: ['localStorage'], openTabs: 'blank', timeout: 300 })
    .catch((error: unknown) => error);
  assert.ok(performance.now() - started < 1500);
  assert.ok(error instanceof ClearSiteDataError, String(error));
  assert.ok(error.cause instanceof TimeoutError);
  assert.deepEqual(error.result, { cookies: [], origins: [], tabs: [first!.id] });
  assert.equal(clears(chrome), 0);
});

test('a call stops on its signal between storage commands', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  let browser!: Browser;
  const log = scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const controller = new AbortController();
  chrome.handle('Storage.clearDataForOrigin', ({ origin }) => {
    log.cleared.push({ origin, storageTypes: '' });
    if (origin === `http://${'app.test'}`) controller.abort(new Error('stop'));
  });
  log.cookies = [jarCookie('sid', 'app.test')];
  const error = await browser.defaultContext
    .clearSiteData({ domains: ['app.test'], signal: controller.signal })
    .catch((error: unknown) => error);
  assert.ok(error instanceof ClearSiteDataError, String(error));
  assert.match(String(error.cause), /stop/);
  // https:// was cleared first; http:// was sent when the signal fired, so it is not listed.
  assert.deepEqual(error.result, { cookies: [], origins: ['https://app.test'], tabs: [] });
  assert.deepEqual(log.deleted, []);
});

test('a cookie set again is reported with the cookies that were deleted', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  let browser!: Browser;
  const log = scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  log.cookies = [jarCookie('sid', 'app.test')];
  chrome.handle('Network.deleteCookies', ({ name, domain }) => {
    log.deleted.push(`${name}@${domain}`);
  });
  const error = await browser.defaultContext
    .clearSiteData({ domains: ['app.test'], types: ['cookies'] })
    .catch((error: unknown) => error);
  assert.ok(error instanceof ClearSiteDataError, String(error));
  assert.match(error.message, /set again/);
  assert.deepEqual(error.result.cookies, [{ name: 'sid', domain: 'app.test', path: '/' }]);
});

test('a visit route is taken out when the call stops, also while Chrome installs it', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: `${one}/` }] });
  let browser!: Browser;
  const log = scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const tab = browser.tabs[0]!;
  await tab.goto('about:blank');
  const enable = gate();
  chrome.handle('Fetch.enable', async () => {
    await enable.promise;
    log.fetch.push('enable');
  });
  const answered: string[] = [];
  chrome.handle('Fetch.continueRequest', () => void answered.push('continued'));
  chrome.handle('Fetch.failRequest', () => void answered.push('failed'));
  const error = await browser.defaultContext
    .clearSiteData({ origins: [one], types: ['sessionStorage'], openTabs: 'blank', timeout: 100 })
    .catch((error: unknown) => error);
  assert.ok(error instanceof ClearSiteDataError && error.cause instanceof TimeoutError);
  assert.deepEqual(log.bypass, [true, false]);
  // Chrome applies a session's commands in the order they were sent, so Fetch ends disabled.
  assert.deepEqual(
    chrome.commands.flatMap(({ method }) => (method.startsWith('Fetch.') ? [method] : [])),
    ['Fetch.enable', 'Fetch.disable'],
  );
  // A request that Chrome pauses meanwhile is no longer answered by the route.
  chrome.emit(
    'Fetch.requestPaused',
    {
      requestId: 'later',
      frameId: tab.mainFrame.id,
      resourceType: 'Document',
      request: {
        url: 'https://unrelated.test/',
        method: 'GET',
        headers: {},
        initialPriority: 'High',
        referrerPolicy: 'no-referrer',
      },
    },
    tab.session.id,
  );
  for (let i = 0; i < 50 && !answered.length; i++) await sleep(10);
  assert.deepEqual(answered, ['continued']);
  enable.resolve();
});

test('a service worker bypass Chrome does not confirm in time is still undone', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: `${one}/` }] });
  let browser!: Browser;
  const log = scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  await browser.tabs[0]!.goto('about:blank');
  chrome.handle('Network.setBypassServiceWorker', ({ bypass }) => {
    log.bypass.push(bypass);
    return bypass ? NO_REPLY : undefined;
  });
  const error = await browser.defaultContext
    .clearSiteData({ origins: [one], types: ['sessionStorage'], openTabs: 'blank', timeout: 100 })
    .catch((error: unknown) => error);
  assert.ok(error instanceof ClearSiteDataError && error.cause instanceof TimeoutError);
  assert.deepEqual(log.bypass, [true, false]);
});

test('a call that stops between closing pages closes no further page', async () => {
  await using chrome = await ScriptedChrome.start({
    pages: [{ url: `${one}/a` }, { url: `${one}/b` }],
  });
  const controller = new AbortController();
  let browser!: Browser;
  scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect({
    observe: {
      onResponse({ method }) {
        if (method === 'Target.closeTarget') controller.abort(new Error('stop'));
      },
    },
  });
  browser = connected;
  const [first, second] = browser.tabs;
  const error = await browser.defaultContext
    .clearSiteData({
      origins: [one],
      types: ['localStorage'],
      openTabs: 'close',
      signal: controller.signal,
    })
    .catch((error: unknown) => error);
  assert.ok(error instanceof ClearSiteDataError, String(error));
  assert.deepEqual(error.result.tabs, [first!.id]);
  // Commands arrive in order: one sent before this round trip has been recorded by now.
  await browser.cdp.send('Browser.getVersion');
  assert.equal(chrome.commands.filter(({ method }) => method === 'Target.closeTarget').length, 1);
  assert.equal(second!.closed, false);
});

test('a temporary tab that is slow to close does not hold up a call that stopped', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  let browser!: Browser;
  scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const release = gate();
  chrome.handle('Storage.clearDataForOrigin', () => NO_REPLY);
  chrome.handle('Target.closeTarget', async ({ targetId }) => {
    await release.promise;
    chrome.destroyTarget(targetId);
    return { success: true };
  });
  const started = performance.now();
  const error = await browser.defaultContext
    .clearSiteData({ origins: [one], types: ['localStorage'], timeout: 100 })
    .catch((error: unknown) => error);
  assert.ok(performance.now() - started < 600);
  assert.ok(error instanceof ClearSiteDataError && error.cause instanceof TimeoutError);
  // The temporary tab still closes, after the call returned.
  const closing = () => chrome.commands.some(({ method }) => method === 'Target.closeTarget');
  for (let i = 0; i < 50 && !closing(); i++) await sleep(10);
  assert.ok(closing());
  release.resolve();
  for (let i = 0; i < 50 && browser.tabs.length; i++) await sleep(10);
  assert.deepEqual(browser.tabs, []);
});

test('a visit that stops keeps its own error when undoing it fails as well', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: `${one}/` }] });
  let browser!: Browser;
  const log = scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  await browser.tabs[0]!.goto('about:blank');
  const reported: unknown[] = [];
  browser.errors.on((error) => void reported.push(error));
  const controller = new AbortController();
  const stop = new Error('stop');
  chrome.handle('Network.setBypassServiceWorker', ({ bypass }) => {
    log.bypass.push(bypass);
    if (!bypass)
      throw new ProtocolError('Network.setBypassServiceWorker', -32000, 'Injected undo failure');
    controller.abort(stop);
    return NO_REPLY;
  });
  const error = await browser.defaultContext
    .clearSiteData({
      origins: [one],
      types: ['sessionStorage'],
      openTabs: 'blank',
      signal: controller.signal,
    })
    .catch((error: unknown) => error);
  assert.ok(error instanceof ClearSiteDataError, String(error));
  assert.equal(error.cause, stop);
  assert.deepEqual(log.bypass, [true, false]);
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), /Injected undo failure/);
});

test('a temporary tab that cannot be closed after the call failed is reported', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  let browser!: Browser;
  scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const reported: unknown[] = [];
  browser.errors.on((error) => void reported.push(error));
  chrome.handle('Storage.clearDataForOrigin', () => {
    throw new ProtocolError('Storage.clearDataForOrigin', -32000, 'Injected clear failure');
  });
  chrome.handle('Target.closeTarget', () => {
    throw new ProtocolError('Target.closeTarget', -32000, 'Injected close failure');
  });
  const error = await browser.defaultContext
    .clearSiteData({ origins: [one], types: ['localStorage'] })
    .catch((error: unknown) => error);
  assert.ok(error instanceof ClearSiteDataError, String(error));
  assert.match(String(error.cause), /Injected clear failure/);
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), /Injected close failure/);
});

test('storageState keeps the error of a visit whose temporary tab cannot be closed either', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [] });
  let browser!: Browser;
  scriptSiteData(chrome, () => browser);
  await using connected = await chrome.connect();
  browser = connected;
  const reported: unknown[] = [];
  browser.errors.on((error) => void reported.push(error));
  chrome.handle('Fetch.enable', () => {
    throw new ProtocolError('Fetch.enable', -32000, 'Injected route failure');
  });
  chrome.handle('Target.closeTarget', () => {
    throw new ProtocolError('Target.closeTarget', -32000, 'Injected close failure');
  });
  browser.defaultContext.noteOrigin(`${one}/`);
  await assert.rejects(browser.defaultContext.storageState(), /Injected route failure/);
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), /Injected close failure/);
});
