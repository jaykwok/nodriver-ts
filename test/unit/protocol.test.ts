import { describe, test } from 'node:test';
import { PassThrough } from 'node:stream';
import { expect } from '../fixtures/expect.ts';
import {
  Connection,
  ProtocolError,
  SessionEndedError,
  TimeoutError,
  DisconnectedError,
  PipeDecoder,
  PipeTransport,
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
    const aError = await a.catch((e) => e);
    expect(aError).toBeInstanceOf(SessionEndedError);
    expect(aError instanceof DisconnectedError).toBe(false);
    t.respond(1, { product: 'okay' });
    expect((await b).product).toBe('okay');
    expect(s.closed).toBe(true);
    await expect(s.send('Page.getFrameTree')).rejects.toBeInstanceOf(SessionEndedError);
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
    expect(await rejected).toBeInstanceOf(SessionEndedError);
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
  test('a browser-level error for a detached session fails only that command with SessionEndedError', async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const p = c.session('gone').send('Page.getFrameTree');
    t.onmessage?.(
      JSON.stringify({
        id: t.messages[0]!.id,
        error: { code: -32001, message: 'Session with given id not found.' },
      }),
    );
    const error = await p.catch((e) => e);
    expect(error).toBeInstanceOf(SessionEndedError);
    expect(error instanceof DisconnectedError).toBe(false);
    expect(c.closed).toBe(false);
    expect(c.pendingCount).toBe(0);
    await c.close();
  });
  test('beforeSend blocks forbidden commands before the wire with zero debt and no send observation', async () => {
    const t = new FakeTransport();
    const seen: Array<{ method: string; params: unknown; sessionId?: string }> = [];
    const observed: string[] = [];
    const blocked = new Error('Forbidden CDP method');
    const c = new Connection(t, {
      observe: {
        onSend: (e) => observed.push(e.method),
        onSettle: () => observed.push('settle'),
      },
      beforeSend(method, params, sessionId) {
        seen.push({ method, params, sessionId });
        if (method.endsWith('.enable') || method === 'Target.setAutoAttach') throw blocked;
      },
    });
    const err = await c
      .session('page-1')
      .send('Runtime.enable')
      .catch((e) => e);
    expect(err).toBe(blocked);
    expect(t.messages).toHaveLength(0);
    expect(c.pendingCount).toBe(0);
    expect(c.unansweredCount).toBe(0);
    expect(observed).toEqual([]);
    const ok = c.session('page-1').send('Runtime.evaluate', { expression: '1 + 1' });
    t.respond(0, { result: { type: 'number', value: 2 } });
    expect((await ok).result.value).toBe(2);
    expect(seen).toEqual([
      { method: 'Runtime.enable', params: undefined, sessionId: 'page-1' },
      { method: 'Runtime.evaluate', params: { expression: '1 + 1' }, sessionId: 'page-1' },
    ]);
    expect(observed).toEqual(['Runtime.evaluate', 'settle']);
    await c.close();
  });
  test('beforeSend synchronously aborting signal, detaching session or closing connection sends nothing', async () => {
    const t = new FakeTransport();
    const observed: string[] = [];
    let hook: (() => void) | undefined;
    const c = new Connection(t, {
      observe: {
        onSend: (e) => observed.push(e.method),
        onSettle: () => observed.push('settle'),
      },
      beforeSend() {
        hook?.();
      },
    });
    const controller = new AbortController();
    const abortReason = new Error('aborted inside beforeSend');
    hook = () => controller.abort(abortReason);
    const abortErr = await c.root
      .sendWith('Browser.getVersion', { signal: controller.signal })
      .catch((e) => e);
    expect(abortErr).toBe(abortReason);
    expect(t.messages).toHaveLength(0);
    expect(c.pendingCount).toBe(0);
    expect(c.unansweredCount).toBe(0);
    expect(observed).toEqual([]);

    const sess = c.session('s-detach');
    hook = () => c.detach('s-detach');
    const detachErr = await sess.send('Page.getFrameTree').catch((e) => e);
    expect(detachErr).toBeInstanceOf(SessionEndedError);
    expect(t.messages).toHaveLength(0);
    expect(c.pendingCount).toBe(0);
    expect(c.unansweredCount).toBe(0);

    hook = () => {
      void c.close();
    };
    const closeErr = await c.root.send('Browser.getVersion').catch((e) => e);
    expect(closeErr).toBeInstanceOf(DisconnectedError);
    expect(t.messages).toHaveLength(0);
    expect(c.closed).toBe(true);
    expect(observed).toEqual([]);
  });
  test('sync and async transport send failures close the connection, reject sibling sessions and drain with DisconnectedError', async () => {
    for (const asyncFail of [false, true]) {
      const t = new FakeTransport();
      const raw = new Error(asyncFail ? 'async write failed' : 'sync write failed');
      let closeCalls = 0;
      t.close = () => {
        closeCalls++;
      };
      const c = new Connection(t);
      const sibling = c.session('sibling');
      const siblingPending = sibling.send('Page.getFrameTree');
      const draining = c.drain({ timeout: 500 });
      t.send = () => {
        if (asyncFail) return Promise.reject(raw);
        throw raw;
      };
      const err = await c.root.send('Browser.getVersion').catch((e) => e);
      expect(err).toBeInstanceOf(DisconnectedError);
      expect(err instanceof SessionEndedError).toBe(false);
      expect(err.message).toContain(raw.message);
      expect(err.cause).toBe(raw);
      expect(c.closed).toBe(true);
      expect(c.pendingCount).toBe(0);
      expect(c.unansweredCount).toBe(0);
      expect(closeCalls).toBe(1);
      const siblingErr = await siblingPending.catch((e) => e);
      expect(siblingErr).toBe(err);
      const drainErr = await draining.catch((e) => e);
      expect(drainErr).toBeInstanceOf(DisconnectedError);
      expect(drainErr.cause).toBe(err);
    }
  });
  test('pipe EPIPE and raw transport close errors normalize to DisconnectedError with original cause', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const pipe = new PipeTransport(readable, writable);
    const conn = new Connection(pipe);
    const pending = conn.root.send('Browser.getVersion');
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    writable.emit('error', epipe);
    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(DisconnectedError);
    expect(err instanceof SessionEndedError).toBe(false);
    expect(err.cause).toBe(epipe);
    expect(conn.closed).toBe(true);
    const after = await conn.root.send('Browser.getVersion').catch((e) => e);
    expect(after).toBeInstanceOf(DisconnectedError);

    // Custom transport invoking onclose with a plain Error also normalizes to DisconnectedError.
    const custom = new FakeTransport();
    const customConn = new Connection(custom);
    const req = customConn.root.send('Browser.getVersion');
    const rawClose = new Error('raw socket reset');
    custom.onclose?.(rawClose);
    const closeErr = await req.catch((e) => e);
    expect(closeErr).toBeInstanceOf(DisconnectedError);
    expect(closeErr instanceof SessionEndedError).toBe(false);
    expect(closeErr.cause).toBe(rawClose);
    await customConn.close();
  });
  test('local JSON serialization errors propagate directly without wrapping as DisconnectedError or closing the connection', async () => {
    const t = new FakeTransport();
    const c = new Connection(t);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const err = await c.root.send('Runtime.evaluate', circular as never).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err instanceof DisconnectedError).toBe(false);
    expect(c.closed).toBe(false);
    expect(c.pendingCount).toBe(0);
    expect(c.unansweredCount).toBe(0);
    expect(t.messages).toHaveLength(0);
    // The healthy connection remains usable after a local serialization error.
    const ok = c.root.send('Browser.getVersion');
    t.respond(0, { product: 'Chrome/ok' });
    expect((await ok).product).toBe('Chrome/ok');
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
