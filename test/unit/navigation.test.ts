import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Protocol } from 'devtools-protocol';
import type { Tab } from '../../src/index.ts';
import { ScriptedChrome } from '../../src/testing/index.ts';

/** Main-frame events of a scripted page. */
function page(chrome: ScriptedChrome, tab: Tab) {
  const frameId = tab.mainFrame.id;
  const frame = (loaderId: string, url: string): Protocol.Page.Frame => ({
    id: frameId,
    loaderId,
    url,
    domainAndRegistry: '',
    securityOrigin: '://',
    mimeType: 'text/html',
    secureContextType: 'InsecureScheme',
    crossOriginIsolatedContextType: 'NotIsolated',
    gatedAPIFeatures: [],
  });
  return {
    commit: (loaderId: string, url: string) =>
      chrome.emit(
        'Page.frameNavigated',
        { type: 'Navigation', frame: frame(loaderId, url) },
        tab.session.id,
      ),
    within: (url: string) =>
      chrome.emit(
        'Page.navigatedWithinDocument',
        { frameId, url, navigationType: 'historyApi' },
        tab.session.id,
      ),
    lifecycle: (loaderId: string, name: string) =>
      chrome.emit('Page.lifecycleEvent', { frameId, loaderId, name, timestamp: 0 }, tab.session.id),
  };
}

test('a same-document change after the commit does not complete goto() before load', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  const events = page(chrome, tab);
  chrome.handle('Page.navigate', () => {
    setImmediate(() => {
      events.commit('next', 'https://a.test/');
      // For example history.replaceState() while the new document loads.
      events.within('https://a.test/#replaced');
    });
    return { frameId: tab.mainFrame.id, loaderId: 'next' };
  });
  let done = false;
  const replaced = tab.session.waitFor('Page.navigatedWithinDocument');
  const navigation = tab.goto('https://a.test/').then((url) => {
    done = true;
    return url;
  });
  await replaced;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  events.lifecycle('next', 'load');
  assert.equal(await navigation, 'https://a.test/#replaced');
});

test('reload() completes only with the new document', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  const events = page(chrome, tab);
  chrome.handle('Page.reload', () => {
    setImmediate(() => {
      // The old document can still change its URL before it unloads.
      events.within('about:blank#old');
      events.commit('reloaded', 'https://a.test/');
      events.lifecycle('reloaded', 'load');
    });
  });
  assert.equal(await tab.reload(), 'https://a.test/');
});

test('go() completes a same-document history navigation only at its entry', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  const events = page(chrome, tab);
  const entry = (id: number, url: string): Protocol.Page.NavigationEntry => ({
    id,
    url,
    userTypedURL: url,
    title: '',
    transitionType: 'link',
  });
  chrome.handle('Page.getNavigationHistory', () => ({
    currentIndex: 1,
    entries: [entry(1, 'about:blank#one'), entry(2, 'about:blank#two')],
  }));
  chrome.handle('Page.navigateToHistoryEntry', () => {
    setImmediate(() => {
      events.within('about:blank#elsewhere');
      events.within('about:blank#one');
    });
  });
  assert.equal(await tab.go(-1), 'about:blank#one');
});
