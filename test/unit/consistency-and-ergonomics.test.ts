import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import type { Protocol } from 'devtools-protocol';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  ActionabilityError,
  Browser,
  Connection,
  Element,
  InputActionError,
  ProtocolError,
  SessionEndedError,
  StaleElementError,
  TimeoutError,
  UnsupportedError,
  XvfbSession,
  createIsolatedWorld,
  decryptState,
  encryptState,
  findExecutable,
  getNodeEventListeners,
  isEncryptedState,
  isFrameGone,
  parseDOMSnapshot,
  setWindowState,
  type ResponseObservation,
  type TabNavigationEvent,
  type Transport,
} from '../../src/index.ts';
import { createBrowserMcpHttpService } from '../../src/mcp/http.ts';
import { createBrowserMcpServer } from '../../src/mcp/server.ts';
import {
  BrowserMcpSocketClientTransport,
  startBrowserMcpSocketServer,
} from '../../src/mcp/socket.ts';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';

interface MiniNode {
  backendNodeId: number;
  tagName: string;
  id?: string;
  classes?: string[];
  attrs?: Record<string, string>;
  text?: string;
  type?: string;
  disabled?: boolean;
  readOnly?: boolean;
  checked?: boolean;
  display?: string;
  visibility?: string;
  pointerEvents?: string;
  checkVis?: boolean;
  rect?: { left: number; top: number; width: number; height: number };
  parentNode: MiniNode | MiniDoc | null;
  children: MiniNode[];
}
interface MiniDoc {
  nodeType: 9;
  children: MiniNode[];
}

/** Lightweight in-process DOM wired to ScriptedChrome for query/Locator/Element unit tests. */
function installMiniDom(chrome: ScriptedChrome) {
  let nextId = 100;
  let nextObj = 0;
  const byId = new Map<number, MiniNode>();
  const objs = new Map<string, unknown>();
  const doc: MiniDoc = { nodeType: 9, children: [] };

  function walk(nodes: MiniNode[], out: MiniNode[]): void {
    for (const n of nodes) {
      out.push(n);
      walk(n.children, out);
    }
  }
  function matchesSelector(node: MiniNode, selector: string): boolean {
    if (selector === '*') return true;
    for (const alt of selector.split(',').map((s) => s.trim())) {
      if (alt === ':disabled') {
        if (node.disabled) return true;
        continue;
      }
      if (alt.startsWith('.')) {
        if ((node.classes ?? []).includes(alt.slice(1))) return true;
        continue;
      }
      if (alt.startsWith('#')) {
        if (node.id === alt.slice(1)) return true;
        continue;
      }
      if (node.tagName.toLowerCase() === alt.toLowerCase()) return true;
    }
    return false;
  }
  class FakeInput {}
  class FakeTextArea {}
  class FakeSelect {}
  const wrappedMap = new WeakMap<MiniNode, Record<string, unknown>>();
  function getText(node: MiniNode): string {
    if (node.text !== undefined) return node.text;
    return node.children.map((c) => getText(c)).join('');
  }
  function wrap(node: MiniNode): Record<string, unknown> {
    const existing = wrappedMap.get(node);
    if (existing) return existing;
    const obj: Record<string, unknown> = {
      __backendNodeId: node.backendNodeId,
      nodeType: 1,
      get tagName() {
        return node.tagName;
      },
      get localName() {
        return node.tagName.toLowerCase();
      },
      get id() {
        return node.id ?? '';
      },
      get type() {
        return node.type ?? '';
      },
      get disabled() {
        return !!node.disabled;
      },
      get readOnly() {
        return !!node.readOnly;
      },
      get checked() {
        return !!node.checked;
      },
      set checked(v: boolean) {
        node.checked = v;
      },
      get isConnected() {
        let cur: MiniNode | MiniDoc | null = node;
        while (cur) {
          if (cur === doc) return true;
          cur = 'parentNode' in cur ? cur.parentNode : null;
        }
        return false;
      },
      get parentNode() {
        return node.parentNode && 'tagName' in node.parentNode ? wrap(node.parentNode) : docWrapper;
      },
      get parentElement() {
        return node.parentNode && 'tagName' in node.parentNode ? wrap(node.parentNode) : null;
      },
      get textContent() {
        return getText(node);
      },
      get innerText() {
        return getText(node);
      },
      get isContentEditable() {
        return false;
      },
      getAttribute(name: string) {
        if (name === 'id') return node.id ?? null;
        if (name === 'disabled') return node.disabled ? '' : null;
        if (name === 'readonly') return node.readOnly ? '' : null;
        return node.attrs?.[name] ?? null;
      },
      matches(sel: string) {
        return matchesSelector(node, sel);
      },
      closest(sel: string) {
        let cur: MiniNode | MiniDoc | null = node;
        while (cur && 'tagName' in cur) {
          if (matchesSelector(cur, sel)) return wrap(cur);
          cur = cur.parentNode;
        }
        return null;
      },
      querySelectorAll(sel: string) {
        const all: MiniNode[] = [];
        walk(node.children, all);
        return all.filter((n) => matchesSelector(n, sel)).map(wrap);
      },
      getClientRects() {
        const r = node.rect ?? { left: 10, top: 10, width: 100, height: 30 };
        return r.width > 0 && r.height > 0 ? [r] : [];
      },
      getBoundingClientRect() {
        const r = node.rect ?? { left: 10, top: 10, width: 100, height: 30 };
        return {
          ...r,
          x: r.left,
          y: r.top,
          right: r.left + r.width,
          bottom: r.top + r.height,
        };
      },
      checkVisibility() {
        return node.checkVis !== undefined ? node.checkVis : true;
      },
      getRootNode() {
        return docWrapper;
      },
    };
    const tag = node.tagName.toUpperCase();
    if (tag === 'INPUT') Object.setPrototypeOf(obj, FakeInput.prototype);
    else if (tag === 'TEXTAREA') Object.setPrototypeOf(obj, FakeTextArea.prototype);
    else if (tag === 'SELECT') Object.setPrototypeOf(obj, FakeSelect.prototype);
    wrappedMap.set(node, obj);
    return obj;
  }
  let readyStateReader: () => string = () => 'complete';
  const docWrapper = {
    nodeType: 9,
    get readyState() {
      return readyStateReader();
    },
    querySelectorAll(sel: string) {
      const all: MiniNode[] = [];
      walk(doc.children, all);
      return all.filter((n) => matchesSelector(n, sel)).map(wrap);
    },
    elementFromPoint(x: number, y: number) {
      const all: MiniNode[] = [];
      walk(doc.children, all);
      for (const n of all) {
        const r = n.rect ?? { left: 10, top: 10, width: 100, height: 30 };
        if (x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height)
          return wrap(n);
      }
      return null;
    },
  };

  function create(spec: Partial<MiniNode> & { tagName: string }, parent?: MiniNode): MiniNode {
    const node: MiniNode = {
      backendNodeId: ++nextId,
      tagName: spec.tagName,
      id: spec.id,
      classes: spec.classes,
      attrs: spec.attrs,
      text: spec.text,
      type: spec.type,
      disabled: spec.disabled,
      readOnly: spec.readOnly,
      checked: spec.checked,
      display: spec.display ?? 'block',
      visibility: spec.visibility ?? 'visible',
      pointerEvents: spec.pointerEvents ?? 'auto',
      checkVis: spec.checkVis,
      rect: spec.rect ?? { left: 10, top: 10, width: 100, height: 30 },
      parentNode: parent ?? doc,
      children: [],
    };
    byId.set(node.backendNodeId, node);
    if (parent) parent.children.push(node);
    else doc.children.push(node);
    return node;
  }

  const sandbox = vm.createContext({
    document: docWrapper,
    window: { innerWidth: 800, innerHeight: 600 },
    innerWidth: 800,
    innerHeight: 600,
    Node: { ELEMENT_NODE: 1 },
    Element: Object,
    HTMLElement: Object,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    HTMLSelectElement: FakeSelect,
    getComputedStyle(el: { __backendNodeId: number }) {
      const raw = byId.get(el.__backendNodeId)!;
      return {
        display: raw.display ?? 'block',
        visibility: raw.visibility ?? 'visible',
        pointerEvents: raw.pointerEvents ?? 'auto',
      };
    },
  });

  const bind = (val: unknown): string => {
    const id = `1.8.${++nextObj}`;
    objs.set(id, val);
    return id;
  };

  let callCount = 0;
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 8 }));
  chrome.handle('Runtime.releaseObjectGroup', () => {});
  chrome.handle('DOM.getDocument', () => ({
    root: {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      localName: '',
      nodeValue: '',
      children: [],
    },
  }));
  chrome.handle('DOM.resolveNode', (params) => {
    const node = byId.get(params!.backendNodeId!);
    if (!node) throw new ProtocolError('DOM.resolveNode', -32000, 'No node with given id found');
    return { object: { type: 'object', objectId: bind(wrap(node)) } };
  });
  chrome.handle('DOM.describeNode', (params) => {
    const target = objs.get(params!.objectId!) as { __backendNodeId?: number } | undefined;
    return {
      node: {
        nodeId: target?.__backendNodeId ?? 1,
        backendNodeId: target?.__backendNodeId ?? 1,
        nodeType: 1,
        nodeName: 'DIV',
        localName: 'div',
        nodeValue: '',
      },
    };
  });
  chrome.handle('Runtime.getProperties', (params) => {
    const arr = objs.get(params.objectId) as unknown[];
    return {
      result: Array.isArray(arr)
        ? arr.map((item, i) => ({
            name: String(i),
            value: { type: 'object', objectId: bind(item) },
            configurable: true,
            enumerable: true,
          }))
        : [],
    };
  });
  chrome.handle('Runtime.callFunctionOn', (params) => {
    callCount++;
    const fn = vm.runInContext(`(${params.functionDeclaration})`, sandbox) as (
      ...a: unknown[]
    ) => unknown;
    const thisArg = params.objectId ? objs.get(params.objectId) : undefined;
    const args = (params.arguments ?? []).map((a) => (a.objectId ? objs.get(a.objectId) : a.value));
    const value = fn.apply(thisArg, args);
    if (params.returnByValue) return { result: { type: typeof value as 'object', value } };
    return { result: { type: 'object', objectId: bind(value) } };
  });

  return {
    create,
    getCallCount: () => callCount,
    resetCallCount: () => (callCount = 0),
    setReadyState: (fn: () => string) => {
      readyStateReader = fn;
    },
  };
}

test('1. { text } blocks disabled pointer-events:none controls from degrading to outer wrappers while preserving decorative children and SVG tag exclusion', async () => {
  await using chrome = await ScriptedChrome.start();
  const dom = installMiniDom(chrome);
  // Disabled button with pointer-events:none inside enabled wrapper div -> must NOT match wrapper!
  const disabledWrap = dom.create({ tagName: 'DIV', classes: ['disabled-wrap'] });
  dom.create(
    { tagName: 'BUTTON', disabled: true, pointerEvents: 'none', text: '加载更多' },
    disabledWrap,
  );
  // aria-disabled="true" with pointer-events:none inside enabled wrapper div -> must NOT match wrapper!
  const ariaWrap = dom.create({ tagName: 'DIV', classes: ['aria-wrap'] });
  dom.create(
    {
      tagName: 'SPAN',
      attrs: { role: 'button', 'aria-disabled': 'true' },
      pointerEvents: 'none',
      text: '已禁用按钮',
    },
    ariaWrap,
  );
  // Enabled button containing decorative pointer-events:none span -> SHOULD match the button!
  const activeBtn = dom.create({ tagName: 'BUTTON', id: 'active-btn' });
  dom.create({ tagName: 'SPAN', pointerEvents: 'none', text: '继续学习' }, activeBtn);
  // Lowercase SVG <script> tag must be excluded by case-insensitive tag filter.
  dom.create({ tagName: 'script', text: 'hiddenSvgScript' });

  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;

  assert.deepEqual(await tab.queryAll({ text: '加载更多' }), []);
  assert.deepEqual(await tab.queryAll({ text: '已禁用按钮' }), []);
  const activeMatches = await tab.queryAll({ text: '继续学习' });
  assert.equal(activeMatches.length, 1);
  assert.equal(activeMatches[0]!.backendNodeId, activeBtn.backendNodeId);
  assert.deepEqual(await tab.queryAll({ text: 'hiddenSvgScript' }), []);
});

test('2. findExecutable respectEnv precedence, non-contradictory channel errors, PATH resolution and launch channel validation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nodriver-find-'));
  const origChromePath = process.env.CHROME_PATH;
  const origPath = process.env.PATH;
  try {
    const fakeEnvBin = join(dir, 'custom-chrome.exe');
    await writeFile(fakeEnvBin, '');
    process.env.CHROME_PATH = fakeEnvBin;

    // respectEnv: true gives CHROME_PATH precedence over prefer.
    assert.equal(
      await findExecutable({ prefer: ['edge', 'chrome'], respectEnv: true }),
      resolve(fakeEnvBin),
    );
    // Empty string is rejected explicitly.
    await assert.rejects(findExecutable(''), TypeError);
    await assert.rejects(findExecutable({ executablePath: '' }), TypeError);
    // Browser.launch({ channel: [] }) names 'channel', NOT 'prefer'.
    await assert.rejects(Browser.launch({ channel: [] as never }), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /channel/i);
      assert.doesNotMatch(error.message, /prefer/i);
      return true;
    });
    // When respectEnv is false and channel is missing, error must NOT misleadingly say "set CHROME_PATH" alone.
    const binDir = join(dir, 'bin');
    await mkdir(binDir);
    const fakeChromium = join(binDir, process.platform === 'win32' ? 'chromium.exe' : 'chromium');
    await writeFile(fakeChromium, '');
    process.env.PATH = binDir;
    delete process.env.CHROME_PATH;
    // PATH discovery finds chromium and returns resolved absolute path.
    assert.equal(await findExecutable({ prefer: ['chromium'] }), resolve(fakeChromium));

    // Empty PATH with respectEnv: false + missing channel gives accurate hint mentioning respectEnv: true.
    process.env.PATH = dir;
    process.env.CHROME_PATH = fakeEnvBin;
    // Use chromium channel which has no default Windows Program Files candidate.
    if (process.platform === 'win32') {
      await assert.rejects(findExecutable({ prefer: ['chromium'] }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /respectEnv: true/);
        return true;
      });
    }
  } finally {
    if (origChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = origChromePath;
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('3. Unified visibility, batched Locator.filter({ visible, enabled }), complementary Locator.waitFor, and Tab/Frame.waitForLoadState', async () => {
  await using chrome = await ScriptedChrome.start();
  const dom = installMiniDom(chrome);
  const zeroBox = dom.create({
    tagName: 'BUTTON',
    classes: ['item'],
    text: 'Go',
    rect: { left: 0, top: 0, width: 0, height: 0 },
  });
  const checkVisFalse = dom.create({
    tagName: 'BUTTON',
    classes: ['item'],
    text: 'Go',
    checkVis: false,
  });
  const visibleDisabled = dom.create({
    tagName: 'BUTTON',
    classes: ['item'],
    text: 'Go',
    disabled: true,
  });
  const visibleEnabled = dom.create({
    tagName: 'BUTTON',
    classes: ['item'],
    text: 'Go',
    disabled: false,
  });

  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;

  // queryAll({ visible: true }) and Element.isVisible() agree on 0x0 and checkVisibility:false.
  const visibleItems = await tab.queryAll('.item', { visible: true });
  assert.deepEqual(
    visibleItems.map((e) => e.backendNodeId),
    [visibleDisabled.backendNodeId, visibleEnabled.backendNodeId],
  );
  assert.equal(
    await new Element(
      tab.mainFrame,
      zeroBox.backendNodeId,
      tab.mainFrame.generation,
      tab.session,
    ).isVisible(),
    false,
  );
  assert.equal(
    await new Element(
      tab.mainFrame,
      checkVisFalse.backendNodeId,
      tab.mainFrame.generation,
      tab.session,
    ).isVisible(),
    false,
  );

  // Locator.filter({ hasText, visible: true, enabled: true }) executes in a single batch callFunctionOn!
  dom.resetCallCount();
  const filtered = await tab
    .locator('.item')
    .filter({ hasText: 'Go', visible: true, enabled: true })
    .all();
  assert.deepEqual(
    filtered.map((e) => e.backendNodeId),
    [visibleEnabled.backendNodeId],
  );
  // 1 query callFunctionOn + 1 batched filter callFunctionOn = 2 total (NOT 4 sequential probes).
  assert.equal(dom.getCallCount(), 2);

  // Strictly complementary Locator.isVisible() / waitFor('visible'|'hidden') when [hidden, visible] exist:
  const allItems = tab.locator('.item');
  assert.equal(await allItems.isVisible(), true);
  assert.equal(await allItems.first().isVisible(), false);
  assert.equal(await allItems.nth(3).isVisible(), true);
  await allItems.waitFor({ state: 'visible', timeout: 500 });
  await allItems.first().waitFor({ state: 'hidden', timeout: 500 });

  // Tab.waitForLoadState retries across transient context-gone and validates LoadState.
  await assert.rejects(tab.waitForLoadState('bogus' as never), TypeError);
  let readyAttempts = 0;
  dom.setReadyState(() => {
    readyAttempts++;
    if (readyAttempts === 1)
      throw new ProtocolError('Runtime.evaluate', -32000, 'Execution context was destroyed');
    if (readyAttempts === 2) return 'loading';
    return 'interactive';
  });
  await tab.waitForLoadState('interactive', { timeout: 1000 });
  assert.equal(readyAttempts, 3);
});

test('4. BrowserContext.origins, clearSiteData exclusions/allKnown/non-repoisoning, Browser.tabNavigated, TabScope.navigated & openerFrameId, and ScriptedChrome navigation helpers', async () => {
  await using chrome = await ScriptedChrome.start({
    pages: [{ url: 'https://keep.example/home' }],
  });
  const offNav = chrome.handleNavigation();
  chrome.handle('Page.getNavigationHistory', () => ({ currentIndex: 0, entries: [] }));
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
  chrome.handle('Runtime.callFunctionOn', () => ({ result: { type: 'undefined' } }));
  chrome.handle('Network.setBypassServiceWorker', () => {});
  chrome.handle('Fetch.enable', () => {});
  chrome.handle('Fetch.disable', () => {});

  const clearedOrigins: string[] = [];
  const deletedCookies: string[] = [];
  let cookies: Protocol.Network.Cookie[] = [
    { name: 'k', domain: 'KEEP.EXAMPLE', path: '/' } as Protocol.Network.Cookie,
    { name: 'd', domain: 'drop.example', path: '/' } as Protocol.Network.Cookie,
    {
      name: 'p-drop',
      domain: 'cdn.other',
      path: '/',
      partitionKey: { topLevelSite: 'https://drop.example' },
    } as unknown as Protocol.Network.Cookie,
    {
      name: 'p-keep',
      domain: 'cdn.other',
      path: '/',
      partitionKey: { topLevelSite: 'https://keep.example' },
    } as unknown as Protocol.Network.Cookie,
    { name: 'local', domain: '127.0.0.1', path: '/' } as Protocol.Network.Cookie,
  ];
  chrome.handle('Storage.clearDataForOrigin', ({ origin }) => {
    clearedOrigins.push(origin);
  });
  chrome.handle('Storage.getCookies', () => ({ cookies }));
  chrome.handle('Network.deleteCookies', ({ name, domain }) => {
    deletedCookies.push(`${name}@${domain}`);
    cookies = cookies.filter((c) => c.name !== name || c.domain !== domain);
  });

  await using browser = await chrome.connect();
  const browserNavEvents: TabNavigationEvent[] = [];
  const offBrowserNav = browser.tabNavigated.on((ev) => {
    browserNavEvents.push(ev);
  });

  const keepTab = browser.tabs[0]!;
  await using scope = browser.tabScope();
  const scopeNavEvents: TabNavigationEvent[] = [];
  scope.navigated.on((ev) => {
    scopeNavEvents.push(ev);
  });

  // ScriptedChrome.handleNavigation handles browser.newTab(url) & tab.goto() & commitNavigation().
  const dropTab = await scope.newTab('https://drop.example/app');
  await dropTab.goto('http://127.0.0.1:4000/dev');
  const waitCommit = dropTab.waitForNavigation({ waitUntil: 'load' });
  chrome.commitNavigation(dropTab.cdp.id!, 'https://drop.example/after');
  await waitCommit;

  assert.ok(browserNavEvents.some((e) => e.url === 'https://drop.example/after'));
  assert.ok(scopeNavEvents.some((e) => e.url === 'https://drop.example/after'));
  // Navigation on keepTab (outside scope) emits on browser.tabNavigated, NOT scope.navigated.
  const scopeCountBefore = scopeNavEvents.length;
  await keepTab.goto('https://keep.example/next');
  assert.equal(scopeNavEvents.length, scopeCountBefore);
  assert.equal(browserNavEvents.at(-1)!.url, 'https://keep.example/next');

  // Snapshot origins read-only accessors.
  assert.ok(browser.defaultContext.origins.includes('https://keep.example'));
  assert.ok(browser.defaultContext.origins.includes('https://drop.example'));
  assert.ok(dropTab.origins.includes('https://drop.example'));

  // Validation: empty clearSiteData or excludeDomains without allKnown rejects with TypeError.
  await assert.rejects(browser.defaultContext.clearSiteData({}), TypeError);
  await assert.rejects(
    browser.defaultContext.clearSiteData({ excludeDomains: ['keep.example'] }),
    TypeError,
  );

  // allKnown + excludeDomains + excludeOrigins keeps keep.example and http://127.0.0.1:4000,
  // deletes drop.example (including partitioned cookie), and does NOT re-poison origins on 'blank'.
  const result = await browser.defaultContext.clearSiteData({
    allKnown: true,
    excludeDomains: ['keep.example'],
    excludeOrigins: ['http://127.0.0.1:4000'],
    openTabs: 'blank',
  });
  assert.ok(clearedOrigins.includes('https://drop.example'));
  assert.ok(!clearedOrigins.includes('https://keep.example'));
  assert.ok(!clearedOrigins.includes('http://127.0.0.1:4000'));
  assert.ok(deletedCookies.includes('d@drop.example'));
  assert.ok(deletedCookies.includes('p-drop@cdn.other'));
  assert.ok(!deletedCookies.some((c) => c.startsWith('k@')));
  assert.ok(!deletedCookies.some((c) => c.startsWith('p-keep@')));
  assert.ok(!deletedCookies.some((c) => c.startsWith('local@')));
  assert.ok(result.tabs.includes(dropTab.id));
  // Cleared origin was NOT re-recorded by visitOrigins during 'blank'!
  assert.ok(!browser.defaultContext.origins.includes('https://drop.example'));
  assert.ok(!dropTab.origins.includes('https://drop.example'));
  assert.ok(browser.defaultContext.origins.includes('https://keep.example'));

  // TabScope tracks popups opened via openerFrameId and accepts WaitOptions on close().
  const popupReady = browser.waitForTab((t) => t.url === 'https://popup.example/');
  const popupId = chrome.addPage({
    url: 'https://popup.example/',
    openerFrameId: dropTab.mainFrame.id,
  });
  const popup = await popupReady;
  assert.ok(scope.tabs.some((t) => t.id === popup.id));
  const closeResult = await scope.close({ timeout: 2000 });
  assert.ok(closeResult.closed.includes(popupId));

  // Unknown Target.closeTarget returns ProtocolError(-32602).
  await assert.rejects(
    browser.cdp.send('Target.closeTarget', { targetId: 'does-not-exist' }),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.code, -32602);
      return true;
    },
  );
  offBrowserNav();
  offNav();
});

test('5. ActionabilityError on setChecked/fill/select, hover & screenshot on disabled elements, read-only probe release non-blocking, Keyboard.type no trailing pause, waitUntil validation', async () => {
  await using chrome = await ScriptedChrome.start();
  const dom = installMiniDom(chrome);
  const radio = dom.create({
    tagName: 'INPUT',
    type: 'radio',
    checked: true,
    disabled: false,
    rect: { left: 10, top: 10, width: 100, height: 30 },
  });
  const disabledText = dom.create({
    tagName: 'INPUT',
    type: 'text',
    disabled: true,
    rect: { left: 10, top: 50, width: 100, height: 30 },
  });
  const disabledBtn = dom.create({
    tagName: 'BUTTON',
    disabled: true,
    text: 'Disabled',
    rect: { left: 10, top: 100, width: 100, height: 30 },
  });
  chrome.handle('Page.bringToFront', () => {});
  chrome.handle('DOM.scrollIntoViewIfNeeded', () => {});
  chrome.handle('DOM.getContentQuads', () => ({ quads: [[10, 100, 110, 100, 110, 130, 10, 130]] }));
  chrome.handle(
    'Page.getLayoutMetrics',
    () =>
      ({
        cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
      }) as Protocol.Page.GetLayoutMetricsResponse,
  );
  chrome.handle('Input.dispatchMouseEvent', () => {});
  chrome.handle('Input.insertText', () => {});
  chrome.handle('Page.captureScreenshot', () => ({ data: Buffer.from('png').toString('base64') }));

  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  chrome.handle('DOM.getNodeForLocation', () => ({
    backendNodeId: disabledBtn.backendNodeId,
    frameId: tab.mainFrame.id,
  }));
  const radioEl = new Element(
    tab.mainFrame,
    radio.backendNodeId,
    tab.mainFrame.generation,
    tab.session,
  );
  const textEl = new Element(
    tab.mainFrame,
    disabledText.backendNodeId,
    tab.mainFrame.generation,
    tab.session,
  );
  const btnEl = new Element(
    tab.mainFrame,
    disabledBtn.backendNodeId,
    tab.mainFrame.generation,
    tab.session,
  );

  // Navigation waitUntil validation.
  await assert.rejects(tab.goto('https://example.com', { waitUntil: 'bogus' as never }), TypeError);

  // setChecked(false) on checked radio throws InputActionError with ActionabilityError cause.
  await assert.rejects(radioEl.setChecked(false), (error: unknown) => {
    assert.ok(error instanceof InputActionError);
    assert.ok(error.cause instanceof ActionabilityError);
    return true;
  });

  // select() on non-<select> throws ActionabilityError (not EvaluationError).
  await assert.rejects(radioEl.select('a'), ActionabilityError);

  // fill() on disabled element throws InputActionError with ActionabilityError cause.
  await assert.rejects(textEl.fill('abc', { timeout: 100 }), (error: unknown) => {
    assert.ok(error instanceof InputActionError);
    assert.ok(error.cause instanceof ActionabilityError);
    return true;
  });

  // screenshot() and hover() succeed on visible disabled elements!
  const shot = await btnEl.screenshot();
  assert.ok(Buffer.isBuffer(shot) && shot.length > 0);
  await btnEl.hover({ timeout: 1000 });

  // Read-only probe Runtime.releaseObjectGroup failure inside an input action does NOT block the connection.
  let failReleaseOnce = true;
  chrome.handle('Runtime.releaseObjectGroup', () => {
    if (failReleaseOnce) {
      failReleaseOnce = false;
      throw new ProtocolError('Runtime.releaseObjectGroup', -32000, 'transient probe release fail');
    }
  });
  await btnEl.hover({ timeout: 1000 });
  // Connection is NOT InputBlockedError: next input action succeeds!
  await tab.keyboard.insertText('still works');

  // Keyboard.type() skips trailing keyDelay on final segment: 3 chars with 50ms delay -> plannedMs === 100.
  tab.setInputPolicy({ mode: 'human', typing: 'insertText', keyDelay: () => 50, pause: [0, 0] });
  const report = await tab.keyboard.type(['a', 'b', 'c']);
  assert.equal(report.plannedMs, 100);
});

test('6. Connection.drain() ignores detached sessions by default, supports detached:"throw", bounds detachedWires, and provides session.drain()', async () => {
  class ManualTransport implements Transport {
    onmessage?: (message: string) => void;
    onclose?: (reason: Error) => void;
    commands: Array<{ id: number; method: string; sessionId?: string }> = [];
    send(message: string): void {
      this.commands.push(JSON.parse(message));
    }
    close(): void {}
    reply(index: number, fields: Record<string, unknown> = { result: {} }): void {
      const cmd = this.commands[index]!;
      this.onmessage?.(JSON.stringify({ id: cmd.id, sessionId: cmd.sessionId, ...fields }));
    }
    emit(method: string, params: unknown, sessionId?: string): void {
      this.onmessage?.(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
    }
  }

  // Test all three detach triggers: Target.detachedFromTarget, Target.targetDestroyed, Target.targetCrashed.
  for (const trigger of ['detachedFromTarget', 'targetDestroyed', 'targetCrashed'] as const) {
    const t = new ManualTransport();
    const responses: ResponseObservation[] = [];
    const c = new Connection(t, { observe: { onResponse: (e) => responses.push(e) } });
    try {
      // Register TargetSessions on connection via attachSession for realistic lifecycle:
      const attachA = c.attachSession('target-a');
      t.reply(0, { result: { sessionId: 'ta-1' } });
      const sessA = await attachA;
      const attachB = c.attachSession('target-b');
      t.reply(1, { result: { sessionId: 'tb-1' } });
      const sessB = await attachB;

      // Issue in-flight command on sessA and sessB.
      const cmdA = sessA.send('Runtime.evaluate', { expression: '1' });
      const cmdB = sessB.send('Runtime.evaluate', { expression: '2' });
      assert.equal(c.unansweredCount, 2);

      // Session-scoped drain for sessB does NOT wait for sessA (and vice versa).
      let bDrained = false;
      const drainB = sessB.drain({ timeout: 500 }).then(() => {
        bDrained = true;
      });
      // Reply only to sessB -> sessB.drain() resolves immediately even though sessA is still unanswered!
      t.reply(3, { result: { result: { type: 'number', value: 2 } } });
      await cmdB;
      await drainB;
      assert.equal(bDrained, true);
      assert.equal(c.unansweredCount, 1);

      // Trigger detach/destroy/crash on sessA while cmdA is still unanswered.
      const cmdARejected = assert.rejects(cmdA, SessionEndedError);
      if (trigger === 'detachedFromTarget')
        t.emit('Target.detachedFromTarget', { sessionId: 'ta-1', targetId: 'target-a' });
      else if (trigger === 'targetDestroyed')
        t.emit('Target.targetDestroyed', { targetId: 'target-a' });
      else {
        t.emit('Target.targetCrashed', { targetId: 'target-a', status: 'crashed', errorCode: 1 });
        // Reply to the automatic cleanup detach for crashed target.
        const cleanupIdx = t.commands.findIndex((cmd) => cmd.method === 'Target.detachFromTarget');
        if (cleanupIdx >= 0) t.reply(cleanupIdx);
      }
      await cmdARejected;

      // Default drain() resolves immediately (never hangs!) and unansweredCount === 0!
      assert.equal(c.unansweredCount, 0);
      assert.equal(c.detachedUnansweredCount, 1);
      await c.drain({ timeout: 500 });
      await sessB.drain({ detached: 'throw', timeout: 500 });

      // detached: 'throw' rejects immediately with SessionEndedError on connection and sessA!
      await assert.rejects(c.drain({ detached: 'throw', timeout: 500 }), SessionEndedError);
      await assert.rejects(sessA.drain({ detached: 'throw', timeout: 500 }), SessionEndedError);
      assert.throws(() => c.drain({ detached: 'bad' as never }), TypeError);

      // Late browser-level error still correlates observe.onResponse and clears detachedUnansweredCount.
      t.onmessage?.(
        JSON.stringify({
          id: t.commands[2]!.id,
          error: { code: -32001, message: 'Session with given id not found.' },
        }),
      );
      assert.equal(c.detachedUnansweredCount, 0);
      assert.equal(responses.at(-1)!.seq, t.commands[2]!.id);
      assert.equal(responses.at(-1)!.late, true);
      assert.equal(responses.at(-1)!.error, '-32001');
    } finally {
      await c.close();
    }
  }

  // Bounded FIFO retention: 600 detached wires cap at 512 (no unbounded leak).
  const t2 = new ManualTransport();
  const c2 = new Connection(t2);
  try {
    for (let i = 0; i < 600; i++) {
      const sid = `s-${i}`;
      const p = c2.session(sid).send('Runtime.evaluate', { expression: '1' });
      c2.detach(sid);
      await assert.rejects(p, SessionEndedError);
    }
    assert.equal(c2.unansweredCount, 0);
    assert.ok(c2.detachedUnansweredCount <= 512);
    await c2.drain({ timeout: 500 });
  } finally {
    await c2.close();
  }
});

test('7. getNodeEventListeners O(1) objectGroup release, releaseHandles:"none", and types allowlist', async () => {
  await using chrome = await ScriptedChrome.start();
  const releasedObjects: string[] = [];
  const releasedGroups: string[] = [];
  chrome.handle('DOM.resolveNode', (params) => ({
    object: { type: 'object', objectId: `obj-${params!.backendNodeId}` },
  }));
  chrome.handle('DOMDebugger.getEventListeners', () => ({
    listeners: Array.from({ length: 20 }, (_, i) => ({
      type: i % 2 === 0 ? 'click' : 'mousemove',
      useCapture: false,
      passive: false,
      once: false,
      scriptId: '1',
      lineNumber: i,
      columnNumber: 0,
      handler: { type: 'function' as const, objectId: `h-${i}`, description: `fn${i}` },
      originalHandler: { type: 'function' as const, objectId: `oh-${i}`, description: `orig${i}` },
    })),
  }));
  chrome.handle('Runtime.releaseObject', (p) => {
    releasedObjects.push(p.objectId);
  });
  chrome.handle('Runtime.releaseObjectGroup', (p) => {
    releasedGroups.push(p.objectGroup);
  });

  await using browser = await chrome.connect({ attach: 'none' });
  const session = await browser.attachSession(browser.pageTargets[0]!.targetId);

  // { backendNodeId } releases all 40 handler handles in O(1) via 1 Runtime.releaseObjectGroup!
  const clicks = await getNodeEventListeners(
    session,
    { backendNodeId: 10 },
    { depth: -1, pierce: true, types: ['click'] },
  );
  await session.drain();
  assert.equal(clicks.length, 10);
  assert.ok(clicks.every((l) => l.type === 'click'));
  assert.equal(releasedObjects.length, 0);
  assert.equal(releasedGroups.length, 1);

  // { objectId } with releaseHandles: 'none' sends 0 Runtime.releaseObject (caller owns ObjectGroupScope).
  const directNone = await getNodeEventListeners(
    session,
    { objectId: 'caller-group-obj' },
    { releaseHandles: 'none', types: ['mousemove'] },
  );
  await session.drain();
  assert.equal(directNone.length, 10);
  assert.equal(releasedObjects.length, 0);

  // Validation errors on invalid releaseHandles / types.
  await assert.rejects(
    getNodeEventListeners(session, { objectId: 'o' }, { releaseHandles: 'bad' as never }),
    TypeError,
  );
  await assert.rejects(
    getNodeEventListeners(session, { objectId: 'o' }, { types: [''] }),
    TypeError,
  );
});

test('8. isFrameGone(), StaleElementError.reason, parseDOMSnapshot (non-isotropic scale, formValue, O(1) findNodeByBackendId), IsolatedWorld dispose cancellation, and setWindowState timeout message', async () => {
  // isFrameGone() covers StaleElementError.reason, ProtocolError, cause chains, and cycles.
  const frameProto = new ProtocolError(
    'Page.createIsolatedWorld',
    -32000,
    'No frame for given id found',
  );
  const frameStale = new StaleElementError('Frame detached', { reason: 'frame-detached' });
  const wrapped = new Error('outer', { cause: frameStale });
  const cyclic: Record<string, unknown> = {};
  cyclic.cause = cyclic;
  assert.equal(isFrameGone(frameProto), true);
  assert.equal(isFrameGone(frameStale), true);
  assert.equal(isFrameGone(wrapped), true);
  assert.equal(isFrameGone(new StaleElementError('Node gone', { reason: 'node-detached' })), false);
  assert.equal(isFrameGone(cyclic), false);

  // parseDOMSnapshot: non-isotropic cssScale { x, y }, formValue, O(1) findNodeByBackendId.
  const rawSnap: Protocol.DOMSnapshot.CaptureSnapshotResponse = {
    strings: ['', 'HTML', 'INPUT', 'TEXTAREA', 'hello', 'body text', 'f-main', 'f-sub'],
    documents: [
      {
        documentURL: 0,
        title: 0,
        baseURL: 0,
        contentLanguage: 0,
        encodingName: 0,
        publicId: 0,
        systemId: 0,
        frameId: 6,
        nodes: {
          parentIndex: [-1, 0, 0],
          nodeType: [1, 1, 1],
          nodeName: [1, 2, 3],
          backendNodeId: [1, 10, 11],
          inputValue: { index: [1], value: [0] }, // empty string '' on <input>
          textValue: { index: [2], value: [5] }, // 'body text' on <textarea>
        },
        layout: {
          nodeIndex: [1],
          bounds: [[20, 40, 200, 80]],
          text: [-1],
          styles: [[]],
          stackingContexts: { index: [] },
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
      {
        documentURL: 0,
        title: 0,
        baseURL: 0,
        contentLanguage: 0,
        encodingName: 0,
        publicId: 0,
        systemId: 0,
        frameId: 7,
        nodes: {
          parentIndex: [-1],
          nodeType: [1],
          nodeName: [2],
          backendNodeId: [20],
          inputValue: { index: [0], value: [4] },
        },
        layout: {
          nodeIndex: [],
          bounds: [],
          text: [],
          styles: [],
          stackingContexts: { index: [] },
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };
  assert.throws(() => parseDOMSnapshot(rawSnap, { cssScale: { x: 0, y: 2 } }), RangeError);
  const snap = parseDOMSnapshot(rawSnap, { cssScale: { x: 2, y: 4 } });
  assert.equal(snap.cssScaleX, 2);
  assert.equal(snap.cssScaleY, 4);
  assert.deepEqual(snap.findNodeByBackendId(10)!.bounds, { x: 10, y: 10, width: 100, height: 20 });
  assert.equal(snap.findNodeByBackendId(10)!.formValue, ''); // empty string preserved!
  assert.equal(snap.findNodeByBackendId(11)!.formValue, 'body text'); // textarea textValue!
  assert.equal(snap.findNodeByBackendId(20)!.formValue, 'hello'); // cross-document lookup!

  // IsolatedWorld scope:'session' dispose() cancels stuck cold-start command immediately with reason:'disposed'.
  await using chrome = await ScriptedChrome.start();
  chrome.handle('Page.createIsolatedWorld', () => NO_REPLY);
  chrome.handle('Browser.getWindowForTarget', () => ({
    windowId: 1,
    bounds: { windowState: 'normal' },
  }));
  chrome.handle('Browser.setWindowBounds', () => {});
  chrome.handle('Browser.getWindowBounds', async () => {
    await sleep(30);
    return { bounds: { windowState: 'normal' } };
  });
  await using browser = await chrome.connect({ attach: 'none' });
  const targetId = browser.pageTargets[0]!.targetId;
  const session = await browser.attachSession(targetId);

  const world = createIsolatedWorld(session, { scope: 'session', verification: 'strict' });
  const pendingEval = world.evaluate('1', undefined, { timeout: 5000 });
  await sleep(15);
  assert.equal(browser.connection.pendingCount, 1);
  world.dispose();
  await assert.rejects(pendingEval, (error: unknown) => {
    assert.ok(error instanceof StaleElementError);
    assert.equal(error.reason, 'disposed');
    return true;
  });
  // Cold-start command was cancelled locally so pendingCount is immediately 0!
  assert.equal(browser.connection.pendingCount, 0);

  // setWindowState waitForState timeout always reports windowState message even when deadline hits right after getWindowBounds.
  await assert.rejects(
    setWindowState(
      browser.cdp,
      targetId,
      { windowState: 'maximized' },
      { waitForState: true, timeout: 45, pollIntervalMs: 10 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TimeoutError);
      assert.match(error.message, /Timed out waiting for windowState "maximized"/);
      return true;
    },
  );
});

test('9. Crypto isEncryptedState/empty passphrase, Xvfb UnsupportedError, MCP HTTP JSON 401, Handoff PNG/Content-Type, browser_wait, and socket lease retention', async (t) => {
  // Crypto: isEncryptedState + empty passphrase fast RangeError.
  const sealed = await encryptState({ version: 2, cookies: [], origins: [] }, 'passphrase-ok');
  assert.equal(isEncryptedState(sealed), true);
  assert.equal(isEncryptedState(Buffer.from('{"version":2}')), false);
  await assert.rejects(decryptState(sealed, ''), RangeError);

  // XvfbSession on non-Linux throws UnsupportedError.
  if (process.platform !== 'linux') {
    await assert.rejects(XvfbSession.start(), UnsupportedError);
  }

  // MCP HTTP 401 returns JSON { error } and Handoff PNG screencast + mixed-case Content-Type.
  const token = 'z'.repeat(40);
  await using chrome = await ScriptedChrome.start();
  chrome.handle('Page.bringToFront', () => {});
  chrome.handle('Page.startScreencast', () => {});
  chrome.handle('Page.stopScreencast', () => {});
  chrome.handle('Page.screencastFrameAck', () => {});
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
  chrome.handle('Input.dispatchMouseEvent', () => {});
  chrome.handle('Input.insertText', () => {});
  chrome.handle('DOM.getDocument', () => ({
    root: {
      nodeId: 1,
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      localName: '',
      nodeValue: '',
      children: [],
    },
  }));
  const browser = await chrome.connect();
  t.mock.method(Browser, 'launch', async () => browser);

  const service = createBrowserMcpHttpService({
    tokens: { [token]: 'alice' },
    browser: {
      remoteHandoff: { linkInResult: true, screencast: { format: 'png' } },
    },
  });
  let client: Client | undefined;
  try {
    // 401 returns JSON error body.
    const unauth = await service.fetch(
      new Request('http://127.0.0.1:3100/leases', { headers: { host: '127.0.0.1:3100' } }),
    );
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('content-type') ?? '', /application\/json/i);
    assert.equal(typeof ((await unauth.json()) as { error: unknown }).error, 'string');

    // Handoff viewer uses PNG MIME type and accepts mixed-case Content-Type.
    const { id: leaseId } = service.manager.create('alice');
    const server = createBrowserMcpServer(
      { remoteHandoff: { linkInResult: true, screencast: { format: 'png' } } },
      {
        manager: service.manager,
        principal: 'alice',
        leaseId,
        handoffOrigin: () => 'http://127.0.0.1:3100',
      },
    );
    client = new Client(
      { name: 'test', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);

    const opened = (await client.callTool({
      name: 'browser_open',
      arguments: {},
    })) as CallToolResult;
    const tabId = (opened.structuredContent as { tabId: string }).tabId;

    // browser_handoff error uses unified toolError (no duplicate "Error: " prefix).
    const badHandoff = (await client.callTool({
      name: 'browser_handoff',
      arguments: {
        tabId,
        mode: 'elicit',
        resumeCondition: { url: 'https://done.example/*', timeout: 1000 },
      },
    })) as CallToolResult;
    assert.equal(badHandoff.isError, true);
    assert.doesNotMatch((badHandoff.content[0] as { text: string }).text, /^TypeError: Error:/);

    const started = (await client.callTool({
      name: 'browser_handoff',
      arguments: {
        tabId,
        mode: 'remote',
        resumeCondition: { url: 'https://done.example/*', timeout: 5000 },
      },
    })) as CallToolResult;
    const { handoffId, url } = started.structuredContent as { handoffId: string; url: string };
    const pageRes = await service.fetch(new Request(url, { headers: { host: '127.0.0.1:3100' } }));
    assert.equal(pageRes.status, 200);
    const cookie = pageRes.headers.get('set-cookie')!.split(';')[0]!;
    // Mixed-case Content-Type is accepted on handoff input endpoint.
    const inputRes = await service.fetch(
      new Request(`http://127.0.0.1:3100/handoff/${handoffId}/input`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3100',
          origin: 'http://127.0.0.1:3100',
          cookie,
          'content-type': 'Application/JSON; charset=utf-8',
        },
        body: JSON.stringify({ kind: 'text', text: 'hi' }),
      }),
    );
    assert.equal(inputRes.status, 204);
    // Viewer script uses dynamic image MIME type (data:image/${format};base64,) instead of hardcoded jpeg!
    const viewerJs = await (
      await service.fetch(
        new Request(`http://127.0.0.1:3100/handoff/${handoffId}/viewer.js`, {
          headers: { host: '127.0.0.1:3100', cookie },
        }),
      )
    ).text();
    assert.match(viewerJs, /data:image\/' \+ \(format === 'png' \? 'png' : 'jpeg'\) \+ ';base64,/);

    await client.callTool({
      name: 'browser_handoff_wait',
      arguments: { handoffId, cancel: true },
    });
  } finally {
    await client?.close().catch(() => {});
    await service.close();
    await browser.close().catch(() => {});
  }

  // Socket transport retains its lease while connected (not evicted by leaseIdleMs).
  const sockServer = await startBrowserMcpSocketServer({
    tokens: { [token]: 'alice' },
    browser: { leaseIdleMs: 80 },
  });
  try {
    const transport = new BrowserMcpSocketClientTransport({ path: sockServer.path, token });
    await transport.start();
    const sockLeaseId = transport.leaseId!;
    await sleep(160);
    // Lease is still alive while socket stays open!
    assert.equal(
      sockServer.manager.list('alice').some((l) => l.id === sockLeaseId),
      true,
    );
    await transport.close();
  } finally {
    await sockServer.close();
  }
});

test('10. Plain Tab crash retires unanswered requests while preserving navigation recovery, attachTarget timeout cleans up late sessions, and commitNavigation preserves subframe parentId', async () => {
  // (1) Plain Tab crash after timed-out unanswered command + in-flight command, then recover via goto().
  {
    await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://tab.example/' }] });
    const offNav = chrome.handleNavigation();
    chrome.handle('Runtime.evaluate', () => NO_REPLY);
    await using browser = await chrome.connect();
    const tab = browser.tabs[0]!;

    // Command times out BEFORE Target.targetCrashed -> unansweredCount is 1 until crash retires it.
    await assert.rejects(
      tab.cdp.sendWith('Runtime.evaluate', { timeout: 25 }, { expression: 'hang1' }),
      TimeoutError,
    );
    assert.equal(browser.connection.unansweredCount, 1);
    chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
    await sleep(10);
    assert.equal(browser.connection.unansweredCount, 0);
    await browser.drain({ timeout: 300 });
    // Recover the crashed tab before triggering the next renderer crash lifecycle.
    await tab.goto('https://after-first-crash.example/', { waitUntil: 'load', timeout: 1000 });
    assert.equal(tab.url, 'https://after-first-crash.example/');

    // Still-pending command when crashTarget() fires + recovery goto() started synchronously
    // inside Inspector.targetCrashed BEFORE Target.targetCrashed arrives!
    const inFlight = tab.cdp.sendWith(
      'Runtime.evaluate',
      { timeout: 5000 },
      { expression: 'hang2' },
    );
    await sleep(10);
    assert.equal(browser.connection.unansweredCount, 1);
    let recovery!: Promise<string>;
    const offCrash = tab.cdp.on('Inspector.targetCrashed', () => {
      offCrash();
      recovery = tab.goto('https://recovered-immediate.example/', {
        waitUntil: 'load',
        timeout: 1000,
      });
    });
    chrome.crashTarget(tab.id);
    await assert.rejects(inFlight, SessionEndedError);
    await recovery;
    assert.equal(tab.crashed, false);
    assert.equal(tab.closed, false);
    assert.equal(tab.url, 'https://recovered-immediate.example/');
    assert.equal(browser.connection.unansweredCount, 0);
    await browser.drain({ timeout: 300 });

    // A subsequent second crash after recovery still retires new pre-crash commands cleanly.
    const inFlight2 = tab.cdp.sendWith(
      'Runtime.evaluate',
      { timeout: 5000 },
      { expression: 'hang3' },
    );
    await sleep(10);
    chrome.crashTarget(tab.id);
    await assert.rejects(inFlight2, SessionEndedError);
    assert.equal(tab.crashed, true);
    assert.equal(browser.connection.unansweredCount, 0);
    await browser.drain({ timeout: 300 });

    await tab.goto('https://recovered.example/', { waitUntil: 'load', timeout: 1000 });
    assert.equal(tab.crashed, false);
    assert.equal(tab.url, 'https://recovered.example/');
    await browser.drain({ timeout: 300 });

    // Reverse crash notification order: Target.targetCrashed arrives first and triggers goto(),
    // followed by the paired Inspector.targetCrashed -> goto() must NOT be cancelled!
    const reverseRecovery = new Promise<string>((resolve, reject) => {
      const offRootCrash = browser.cdp.on('Target.targetCrashed', ({ targetId }) => {
        if (targetId !== tab.id) return;
        offRootCrash();
        tab
          .goto('https://recovered-reverse.example/', {
            waitUntil: 'load',
            timeout: 1000,
          })
          .then(resolve, reject);
      });
    });
    chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
    chrome.emit('Inspector.targetCrashed', undefined, tab.cdp.id);
    assert.equal(await reverseRecovery, 'https://recovered-reverse.example/');
    assert.equal(tab.crashed, false);
    assert.equal(tab.url, 'https://recovered-reverse.example/');
    await browser.drain({ timeout: 300 });

    // Late paired root Target.targetCrashed arriving AFTER recovery main-frame commit must NOT
    // retire an in-flight Runtime.evaluate on the new document; a later REAL crash still must.
    chrome.emit('Inspector.targetCrashed', undefined, tab.cdp.id);
    await sleep(10);
    assert.equal(tab.crashed, true);
    await tab.goto('https://recovered-before-root.example/', { waitUntil: 'load', timeout: 1000 });
    assert.equal(tab.crashed, false);

    let releaseNewDocEval!: () => void;
    let evalStarted!: () => void;
    const evalGate = new Promise<void>((r) => {
      releaseNewDocEval = r;
    });
    const evalReached = new Promise<void>((r) => {
      evalStarted = r;
    });
    chrome.replyOnce('Runtime.evaluate', async () => {
      evalStarted();
      await evalGate;
      return { result: { type: 'number', value: 7 } };
    });
    const newDocEval = tab.cdp.sendWith('Runtime.evaluate', { timeout: 1000 }, { expression: '7' });
    await evalReached;
    // Lagging Target.targetCrashed from the earlier crash crosses the recovery commit:
    chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
    await sleep(10);
    assert.equal(tab.crashed, false);
    assert.equal(browser.connection.unansweredCount, 1);
    releaseNewDocEval();
    assert.equal((await newDocEval).result.value, 7);

    // Next REAL crash after that paired notification still retires in-flight requests and sets crashed.
    const realCrashEval = tab.cdp.sendWith(
      'Runtime.evaluate',
      { timeout: 5000 },
      { expression: 'hang-after-late-pair' },
    );
    await sleep(10);
    chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
    await assert.rejects(realCrashEval, SessionEndedError);
    assert.equal(tab.crashed, true);
    assert.equal(browser.connection.unansweredCount, 0);
    await browser.drain({ timeout: 300 });

    // Discovery toggle interruption: disable Target discovery -> Inspector-only crash #1 ->
    // recover via goto() -> re-enable Target discovery -> root-only Target.targetCrashed for
    // crash #2 must NOT pair with crash #1 (must set crashed, reject eval, and let drain() finish!).
    await tab.goto('https://before-toggle.example/', { waitUntil: 'load', timeout: 1000 });
    assert.equal(tab.crashed, false);
    await browser.cdp.send('Target.setDiscoverTargets', { discover: false });
    chrome.crashTarget(tab.id); // discovering is false -> only Inspector.targetCrashed is emitted
    await sleep(10);
    assert.equal(tab.crashed, true);
    await tab.goto('https://recovered-after-toggle.example/', { waitUntil: 'load', timeout: 1000 });
    assert.equal(tab.crashed, false);
    await browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    const postToggleEval = tab.cdp.sendWith(
      'Runtime.evaluate',
      { timeout: 5000 },
      { expression: 'hang-after-discovery-reenable' },
    );
    await sleep(10);
    assert.equal(browser.connection.unansweredCount, 1);
    chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
    await assert.rejects(postToggleEval, SessionEndedError);
    assert.equal(tab.crashed, true);
    assert.equal(browser.connection.unansweredCount, 0);
    await browser.drain({ timeout: 300 });

    // Overlapping discover:true requests: first discover:true is still in flight when an
    // Inspector.targetCrashed + recovery commit happen, followed by a second overlapping
    // discover:true. The second discover:true must NOT clear the in-flight crash's pairing, so a
    // late root Target.targetCrashed for that crash leaves the new document's eval untouched!
    await tab.goto('https://before-overlap.example/', { waitUntil: 'load', timeout: 1000 });
    assert.equal(tab.crashed, false);
    await browser.cdp.send('Target.setDiscoverTargets', { discover: false });

    let releaseFirstEnable!: () => void;
    let firstEnableReached!: () => void;
    const firstEnableGate = new Promise<void>((r) => {
      releaseFirstEnable = r;
    });
    const firstEnableArrived = new Promise<void>((r) => {
      firstEnableReached = r;
    });
    chrome.replyOnce('Target.setDiscoverTargets', async () => {
      firstEnableReached();
      await firstEnableGate;
    });
    const enable1 = browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    await firstEnableArrived;

    // Crash arrives while first discover:true is in flight; recover, then send second discover:true.
    chrome.emit('Inspector.targetCrashed', undefined, tab.cdp.id);
    await sleep(10);
    assert.equal(tab.crashed, true);
    await tab.goto('https://recovered-during-overlap.example/', {
      waitUntil: 'load',
      timeout: 1000,
    });
    assert.equal(tab.crashed, false);
    const enable2 = browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    releaseFirstEnable();
    await Promise.all([enable1, enable2]);

    let releaseOverlapEval!: () => void;
    let overlapEvalStarted!: () => void;
    const overlapEvalGate = new Promise<void>((r) => {
      releaseOverlapEval = r;
    });
    const overlapEvalArrived = new Promise<void>((r) => {
      overlapEvalStarted = r;
    });
    chrome.replyOnce('Runtime.evaluate', async () => {
      overlapEvalStarted();
      await overlapEvalGate;
      return { result: { type: 'number', value: 11 } };
    });
    const overlapEval = tab.cdp.sendWith(
      'Runtime.evaluate',
      { timeout: 1000 },
      { expression: '11' },
    );
    await overlapEvalArrived;
    // Lagging root Target.targetCrashed from the crash during enable1 must pair cleanly:
    chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
    await sleep(10);
    assert.equal(tab.crashed, false);
    assert.equal(browser.connection.unansweredCount, 1);
    releaseOverlapEval();
    assert.equal((await overlapEval).result.value, 11);
    await browser.drain({ timeout: 300 });

    // Interleaving A: stale discover:true replies AFTER a newer discover:false already succeeded ->
    // stale true MUST NOT overwrite local discovery=false, so a subsequent Inspector-only crash
    // leaves no dangling pairing and a later root Target.targetCrashed retires the next eval.
    let releaseStaleTrue!: () => void;
    let staleTrueArrived!: () => void;
    const staleTrueGate = new Promise<void>((r) => {
      releaseStaleTrue = r;
    });
    const staleTrueReached = new Promise<void>((r) => {
      staleTrueArrived = r;
    });
    chrome.replyOnce('Target.setDiscoverTargets', async () => {
      staleTrueArrived();
      await staleTrueGate;
    });
    const staleTrue = browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    await staleTrueReached;
    await browser.cdp.send('Target.setDiscoverTargets', { discover: false });
    releaseStaleTrue();
    await staleTrue;
    chrome.crashTarget(tab.id); // peer discovering is false -> Inspector-only crash
    await sleep(10);
    assert.equal(tab.crashed, true);
    await tab.goto('https://recovered-after-stale-true.example/', {
      waitUntil: 'load',
      timeout: 1000,
    });
    assert.equal(tab.crashed, false);
    await browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    const afterStaleTrueEval = tab.cdp.sendWith(
      'Runtime.evaluate',
      { timeout: 5000 },
      { expression: 'hang-after-stale-true' },
    );
    await sleep(10);
    chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
    await assert.rejects(afterStaleTrueEval, SessionEndedError);
    assert.equal(tab.crashed, true);
    assert.equal(browser.connection.unansweredCount, 0);
    await browser.drain({ timeout: 300 });

    // Interleaving B: discover:false is in flight -> Inspector crash + recovery -> discover:true
    // sent -> discover:false replies first, then discover:true replies -> the crash predating
    // discover:true must be closed by discover:false's reply so next root crash retires new eval!
    await tab.goto('https://before-false-true-interleave.example/', {
      waitUntil: 'load',
      timeout: 1000,
    });
    assert.equal(tab.crashed, false);
    let releaseDisable!: () => void;
    let disableArrived!: () => void;
    let releaseReenable!: () => void;
    let reenableArrived!: () => void;
    const disableGate = new Promise<void>((r) => {
      releaseDisable = r;
    });
    const disableReached = new Promise<void>((r) => {
      disableArrived = r;
    });
    const reenableGate = new Promise<void>((r) => {
      releaseReenable = r;
    });
    const reenableReached = new Promise<void>((r) => {
      reenableArrived = r;
    });
    chrome.replyOnce('Target.setDiscoverTargets', async () => {
      disableArrived();
      await disableGate;
    });
    chrome.replyOnce('Target.setDiscoverTargets', async () => {
      reenableArrived();
      await reenableGate;
    });
    const pendingDisable = browser.cdp.send('Target.setDiscoverTargets', { discover: false });
    await disableReached;
    chrome.emit('Inspector.targetCrashed', undefined, tab.cdp.id);
    await sleep(10);
    assert.equal(tab.crashed, true);
    await tab.goto('https://recovered-during-disable.example/', {
      waitUntil: 'load',
      timeout: 1000,
    });
    assert.equal(tab.crashed, false);
    const pendingReenable = browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    await reenableReached;
    // In-order replies: false replies first while true is already in flight, then true replies.
    releaseDisable();
    await pendingDisable;
    releaseReenable();
    await pendingReenable;
    const afterInterleaveEval = tab.cdp.sendWith(
      'Runtime.evaluate',
      { timeout: 5000 },
      { expression: 'hang-after-false-true-interleave' },
    );
    await sleep(10);
    chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
    await assert.rejects(afterInterleaveEval, SessionEndedError);
    assert.equal(tab.crashed, true);
    assert.equal(browser.connection.unansweredCount, 0);
    await browser.drain({ timeout: 300 });

    // Interleaving C: delayed discover:false reply arrives AFTER TWO succeeding discover:true calls
    // with an Inspector crash + recovery between enable #1 and enable #2 -> the disable reply must
    // use enable #1's seq as its boundary (preserving the crash pairing after enable #1) so a late
    // root Target.targetCrashed leaves the recovered document's eval untouched!
    await tab.goto('https://before-double-true-before-false.example/', {
      waitUntil: 'load',
      timeout: 1000,
    });
    assert.equal(tab.crashed, false);
    let releaseDelayedFalse!: () => void;
    let delayedFalseArrived!: () => void;
    const delayedFalseGate = new Promise<void>((r) => {
      releaseDelayedFalse = r;
    });
    const delayedFalseReached = new Promise<void>((r) => {
      delayedFalseArrived = r;
    });
    chrome.replyOnce('Target.setDiscoverTargets', async () => {
      delayedFalseArrived();
      await delayedFalseGate;
    });
    const delayedFalse = browser.cdp.send('Target.setDiscoverTargets', { discover: false });
    await delayedFalseReached;
    // Enable #1 succeeds while delayedFalse is still pending.
    await browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    // Inspector crash + recovery happen AFTER enable #1.
    chrome.emit('Inspector.targetCrashed', undefined, tab.cdp.id);
    await sleep(10);
    assert.equal(tab.crashed, true);
    await tab.goto('https://recovered-between-two-trues.example/', {
      waitUntil: 'load',
      timeout: 1000,
    });
    assert.equal(tab.crashed, false);
    // Enable #2 ALSO succeeds before delayedFalse replies!
    await browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    releaseDelayedFalse();
    await delayedFalse;

    let releaseDoubleTrueEval!: () => void;
    let doubleTrueEvalStarted!: () => void;
    const doubleTrueEvalGate = new Promise<void>((r) => {
      releaseDoubleTrueEval = r;
    });
    const doubleTrueEvalArrived = new Promise<void>((r) => {
      doubleTrueEvalStarted = r;
    });
    chrome.replyOnce('Runtime.evaluate', async () => {
      doubleTrueEvalStarted();
      await doubleTrueEvalGate;
      return { result: { type: 'number', value: 42 } };
    });
    const doubleTrueEval = tab.cdp.sendWith(
      'Runtime.evaluate',
      { timeout: 1000 },
      { expression: '42' },
    );
    await doubleTrueEvalArrived;
    // Lagging root Target.targetCrashed from the crash after enable #1 must pair cleanly:
    chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
    await sleep(10);
    assert.equal(tab.crashed, false);
    assert.equal(browser.connection.unansweredCount, 1);
    releaseDoubleTrueEval();
    assert.equal((await doubleTrueEval).result.value, 42);
    await browser.drain({ timeout: 300 });

    // Interleaving D: delayed discover:false AND delayed failing first discover:true, Inspector
    // crash + recovery, then second discover:true succeeds -> BOTH reply orders (disable-first vs
    // error-first) produce the exact same result: old crash is reconciled up to enable #2 so the
    // next root Target.targetCrashed rejects the new eval and drain() succeeds!
    for (const replyOrder of ['error-first', 'disable-first'] as const) {
      await tab.goto(`https://before-fail-enable-${replyOrder}.example/`, {
        waitUntil: 'load',
        timeout: 1000,
      });
      assert.equal(tab.crashed, false);
      await browser.cdp.send('Target.setDiscoverTargets', { discover: false });

      let releaseDisableD!: () => void;
      let disableDArrived!: () => void;
      let releaseFailEnable!: () => void;
      let failEnableArrived!: () => void;
      const disableDGate = new Promise<void>((r) => {
        releaseDisableD = r;
      });
      const disableDReached = new Promise<void>((r) => {
        disableDArrived = r;
      });
      const failEnableGate = new Promise<void>((r) => {
        releaseFailEnable = r;
      });
      const failEnableReached = new Promise<void>((r) => {
        failEnableArrived = r;
      });
      chrome.replyOnce('Target.setDiscoverTargets', async () => {
        disableDArrived();
        await disableDGate;
      });
      chrome.replyOnce('Target.setDiscoverTargets', async () => {
        failEnableArrived();
        await failEnableGate;
        throw new ProtocolError('Target.setDiscoverTargets', -32000, 'transient enable failure');
      });

      const pendingDisableD = browser.cdp.send('Target.setDiscoverTargets', { discover: false });
      await disableDReached;
      const pendingFailEnable = browser.cdp.send('Target.setDiscoverTargets', { discover: true });
      await failEnableReached;

      chrome.emit('Inspector.targetCrashed', undefined, tab.cdp.id);
      await sleep(10);
      assert.equal(tab.crashed, true);
      await tab.goto(`https://recovered-fail-enable-${replyOrder}.example/`, {
        waitUntil: 'load',
        timeout: 1000,
      });
      assert.equal(tab.crashed, false);

      // Second discover:true succeeds before either pendingDisableD or pendingFailEnable replies.
      await browser.cdp.send('Target.setDiscoverTargets', { discover: true });

      if (replyOrder === 'error-first') {
        releaseFailEnable();
        await assert.rejects(pendingFailEnable, ProtocolError);
        releaseDisableD();
        await pendingDisableD;
      } else {
        releaseDisableD();
        await pendingDisableD;
        releaseFailEnable();
        await assert.rejects(pendingFailEnable, ProtocolError);
      }

      const afterOrderEval = tab.cdp.sendWith(
        'Runtime.evaluate',
        { timeout: 5000 },
        { expression: `hang-${replyOrder}` },
      );
      await sleep(10);
      chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
      await assert.rejects(afterOrderEval, SessionEndedError);
      assert.equal(tab.crashed, true);
      assert.equal(browser.connection.unansweredCount, 0);
      await browser.drain({ timeout: 300 });
    }

    // Interleaving E: discover:false ALREADY confirmed BEFORE a delayed failing first enable ->
    // Inspector crash + recovery -> second enable succeeds -> first enable fails -> crash pairing
    // is reconciled up to enable #2 so the next root Target.targetCrashed rejects eval & drains!
    await tab.goto('https://before-confirmed-disable-fail-enable.example/', {
      waitUntil: 'load',
      timeout: 1000,
    });
    assert.equal(tab.crashed, false);
    await browser.cdp.send('Target.setDiscoverTargets', { discover: false });
    let releaseFailAfterConfirmed!: () => void;
    let failAfterConfirmedArrived!: () => void;
    const failAfterConfirmedGate = new Promise<void>((r) => {
      releaseFailAfterConfirmed = r;
    });
    const failAfterConfirmedReached = new Promise<void>((r) => {
      failAfterConfirmedArrived = r;
    });
    chrome.replyOnce('Target.setDiscoverTargets', async () => {
      failAfterConfirmedArrived();
      await failAfterConfirmedGate;
      throw new ProtocolError('Target.setDiscoverTargets', -32000, 'late enable failure');
    });
    const failingEnable = browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    await failAfterConfirmedReached;
    chrome.emit('Inspector.targetCrashed', undefined, tab.cdp.id);
    await sleep(10);
    assert.equal(tab.crashed, true);
    await tab.goto('https://recovered-confirmed-disable-fail-enable.example/', {
      waitUntil: 'load',
      timeout: 1000,
    });
    assert.equal(tab.crashed, false);
    await browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    releaseFailAfterConfirmed();
    await assert.rejects(failingEnable, ProtocolError);
    const afterConfirmedFailEval = tab.cdp.sendWith(
      'Runtime.evaluate',
      { timeout: 5000 },
      { expression: 'hang-after-confirmed-disable-fail-enable' },
    );
    await sleep(10);
    chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
    await assert.rejects(afterConfirmedFailEval, SessionEndedError);
    assert.equal(tab.crashed, true);
    assert.equal(browser.connection.unansweredCount, 0);
    await browser.drain({ timeout: 300 });

    // Interleaving F: a FAILED discover:false between a delayed succeeding discover:true #1 (with
    // an Inspector crash + recovery during enable #1) and a redundant discover:true #2 must NOT
    // clear enable #1's crash pairing -> late root Target.targetCrashed leaves new doc eval intact!
    await tab.goto('https://before-failed-disable.example/', { waitUntil: 'load', timeout: 1000 });
    assert.equal(tab.crashed, false);
    await browser.cdp.send('Target.setDiscoverTargets', { discover: false });

    let releaseEnableF1!: () => void;
    let enableF1Arrived!: () => void;
    const enableF1Gate = new Promise<void>((r) => {
      releaseEnableF1 = r;
    });
    const enableF1Reached = new Promise<void>((r) => {
      enableF1Arrived = r;
    });
    chrome.replyOnce('Target.setDiscoverTargets', async () => {
      enableF1Arrived();
      await enableF1Gate;
    });
    chrome.replyOnce('Target.setDiscoverTargets', () => {
      throw new ProtocolError('Target.setDiscoverTargets', -32000, 'disable refused');
    });
    const enableF1 = browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    await enableF1Reached;
    chrome.emit('Inspector.targetCrashed', undefined, tab.cdp.id);
    await sleep(10);
    assert.equal(tab.crashed, true);
    await tab.goto('https://recovered-failed-disable.example/', {
      waitUntil: 'load',
      timeout: 1000,
    });
    assert.equal(tab.crashed, false);
    await assert.rejects(
      browser.cdp.send('Target.setDiscoverTargets', { discover: false }),
      ProtocolError,
    );
    const enableF2 = browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    releaseEnableF1();
    await Promise.all([enableF1, enableF2]);

    let releaseFailedDisableEval!: () => void;
    let failedDisableEvalStarted!: () => void;
    const failedDisableEvalGate = new Promise<void>((r) => {
      releaseFailedDisableEval = r;
    });
    const failedDisableEvalArrived = new Promise<void>((r) => {
      failedDisableEvalStarted = r;
    });
    chrome.replyOnce('Runtime.evaluate', async () => {
      failedDisableEvalStarted();
      await failedDisableEvalGate;
      return { result: { type: 'number', value: 88 } };
    });
    const failedDisableEval = tab.cdp.sendWith(
      'Runtime.evaluate',
      { timeout: 1000 },
      { expression: '88' },
    );
    await failedDisableEvalArrived;
    // Lagging root Target.targetCrashed from the crash during enableF1 must pair cleanly:
    chrome.emit('Target.targetCrashed', { targetId: tab.id, status: 'crashed', errorCode: 1 });
    await sleep(10);
    assert.equal(tab.crashed, false);
    assert.equal(browser.connection.unansweredCount, 1);
    releaseFailedDisableEval();
    assert.equal((await failedDisableEval).result.value, 88);
    await browser.drain({ timeout: 300 });

    // Bounded discovery tracking:
    // (a) 64 discover:false commands followed by 1 never-replied discover:true, with all 64
    //     disables replying in REVERSE order -> total discovery tracking state stays strictly
    //     bounded by unanswered count (0 disables + 1 enable = 1)!
    const disableReleases: Array<() => void> = [];
    for (let i = 0; i < 64; i++) {
      chrome.replyOnce(
        'Target.setDiscoverTargets',
        () =>
          new Promise<void>((r) => {
            disableReleases.push(r);
          }),
      );
    }
    chrome.replyOnce('Target.setDiscoverTargets', () => NO_REPLY);
    const disables = Array.from({ length: 64 }, () =>
      browser.cdp.send('Target.setDiscoverTargets', { discover: false }),
    );
    const hungEnable = assert.rejects(
      browser.cdp.sendWith('Target.setDiscoverTargets', { timeout: 25 }, { discover: true }),
      TimeoutError,
    );
    while (disableReleases.length < 64) await sleep(5);
    for (let i = disableReleases.length - 1; i >= 0; i--) disableReleases[i]!();
    await Promise.all(disables);
    await hungEnable;
    const internal = browser.connection as unknown as {
      inFlightDiscoverDisables: Map<number, number>;
      inFlightDiscoverEnables: Map<number, number | undefined>;
    };
    assert.equal(browser.connection.unansweredCount, 1);
    assert.equal(internal.inFlightDiscoverDisables.size, 0);
    assert.equal(internal.inFlightDiscoverEnables.size, 1);

    // (b) 1 never-replied discover:false followed by 100 succeeding discover:true commands keeps
    //     strictly 1 disable entry (no unbounded growth).
    chrome.replyOnce('Target.setDiscoverTargets', () => NO_REPLY);
    await assert.rejects(
      browser.cdp.sendWith('Target.setDiscoverTargets', { timeout: 20 }, { discover: false }),
      TimeoutError,
    );
    for (let i = 0; i < 100; i++) {
      await browser.cdp.send('Target.setDiscoverTargets', { discover: true });
    }
    assert.equal(browser.connection.unansweredCount, 2);
    assert.equal(internal.inFlightDiscoverDisables.size, 1);
    assert.equal(internal.inFlightDiscoverEnables.size, 1);
    offNav();
  }

  // (2) attachTarget() gives concurrent callers independent budgets AND cleans up late session
  //     when the last waiter exits.
  {
    await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://lazy.example/' }] });
    await using browser = await chrome.connect({ attach: 'created' });
    const targetId = browser.pageTargets[0]!.targetId;
    assert.equal(browser.tabs.length, 0);

    // 2a) Single waiter timeout (25ms vs 90ms reply): late session is detached cleanly.
    chrome.attachReplyDelayMs = 90;
    await assert.rejects(browser.attachTarget(targetId, { timeout: 25 }), TimeoutError);
    // drain() waits for the late attach reply AND the automatic Target.detachFromTarget cleanup.
    await browser.drain({ timeout: 1000 });
    assert.equal(browser.tabs.length, 0);
    assert.equal(chrome.commands.filter((c) => c.method === 'Target.detachFromTarget').length, 1);
    assert.equal(
      (await browser.cdp.send('Target.getTargetInfo', { targetId })).targetInfo.attached,
      false,
    );

    // 2b) Two concurrent callers (25ms & 40ms vs 90ms reply): both time out -> last waiter exit
    //     aborts shared attach and cleans up late session.
    const [r1, r2] = await Promise.allSettled([
      browser.attachTarget(targetId, { timeout: 25 }),
      browser.attachTarget(targetId, { timeout: 40 }),
    ]);
    assert.equal(r1.status, 'rejected');
    assert.ok(r1.reason instanceof TimeoutError);
    assert.equal(r2.status, 'rejected');
    assert.ok(r2.reason instanceof TimeoutError);
    await browser.drain({ timeout: 1000 });
    assert.equal(browser.tabs.length, 0);
    assert.equal(chrome.commands.filter((c) => c.method === 'Target.detachFromTarget').length, 2);
    assert.equal(
      (await browser.cdp.send('Target.getTargetInfo', { targetId })).targetInfo.attached,
      false,
    );

    // 2c) Concurrent callers (25ms & 1000ms vs 90ms reply): short waiter fails at 25ms, long waiter
    //     succeeds at 90ms on the same single Target.attachToTarget with zero spurious detach!
    const attachCountBefore = chrome.commands.filter(
      (c) => c.method === 'Target.attachToTarget',
    ).length;
    const detachCountBefore = chrome.commands.filter(
      (c) => c.method === 'Target.detachFromTarget',
    ).length;
    const shortWait = browser.attachTarget(targetId, { timeout: 25 });
    const longWait = browser.attachTarget(targetId, { timeout: 1000 });
    await assert.rejects(shortWait, TimeoutError);
    const adopted = await longWait;
    assert.equal(adopted.id, targetId);
    assert.equal(browser.tabs.length, 1);
    assert.equal(
      chrome.commands.filter((c) => c.method === 'Target.attachToTarget').length,
      attachCountBefore + 1,
    );
    assert.equal(
      chrome.commands.filter((c) => c.method === 'Target.detachFromTarget').length,
      detachCountBefore,
    );

    // 2d) Concurrent caller joining while Page.enable is paused waits for initialization (never
    //     receives a Tab without mainFrame) and survives when the earlier caller times out!
    await browser.cdp.send('Target.detachFromTarget', { sessionId: adopted.session.id! });
    chrome.attachReplyDelayMs = 0;
    let releaseEnable!: () => void;
    let enableStarted!: () => void;
    const enableGate = new Promise<void>((r) => {
      releaseEnable = r;
    });
    const enableReached = new Promise<void>((r) => {
      enableStarted = r;
    });
    chrome.replyOnce('Page.enable', async () => {
      enableStarted();
      await enableGate;
    });
    const firstInit = browser.attachTarget(targetId, { timeout: 40 });
    await enableReached;
    let secondResolvedEarly = false;
    const secondInit = browser.attachTarget(targetId, { timeout: 1000 }).then((tab) => {
      secondResolvedEarly = true;
      return tab;
    });
    await sleep(10);
    assert.equal(secondResolvedEarly, false);
    await assert.rejects(firstInit, TimeoutError);
    releaseEnable();
    const initializedTab = await secondInit;
    assert.equal(initializedTab.closed, false);
    assert.ok(initializedTab.mainFrame);
    assert.equal(initializedTab.mainFrame.id, targetId);
    assert.equal(browser.tabs.length, 1);
  }

  // (3) ScriptedChrome.commitNavigation() preserves parentId for direct and nested subframes.
  {
    await using chrome = await ScriptedChrome.start({
      pages: [{ url: 'https://parent.example/' }],
    });
    await using browser = await chrome.connect();
    const tab = browser.tabs[0]!;
    const mainId = tab.mainFrame.id;

    chrome.emit('Page.frameAttached', { frameId: 'child', parentFrameId: mainId }, tab.cdp.id);
    chrome.emit(
      'Page.frameAttached',
      { frameId: 'grandchild', parentFrameId: 'child' },
      tab.cdp.id,
    );
    await sleep(10);

    chrome.commitNavigation(tab.cdp.id!, 'https://child.example/', { frameId: 'child' });
    chrome.commitNavigation(tab.cdp.id!, 'https://grandchild.example/', { frameId: 'grandchild' });
    await sleep(10);

    assert.equal(tab.mainFrame.id, mainId);
    assert.equal(tab.url, 'https://parent.example/');
    const child = tab.frames.find((f) => f.id === 'child');
    const grandchild = tab.frames.find((f) => f.id === 'grandchild');
    assert.equal(child?.parent?.id, mainId);
    assert.equal(child?.url, 'https://child.example/');
    assert.equal(grandchild?.parent?.id, 'child');
    assert.equal(grandchild?.url, 'https://grandchild.example/');
  }
});

test('11. Partial clearSiteData retains origins for follow-up allKnown, MCP describe() honors timeout/signal, Frame.evaluate() sets frame-detached/context-gone reasons, and getNodeEventListeners({ backendNodeId }) enforces O(1) group cleanup', async (t) => {
  // (4) Partial clearSiteData keeps closed-page origin so follow-up allKnown clears remaining data.
  {
    await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://keep.example/' }] });
    const offNav = chrome.handleNavigation();
    const cleared: Array<{ origin: string; storageTypes: string }> = [];
    chrome.handle('Storage.clearDataForOrigin', ({ origin, storageTypes }) => {
      cleared.push({ origin, storageTypes });
    });
    chrome.handle('Storage.getCookies', () => ({ cookies: [] }));

    await using browser = await chrome.connect();
    const temp = await browser.newTab('https://partial.example/');
    await temp.close();
    assert.ok(browser.defaultContext.origins.includes('https://partial.example'));

    // Partial clear (localStorage + indexedDB only) must NOT forget the origin.
    await browser.defaultContext.clearSiteData({
      origins: ['https://partial.example'],
      types: ['localStorage', 'indexedDB'],
    });
    assert.ok(browser.defaultContext.origins.includes('https://partial.example'));

    // Follow-up allKnown clear still discovers https://partial.example for cacheStorage/serviceWorkers.
    cleared.length = 0;
    await browser.defaultContext.clearSiteData({
      allKnown: true,
      excludeDomains: ['keep.example'],
      types: ['cacheStorage', 'serviceWorkers'],
    });
    assert.ok(
      cleared.some(
        (c) =>
          c.origin === 'https://partial.example' &&
          c.storageTypes.includes('cache_storage') &&
          c.storageTypes.includes('service_workers'),
      ),
    );
    assert.ok(browser.defaultContext.origins.includes('https://partial.example'));

    // Full clear forgets https://partial.example from context.origins.
    await browser.defaultContext.clearSiteData({
      allKnown: true,
      excludeDomains: ['keep.example'],
    });
    assert.ok(!browser.defaultContext.origins.includes('https://partial.example'));
    offNav();
  }

  // (5) MCP describe() passes wait as 3rd arg to Element.evaluate(), honoring caller timeout.
  {
    await using chrome = await ScriptedChrome.start();
    let describeCalls = 0;
    chrome.handle('Page.bringToFront', () => {});
    chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 8 }));
    chrome.handle('Runtime.releaseObjectGroup', () => {});
    chrome.handle('DOM.getDocument', () => ({
      root: {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 9,
        nodeName: '#document',
        localName: '',
        nodeValue: '',
        children: [],
      },
    }));
    chrome.handle('Runtime.callFunctionOn', (params) => {
      if (params.functionDeclaration.includes('inViewport')) {
        describeCalls++;
        return NO_REPLY;
      }
      // queryAll returns 1 matched node object; visibility check returns true.
      if (params.returnByValue) return { result: { type: 'boolean', value: true } };
      return { result: { type: 'object', objectId: '1.8.1' } };
    });
    chrome.handle('Runtime.getProperties', () => ({
      result: [
        {
          name: '0',
          value: { type: 'object', objectId: '1.8.2' },
          configurable: true,
          enumerable: true,
        },
      ],
    }));
    chrome.handle('DOM.describeNode', () => ({
      node: {
        nodeId: 10,
        backendNodeId: 10,
        nodeType: 1,
        nodeName: 'BUTTON',
        localName: 'button',
        nodeValue: '',
      },
    }));
    chrome.handle('DOM.resolveNode', () => ({
      object: { type: 'object', objectId: '1.8.3' },
    }));
    chrome.handle('Accessibility.getPartialAXTree', () => ({ nodes: [] }));

    const browser = await chrome.connect();
    t.mock.method(Browser, 'launch', async () => browser);
    const server = createBrowserMcpServer({});
    const client = new Client(
      { name: 'test', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const opened = (await client.callTool({
        name: 'browser_open',
        arguments: {},
      })) as CallToolResult;
      const tabId = (opened.structuredContent as { tabId: string }).tabId;
      const startedAt = performance.now();
      const res = (await client.callTool({
        name: 'browser_wait',
        arguments: { tabId, selector: '.target', timeout: 80 },
      })) as CallToolResult;
      const elapsed = performance.now() - startedAt;
      assert.equal(res.isError, true);
      assert.ok(describeCalls >= 1);
      assert.ok(elapsed < 1000, `Expected describe() to honor 80ms timeout, took ${elapsed}ms`);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  // (6) Frame.evaluate() sets reason:'frame-detached' when detached mid-flight (isFrameGone === true)
  //     and reason:'context-gone' when navigated mid-flight (isFrameGone === false).
  {
    await using chrome = await ScriptedChrome.start();
    chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 9 }));
    chrome.handle('Runtime.releaseObject', () => {});
    await using browser = await chrome.connect();
    const tab = browser.tabs[0]!;
    chrome.emit(
      'Page.frameAttached',
      { frameId: 'sub', parentFrameId: tab.mainFrame.id },
      tab.cdp.id,
    );
    await sleep(10);
    const sub = tab.frames.find((f) => f.id === 'sub')!;

    chrome.replyOnce('Runtime.evaluate', async () => {
      chrome.emit('Page.frameDetached', { frameId: 'sub', reason: 'remove' }, tab.cdp.id);
      await sleep(10);
      return { result: { type: 'number', value: 42 } };
    });
    await assert.rejects(sub.evaluate('42', undefined, { world: 'isolated' }), (error: unknown) => {
      assert.ok(error instanceof StaleElementError);
      assert.equal(error.reason, 'frame-detached');
      assert.equal(isFrameGone(error), true);
      return true;
    });

    chrome.replyOnce('Runtime.evaluate', async () => {
      chrome.commitNavigation(tab.cdp.id!, 'https://navigated.example/');
      await sleep(10);
      return { result: { type: 'number', value: 99 } };
    });
    await assert.rejects(
      tab.mainFrame.evaluate('99', undefined, { world: 'isolated' }),
      (error: unknown) => {
        assert.ok(error instanceof StaleElementError);
        assert.equal(error.reason, 'context-gone');
        assert.equal(isFrameGone(error), false);
        return true;
      },
    );
  }

  // (7) getNodeEventListeners({ backendNodeId }) ignores releaseHandles:'each'/'none',
  //     always using O(1) objectGroup cleanup and preserving late-reply group release.
  {
    await using chrome = await ScriptedChrome.start();
    const releasedObjects: string[] = [];
    const releasedGroups: string[] = [];
    chrome.handle('DOM.resolveNode', () => ({
      object: { type: 'object', objectId: 'node-10' },
    }));
    chrome.handle('Runtime.releaseObject', (p) => {
      releasedObjects.push(p.objectId);
    });
    chrome.handle('Runtime.releaseObjectGroup', (p) => {
      releasedGroups.push(p.objectGroup);
    });
    chrome.handle('DOMDebugger.getEventListeners', () => ({
      listeners: [
        {
          type: 'click',
          useCapture: false,
          passive: false,
          once: false,
          scriptId: '1',
          lineNumber: 0,
          columnNumber: 0,
          handler: { type: 'function', objectId: 'h-1', description: 'fn1' },
          originalHandler: { type: 'function', objectId: 'oh-1', description: 'orig1' },
        },
      ],
    }));

    await using browser = await chrome.connect({ attach: 'none' });
    const session = await browser.attachSession(browser.pageTargets[0]!.targetId);

    // Passing releaseHandles: 'each' on { backendNodeId } still sends 0 Runtime.releaseObject and 1 group release.
    await getNodeEventListeners(session, { backendNodeId: 10 }, { releaseHandles: 'each' });
    await session.drain();
    assert.equal(releasedObjects.length, 0);
    assert.equal(releasedGroups.length, 1);

    // Passing releaseHandles: 'none' on { backendNodeId } still preserves late-reply group cleanup.
    chrome.replyOnce('DOMDebugger.getEventListeners', async () => {
      await sleep(60);
      return {
        listeners: [
          {
            type: 'click',
            useCapture: false,
            passive: false,
            once: false,
            scriptId: '1',
            lineNumber: 0,
            columnNumber: 0,
            handler: { type: 'function', objectId: 'h-late', description: 'late' },
          },
        ],
      };
    });
    await assert.rejects(
      getNodeEventListeners(
        session,
        { backendNodeId: 10 },
        { releaseHandles: 'none', timeout: 25 },
      ),
      TimeoutError,
    );
    await session.drain({ timeout: 500 });
    assert.equal(releasedObjects.length, 0);
    // 1 (first call) + 1 (finally on timeout) + 1 (late-reply group release after timeout) = 3.
    assert.equal(releasedGroups.length, 3);

    // Late DOM.resolveNode reply after timeout also cleans up via Runtime.releaseObjectGroup (0 Runtime.releaseObject).
    chrome.replyOnce('DOM.resolveNode', async () => {
      await sleep(75);
      return { object: { type: 'object', objectId: 'node-late-10' } };
    });
    await assert.rejects(
      getNodeEventListeners(session, { backendNodeId: 10 }, { timeout: 25 }),
      TimeoutError,
    );
    await session.drain({ timeout: 500 });
    assert.equal(releasedObjects.length, 0);
    // +1 (finally on timeout) + 1 (late DOM.resolveNode group release) = 5.
    assert.equal(releasedGroups.length, 5);
  }
});
