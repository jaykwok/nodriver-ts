import { describe, test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import {
  Connection,
  ProtocolError,
  TimeoutError,
  DisconnectedError,
  PipeDecoder,
} from '../../src/index.ts';
import type { Transport } from '../../src/index.ts';
import { project } from '../../src/dom/element.ts';
class FakeTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason: Error) => void;
  messages: Array<{ id: number; method: string; sessionId?: string }> = [];
  send(message: string): void {
    this.messages.push(JSON.parse(message));
  }
  close(): void {}
  respond(index: number, result: unknown): void {
    const m = this.messages[index]!;
    this.onmessage?.(JSON.stringify({ id: m.id, sessionId: m.sessionId, result }));
  }
  event(method: string, params: unknown, sessionId?: string): void {
    this.onmessage?.(JSON.stringify({ method, params, sessionId }));
  }
}
describe('CDP connection', () => {
  test('concurrent responses route by id and session, including out of order', async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const a = c.root.send('Browser.getVersion');
    const b = c.session('page').send('Runtime.evaluate', { expression: '2' });
    t.respond(1, { result: { type: 'number', value: 2 } });
    t.respond(0, { product: 'Chrome/test' });
    expect((await a).product).toBe('Chrome/test');
    expect((await b).result.value).toBe(2);
    expect(c.pendingCount).toBe(0);
    await c.close();
  });
  test('timeout removes pending entry and ignores late response', async () => {
    const t = new FakeTransport();
    const c = new Connection(t, { timeout: 5 });
    await expect(c.root.send('Browser.getVersion')).rejects.toBeInstanceOf(TimeoutError);
    expect(c.pendingCount).toBe(0);
    t.respond(0, {});
    expect(c.closed).toBe(false);
    await c.close();
  });
  test('abort before and during request', async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const abort = new AbortController();
    const request = c.root.sendWith('Browser.getVersion', { signal: abort.signal });
    abort.abort(new Error('cancelled'));
    await expect(request).rejects.toThrow('cancelled');
    await expect(c.root.sendWith('Browser.getVersion', { signal: abort.signal })).rejects.toThrow(
      'cancelled',
    );
    expect(t.messages.length).toBe(1);
    expect(c.pendingCount).toBe(0);
    await c.close();
  });
  test('detach rejects only the associated session', async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const s = c.session('child');
    const a = s.send('Page.getFrameTree');
    const b = c.root.send('Browser.getVersion');
    t.event('Target.detachedFromTarget', { sessionId: 'child' });
    await expect(a).rejects.toBeInstanceOf(DisconnectedError);
    t.respond(1, { product: 'okay' });
    expect((await b).product).toBe('okay');
    expect(s.closed).toBe(true);
    await expect(s.send('Page.getFrameTree')).rejects.toBeInstanceOf(DisconnectedError);
    await c.close();
  });
  test('detaching a parent retires nested sessions even without child detach events', async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const parent = c.session('page');
    t.event('Target.attachedToTarget', { sessionId: 'oopif' }, 'page');
    const child = c.session('oopif');
    t.event('Target.attachedToTarget', { sessionId: 'nested' }, 'oopif');
    const nested = c.session('nested');
    const sibling = c.session('other-page');
    const baseline = c.events.size;
    child.on('Page.loadEventFired', () => {});
    nested.on('Page.loadEventFired', () => {});
    const pending = nested.send('Page.getFrameTree');
    const rejected = pending.catch((error) => error);
    t.event('Target.detachedFromTarget', { sessionId: 'page' });
    expect(parent.closed && child.closed && nested.closed).toBe(true);
    expect(sibling.closed).toBe(false);
    expect(c.events.size).toBe(baseline);
    expect(c.pendingCount).toBe(0);
    expect(await rejected).toBeInstanceOf(DisconnectedError);
    await c.close();
  });
  test('protocol errors preserve method, code and data', async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const p = c.root.send('Browser.getVersion');
    t.onmessage?.(
      JSON.stringify({
        id: t.messages[0]!.id,
        error: { code: -32601, message: 'Missing', data: 'details' },
      }),
    );
    await expect(p).rejects.toBeInstanceOf(ProtocolError);
    expect(c.closed).toBe(false);
    await c.close();
  });
  test('event order is preserved and throwing listeners cannot stop routing', async () => {
    const errors: unknown[] = [];
    const t = new FakeTransport();
    const c = new Connection(t, { onError: (e) => errors.push(e) });
    const s = c.session('page');
    const values: number[] = [];
    s.on('Page.loadEventFired', () => {
      throw Error('listener');
    });
    s.on('Page.loadEventFired', (e) => {
      values.push(e.timestamp);
    });
    t.event('Page.loadEventFired', { timestamp: 1 }, 'page');
    t.event('Page.loadEventFired', { timestamp: 2 }, 'page');
    expect(values).toEqual([1, 2]);
    expect(errors.length).toBe(2);
    await c.close();
  });
  test('event wait cleanup on timeout, cancellation and disconnection', async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const s = c.session('page');
    const initial = c.events.size;
    await expect(
      s.waitFor('Page.loadEventFired', undefined, { timeout: 1 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(c.events.size).toBe(initial);
    const abort = new AbortController();
    const p = s.waitFor('Page.loadEventFired', undefined, { signal: abort.signal });
    abort.abort();
    await expect(p).rejects.toThrow();
    expect(c.events.size).toBe(initial);
    const q = s.waitFor('Page.loadEventFired');
    await c.close();
    await expect(q).rejects.toBeInstanceOf(DisconnectedError);
    expect(c.events.size).toBe(0);
  });
  test('invalid JSON or session mismatch closes and rejects pending requests', async () => {
    for (const mismatch of [true, false]) {
      const t = new FakeTransport();
      const c = new Connection(t);
      const p = c.session('page').send('Page.getFrameTree');
      t.onmessage?.(
        mismatch ? JSON.stringify({ id: t.messages[0]!.id, result: {}, sessionId: 'wrong' }) : '{',
      );
      await expect(p).rejects.toBeInstanceOf(DisconnectedError);
      expect(c.closed).toBe(true);
      expect(c.pendingCount).toBe(0);
    }
  });
  test('a browser-level error for a detached session fails only that command', async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const p = c.session('gone').send('Page.getFrameTree');
    t.onmessage?.(
      JSON.stringify({
        id: t.messages[0]!.id,
        error: { code: -32001, message: 'Session with given id not found.' },
      }),
    );
    await expect(p).rejects.toBeInstanceOf(DisconnectedError);
    expect(c.closed).toBe(false);
    expect(c.pendingCount).toBe(0);
    await c.close();
  });
  test('transport failure cannot leave pending requests', async () => {
    const t = new FakeTransport();
    t.send = () => {
      throw Error('send failed');
    };
    const c = new Connection(t);
    await expect(c.root.send('Browser.getVersion')).rejects.toThrow('send failed');
    expect(c.pendingCount).toBe(0);
    await c.close();
  });
});
describe('pipe framing and coordinates', () => {
  test('every possible byte split preserves Unicode and multiple messages', () => {
    const text = JSON.stringify({ text: '中文 😀' });
    const bytes = Buffer.from(`${text}\0${text}\0`);
    for (let i = 0; i <= bytes.length; i++) {
      const messages: string[] = [];
      const d = new PipeDecoder((m) => messages.push(m));
      d.push(bytes.subarray(0, i));
      d.push(bytes.subarray(i));
      d.end();
      expect(messages).toEqual([text, text]);
    }
  });
  test('oversized and truncated pipe frames fail', () => {
    expect(() => new PipeDecoder(() => {}, 3).push(Buffer.from('1234'))).toThrow('size');
    const d = new PipeDecoder(() => {});
    d.push(Buffer.from('{'));
    expect(() => d.end()).toThrow('Truncated');
  });
  test('projective transform handles affine and perspective corners', () => {
    const q = [10, 20, 210, 30, 180, 140, 20, 120];
    expect(project({ x: 0, y: 0 }, 100, 100, q)).toEqual({ x: 10, y: 20 });
    const r = project({ x: 100, y: 100 }, 100, 100, q);
    expect(r.x).toBeCloseTo(180);
    expect(r.y).toBeCloseTo(140);
    expect(project({ x: 50, y: 50 }, 100, 100, [10, 20, 210, 20, 210, 120, 10, 120])).toEqual({
      x: 110,
      y: 70,
    });
  });
});
