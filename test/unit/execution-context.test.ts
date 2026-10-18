import { expect, test } from 'bun:test';
import { Connection } from '../../src/protocol/connection.js';
import { Frame, type FrameManager } from '../../src/page/frames.js';
import { parseRemoteObjectId, resolveMainContext } from '../../src/page/execution-context.js';
import { StaleElementError, UnsupportedError } from '../../src/errors.js';
import type { Transport } from '../../src/transport/transport.js';

class ContextTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (error: Error) => void;
  messages: Array<{ method: string; params: Record<string, unknown> }> = [];
  objectId = '-123.7.2';
  backendNodeId = 42;
  contextLost = false;
  onRelease?: () => void;
  send(message: string) {
    const m = JSON.parse(message);
    this.messages.push(m);
    if (this.contextLost && m.params?.expression === 'sideEffect()') {
      queueMicrotask(() =>
        this.onmessage?.(
          JSON.stringify({
            id: m.id,
            sessionId: m.sessionId,
            error: { code: -32000, message: 'Cannot find context with specified id' },
          }),
        ),
      );
      return;
    }
    let result: unknown;
    switch (m.method) {
      case 'Page.createIsolatedWorld':
        result = { executionContextId: 8 };
        break;
      case 'DOM.describeNode':
        result = {
          node: { backendNodeId: m.params.objectId === '-123.7.3' ? this.backendNodeId : 42 },
        };
        break;
      case 'DOM.resolveNode':
        result = { object: { type: 'object', objectId: this.objectId } };
        break;
      case 'Runtime.evaluate':
        result = {
          result:
            m.params.expression === 'this.document'
              ? { type: 'object', objectId: m.params.contextId === 8 ? '-123.8.1' : '-123.7.3' }
              : { type: 'number', value: 5 },
        };
        break;
      case 'Runtime.releaseObjectGroup':
        this.onRelease?.();
        result = {};
        break;
      default:
        throw new Error(`Unexpected command ${m.method}`);
    }
    queueMicrotask(() =>
      this.onmessage?.(JSON.stringify({ id: m.id, sessionId: m.sessionId, result })),
    );
  }
  close() {}
}

test('incompatible object IDs fail explicitly instead of guessing a context', () => {
  expect(parseRemoteObjectId('-123.7.2')).toEqual({ isolate: '-123', context: 7 });
  for (const id of [
    undefined,
    '',
    '7',
    '{}',
    'a.7.2',
    '1.0.1',
    '1.-1.2',
    '1.2147483648.2',
    '1.1.0',
    '1.2.3.extra',
  ])
    expect(() => parseRemoteObjectId(id)).toThrow(UnsupportedError);
});
test('wrong context/document fails closed and always releases temporary objects', async () => {
  for (const objectId of ['changed-format', '-123.8.2', '999.7.2', '-123.7.2']) {
    const transport = new ContextTransport();
    transport.objectId = objectId;
    transport.backendNodeId = 99;
    const connection = new Connection(transport);
    try {
      await expect(resolveMainContext(connection.session('frame'), 8, {})).rejects.toBeInstanceOf(
        UnsupportedError,
      );
      expect(transport.messages.at(-1)?.method).toBe('Runtime.releaseObjectGroup');
      expect(transport.messages.some((m) => m.method === 'Runtime.enable')).toBeFalse();
      expect(connection.pendingCount).toBe(0);
    } finally {
      await connection.close();
    }
  }
});
test('navigation during discovery cannot run user script; fresh document can recover', async () => {
  const transport = new ContextTransport();
  const connection = new Connection(transport);
  const frame = new Frame(
    { worldName: 'test' } as unknown as FrameManager,
    'frame',
    connection.session('page'),
  );
  transport.onRelease = () => frame.invalidate();
  try {
    await expect(frame.evaluate('sideEffect()')).rejects.toBeInstanceOf(StaleElementError);
    expect(transport.messages.some((m) => m.params?.expression === 'sideEffect()')).toBeFalse();
    transport.onRelease = undefined;
    expect(await frame.evaluate('sideEffect()')).toBe(5);
    expect(transport.messages.filter((m) => m.params?.expression === 'sideEffect()').length).toBe(
      1,
    );
  } finally {
    await connection.close();
  }
});

test('lost contexts clear caches for the next call without replaying user code', async () => {
  const transport = new ContextTransport();
  const connection = new Connection(transport);
  const frame = new Frame(
    { worldName: 'test' } as unknown as FrameManager,
    'frame',
    connection.session('page'),
  );
  try {
    await frame.evaluate('sideEffect()');
    transport.contextLost = true;
    await expect(frame.evaluate('sideEffect()')).rejects.toThrow('Cannot find context');
    expect(transport.messages.filter((m) => m.params?.expression === 'sideEffect()').length).toBe(
      2,
    );
    transport.contextLost = false;
    expect(await frame.evaluate('sideEffect()')).toBe(5);
    expect(transport.messages.filter((m) => m.method === 'Page.createIsolatedWorld').length).toBe(
      2,
    );
  } finally {
    await connection.close();
  }
});
