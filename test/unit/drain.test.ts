import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import {
  Connection,
  TargetSession,
  TimeoutError,
  DisconnectedError,
  type Transport,
} from '../../src/index.ts';

class ManualTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason: Error) => void;
  commands: Array<{ id: number; method: string; sessionId?: string }> = [];
  send(message: string): void {
    this.commands.push(JSON.parse(message));
  }
  close(): void {}
  reply(index: number, fields: Record<string, unknown> = { result: {} }): void {
    this.onmessage?.(JSON.stringify({ ...this.commands[index], ...fields }));
  }
}
async function checkpoint(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('drain waits for late responses, has independent waiters and does not resend or disconnect on timeout', async () => {
  const t = new ManualTransport();
  const c = new Connection(t);
  try {
    await c.drain();
    const controller = new AbortController();
    const request = c.root.sendWith(
      'Input.insertText',
      { signal: controller.signal },
      { text: 'once' },
    );
    controller.abort(new Error('cancel input'));
    await assert.rejects(request, /cancel input/);
    let drained = false;
    const waiting = c.drain().then(() => {
      drained = true;
    });
    await assert.rejects(c.drain({ timeout: 10 }), TimeoutError);
    assert.equal(drained, false);
    assert.equal(c.closed, false);
    assert.equal(t.commands.length, 1);
    t.reply(0);
    await waiting;
    assert.equal(c.unansweredCount, 0);
  } finally {
    await c.close();
  }
});

test('drain distinguishes disconnect even after counters clear; abort only cancels its waiter', async () => {
  const t = new ManualTransport();
  const c = new Connection(t);
  const request = assert.rejects(c.root.send('Browser.getVersion'));
  const controller = new AbortController();
  const reason = new Error('stop waiting');
  const cancelled = assert.rejects(
    c.drain({ signal: controller.signal }),
    (error) => error === reason,
  );
  controller.abort(reason);
  await cancelled;
  assert.equal(c.closed, false);
  const waiting = assert.rejects(c.drain(), DisconnectedError);
  t.onclose?.(new Error('wire lost'));
  await Promise.all([request, waiting]);
  assert.equal(c.pendingCount, 0);
  assert.equal(c.unansweredCount, 0);
  await assert.rejects(c.drain(), DisconnectedError);
});

test('drain includes late attach cleanup before onResponse and its cleanup decision', async () => {
  for (const fail of [false, true]) {
    const t = new ManualTransport();
    const c = new Connection(t);
    try {
      const controller = new AbortController();
      const attaching = c.attachSession('target', { signal: controller.signal });
      controller.abort(new Error('cancel attach'));
      await assert.rejects(attaching);
      let drained = false;
      const waiting = c.drain().then(() => {
        drained = true;
      });
      const result = fail ? assert.rejects(waiting, DisconnectedError) : waiting;
      t.reply(0, { result: { sessionId: 'late' } });
      await checkpoint();
      assert.equal(drained, false);
      assert.equal(t.commands[1]?.method, 'Target.detachFromTarget');
      t.reply(1, fail ? { error: { code: -1, message: 'cleanup failed' } } : { result: {} });
      await result;
      assert.equal(c.closed, fail);
    } finally {
      await c.close();
    }
  }
});

test('drain waits across a rejected detach and its asynchronous cleanup retry', async () => {
  const t = new ManualTransport();
  const c = new Connection(t);
  try {
    const session = new TargetSession(c, 'session', 'target');
    const detaching = assert.rejects(session.detach(), /first detach failed/);
    let drained = false;
    const waiting = c.drain().then(() => {
      drained = true;
    });
    t.reply(0, { error: { code: -1, message: 'first detach failed' } });
    await detaching;
    await checkpoint();
    assert.equal(drained, false);
    assert.equal(t.commands[1]?.method, 'Target.detachFromTarget');
    t.reply(1);
    await waiting;
  } finally {
    await c.close();
  }
});

test('drain covers queued and observer-triggered sends with synchronous transports', async () => {
  const t = new ManualTransport();
  t.send = function (message) {
    this.commands.push(JSON.parse(message));
    this.reply(this.commands.length - 1);
  };
  let waiting!: Promise<void>;
  let extra!: Promise<unknown>;
  const c = new Connection(t, {
    observe: {
      onSend(e) {
        if (e.seq === 1) waiting = c.drain();
      },
      onSettle(e) {
        if (e.seq === 1) extra = c.root.send('Browser.getVersion');
      },
    },
  });
  await c.root.send('Browser.getVersion');
  await waiting;
  assert.equal(t.commands.length, 2);
  await extra;
  await c.close();
});

test('drain releases abort listeners on success, timeout and disconnect', async () => {
  const t = new ManualTransport();
  const c = new Connection(t);
  const controller = new AbortController();
  await c.drain({ signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const request = assert.rejects(c.root.send('Browser.getVersion'));
  await assert.rejects(c.drain({ signal: controller.signal, timeout: 5 }), TimeoutError);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const waiting = assert.rejects(c.drain({ signal: controller.signal }), DisconnectedError);
  await c.close();
  await Promise.all([request, waiting]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('uncertain send failure retains drain debt until an ACK; serialization failure does not', async () => {
  const t = new ManualTransport();
  t.send = function (message) {
    this.commands.push(JSON.parse(message));
    throw new Error('partial write');
  };
  const c = new Connection(t);
  try {
    await assert.rejects(c.root.send('Browser.getVersion'), /partial write/);
    await assert.rejects(c.drain({ timeout: 5 }), TimeoutError);
    t.reply(0);
    await c.drain();
    const text = {
      toJSON() {
        throw new Error('bad serialization');
      },
    } as unknown as string;
    await assert.rejects(c.root.send('Input.insertText', { text }), /bad serialization/);
    await c.drain();
    assert.equal(t.commands.length, 1);
  } finally {
    await c.close();
  }
});
