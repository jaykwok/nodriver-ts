import type { Protocol } from 'devtools-protocol';
import { ProtocolError } from '../../src/index.ts';
import type { ScriptedChrome } from '../../src/testing/index.ts';

/** Backend node IDs of the scripted document: one control and its label. */
export const CONTROL = 1;
export const LABEL = 2;

export interface ScriptedDom {
  control: { checked: boolean; radio: boolean; rendered: boolean; disabled: boolean };
  /** Whether the control has a rendered label to click instead of itself. */
  useLabel: boolean;
  /** Whether a click checks the control; false models a page that ignores it. */
  clickChanges: boolean;
  text: string;
  attribute: string | null;
  /** Delays reads of text and attributes. */
  readDelay: number;
  /** The next hit test fails as if the element had been replaced. */
  replaceBeforeInput: boolean;
  /** The next press fails as if the element had been replaced after input was sent. */
  replaceOnPress: boolean;
  /** Backend node IDs that received a press, in order. */
  pressed: number[];
  /** Text and keys that reached the page, in order. */
  typed: string[];
  /** Times the query ran. */
  queries: number;
}
const detached = {
  result: { type: 'undefined' },
  exceptionDetails: {
    exceptionId: 1,
    text: 'Uncaught',
    lineNumber: 0,
    columnNumber: 0,
    exception: { type: 'object', description: 'Error: Node is detached' },
  },
} as Protocol.Runtime.CallFunctionOnResponse;

/** Answers the commands of queries, element reads and instant-mode input for one element. */
export function scriptDom(chrome: ScriptedChrome, frameId: () => string): ScriptedDom {
  const dom: ScriptedDom = {
    control: { checked: false, radio: false, rendered: true, disabled: false },
    useLabel: false,
    clickChanges: true,
    text: 'text',
    attribute: 'value',
    readDelay: 0,
    replaceBeforeInput: false,
    replaceOnPress: false,
    pressed: [],
    typed: [],
    queries: 0,
  };
  const ids: Record<string, number> = { control: CONTROL, label: LABEL };
  const value = (value: unknown) =>
    ({ result: { type: 'object', value } }) as Protocol.Runtime.CallFunctionOnResponse;
  let pointed = CONTROL;
  chrome.handle('Page.bringToFront', () => {});
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
  chrome.handle('Runtime.releaseObjectGroup', () => {});
  chrome.handle('Runtime.getProperties', () => ({
    result: [
      {
        name: '0',
        value: { type: 'object', objectId: 'control' },
        configurable: true,
        enumerable: true,
      },
    ],
  }));
  chrome.handle('DOM.describeNode', (params) => ({
    node: {
      nodeId: 1,
      backendNodeId: ids[params!.objectId!]!,
      nodeType: 1,
      nodeName: 'INPUT',
      localName: 'input',
      nodeValue: '',
    },
  }));
  chrome.handle('DOM.resolveNode', (params) => ({
    object: { type: 'object', objectId: params!.backendNodeId === LABEL ? 'label' : 'control' },
  }));
  chrome.handle('DOM.scrollIntoViewIfNeeded', () => {});
  chrome.handle('DOM.getContentQuads', (params) => {
    pointed = params!.backendNodeId!;
    return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
  });
  chrome.handle(
    'Page.getLayoutMetrics',
    () =>
      ({
        cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
      }) as Protocol.Page.GetLayoutMetricsResponse,
  );
  chrome.handle('DOM.getNodeForLocation', () => ({ backendNodeId: pointed, frameId: frameId() }));
  chrome.handle('Input.dispatchMouseEvent', ({ type }) => {
    if (type === 'mousePressed') {
      dom.pressed.push(pointed);
      if (dom.replaceOnPress) {
        dom.replaceOnPress = false;
        throw new ProtocolError('Input.dispatchMouseEvent', -32000, 'No node found');
      }
    }
    if (type === 'mouseReleased' && dom.clickChanges) dom.control.checked = !dom.control.checked;
  });
  chrome.handle('Input.dispatchKeyEvent', ({ type, key }) => {
    if (type !== 'keyUp') dom.typed.push(key!);
  });
  chrome.handle('Input.insertText', ({ text }) => {
    dom.typed.push(text);
  });
  chrome.handle('Runtime.callFunctionOn', async ({ functionDeclaration: code }) => {
    if (code.startsWith('function(hit)')) return value(true);
    if (code.includes('.labels'))
      return dom.useLabel
        ? { result: { type: 'object', objectId: 'label' } }
        : { result: { type: 'object', subtype: 'null', value: null } };
    if (!code.includes('this.isConnected')) {
      dom.queries++;
      return { result: { type: 'object', objectId: 'matches' } };
    }
    if (code.includes('textContent ??') || code.includes('getAttribute(key)')) {
      await new Promise((resolve) => setTimeout(resolve, dom.readDelay));
      return value(code.includes('textContent ??') ? dom.text : dom.attribute);
    }
    if (code.includes('valid:')) {
      if (dom.replaceBeforeInput) {
        dom.replaceBeforeInput = false;
        return detached;
      }
      return value({ valid: true, u: 0.5, v: 0.5 });
    }
    if (code.includes('checkVisibility')) return value(dom.control);
    if (code.includes('.checked')) return value(dom.control.checked);
    return value(true);
  });
  return dom;
}
