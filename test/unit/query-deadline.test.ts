import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { Connection } from '../../src/protocol/connection.ts';
import { Frame, FrameManager } from '../../src/page/frames.ts';
import type { Tab } from '../../src/page/tab.ts';
import { TimeoutError } from '../../src/errors.ts';
import type { Transport } from '../../src/transport/transport.ts';

// A renderer that answers only the listed methods; everything else stalls until the
// connection deadline (deliberately far beyond the caller's own budget).
function stalled(answers: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const transport: Transport = {
    send(message) {
      const { id, method, sessionId } = JSON.parse(message);
      sent.push(method);
      if (method in answers)
        queueMicrotask(() =>
          transport.onmessage?.(JSON.stringify({ id, sessionId, result: answers[method] })),
        );
    },
    close() {},
  };
  const connection = new Connection(transport, { timeout: 5_000 });
  const session = connection.session('page');
  const manager = new FrameManager({} as Tab, session);
  const frame = new Frame(manager, 'root', session);
  manager.frames.set(frame.id, frame);
  manager.mainFrame = frame;
  return { connection, manager, frame, sent };
}

test('waitForSelector timeout bounds the execution-context lookup', async () => {
  const { connection, manager, frame, sent } = stalled();
  try {
    const started = performance.now();
    await expect(frame.waitForSelector('#missing', { timeout: 50 })).rejects.toThrow(TimeoutError);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(sent).toContain('Page.createIsolatedWorld');
  } finally {
    manager.dispose();
    await connection.close();
  }
});

test('an abort signal ends a query stalled inside a DOM request', async () => {
  const { connection, manager, frame, sent } = stalled({
    'Page.createIsolatedWorld': { executionContextId: 7 },
  });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('caller cancelled')), 30);
    const started = performance.now();
    await expect(
      frame.waitForSelector('#missing', { timeout: 4_000, signal: controller.signal }),
    ).rejects.toThrow('caller cancelled');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(sent).toContain('DOM.getDocument');
  } finally {
    manager.dispose();
    await connection.close();
  }
});

test('later query steps get only the remaining budget', async () => {
  const { connection, manager, frame, sent } = stalled({
    'Page.createIsolatedWorld': { executionContextId: 7 },
  });
  try {
    const started = performance.now();
    await expect(frame.queryAll('#missing', { timeout: 80 })).rejects.toThrow(TimeoutError);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(sent).toContain('DOM.getDocument');
    // Object cleanup is still attempted, on its own deadline.
    expect(sent).toContain('Runtime.releaseObjectGroup');
  } finally {
    manager.dispose();
    await connection.close();
  }
});

test('closed shadow roots found by one DOM scan serve later queries until the DOM changes', async () => {
  const node = (backendNodeId: number, nodeType: number, extra: object = {}) => ({
    nodeId: backendNodeId,
    backendNodeId,
    nodeType,
    nodeName: '',
    localName: '',
    nodeValue: '',
    ...extra,
  });
  const document = node(1, 9, {
    frameId: 'root',
    children: [node(2, 1, { shadowRoots: [node(3, 11, { shadowRootType: 'closed' })] })],
  });
  const { connection, manager, frame, sent } = stalled({
    'Page.createIsolatedWorld': { executionContextId: 7 },
    'DOM.getDocument': { root: document },
    'DOM.resolveNode': { object: { type: 'object', objectId: 'root' } },
    'Runtime.callFunctionOn': { result: { type: 'undefined' } },
    'Runtime.releaseObjectGroup': {},
  });
  const scans = () => sent.filter((method) => method === 'DOM.getDocument').length;
  try {
    await frame.queryAll('#missing');
    await frame.queryAll('#missing');
    expect(scans()).toBe(1);
    // Both queries searched the document and its closed root.
    expect(sent.filter((method) => method === 'DOM.resolveNode').length).toBe(4);
    connection.transport.onmessage?.(
      JSON.stringify({
        method: 'DOM.childNodeInserted',
        params: { parentNodeId: 1, previousNodeId: 2, node: node(4, 1) },
        sessionId: 'page',
      }),
    );
    await frame.queryAll('#missing');
    expect(scans()).toBe(2);
  } finally {
    manager.dispose();
    await connection.close();
  }
});
