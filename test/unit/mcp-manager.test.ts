import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { OperationQueue } from '../../src/mcp/queue.ts';
import { BrowserSessionManager } from '../../src/mcp/manager.ts';
import { createBrowserMcpHttpService } from '../../src/mcp/http.ts';

test('bounded queue cancels waiting work and keeps a running operation locked until cleanup', async () => {
  const queue = new OperationQueue(1),
    signal = new AbortController().signal;
  let finish!: () => void;
  const history: string[] = [];
  const first = queue.run(
    signal,
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          history.push('cleaned');
          resolve();
        };
      }),
  );
  const controller = new AbortController();
  const waiting = queue.run(controller.signal, async () => {
    history.push('must not run');
  });
  const rejected = waiting.catch((error) => error);
  await expect(queue.run(signal, async () => {})).rejects.toThrow('limit');
  controller.abort(new Error('cancel queued'));
  expect(await rejected).toBeInstanceOf(Error);
  const next = queue.run(signal, async () => {
    history.push('next');
  });
  expect(history).toEqual([]);
  finish();
  await first;
  await next;
  expect(history).toEqual(['cleaned', 'next']);
});

test('HTTP body deadlines cancel slow readers and never allocate browser state', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const service = createBrowserMcpHttpService({
    tokens: { ['s'.repeat(40)]: 'local' },
    requestTimeout: 30,
  });
  try {
    const response = await service.fetch(
      new Request('http://127.0.0.1:3100/leases', {
        method: 'POST',
        headers: { authorization: `Bearer ${'s'.repeat(40)}`, 'content-type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit),
    );
    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(service.manager.stats().leases).toBe(0);
  } finally {
    await service.close();
  }
});

test('leases bind authenticated principals, expire idle state and protect active work', async () => {
  const manager = new BrowserSessionManager({
    maxLeases: 2,
    leaseIdleMs: 20,
    sweepIntervalMs: 60000,
  });
  try {
    const a = manager.create('alice'),
      b = manager.create('bob');
    expect(() => manager.session('bob', a.id)).toThrow('unauthorized');
    expect(() => manager.create('alice')).toThrow('capacity');
    const release = manager.retain('alice', a.id);
    await sleep(30);
    await manager.sweep();
    expect(manager.list('bob')).toEqual([]);
    expect(manager.list('alice')).toHaveLength(1);
    expect(() => manager.session('bob', b.id)).toThrow('expired');
    release();
    await sleep(30);
    await manager.sweep();
    expect(manager.stats().leases).toBe(0);
  } finally {
    await manager.close();
  }
  expect(() => manager.create('alice')).toThrow('stopping');
});
