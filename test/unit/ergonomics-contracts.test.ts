import assert from 'node:assert/strict';
import inspector from 'node:inspector';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import type { Protocol } from 'devtools-protocol';
import {
  ActionabilityError,
  Browser,
  DisconnectedError,
  Element,
  EvaluationError,
  InputActionError,
  NodriverError,
  ProtocolError,
  SessionEndedError,
  StaleElementError,
  TimeoutError,
  findExecutable,
  getStartupDiagnostics,
  type Tab,
  type TabNavigationEvent,
} from '../../src/index.ts';
import { Frame } from '../../src/page/frames.ts';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';
import { CONTROL, scriptDom } from '../fixtures/scripted-dom.ts';

interface FakeNode {
  backendNodeId: number;
  tagName: string;
  id?: string;
  classes?: string[];
  attrs?: Record<string, string>;
  text?: string;
  type?: string;
  checked?: boolean;
  disabled?: boolean;
  fieldsetDisabled?: boolean;
  display?: string;
  visibility?: string;
  pointerEvents?: string;
  checkVis?: boolean;
  rect?: { left: number; top: number; width: number; height: number };
  parentNode: FakeNode | FakeDoc | null;
  children: FakeNode[];
  shadowRoot?: FakeDoc;
}
interface FakeDoc {
  nodeType: 9 | 11;
  children: FakeNode[];
  querySelectorAll: (selector: string) => FakeNode[];
}

function makeFakeDom() {
  let nextId = 100;
  const byId = new Map<number, FakeNode>();
  const doc: FakeDoc = {
    nodeType: 9,
    children: [],
    querySelectorAll(selector: string) {
      return collectMatching(this.children, selector);
    },
  };
  function matchesSimple(node: FakeNode, selector: string): boolean {
    if (selector === '*') return true;
    const parts = selector.trim().split(/\s+/);
    if (parts.length > 1) {
      if (!matchesSimple(node, parts.at(-1)!)) return false;
      let cur = node.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) {
        let found = false;
        while (cur && 'tagName' in cur) {
          if (matchesSimple(cur, parts[i]!)) {
            found = true;
            cur = cur.parentNode;
            break;
          }
          cur = cur.parentNode;
        }
        if (!found) return false;
      }
      return true;
    }
    const sel = parts[0]!;
    if (sel.startsWith('#')) return node.id === sel.slice(1);
    if (sel.startsWith('.')) return (node.classes ?? []).includes(sel.slice(1));
    const attrMatch = /^([a-z0-9*]*)?\[([^=\]]+)(?:="([^"]*)")?\]$/i.exec(sel);
    if (attrMatch) {
      const [, tag, attr, val] = attrMatch;
      if (tag && tag !== '*' && node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      const actual = node.attrs?.[attr!];
      return val === undefined ? actual !== undefined : actual === val;
    }
    return node.tagName.toLowerCase() === sel.toLowerCase();
  }
  function walk(nodes: FakeNode[], out: FakeNode[]): void {
    for (const n of nodes) {
      out.push(n);
      walk(n.children, out);
    }
  }
  function collectMatching(roots: FakeNode[], selector: string): FakeNode[] {
    const all: FakeNode[] = [];
    walk(roots, all);
    return all.filter((n) => matchesSimple(n, selector));
  }
  const shadowWrappers = new WeakMap<FakeDoc, Record<string, unknown>>();
  function wrapShadow(shadow: FakeDoc): Record<string, unknown> {
    if (shadowWrappers.has(shadow)) return shadowWrappers.get(shadow)!;
    const w = {
      nodeType: 11,
      querySelectorAll: (sel: string) => shadow.querySelectorAll(sel).map(wrap),
    };
    shadowWrappers.set(shadow, w);
    return w;
  }
  function attachShadow(host: FakeNode): FakeDoc {
    const shadow: FakeDoc = {
      nodeType: 11,
      children: [],
      querySelectorAll(selector: string) {
        return collectMatching(this.children, selector);
      },
    };
    host.shadowRoot = shadow;
    return shadow;
  }
  function createNode(
    spec: Partial<FakeNode> & { tagName: string },
    parent?: FakeNode | FakeDoc,
  ): FakeNode {
    const node: FakeNode = {
      backendNodeId: ++nextId,
      tagName: spec.tagName.toUpperCase(),
      id: spec.id,
      classes: spec.classes ?? [],
      attrs: { ...(spec.attrs ?? {}) },
      text: spec.text,
      type: spec.type,
      checked: spec.checked ?? false,
      disabled: spec.disabled ?? false,
      fieldsetDisabled: spec.fieldsetDisabled ?? false,
      display: spec.display ?? 'block',
      visibility: spec.visibility ?? 'visible',
      pointerEvents: spec.pointerEvents,
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
  function detachNode(node: FakeNode): void {
    const parent = node.parentNode;
    if (parent) {
      parent.children = parent.children.filter((c) => c !== node);
      node.parentNode = null;
    }
  }
  function isConnected(node: FakeNode): boolean {
    let cur: FakeNode | FakeDoc | null = node;
    while (cur) {
      if (cur === doc) return true;
      if ('nodeType' in cur && cur.nodeType === 11) return true;
      cur = 'parentNode' in cur ? cur.parentNode : null;
    }
    return false;
  }
  function effectivePointerEvents(node: FakeNode): string {
    let cur: FakeNode | FakeDoc | null = node;
    while (cur && 'tagName' in cur) {
      if (cur.pointerEvents !== undefined) return cur.pointerEvents;
      cur = cur.parentNode;
    }
    return 'auto';
  }
  function textOfNode(node: FakeNode): string {
    if (node.children.length === 0) return node.text ?? '';
    return (node.text ?? '') + node.children.map(textOfNode).join('');
  }
  class FakeHTMLInputElement {}
  function wrap(node: FakeNode): Record<string, unknown> {
    if (wrappedCache.has(node)) return wrappedCache.get(node)!;
    const obj: Record<string, unknown> =
      node.tagName === 'INPUT' ? Object.create(FakeHTMLInputElement.prototype) : {};
    Object.defineProperties(obj, {
      __node: { value: node },
      tagName: { get: () => node.tagName },
      type: { get: () => node.type ?? '' },
      checked: {
        get: () => !!node.checked,
        set: (v: boolean) => {
          node.checked = v;
        },
      },
      isConnected: { get: () => isConnected(node) },
      textContent: { get: () => textOfNode(node) },
      parentNode: {
        get: () =>
          node.parentNode && 'tagName' in node.parentNode
            ? wrap(node.parentNode)
            : node.parentNode && node.parentNode !== doc
              ? wrapShadow(node.parentNode)
              : docWrapper,
      },
      children: { get: () => node.children.map(wrap) },
      shadowRoot: {
        get: () => (node.shadowRoot ? wrapShadow(node.shadowRoot) : null),
      },
      querySelectorAll: {
        value: (sel: string) => collectMatching(node.children, sel).map(wrap),
      },
      getAttribute: {
        value: (name: string) => (name in (node.attrs ?? {}) ? node.attrs![name]! : null),
      },
      matches: {
        value: (sel: string) => {
          if (sel === ':disabled') return !!(node.disabled || node.fieldsetDisabled);
          return matchesSimple(node, sel);
        },
      },
      checkVisibility: {
        value: (opts?: { visibilityProperty?: boolean }) => {
          if (node.checkVis !== undefined) return node.checkVis;
          let cur: FakeNode | FakeDoc | null = node;
          while (cur && 'tagName' in cur) {
            if (cur.display === 'none') return false;
            if (opts?.visibilityProperty && cur.visibility === 'hidden') return false;
            cur = cur.parentNode;
          }
          return true;
        },
      },
      getBoundingClientRect: {
        value: () =>
          node.display === 'none'
            ? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
            : {
                ...node.rect!,
                right: node.rect!.left + node.rect!.width,
                bottom: node.rect!.top + node.rect!.height,
              },
      },
      getClientRects: {
        value: () =>
          node.display === 'none' || !node.rect || node.rect.width <= 0 || node.rect.height <= 0
            ? []
            : [node.rect],
      },
    });
    wrappedCache.set(node, obj);
    return obj;
  }
  const wrappedCache = new WeakMap<FakeNode, Record<string, unknown>>();
  const docWrapper = {
    nodeType: 9,
    querySelectorAll: (sel: string) => doc.querySelectorAll(sel).map(wrap),
  };
  const sandbox = vm.createContext({
    document: docWrapper,
    HTMLInputElement: FakeHTMLInputElement,
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: (el: { __node: FakeNode }) => ({
      display: el.__node.display ?? 'block',
      visibility: el.__node.visibility ?? 'visible',
      pointerEvents: effectivePointerEvents(el.__node),
    }),
  });

  function install(
    chrome: ScriptedChrome,
    hooks: {
      onResolve?: (backendNodeId: number) => typeof NO_REPLY | void;
      beforeCallFn?: (params: Protocol.Runtime.CallFunctionOnRequest) => void;
    } = {},
  ): void {
    const objects = new Map<string, unknown>();
    let objSeq = 0;
    const store = (val: unknown): string => {
      const id = `obj-${++objSeq}`;
      objects.set(id, val);
      return id;
    };
    chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
    chrome.handle('DOM.getDocument', () => ({
      root: {
        nodeId: 1,
        backendNodeId: 1,
        nodeType: 9,
        nodeName: '#document',
        localName: '',
        nodeValue: '',
        frameId: 'page-1',
        children: [],
      },
    }));
    chrome.handle('DOM.resolveNode', (params) => {
      if (hooks.onResolve?.(params!.backendNodeId!) === NO_REPLY) return NO_REPLY;
      const node = byId.get(params!.backendNodeId!);
      if (!node) throw new ProtocolError('DOM.resolveNode', -32000, 'No node with given id found');
      return { object: { type: 'object', objectId: store(wrap(node)) } };
    });
    chrome.handle('DOM.describeNode', (params) => {
      const wrapped = objects.get(params!.objectId!) as { __node: FakeNode } | undefined;
      if (!wrapped?.__node)
        throw new ProtocolError('DOM.describeNode', -32000, 'Could not find node with given id');
      return {
        node: {
          nodeId: wrapped.__node.backendNodeId,
          backendNodeId: wrapped.__node.backendNodeId,
          nodeType: 1,
          nodeName: wrapped.__node.tagName,
          localName: wrapped.__node.tagName.toLowerCase(),
          nodeValue: '',
        },
      };
    });
    chrome.handle('Runtime.getProperties', (params) => {
      const target = objects.get(params!.objectId!) as unknown[];
      return {
        result: target.map((item, idx) => ({
          name: String(idx),
          value: { type: 'object', objectId: store(item) },
          configurable: true,
          enumerable: true,
        })),
      };
    });
    chrome.handle('Runtime.callFunctionOn', (params) => {
      hooks.beforeCallFn?.(params);
      const thisArg = params.objectId ? objects.get(params.objectId) : undefined;
      const args = (params.arguments ?? []).map((a) =>
        a.objectId ? objects.get(a.objectId) : a.value,
      );
      const fn = vm.runInContext(`(${params.functionDeclaration})`, sandbox) as (
        ...a: unknown[]
      ) => unknown;
      try {
        const out = fn.apply(thisArg, args);
        if (params.returnByValue) {
          if (typeof out === 'bigint')
            return { result: { type: 'bigint', unserializableValue: `${out}n` } };
          if (typeof out === 'number' && Number.isNaN(out))
            return { result: { type: 'number', unserializableValue: 'NaN' } };
          if (Object.is(out, -0)) return { result: { type: 'number', unserializableValue: '-0' } };
          return { result: { type: typeof out as 'object', value: out } };
        }
        return { result: { type: 'object', objectId: store(out) } };
      } catch (error) {
        return {
          result: { type: 'undefined' },
          exceptionDetails: {
            exceptionId: 1,
            text: 'Uncaught',
            lineNumber: 0,
            columnNumber: 0,
            exception: { type: 'object', description: String(error) },
          },
        };
      }
    });
    chrome.handle('Runtime.releaseObjectGroup', () => {});
  }
  return { doc, createNode, attachShadow, detachNode, install };
}

test('1. scrollIntoView normalizes missing layout object to ActionabilityError and click/hover/clickablePoint wait in poll budget', async () => {
  await using chrome = await ScriptedChrome.start();
  let tab!: Tab;
  const dom = scriptDom(chrome, () => tab.mainFrame.id);
  await using browser = await chrome.connect({ timeout: 2000 });
  tab = browser.tabs[0]!;
  const element = new Element(tab.mainFrame, CONTROL, tab.mainFrame.generation, tab.session);

  // Standalone scrollIntoView() normalizes the protocol error into ActionabilityError with cause.
  chrome.replyOnce('DOM.scrollIntoViewIfNeeded', () => {
    throw new ProtocolError(
      'DOM.scrollIntoViewIfNeeded',
      -32000,
      'Node does not have a layout object',
    );
  });
  await assert.rejects(element.scrollIntoView(), (error: unknown) => {
    assert.ok(error instanceof ActionabilityError);
    assert.ok(error.cause instanceof ProtocolError);
    assert.equal(error.cause.protocolMessage, 'Node does not have a layout object');
    return true;
  });

  // Standalone screenshot() also normalizes missing layout object into ActionabilityError.
  chrome.replyOnce('DOM.scrollIntoViewIfNeeded', () => {
    throw new ProtocolError(
      'DOM.scrollIntoViewIfNeeded',
      -32000,
      'Node does not have a layout object',
    );
  });
  await assert.rejects(element.screenshot(), (error: unknown) => {
    assert.ok(error instanceof ActionabilityError);
    assert.ok(error.cause instanceof ProtocolError);
    return true;
  });

  // click() polls while DOM.scrollIntoViewIfNeeded reports missing layout object and succeeds once layout appears.
  for (let i = 0; i < 2; i++) {
    chrome.replyOnce('DOM.scrollIntoViewIfNeeded', () => {
      throw new ProtocolError(
        'DOM.scrollIntoViewIfNeeded',
        -32000,
        'Node does not have a layout object',
      );
    });
  }
  await element.click({ timeout: 1000 });
  assert.deepEqual(dom.pressed, [CONTROL]);

  // hover() and clickablePoint() also poll past transient missing layout object.
  chrome.replyOnce('DOM.scrollIntoViewIfNeeded', () => {
    throw new ProtocolError(
      'DOM.scrollIntoViewIfNeeded',
      -32000,
      'Node does not have a layout object',
    );
  });
  assert.deepEqual(await element.hover({ timeout: 1000 }), { x: 10, y: 10 });

  chrome.replyOnce('DOM.scrollIntoViewIfNeeded', () => {
    throw new ProtocolError(
      'DOM.scrollIntoViewIfNeeded',
      -32000,
      'Node does not have a layout object',
    );
  });
  assert.deepEqual(await element.clickablePoint({ timeout: 1000 }), { x: 10, y: 10 });

  // Persistent missing layout object times out cleanly inside click()'s budget (not bare ProtocolError).
  const off = chrome.handle('DOM.scrollIntoViewIfNeeded', () => {
    throw new ProtocolError(
      'DOM.scrollIntoViewIfNeeded',
      -32000,
      'Node does not have a layout object',
    );
  });
  const clickFailure = await element.click({ timeout: 120 }).catch((error: unknown) => error);
  assert.ok(clickFailure instanceof InputActionError);
  assert.ok(clickFailure.cause instanceof TimeoutError);
  await clickFailure.cleanup;
  off();

  // Human-mode scrollIntoView skips mouseWheel when element has no layout box (hasBox === false).
  tab.setInputPolicy({ mode: 'human', scrollSteps: [1, 1], pause: [0, 0] });
  (dom.box as { hasBox?: boolean }).hasBox = false;
  chrome.replyOnce('DOM.scrollIntoViewIfNeeded', () => {
    throw new ProtocolError(
      'DOM.scrollIntoViewIfNeeded',
      -32000,
      'Node does not have a layout object',
    );
  });
  const beforeWheels = chrome.commands.filter(
    (c) =>
      c.method === 'Input.dispatchMouseEvent' &&
      (c.params as { type?: string }).type === 'mouseWheel',
  ).length;
  await assert.rejects(element.scrollIntoView(), ActionabilityError);
  const afterWheels = chrome.commands.filter(
    (c) =>
      c.method === 'Input.dispatchMouseEvent' &&
      (c.params as { type?: string }).type === 'mouseWheel',
  ).length;
  assert.equal(afterWheels, beforeWheels);
});

test('2. Frame.context normalizes in-flight No frame for/with given id races into StaleElementError', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  const child = new Frame(tab.framesManager, 'iframe-gone', tab.session);
  child.parentId = tab.mainFrame.id;
  tab.framesManager.frames.set(child.id, child);

  for (const message of ['No frame for given id found', 'No frame with given id']) {
    chrome.replyOnce('Page.createIsolatedWorld', () => {
      throw new ProtocolError('Page.createIsolatedWorld', -32000, message);
    });
    await assert.rejects(child.context('isolated'), (error: unknown) => {
      assert.ok(error instanceof StaleElementError);
      assert.ok(error.cause instanceof ProtocolError);
      assert.equal(error.cause.protocolMessage, message);
      return true;
    });
  }

  // Main-world resolution, evaluate(), and query() inherit the same normalization.
  chrome.replyOnce('Page.createIsolatedWorld', () => {
    throw new ProtocolError('Page.createIsolatedWorld', -32000, 'No frame for given id found');
  });
  await assert.rejects(child.context('main'), StaleElementError);

  chrome.replyOnce('Page.createIsolatedWorld', () => {
    throw new ProtocolError('Page.createIsolatedWorld', -32000, 'No frame for given id found');
  });
  await assert.rejects(child.query('button'), StaleElementError);

  // Failed lookup is never cached: a later retry succeeds if the frame becomes available.
  chrome.replyOnce('Page.createIsolatedWorld', { executionContextId: 42 });
  assert.equal(await child.context('isolated'), 42);
});

test('3. { text } selector ignores pointer-events: none nodes and descendants to stay clickable', async () => {
  await using chrome = await ScriptedChrome.start();
  const fake = makeFakeDom();
  fake.install(chrome);
  // Case A: <button><span style="pointer-events:none">Submit</span></button>
  const btn = fake.createNode({ tagName: 'button', id: 'btn-submit' });
  fake.createNode({ tagName: 'span', text: 'Submit', pointerEvents: 'none' }, btn);
  // Case B: nested inherited pointer-events: none
  const link = fake.createNode({ tagName: 'a', id: 'link-save' });
  const wrapDiv = fake.createNode({ tagName: 'div', pointerEvents: 'none' }, link);
  fake.createNode({ tagName: 'span', text: 'Save changes' }, wrapDiv);
  // Case C: descendant explicitly re-enables pointer-events: auto
  const outer = fake.createNode({ tagName: 'button', id: 'outer-btn' });
  const peNone = fake.createNode({ tagName: 'div', pointerEvents: 'none' }, outer);
  const innerAuto = fake.createNode(
    { tagName: 'span', id: 'inner-auto', text: 'Override', pointerEvents: 'auto' },
    peNone,
  );
  // Case D: normal clickable child still picks smallest clickable node
  const box = fake.createNode({ tagName: 'div', id: 'normal-box' });
  const normalSpan = fake.createNode({ tagName: 'span', id: 'normal-span', text: 'Normal' }, box);
  // Case E: decorative element with pointer-events: none and no clickable exact match
  fake.createNode({ tagName: 'div', id: 'badge', text: 'DecorativeOnly', pointerEvents: 'none' });

  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;

  const submitMatches = await tab.queryAll({ text: 'Submit' });
  assert.deepEqual(
    submitMatches.map((e) => e.backendNodeId),
    [btn.backendNodeId],
  );
  const submitExact = await tab.queryAll({ text: 'Submit', exact: true });
  assert.deepEqual(
    submitExact.map((e) => e.backendNodeId),
    [btn.backendNodeId],
  );

  const saveMatches = await tab.queryAll({ text: 'Save changes' });
  assert.deepEqual(
    saveMatches.map((e) => e.backendNodeId),
    [link.backendNodeId],
  );

  const overrideMatches = await tab.queryAll({ text: 'Override' });
  assert.deepEqual(
    overrideMatches.map((e) => e.backendNodeId),
    [innerAuto.backendNodeId],
  );

  const normalMatches = await tab.queryAll({ text: 'Normal' });
  assert.deepEqual(
    normalMatches.map((e) => e.backendNodeId),
    [normalSpan.backendNodeId],
  );

  const decorativeExact = await tab.queryAll({ text: 'DecorativeOnly', exact: true });
  assert.deepEqual(decorativeExact, []);
});

test('4. OOPIF Element.click and hover confirm pointer once without duplicate path or wiggle', async () => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  const oopifSession = await browser.attachSession(tab.id);
  tab.framesManager.track(oopifSession);
  const child = new Frame(tab.framesManager, 'oopif-1', oopifSession);
  child.parentId = tab.mainFrame.id;
  tab.framesManager.frames.set(child.id, child);

  let probeCount = 0;
  let probeHit = false;
  let movedInParent = false;
  let elementCenterX = 10;

  chrome.handle('Page.bringToFront', () => {});
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
  chrome.handle('DOM.scrollIntoViewIfNeeded', () => {});
  chrome.handle('DOM.resolveNode', () => ({ object: { type: 'object', objectId: 'oopif-el' } }));
  chrome.handle('Runtime.releaseObjectGroup', () => {});
  chrome.handle('Runtime.releaseObject', () => {});
  chrome.handle('DOM.getContentQuads', () => ({
    quads: [
      [
        elementCenterX - 10,
        0,
        elementCenterX + 10,
        0,
        elementCenterX + 10,
        20,
        elementCenterX - 10,
        20,
      ],
    ],
  }));
  chrome.handle('DOM.getFrameOwner', () => ({ backendNodeId: 77 }));
  chrome.handle('DOM.getBoxModel', () => ({
    model: {
      content: [100, 100, 300, 100, 300, 300, 100, 300],
      padding: [100, 100, 300, 100, 300, 300, 100, 300],
      border: [100, 100, 300, 100, 300, 300, 100, 300],
      margin: [100, 100, 300, 100, 300, 300, 100, 300],
      width: 200,
      height: 200,
    },
  }));
  chrome.handle('Runtime.evaluate', () => ({
    result: { type: 'object', value: { width: 200, height: 200 } },
  }));
  chrome.handle(
    'Page.getLayoutMetrics',
    () =>
      ({
        cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
      }) as Protocol.Page.GetLayoutMetricsResponse,
  );
  chrome.handle('DOM.getNodeForLocation', () => ({
    backendNodeId: movedInParent ? 999 : 77,
    frameId: tab.mainFrame.id,
  }));
  chrome.handle('Runtime.callFunctionOn', (params) => {
    const code = params.functionDeclaration;
    if (code === 'function(){return this.isConnected}')
      return { result: { type: 'boolean', value: true } };
    if (code.includes('valid:'))
      return { result: { type: 'object', value: { valid: true, u: 0.5, v: 0.5 } } };
    if (code.includes('addEventListener("mousemove"')) {
      probeCount++;
      probeHit = false;
      return { result: { type: 'object', objectId: `probe-${probeCount}` } };
    }
    if (code === 'function(){return this.hit}')
      return { result: { type: 'boolean', value: probeHit } };
    if (code === 'function(){this.remove()}') return { result: { type: 'undefined' } };
    return { result: { type: 'boolean', value: true } };
  });
  chrome.handle('Input.dispatchMouseEvent', (params) => {
    if (params.type === 'mouseMoved' && Math.hypot(params.x - 110, params.y - 110) < 0.01)
      probeHit = true;
  });

  const el = new Element(child, 55, child.generation, oopifSession);
  // Instant mode: exactly 1 mouseMoved, 1 receivesPointer probe, 1 press, 1 release, 0 wiggle.
  await el.click();
  const mouseEvents = chrome.commands
    .filter((c) => c.method === 'Input.dispatchMouseEvent')
    .map((c) => c.params as Protocol.Input.DispatchMouseEventRequest);
  assert.equal(probeCount, 1);
  assert.deepEqual(
    mouseEvents.map((e) => e.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased'],
  );
  assert.deepEqual(
    mouseEvents.map((e) => [e.x, e.y]),
    [
      [110, 110],
      [110, 110],
      [110, 110],
    ],
  );

  // Human mode with pointerGrid: still 1 receivesPointer probe, 0 duplicate path, 0 wiggle.
  await tab.mouse.move(10, 10);
  tab.setInputPolicy({
    mode: 'human',
    seed: 7,
    moveSteps: [2, 2],
    moveDuration: [0, 0],
    pause: [0, 0],
    pressDelay: [0, 0],
    pointerGrid: { scale: 2 },
  });
  probeCount = 0;
  const startHuman = chrome.commands.length;
  chrome.handle('Input.dispatchMouseEvent', (params) => {
    if (params.type === 'mouseMoved' && Math.hypot(params.x - 110, params.y - 110) < 12)
      probeHit = true;
  });
  await el.click();
  const humanEvents = chrome.commands
    .slice(startHuman)
    .filter((c) => c.method === 'Input.dispatchMouseEvent')
    .map((c) => c.params as Protocol.Input.DispatchMouseEventRequest);
  const humanPressIndex = humanEvents.findIndex((e) => e.type === 'mousePressed');
  assert.equal(probeCount, 1);
  assert.ok(humanPressIndex >= 1);
  // Only the single 2-step move path runs before mousePressed (no second path or wiggle).
  assert.ok(humanPressIndex <= 2);
  tab.setInputPolicy({ mode: 'instant' });

  // Hover on OOPIF also skips redundant move after receivesPointer confirms arrival.
  probeCount = 0;
  const beforeHover = chrome.commands.length;
  // Move pointer away first so reach() takes a single direct step.
  await tab.mouse.move(10, 10);
  const startHover = chrome.commands.length;
  assert.deepEqual(await el.hover(), { x: 110, y: 110 });
  const hoverMoves = chrome.commands
    .slice(startHover)
    .filter(
      (c) =>
        c.method === 'Input.dispatchMouseEvent' &&
        (c.params as { type?: string }).type === 'mouseMoved',
    );
  assert.equal(probeCount, 1);
  assert.equal(hoverMoves.length, 1);
  assert.ok(beforeHover > 0);

  // Regression (P1): trajectory crosses the target mid-path, but the final resting pointerGrid
  // point lands outside the target at (112, 112). Click MUST NOT reuse the mid-path hit or press.
  await tab.mouse.move(10, 10);
  tab.setInputPolicy({
    mode: 'human',
    seed: 7,
    moveSteps: [4, 4],
    moveDuration: [0, 0],
    pause: [0, 0],
    pressDelay: [0, 0],
    pointerGrid: { scale: 0.25 }, // 4px grid: (110, 110) snaps to (112, 112)
  });
  let probeArmed = false;
  let midPathCrossedTarget = false;
  let finalRestedAt112 = false;
  probeHit = false;
  const beforeMiss = chrome.commands.length;
  chrome.handle('Runtime.callFunctionOn', (params) => {
    const code = params.functionDeclaration;
    if (code === 'function(){return this.isConnected}')
      return { result: { type: 'boolean', value: true } };
    if (code.includes('valid:'))
      return { result: { type: 'object', value: { valid: true, u: 0.5, v: 0.5 } } };
    if (code.includes('addEventListener("mousemove"')) {
      probeCount++;
      probeArmed = true;
      probeHit = false;
      return { result: { type: 'object', objectId: `probe-${probeCount}` } };
    }
    if (code === 'function(){return this.hit}')
      return { result: { type: 'boolean', value: probeHit } };
    if (code === 'function(){this.remove()}') {
      probeArmed = false;
      return { result: { type: 'undefined' } };
    }
    return { result: { type: 'boolean', value: true } };
  });
  chrome.handle('Input.dispatchMouseEvent', (params) => {
    if (params.type !== 'mouseMoved') return;
    // Target box covers [100, 111] x [100, 111]; snapped resting point (112, 112) is outside.
    const hitsTarget = params.x >= 100 && params.x <= 111 && params.y >= 100 && params.y <= 111;
    if (hitsTarget && !probeArmed) midPathCrossedTarget = true;
    if (params.x === 112 && params.y === 112) finalRestedAt112 = true;
    if (probeArmed) probeHit = hitsTarget;
  });
  const missErr = await el.click({ timeout: 220 }).catch((e: unknown) => e);
  assert.ok(missErr instanceof InputActionError);
  assert.ok(missErr.cause instanceof TimeoutError);
  await missErr.cleanup;
  assert.equal(midPathCrossedTarget, true, 'intermediate sample crossed the target');
  assert.equal(finalRestedAt112, true, 'final snapped move landed at (112, 112) outside target');
  const pressedOnMiss = chrome.commands
    .slice(beforeMiss)
    .filter(
      (c) =>
        c.method === 'Input.dispatchMouseEvent' &&
        (c.params as { type?: string }).type === 'mousePressed',
    );
  assert.equal(pressedOnMiss.length, 0);
  tab.setInputPolicy({ mode: 'instant' });
  chrome.handle('Input.dispatchMouseEvent', (params) => {
    if (params.type === 'mouseMoved' && Math.hypot(params.x - 110, params.y - 110) < 0.01)
      probeHit = true;
  });

  // Regression (P1): pointerGrid snaps target (110, 110) to (112, 112); (112, 112) hits during
  // poll(), then an overlay appears covering ONLY (112, 112) before mouseDown while (110, 110)
  // stays clear. The mouseDown guard must re-verify the actual press coordinate (112, 112) in the
  // parent frame and refuse mousePressed without moving the mouse again.
  await tab.mouse.move(10, 10);
  tab.setInputPolicy({
    mode: 'human',
    seed: 7,
    moveSteps: [2, 2],
    moveDuration: [0, 0],
    pause: [0, 0],
    pressDelay: [0, 0],
    pointerGrid: { scale: 0.25 }, // (110, 110) -> (112, 112)
  });
  let overlayAt112 = false;
  const hitTestedCoords: Array<{ x: number; y: number }> = [];
  chrome.handle('DOM.getNodeForLocation', (params) => {
    hitTestedCoords.push({ x: params.x, y: params.y });
    if (overlayAt112 && params.x === 112 && params.y === 112)
      return { backendNodeId: 888, frameId: tab.mainFrame.id };
    return { backendNodeId: 77, frameId: tab.mainFrame.id };
  });
  chrome.handle('Input.dispatchMouseEvent', (params) => {
    if (params.type === 'mouseMoved' && params.x === 112 && params.y === 112) {
      probeHit = true;
      // Right after the resting move succeeds, a parent overlay covers only (112, 112).
      overlayAt112 = true;
    }
  });
  const before112Overlay = chrome.commands.length;
  const overlayErr = await el.click({ timeout: 500 }).catch((e: unknown) => e);
  assert.ok(overlayErr instanceof InputActionError);
  assert.ok(overlayErr.cause instanceof ActionabilityError);
  await overlayErr.cleanup;
  assert.ok(
    hitTestedCoords.some((c) => c.x === 112 && c.y === 112),
    'mouseDown guard hit-tested actual press coordinate (112, 112)',
  );
  assert.equal(
    chrome.commands
      .slice(before112Overlay)
      .filter(
        (c) =>
          c.method === 'Input.dispatchMouseEvent' &&
          (c.params as { type?: string }).type === 'mousePressed',
      ).length,
    0,
  );

  // Also catch an overlay appearing INSIDE the OOPIF covering only the unprojected (12, 12).
  overlayAt112 = false;
  await tab.mouse.move(10, 10);
  let innerOverlayAt12 = false;
  chrome.handle('Input.dispatchMouseEvent', (params) => {
    if (params.type === 'mouseMoved' && params.x === 112 && params.y === 112) {
      probeHit = true;
      innerOverlayAt12 = true;
    }
  });
  const prevCallFn = chrome.handle('Runtime.callFunctionOn', (params) => {
    const code = params.functionDeclaration;
    if (code === 'function(){return this.isConnected}')
      return { result: { type: 'boolean', value: true } };
    if (code.includes('valid:'))
      return { result: { type: 'object', value: { valid: true, u: 0.5, v: 0.5 } } };
    if (code.includes('addEventListener("mousemove"')) {
      probeCount++;
      probeHit = false;
      return { result: { type: 'object', objectId: `probe-${probeCount}` } };
    }
    if (code === 'function(){return this.hit}')
      return { result: { type: 'boolean', value: probeHit } };
    if (code === 'function(){this.remove()}') return { result: { type: 'undefined' } };
    if (code.includes('elementFromPoint(x, y)') && !code.includes('valid:')) {
      const arg = params.arguments?.[0]?.value as { x: number; y: number } | undefined;
      assert.ok(arg && Math.hypot(arg.x - 12, arg.y - 12) < 0.01);
      return { result: { type: 'boolean', value: !innerOverlayAt12 } };
    }
    return { result: { type: 'boolean', value: true } };
  });
  const beforeInnerOverlay = chrome.commands.length;
  const innerOverlayErr = await el.click({ timeout: 500 }).catch((e: unknown) => e);
  assert.ok(innerOverlayErr instanceof InputActionError);
  assert.ok(innerOverlayErr.cause instanceof ActionabilityError);
  await innerOverlayErr.cleanup;
  assert.equal(
    chrome.commands
      .slice(beforeInnerOverlay)
      .filter(
        (c) =>
          c.method === 'Input.dispatchMouseEvent' &&
          (c.params as { type?: string }).type === 'mousePressed',
      ).length,
    0,
  );
  prevCallFn();
  tab.setInputPolicy({ mode: 'instant' });
  chrome.handle('DOM.getNodeForLocation', () => ({
    backendNodeId: movedInParent ? 999 : 77,
    frameId: tab.mainFrame.id,
  }));
  chrome.handle('Runtime.callFunctionOn', (params) => {
    const code = params.functionDeclaration;
    if (code === 'function(){return this.isConnected}')
      return { result: { type: 'boolean', value: true } };
    if (code.includes('valid:'))
      return { result: { type: 'object', value: { valid: true, u: 0.5, v: 0.5 } } };
    if (code.includes('addEventListener("mousemove"')) {
      probeCount++;
      probeHit = false;
      return { result: { type: 'object', objectId: `probe-${probeCount}` } };
    }
    if (code === 'function(){return this.hit}')
      return { result: { type: 'boolean', value: probeHit } };
    if (code === 'function(){this.remove()}') return { result: { type: 'undefined' } };
    return { result: { type: 'boolean', value: true } };
  });
  chrome.handle('Input.dispatchMouseEvent', (params) => {
    if (params.type === 'mouseMoved' && Math.hypot(params.x - 110, params.y - 110) < 0.01)
      probeHit = true;
  });

  // Safety guard still catches target movement / parent obstruction right before mousePressed.
  await tab.mouse.move(10, 10);
  const beforeGuardFail = chrome.commands.length;
  chrome.handle('Input.dispatchMouseEvent', (params) => {
    if (params.type === 'mouseMoved') {
      probeHit = true;
      movedInParent = true;
    }
  });
  const err = await el.click().catch((e: unknown) => e);
  assert.ok(err instanceof InputActionError);
  assert.ok(err.cause instanceof ActionabilityError);
  const pressedAfterFail = chrome.commands
    .slice(beforeGuardFail)
    .filter(
      (c) =>
        c.method === 'Input.dispatchMouseEvent' &&
        (c.params as { type?: string }).type === 'mousePressed',
    );
  assert.equal(pressedAfterFail.length, 0);
  // Regression (P1, round 4): skewed/clipped OOPIF element WITHOUT pointerGrid where bbox
  // elementFromPoint checks (170, 20) while projected quad press point is (178, 20) (root (278, 120)).
  // Covering ONLY (178, 20) after hover must be caught by verifyOopifPoint with 0 mousePressed.
  await tab.mouse.move(10, 10);
  movedInParent = false;
  let skewedOverlayAt178 = false;
  const skewedHitPoints: Array<{ x: number; y: number }> = [];
  chrome.handle('DOM.getContentQuads', () => ({
    // Skewed quad whose (u=0.5, v=0.5) projects to frame-local (178, 20) while bbox check used (170, 20).
    quads: [[160, 0, 200, 0, 196, 40, 156, 40]],
  }));
  chrome.handle('DOM.getNodeForLocation', () => ({
    backendNodeId: 77,
    frameId: tab.mainFrame.id,
  }));
  chrome.handle('Input.dispatchMouseEvent', (params) => {
    if (params.type === 'mouseMoved' && Math.hypot(params.x - 278, params.y - 120) < 0.01) {
      probeHit = true;
      skewedOverlayAt178 = true;
    }
  });
  chrome.handle('Runtime.callFunctionOn', (params) => {
    const code = params.functionDeclaration;
    if (code === 'function(){return this.isConnected}')
      return { result: { type: 'boolean', value: true } };
    if (code.includes('valid:'))
      // Simulates bbox hit test passing at (170, 20) even while (178, 20) is covered.
      return { result: { type: 'object', value: { valid: true, u: 0.5, v: 0.5 } } };
    if (code.includes('addEventListener("mousemove"')) {
      probeCount++;
      probeHit = false;
      return { result: { type: 'object', objectId: `probe-${probeCount}` } };
    }
    if (code === 'function(){return this.hit}')
      return { result: { type: 'boolean', value: probeHit } };
    if (code === 'function(){this.remove()}') return { result: { type: 'undefined' } };
    if (code.includes('elementFromPoint(x, y)') && !code.includes('valid:')) {
      const arg = params.arguments?.[0]?.value as { x: number; y: number } | undefined;
      assert.ok(arg);
      skewedHitPoints.push(arg);
      const blocked = skewedOverlayAt178 && Math.hypot(arg.x - 178, arg.y - 20) < 0.5;
      return { result: { type: 'boolean', value: !blocked } };
    }
    return { result: { type: 'boolean', value: true } };
  });
  const beforeSkewed = chrome.commands.length;
  const skewedErr = await el.click({ timeout: 500 }).catch((e: unknown) => e);
  assert.ok(skewedErr instanceof InputActionError);
  assert.ok(skewedErr.cause instanceof ActionabilityError);
  await skewedErr.cleanup;
  assert.ok(
    skewedHitPoints.some((p) => Math.hypot(p.x - 178, p.y - 20) < 0.5),
    'mouseDown guard verified actual projected press point (178, 20) without pointerGrid',
  );
  assert.equal(
    chrome.commands
      .slice(beforeSkewed)
      .filter(
        (c) =>
          c.method === 'Input.dispatchMouseEvent' &&
          (c.params as { type?: string }).type === 'mousePressed',
      ).length,
    0,
  );
  // Restore standard content quads for the late-reply test below.
  chrome.handle('DOM.getContentQuads', () => ({
    quads: [[0, 0, 20, 0, 20, 20, 0, 20]],
  }));

  // Regression (P2, round 3 + round 4): late reply to receivesPointer arm() cleans up real element
  // & document listeners EVEN under real CDP objectGroup inheritance (omitting objectGroup on
  // Runtime.callFunctionOn inherits the receiver's group; releasing the element's group must NOT
  // invalidate the state handle because arm() assigns a dedicated stateGroup).
  await tab.mouse.move(10, 10);
  movedInParent = false;
  const elListeners = new Set<string>();
  const docListeners = new Set<string>();
  const releasedGroups: string[] = [];
  const remoteObjects = new Map<string, { value: unknown; group: string }>();
  const fakeDoc = {
    addEventListener(type: string, fn: unknown, cap: boolean) {
      docListeners.add(`${type}:${String(cap)}:${String(fn)}`);
    },
    removeEventListener(type: string, fn: unknown, cap: boolean) {
      docListeners.delete(`${type}:${String(cap)}:${String(fn)}`);
    },
  };
  const fakeEl = {
    isConnected: true,
    ownerDocument: fakeDoc,
    addEventListener(type: string, fn: unknown, cap: boolean) {
      elListeners.add(`${type}:${String(cap)}:${String(fn)}`);
    },
    removeEventListener(type: string, fn: unknown, cap: boolean) {
      elListeners.delete(`${type}:${String(cap)}:${String(fn)}`);
    },
  };
  chrome.handle('DOM.resolveNode', (params) => {
    remoteObjects.set('oopif-el', { value: fakeEl, group: params?.objectGroup ?? 'default' });
    return { object: { type: 'object', objectId: 'oopif-el' } };
  });
  let armArrived!: () => void;
  const armWaiting = new Promise<void>((r) => {
    armArrived = r;
  });
  let elGroupName = '';
  let elGroupReleased!: () => void;
  const waitElGroupRelease = new Promise<void>((r) => {
    elGroupReleased = r;
  });
  let releaseArmReply!: () => void;
  const armGate = new Promise<void>((r) => {
    releaseArmReply = r;
  });
  const lateSandbox = vm.createContext({});
  let capturedArmDecl = '';
  chrome.handle('Runtime.releaseObjectGroup', (params) => {
    releasedGroups.push(params.objectGroup);
    for (const [id, entry] of remoteObjects) {
      if (entry.group === params.objectGroup) remoteObjects.delete(id);
    }
    if (elGroupName && params.objectGroup === elGroupName) elGroupReleased();
  });
  chrome.handle('Runtime.callFunctionOn', async (params) => {
    const code = params.functionDeclaration;
    if (code === 'function(){return this.isConnected}')
      return { result: { type: 'boolean', value: true } };
    if (code.includes('valid:'))
      return { result: { type: 'object', value: { valid: true, u: 0.5, v: 0.5 } } };
    if (code.includes('addEventListener("mousemove"')) {
      capturedArmDecl = code;
      const receiver = remoteObjects.get(params.objectId!);
      assert.ok(receiver, 'element handle exists when arm starts');
      elGroupName = receiver.group;
      // Model real CDP behavior: omitting objectGroup inherits receiver's group!
      const resultGroup = params.objectGroup ?? receiver.group;
      assert.notEqual(
        resultGroup,
        receiver.group,
        'arm() must specify a dedicated stateGroup distinct from element group',
      );
      const fn = vm.runInContext(`(${code})`, lateSandbox) as () => unknown;
      const stateObj = fn.call(receiver.value);
      remoteObjects.set('late-state-1', { value: stateObj, group: resultGroup });
      armArrived();
      await armGate;
      return { result: { type: 'object', objectId: 'late-state-1' } };
    }
    if (code === 'function(){this.remove()}') {
      const fn = vm.runInContext(`(${code})`, lateSandbox) as () => void;
      const target = remoteObjects.get(params.objectId!);
      if (!target)
        throw new ProtocolError(
          'Runtime.callFunctionOn',
          -32000,
          'Could not find object with given id',
        );
      fn.call(target.value);
      return { result: { type: 'undefined' } };
    }
    return { result: { type: 'boolean', value: true } };
  });
  const abortLate = new AbortController();
  const lateClick = el.click({ signal: abortLate.signal }).catch((e: unknown) => e);
  await armWaiting;
  assert.equal(docListeners.size, 1);
  assert.equal(elListeners.size, 2);
  abortLate.abort(new Error('cancel during arm'));
  const lateErr = await lateClick;
  assert.ok(lateErr instanceof InputActionError);
  // Wait for Chrome to process withIsolatedObject's releaseObjectGroup(elGroup) BEFORE the late
  // arm() reply arrives, proving late-state-1 survives in its own dedicated stateGroup.
  await waitElGroupRelease;
  assert.equal(remoteObjects.has('oopif-el'), false);
  assert.equal(remoteObjects.has('late-state-1'), true);
  releaseArmReply();
  const cleanupReport = await lateErr.cleanup;
  assert.equal(cleanupReport.status, 'completed');
  await browser.drain();
  assert.equal(docListeners.size, 0);
  assert.equal(elListeners.size, 0);
  assert.equal(remoteObjects.has('late-state-1'), false, 'stateGroup released after remove()');
  assert.ok(releasedGroups.some((g) => g.startsWith('nodriver-pointer-probe-')));

  // Real V8 verification via node:inspector of objectGroup inheritance + dedicated stateGroup cleanup.
  const v8 = new inspector.Session();
  v8.connect();
  const v8Send = <T = unknown>(method: string, params?: Record<string, unknown>) =>
    new Promise<T>((res, rej) =>
      v8.post(method, params, (err, result) => (err ? rej(err) : res(result as T))),
    );
  try {
    const setup = await v8Send<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
      expression: `(() => {
        const docSet = new Set(), elSet = new Set();
        const doc = {
          addEventListener: (t, f, c) => docSet.add(t + ':' + c),
          removeEventListener: (t, f, c) => docSet.delete(t + ':' + c),
        };
        const el = {
          ownerDocument: doc,
          addEventListener: (t, f, c) => elSet.add(t + ':' + c),
          removeEventListener: (t, f, c) => elSet.delete(t + ':' + c),
          counts: () => ({ doc: docSet.size, el: elSet.size }),
        };
        globalThis.__probeV8Counts = () => el.counts();
        return el;
      })()`,
      objectGroup: 'v8-el-group',
    });
    const armed = await v8Send<Protocol.Runtime.CallFunctionOnResponse>('Runtime.callFunctionOn', {
      objectId: setup.result.objectId!,
      objectGroup: 'v8-state-group',
      functionDeclaration: capturedArmDecl,
    });
    assert.ok(armed.result.objectId);
    // Release the element's objectGroup first (exactly as withIsolatedObject does on cancellation).
    await v8Send('Runtime.releaseObjectGroup', { objectGroup: 'v8-el-group' });
    // state handle in v8-state-group MUST remain alive so state.remove() succeeds!
    const removed = await v8Send<Protocol.Runtime.CallFunctionOnResponse>(
      'Runtime.callFunctionOn',
      {
        objectId: armed.result.objectId,
        functionDeclaration: 'function(){this.remove()}',
        returnByValue: true,
      },
    );
    assert.equal(removed.exceptionDetails, undefined);
    await v8Send('Runtime.releaseObjectGroup', { objectGroup: 'v8-state-group' });
    const counts = await v8Send<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
      expression:
        '(() => { const c = globalThis.__probeV8Counts(); delete globalThis.__probeV8Counts; return c; })()',
      returnByValue: true,
    });
    assert.deepEqual(counts.result.value, { doc: 0, el: 0 });
  } finally {
    v8.disconnect();
  }
});

test('5 & 6. Locator waitFor/locator/filter/first/nth/all and Element/Locator isVisible/isEnabled/isChecked', async () => {
  await using chrome = await ScriptedChrome.start();
  const fake = makeFakeDom();
  fake.install(chrome);

  const list = fake.createNode({ tagName: 'ul', id: 'cards' });
  const card1 = fake.createNode({ tagName: 'li', classes: ['card'] }, list);
  fake.createNode({ tagName: 'span', classes: ['title'], text: '  Alpha   Plan  ' }, card1);
  fake.createNode({ tagName: 'button', classes: ['buy'], text: 'Buy' }, card1);

  const card2 = fake.createNode({ tagName: 'li', classes: ['card'] }, list);
  fake.createNode({ tagName: 'span', classes: ['title'], text: 'Beta Plan' }, card2);
  const badge = fake.createNode({ tagName: 'span', classes: ['badge'], text: 'Popular' }, card2);
  const buy2 = fake.createNode({ tagName: 'button', classes: ['buy'], text: 'Buy' }, card2);

  const card3 = fake.createNode({ tagName: 'li', classes: ['card'] }, list);
  fake.createNode({ tagName: 'span', classes: ['title'], text: 'Beta Pro' }, card3);
  const buy3 = fake.createNode({ tagName: 'button', classes: ['buy'], text: 'Buy' }, card3);

  const cb = fake.createNode({
    tagName: 'input',
    id: 'agree',
    type: 'checkbox',
    checked: true,
    disabled: false,
  });
  const fieldsetInput = fake.createNode({
    tagName: 'input',
    id: 'fs-disabled',
    type: 'checkbox',
    checked: false,
    fieldsetDisabled: true,
  });
  const ariaDisabledBtn = fake.createNode({
    tagName: 'button',
    id: 'aria-dis',
    attrs: { 'aria-disabled': 'true' },
  });
  const ariaSwitch = fake.createNode({
    tagName: 'div',
    id: 'toggle',
    attrs: { role: 'switch', 'aria-checked': 'true' },
  });
  const ariaUncheckedSwitch = fake.createNode({
    tagName: 'div',
    id: 'toggle-off',
    attrs: { role: 'switch' },
  });
  const plainDiv = fake.createNode({ tagName: 'div', id: 'plain', text: 'hello' });
  const hiddenVis = fake.createNode({ tagName: 'div', id: 'vis-hidden', visibility: 'hidden' });
  const hiddenZero = fake.createNode({
    tagName: 'div',
    id: 'zero-size',
    rect: { left: 0, top: 0, width: 0, height: 10 },
  });

  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;

  // Chaining, filtering (string, global RegExp, has), first, nth, all, count.
  const cards = tab.locator('#cards').locator('.card');
  assert.equal(await cards.count(), 3);
  assert.equal((await cards.all()).length, 3);
  assert.equal((await cards.first().element()).backendNodeId, card1.backendNodeId);
  assert.equal((await cards.nth(1).element()).backendNodeId, card2.backendNodeId);
  assert.equal((await cards.nth(2).element()).backendNodeId, card3.backendNodeId);
  assert.deepEqual(await cards.nth(5).all(), []);
  assert.throws(() => cards.nth(-1), RangeError);
  assert.throws(() => cards.nth(1.5), RangeError);

  const alpha = cards.filter({ hasText: 'Alpha Plan' });
  assert.equal((await alpha.element()).backendNodeId, card1.backendNodeId);
  // Global RegExp must not lose matches due to stateful lastIndex across elements.
  const beta = cards.filter({ hasText: /Beta/g });
  assert.deepEqual(
    (await beta.all()).map((e) => e.backendNodeId),
    [card2.backendNodeId, card3.backendNodeId],
  );
  const betaPopularBuy = beta.filter({ has: '.badge' }).locator('.buy');
  assert.equal((await betaPopularBuy.element()).backendNodeId, buy2.backendNodeId);
  assert.equal((await beta.nth(1).locator('.buy').element()).backendNodeId, buy3.backendNodeId);
  assert.ok(badge.backendNodeId > 0);

  // Element & Locator read-only probes: isVisible / isEnabled / isChecked.
  const cbEl = (await tab.query('#agree'))!;
  assert.equal(await cbEl.isVisible(), true);
  assert.equal(await cbEl.isEnabled(), true);
  assert.equal(await cbEl.isChecked(), true);
  assert.equal(await tab.locator('#agree').isVisible(), true);
  assert.equal(await tab.locator('#agree').isEnabled(), true);
  assert.equal(await tab.locator('#agree').isChecked(), true);

  assert.equal(await tab.locator('#fs-disabled').isEnabled(), false);
  assert.equal(await tab.locator('#fs-disabled').isChecked(), false);
  assert.equal(await tab.locator('#aria-dis').isEnabled(), false);
  assert.equal(await tab.locator('#toggle').isChecked(), true);
  assert.equal(await tab.locator('#toggle-off').isChecked(), false);
  await assert.rejects(tab.locator('#plain').isChecked(), ActionabilityError);

  assert.equal(await tab.locator('#vis-hidden').isVisible(), false);
  assert.equal(await tab.locator('#zero-size').isVisible(), false);
  assert.equal(await tab.locator('#does-not-exist').isVisible(), false);
  assert.equal(await (await tab.query('#vis-hidden'))!.isVisible(), false);
  assert.equal(await (await tab.query('#zero-size'))!.isVisible(), false);
  assert.ok(
    fieldsetInput.backendNodeId > 0 &&
      ariaDisabledBtn.backendNodeId > 0 &&
      ariaSwitch.backendNodeId > 0 &&
      ariaUncheckedSwitch.backendNodeId > 0 &&
      plainDiv.backendNodeId > 0 &&
      hiddenVis.backendNodeId > 0 &&
      hiddenZero.backendNodeId > 0,
  );

  // Locator.waitFor() across all 4 states: attached -> visible -> hidden -> detached.
  await assert.rejects(tab.locator('#modal').waitFor({ state: 'bogus' as 'visible' }), TypeError);

  const modalLoc = tab.locator('#modal');
  let modalNode: FakeNode | undefined;
  setTimeout(() => {
    modalNode = fake.createNode({
      tagName: 'div',
      id: 'modal',
      text: 'Dialog',
      display: 'none',
    });
  }, 40);
  await modalLoc.waitFor({ state: 'attached', timeout: 1000 });
  assert.equal(await modalLoc.isVisible(), false);

  // { text } locator also supports state: 'attached' even when display: none.
  await tab.locator({ text: 'Dialog' }).waitFor({ state: 'attached', timeout: 500 });

  setTimeout(() => {
    modalNode!.display = 'block';
  }, 40);
  await modalLoc.waitFor({ timeout: 1000 }); // default state is 'visible'
  assert.equal(await modalLoc.isVisible(), true);

  // hidden waits until ALL matching overlays become hidden.
  const overlay2 = fake.createNode({ tagName: 'div', classes: ['overlay'], display: 'block' });
  const overlay1 = fake.createNode({ tagName: 'div', classes: ['overlay'], display: 'none' });
  let secondHidden = false;
  setTimeout(() => {
    secondHidden = true;
    overlay2.display = 'none';
  }, 50);
  await tab.locator('.overlay').waitFor({ state: 'hidden', timeout: 1000 });
  assert.equal(secondHidden, true);
  assert.ok(overlay1.backendNodeId > 0);

  // detached waits until node is actually removed (not merely display: none).
  modalNode!.display = 'none';
  let detached = false;
  setTimeout(() => {
    detached = true;
    fake.detachNode(modalNode!);
  }, 50);
  await modalLoc.waitFor({ state: 'detached', timeout: 1000 });
  assert.equal(detached, true);

  // Timeout works cleanly for waitFor().
  await assert.rejects(modalLoc.waitFor({ state: 'visible', timeout: 80 }), TimeoutError);

  // Regression (P2): chained nth() across overlapping parents must match all()[n].
  // outerWrap has longer text and an open shadow root containing innerWrap (shorter text, [A])
  // plus [B], so `{ text: 'hit' }` orders [innerWrap, outerWrap] where parent1 matches [A] and
  // parent2 matches [A, B].
  const outerWrap = fake.createNode({ tagName: 'section', text: 'hit longer' });
  const outerShadow = fake.attachShadow(outerWrap);
  const innerWrap = fake.createNode({ tagName: 'div', text: 'hit' }, outerShadow);
  const itemA = fake.createNode({ tagName: 'em', classes: ['leaf'], text: 'A' }, innerWrap);
  const itemB = fake.createNode({ tagName: 'em', classes: ['leaf'], text: 'B' }, outerShadow);
  const overlapLoc = tab.locator({ text: 'hit' }).locator('.leaf');
  assert.deepEqual(
    (await overlapLoc.all()).map((e) => e.backendNodeId),
    [itemA.backendNodeId, itemB.backendNodeId],
  );
  assert.deepEqual(
    (await overlapLoc.nth(1).all()).map((e) => e.backendNodeId),
    [itemB.backendNodeId],
  );
  assert.equal((await overlapLoc.nth(1).element()).backendNodeId, itemB.backendNodeId);

  // Regression (P2): hidden wait must preserve locator visibility/indexing semantics for first().
  const hiddenDup = fake.createNode({
    tagName: 'span',
    id: 'dup-hidden',
    text: 'SaveAction',
    display: 'none',
  });
  const visibleDup = fake.createNode({
    tagName: 'button',
    id: 'dup-visible',
    text: 'SaveAction',
    display: 'block',
  });
  const saveFirst = tab.locator({ text: 'SaveAction' }).first();
  assert.equal(await saveFirst.isVisible(), true);
  await assert.rejects(saveFirst.waitFor({ state: 'hidden', timeout: 120 }), TimeoutError);
  setTimeout(() => {
    visibleDup.display = 'none';
  }, 40);
  await saveFirst.waitFor({ state: 'hidden', timeout: 1000 });
  assert.equal(await saveFirst.isVisible(), false);
  assert.ok(hiddenDup.backendNodeId > 0);

  // Optimization regression: 100 candidates batch hasText filtering and hidden visibility checks.
  const bulkList = fake.createNode({ tagName: 'ul', id: 'bulk-list' });
  const bulkItems: FakeNode[] = [];
  for (let i = 0; i < 100; i++) {
    bulkItems.push(
      fake.createNode(
        {
          tagName: 'li',
          classes: ['bulk-row'],
          text: i === 73 ? 'Needle 73' : `Row ${i}`,
          display: 'none',
        },
        bulkList,
      ),
    );
  }
  const bulkLoc = tab.locator('.bulk-row');
  const beforeFilterCalls = chrome.commands.filter(
    (c) => c.method === 'Runtime.callFunctionOn',
  ).length;
  const filteredBulk = await bulkLoc.filter({ hasText: 'Needle 73' }).all();
  const filterCalls =
    chrome.commands.filter((c) => c.method === 'Runtime.callFunctionOn').length - beforeFilterCalls;
  assert.deepEqual(
    filteredBulk.map((e) => e.backendNodeId),
    [bulkItems[73]!.backendNodeId],
  );
  // 1 query call + 1 batched text probe across all 100 candidates (not 200+ serial calls).
  assert.equal(filterCalls, 2);

  const beforeHiddenCalls = chrome.commands.filter(
    (c) => c.method === 'Runtime.callFunctionOn',
  ).length;
  await bulkLoc.waitFor({ state: 'hidden', timeout: 1000 });
  const hiddenCalls =
    chrome.commands.filter((c) => c.method === 'Runtime.callFunctionOn').length - beforeHiddenCalls;
  // 1 query call + 1 batched visibility probe across all 100 candidates (not 200+ serial calls).
  assert.equal(hiddenCalls, 2);

  // Regression (P3): DOM.resolveNode returning `No node with given id found` is normalized into
  // StaleElementError (with original ProtocolError as cause) across Element state probes.
  const staleEl = new Element(tab.mainFrame, 999_999, tab.mainFrame.generation, tab.session);
  for (const probe of [
    () => staleEl.isVisible(),
    () => staleEl.isEnabled(),
    () => staleEl.isChecked(),
    () => staleEl.text(),
  ]) {
    await assert.rejects(probe(), (error: unknown) => {
      assert.ok(error instanceof StaleElementError);
      assert.ok(error.cause instanceof ProtocolError);
      assert.equal(error.cause.protocolMessage, 'No node with given id found');
      return true;
    });
  }
});

test('5b. Batched filter({ hasText }).first() returns a stable match even when a trailing item keeps detaching', async () => {
  await using chrome = await ScriptedChrome.start();
  const fake = makeFakeDom();
  const list = fake.createNode({ tagName: 'ul', id: 'volatile-list' });
  const stableFirst = fake.createNode(
    { tagName: 'li', classes: ['vrow'], text: 'Stable Target' },
    list,
  );
  // 98 middle rows + 1 volatile trailing row that detaches right as batch resolve runs.
  for (let i = 0; i < 98; i++)
    fake.createNode({ tagName: 'li', classes: ['vrow'], text: `Other ${i}` }, list);
  const volatileTail = fake.createNode(
    { tagName: 'li', classes: ['vrow'], text: 'Volatile Tail' },
    list,
  );
  let tailResolveHits = 0;
  let vanishMode: 'detach' | 'protocol' = 'detach';
  fake.install(chrome, {
    onResolve(backendNodeId) {
      if (backendNodeId !== volatileTail.backendNodeId) return;
      tailResolveHits++;
      if (vanishMode === 'detach') fake.detachNode(volatileTail);
      else throw new ProtocolError('DOM.resolveNode', -32000, 'No node with given id found');
    },
  });
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  const loc = tab.locator('.vrow').filter({ hasText: 'Stable Target' }).first();

  // Case 1: trailing node detaches (`!el.isConnected`) after DOM.resolveNode; first item still
  // resolves immediately in 2 Runtime.callFunctionOn calls (1 query + 1 batched text probe).
  const beforeDetach = chrome.commands.filter((c) => c.method === 'Runtime.callFunctionOn').length;
  const el1 = await loc.element({ timeout: 500 });
  const callsDetach =
    chrome.commands.filter((c) => c.method === 'Runtime.callFunctionOn').length - beforeDetach;
  assert.equal(el1.backendNodeId, stableFirst.backendNodeId);
  assert.equal(tailResolveHits, 1);
  assert.equal(callsDetach, 2);

  // Case 2: trailing node disappears before DOM.resolveNode (`No node with given id found`);
  // stable first item still succeeds on attempt #1.
  list.children.push(volatileTail);
  volatileTail.parentNode = list;
  vanishMode = 'protocol';
  const beforeProto = chrome.commands.filter((c) => c.method === 'Runtime.callFunctionOn').length;
  const el2 = await loc.element({ timeout: 500 });
  const callsProto =
    chrome.commands.filter((c) => c.method === 'Runtime.callFunctionOn').length - beforeProto;
  assert.equal(el2.backendNodeId, stableFirst.backendNodeId);
  assert.equal(tailResolveHits, 2);
  assert.equal(callsProto, 2);

  // Case 3: when a stale item precedes the requested index, it retries rather than silently
  // skipping over a potentially matching item.
  const volatileBeforeMatch = fake.createNode(
    { tagName: 'li', classes: ['vrow2'], text: 'Match A' },
    list,
  );
  fake.createNode({ tagName: 'li', classes: ['vrow2'], text: 'Match B' }, list);
  let firstStaleOnce = true;
  fake.install(chrome, {
    onResolve(backendNodeId) {
      if (backendNodeId === volatileBeforeMatch.backendNodeId && firstStaleOnce) {
        firstStaleOnce = false;
        throw new ProtocolError('DOM.resolveNode', -32000, 'No node with given id found');
      }
    },
  });
  const matched = await tab.locator('.vrow2').filter({ hasText: 'Match' }).first().element({
    timeout: 500,
  });
  assert.equal(firstStaleOnce, false);
  assert.equal(matched.backendNodeId, volatileBeforeMatch.backendNodeId);
});

test('5c. Streaming chunk early-stop skips later batches and mid-read detach throws StaleElementError (not EvaluationError)', async () => {
  await using chrome = await ScriptedChrome.start();
  const fake = makeFakeDom();
  const list = fake.createNode({ tagName: 'ul', id: 'stream-list' });
  const rows: FakeNode[] = [];
  for (let i = 0; i < 257; i++) {
    rows.push(
      fake.createNode(
        {
          tagName: 'li',
          classes: ['stream-row'],
          text: i === 0 ? 'First Winner' : `Row ${i}`,
          display: 'block',
        },
        list,
      ),
    );
  }
  const cb = fake.createNode({
    tagName: 'input',
    id: 'mid-detach',
    type: 'checkbox',
    checked: true,
  });

  const resolvedIds: number[] = [];
  let detachBeforeNextEval = false;
  fake.install(chrome, {
    onResolve(backendNodeId) {
      resolvedIds.push(backendNodeId);
      // Item 256 (3rd chunk) hangs forever if resolved; streaming early-stop must never touch it!
      if (backendNodeId === rows[256]!.backendNodeId) return NO_REPLY;
    },
    beforeCallFn(params) {
      if (detachBeforeNextEval && params.functionDeclaration.includes('__nodriver_detached_')) {
        detachBeforeNextEval = false;
        fake.detachNode(cb);
      }
    },
  });
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;

  // Regression (P2, round 4): 257-item filter({ hasText }).first() short-circuits after chunk 0.
  resolvedIds.length = 0;
  const firstEl = await tab
    .locator('.stream-row')
    .filter({ hasText: 'First Winner' })
    .first()
    .element({ timeout: 3000 });
  assert.equal(firstEl.backendNodeId, rows[0]!.backendNodeId);
  assert.equal(resolvedIds.includes(rows[256]!.backendNodeId), false);
  assert.equal(resolvedIds.length, 256);

  // waitFor({ state: 'hidden' }) also stops after chunk 0 when row 0 is visible.
  resolvedIds.length = 0;
  await assert.rejects(
    tab.locator('.stream-row').waitFor({ state: 'hidden', timeout: 90 }),
    TimeoutError,
  );
  assert.equal(resolvedIds.includes(rows[256]!.backendNodeId), false);

  // Regression (P3, round 4): Element detaching right after withWorldObject's isConnected check
  // throws StaleElementError (NOT EvaluationError) across evaluate/isVisible/isEnabled/isChecked.
  const cbEl = (await tab.query('#mid-detach'))!;
  for (const probe of [
    () => cbEl.evaluate(() => 123),
    () => cbEl.isVisible(),
    () => cbEl.isEnabled(),
    () => cbEl.isChecked(),
  ]) {
    // Re-attach before each probe so withWorldObject passes and detach happens inside evaluate().
    if (!cb.parentNode) {
      cb.parentNode = fake.doc;
      fake.doc.children.push(cb);
    }
    detachBeforeNextEval = true;
    await assert.rejects(probe(), (error: unknown) => {
      assert.ok(
        error instanceof StaleElementError,
        `expected StaleElementError, got ${String(error)}`,
      );
      assert.equal(error instanceof EvaluationError, false);
      return true;
    });
  }

  // User exception literally throwing `new Error('Node is detached')` still surfaces EvaluationError,
  // and special values (undefined, NaN, -0, BigInt) round-trip cleanly.
  if (!cb.parentNode) {
    cb.parentNode = fake.doc;
    fake.doc.children.push(cb);
  }
  await assert.rejects(
    cbEl.evaluate(() => {
      throw new Error('Node is detached');
    }),
    (error: unknown) => {
      assert.ok(error instanceof EvaluationError);
      assert.equal(error instanceof StaleElementError, false);
      return true;
    },
  );
  assert.equal(await cbEl.evaluate(() => undefined), undefined);
  assert.ok(Number.isNaN(await cbEl.evaluate(() => Number.NaN)));
  assert.ok(Object.is(await cbEl.evaluate(() => -0), -0));
  assert.equal(await cbEl.evaluate(() => 42n), 42n);
});

test('7. Tab.navigated, Tab.onClose and Browser.tabClosed emit accurately and once per live tab', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://start.test/' }] });
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;

  const navEvents: TabNavigationEvent[] = [];
  tab.navigated.on((e) => {
    navEvents.push(e);
  });

  const mainFrameInfo = (url: string): Protocol.Page.Frame => ({
    id: tab.mainFrame.id,
    loaderId: 'loader-2',
    url,
    domainAndRegistry: '',
    securityOrigin: 'https://start.test',
    mimeType: 'text/html',
    secureContextType: 'Secure',
    crossOriginIsolatedContextType: 'NotIsolated',
    gatedAPIFeatures: [],
  });
  chrome.emit(
    'Page.frameNavigated',
    { frame: mainFrameInfo('https://start.test/page2'), type: 'Navigation' },
    tab.cdp.id,
  );
  chrome.emit(
    'Page.navigatedWithinDocument',
    {
      frameId: tab.mainFrame.id,
      url: 'https://start.test/page2#section',
      navigationType: 'fragment',
    },
    tab.cdp.id,
  );
  chrome.emit(
    'Page.frameNavigated',
    { frame: mainFrameInfo('https://start.test/'), type: 'BackForwardCacheRestore' },
    tab.cdp.id,
  );
  chrome.emit(
    'Page.frameNavigated',
    {
      frame: {
        ...mainFrameInfo('https://sub.test/embed'),
        id: 'child-frame',
        parentId: tab.mainFrame.id,
      },
      type: 'Navigation',
    },
    tab.cdp.id,
  );
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(navEvents.length, 4);
  assert.deepEqual(
    navEvents.map((e) => ({
      tabId: e.tab.id,
      frameId: e.frame.id,
      url: e.url,
      sameDocument: e.sameDocument,
      restored: e.restored,
      isMainFrame: e.isMainFrame,
    })),
    [
      {
        tabId: tab.id,
        frameId: tab.mainFrame.id,
        url: 'https://start.test/page2',
        sameDocument: false,
        restored: false,
        isMainFrame: true,
      },
      {
        tabId: tab.id,
        frameId: tab.mainFrame.id,
        url: 'https://start.test/page2#section',
        sameDocument: true,
        restored: false,
        isMainFrame: true,
      },
      {
        tabId: tab.id,
        frameId: tab.mainFrame.id,
        url: 'https://start.test/',
        sameDocument: false,
        restored: true,
        isMainFrame: true,
      },
      {
        tabId: tab.id,
        frameId: 'child-frame',
        url: 'https://sub.test/embed',
        sameDocument: false,
        restored: false,
        isMainFrame: false,
      },
    ],
  );

  // Track browser.tabClosed and tab.onClose across close(), destroyTarget(), detachSession(), failed attach, and disconnect.
  const browserClosed: Tab[] = [];
  browser.tabClosed.on((closedTab) => {
    assert.equal(closedTab.closed, true);
    assert.equal(browser.tabs.includes(closedTab), false);
    browserClosed.push(closedTab);
  });

  // 1) tab.close()
  let tabCloseCount = 0;
  tab.onClose.on((closedTab) => {
    assert.equal(closedTab, tab);
    assert.equal(closedTab.closed, true);
    tabCloseCount++;
  });
  await tab.close();
  assert.equal(tabCloseCount, 1);
  assert.deepEqual(browserClosed, [tab]);

  // 2) remote destroyTarget()
  const tab2 = await browser.newTab();
  let tab2CloseCount = 0;
  tab2.onClose.on(() => {
    tab2CloseCount++;
  });
  const closedPromise = browser.waitEvent(browser.tabClosed, (t) => t === tab2, {}, 'tabClosed');
  chrome.destroyTarget(tab2.id);
  assert.equal(await closedPromise, tab2);
  assert.equal(tab2CloseCount, 1);

  // 3) session detach without target destruction -> emits close once; re-attach emits created + later close.
  const tab3 = await browser.newTab();
  let tab3CloseCount = 0;
  tab3.onClose.on(() => {
    tab3CloseCount++;
  });
  const detachedClose = browser.waitEvent(browser.tabClosed, (t) => t === tab3, {}, 'detachClose');
  chrome.detachSession(tab3.cdp.id!);
  assert.equal(await detachedClose, tab3);
  assert.equal(tab3CloseCount, 1);
  const tab3Reattached = await browser.attachTarget(tab3.id);
  assert.notEqual(tab3Reattached, tab3);

  // 4) Failed tab initialization must NOT emit tabCreated or tabClosed.
  let createdDuringFailure = 0;
  const offCreated = browser.tabCreated.on(() => {
    createdDuringFailure++;
  });
  const beforeFailCount = browserClosed.length;
  chrome.replyOnce('Page.enable', () => {
    throw new ProtocolError('Page.enable', -32000, 'init failed');
  });
  const badId = chrome.addPage({ url: 'https://fail.test/' });
  await new Promise((r) => setTimeout(r, 40));
  offCreated();
  assert.equal(createdDuringFailure, 0);
  assert.equal(browserClosed.length, beforeFailCount);
  assert.ok(badId);

  // 5) Browser disconnect notifies remaining live tabs once and preserves DisconnectedError on
  // attached child iframe sessions instead of misclassifying them as SessionEndedError('detached').
  const childSession = browser.connection.session('oopif-child');
  chrome.emit(
    'Target.attachedToTarget',
    {
      sessionId: 'oopif-child',
      targetInfo: {
        targetId: 'oopif-frame',
        type: 'iframe',
        title: '',
        url: 'https://sub.test/',
        attached: true,
        canAccessOpener: false,
      },
      waitingForDebugger: false,
    },
    tab3Reattached.cdp.id,
  );
  await new Promise((r) => setTimeout(r, 30));
  let childDisconnectReason: Error | undefined;
  childSession.disconnected.on((reason) => {
    childDisconnectReason = reason;
  });
  let tab3ReCloseCount = 0;
  tab3Reattached.onClose.on(() => {
    tab3ReCloseCount++;
  });
  chrome.disconnect();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(tab3ReCloseCount, 1);
  assert.equal(browserClosed.filter((t) => t === tab3).length, 1);
  assert.equal(browserClosed.filter((t) => t === tab3Reattached).length, 1);
  assert.ok(tab3Reattached.cdp.closeReason instanceof DisconnectedError);
  assert.ok(childDisconnectReason instanceof DisconnectedError);
  assert.equal(childDisconnectReason instanceof SessionEndedError, false);
  assert.ok(childSession.closeReason instanceof DisconnectedError);
});

test('8. findExecutable channel selection, Windows user-level Edge path, and LaunchOptions.channel validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nodriver-exec-'));
  const saved = {
    CHROME_PATH: process.env.CHROME_PATH,
    PROGRAMFILES: process.env.PROGRAMFILES,
    'PROGRAMFILES(X86)': process.env['PROGRAMFILES(X86)'],
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: process.env.PATH,
  };
  try {
    // Validation errors on all platforms.
    await assert.rejects(findExecutable({ prefer: [] }), TypeError);
    await assert.rejects(findExecutable({ prefer: ['firefox' as 'chrome'] }), TypeError);
    await assert.rejects(Browser.launch({ channel: 'firefox' as 'chrome' }), TypeError);
    await assert.rejects(Browser.launch({ channel: [] }), TypeError);

    const customBin = join(root, 'custom-browser.exe');
    await writeFile(customBin, '');
    assert.equal(await findExecutable(customBin), resolve(customBin));
    assert.equal(
      await findExecutable({ executablePath: customBin, prefer: ['edge'] }),
      resolve(customBin),
    );

    if (process.platform === 'win32') {
      const pf = join(root, 'ProgramFiles');
      const pfx86 = join(root, 'ProgramFilesX86');
      const localApp = join(root, 'LocalAppData');
      const pathDir = join(root, 'bin');
      const chromeExe = join(pf, 'Google/Chrome/Application/chrome.exe');
      const userEdgeExe = join(localApp, 'Microsoft/Edge/Application/msedge.exe');
      const envChrome = join(root, 'env-chrome.exe');
      await mkdir(join(pf, 'Google/Chrome/Application'), { recursive: true });
      await mkdir(join(localApp, 'Microsoft/Edge/Application'), { recursive: true });
      await mkdir(pathDir, { recursive: true });
      await writeFile(userEdgeExe, '');
      await writeFile(envChrome, '');

      delete process.env.CHROME_PATH;
      process.env.PROGRAMFILES = pf;
      process.env['PROGRAMFILES(X86)'] = pfx86;
      process.env.LOCALAPPDATA = localApp;
      process.env.PATH = pathDir;

      // Windows user-level %LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe is discovered.
      assert.equal(await findExecutable(), userEdgeExe);
      assert.equal(await findExecutable({ prefer: ['edge'] }), userEdgeExe);

      // Regression (P2): default search keeps Chrome SxS/Canary below stable Edge, while explicit
      // prefer: ['chrome'] selects Chrome SxS when stable Chrome is absent.
      const chromeSxsExe = join(localApp, 'Google/Chrome SxS/Application/chrome.exe');
      await mkdir(join(localApp, 'Google/Chrome SxS/Application'), { recursive: true });
      await writeFile(chromeSxsExe, '');
      assert.equal(await findExecutable(), userEdgeExe);
      assert.equal(await findExecutable({ prefer: ['chrome'] }), chromeSxsExe);

      // Missing requested channel reports explicit NodriverError (and LaunchOptions.channel maps cleanly).
      await assert.rejects(
        findExecutable({ prefer: ['chromium'] }),
        (error: unknown) => error instanceof NodriverError && /chromium/.test(error.message),
      );
      await assert.rejects(Browser.launch({ channel: 'chromium' }), (error: unknown) => {
        assert.ok(error instanceof NodriverError);
        assert.equal(getStartupDiagnostics(error)?.stage, 'process-launch');
        return true;
      });

      // With both Chrome and user-level Edge installed, channel preference controls selection.
      await writeFile(chromeExe, '');
      assert.equal(await findExecutable(), chromeExe);
      assert.equal(await findExecutable({ prefer: ['edge', 'chrome'] }), userEdgeExe);
      assert.equal(await findExecutable({ prefer: ['chrome', 'edge'] }), chromeExe);

      // CHROME_PATH wins when prefer is omitted, while explicit prefer overrides CHROME_PATH.
      process.env.CHROME_PATH = envChrome;
      assert.equal(await findExecutable(), resolve(envChrome));
      assert.equal(await findExecutable({ prefer: ['edge'] }), userEdgeExe);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
