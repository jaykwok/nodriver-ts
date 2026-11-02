import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { expect } from '../fixtures/expect.ts';
import { Browser } from '../../src/browser/browser.ts';
import { OperationQueue } from '../../src/mcp/queue.ts';
import { BrowserPool } from '../../src/mcp/pool.ts';
import { BrowserSessionManager } from '../../src/mcp/manager.ts';
import { createBrowserMcpHttpService } from '../../src/mcp/http.ts';

const free = new AbortController().signal;
function fakeBrowser(closing?: Error, contextClosing?: Error) {
  const browser: any = {
    closed: false,
    input: {},
    closes: 0,
    close: async () => {
      browser.closes++;
      browser.closed = true;
      if (closing) throw closing;
    },
    newContext: async () => ({
      close: async () => {
        if (contextClosing) throw contextClosing;
      },
    }),
  };
  return browser;
}

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

test('leases bind authenticated principals, expire idle state and protect active work', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
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
    now += 20;
    await manager.sweep();
    expect(manager.list('bob')).toEqual([]);
    expect(manager.list('alice')).toHaveLength(1);
    expect(() => manager.session('bob', b.id)).toThrow('expired');
    release();
    now += 19;
    await manager.sweep();
    expect(manager.stats().leases).toBe(1);
    now++;
    await manager.sweep();
    expect(manager.stats().leases).toBe(0);
  } finally {
    await manager.close();
  }
  expect(() => manager.create('alice')).toThrow('stopping');
});

test('a held queue slot outlives the operation that returned, until its work settles', async () => {
  const queue = new OperationQueue(4);
  let finish!: () => void, fail!: (error: Error) => void;
  const history: string[] = [];
  let released = 0;
  const result = await queue.run(
    free,
    async () => {
      queue.hold(new Promise<void>((resolve) => (finish = resolve)));
      queue.hold(new Promise<void>((_, reject) => (fail = reject)));
      return 'returned';
    },
    () => released++,
  );
  expect(result).toBe('returned');
  const next = queue.run(free, async () => {
    history.push('next');
  });
  await tick();
  expect(queue.size).toBe(2);
  expect(released).toBe(0);
  expect(history).toEqual([]);
  finish();
  await tick();
  expect(history).toEqual([]);
  // A rejected hold only ends the hold.
  fail(new Error('Background failure'));
  await next;
  expect(history).toEqual(['next']);
  expect(released).toBe(1);
  await tick();
  expect(queue.size).toBe(0);
});

test('holding an idle queue takes the slot; release callbacks run for refused operations too', async () => {
  const queue = new OperationQueue(1);
  let finish!: () => void;
  queue.hold(new Promise<void>((resolve) => (finish = resolve)));
  expect(queue.size).toBe(1);
  const history: string[] = [];
  const next = queue.run(free, async () => {
    history.push('next');
  });
  await tick();
  expect(history).toEqual([]);
  let released = 0;
  // The waiting list is full.
  await expect(
    queue.run(
      free,
      async () => {},
      () => released++,
    ),
  ).rejects.toThrow('limit');
  expect(released).toBe(1);
  finish();
  await next;
  expect(history).toEqual(['next']);
  await tick();
  const aborted = new AbortController();
  aborted.abort(new Error('Cancelled'));
  await expect(
    queue.run(
      aborted.signal,
      async () => {},
      () => released++,
    ),
  ).rejects.toThrow('Cancelled');
  expect(released).toBe(2);
  // Cancelling a waiting operation releases it as well.
  let gate!: () => void;
  const running = queue.run(free, () => new Promise<void>((resolve) => (gate = resolve)));
  const cancel = new AbortController();
  const waiting = queue.run(
    cancel.signal,
    async () => {},
    () => released++,
  );
  cancel.abort(new Error('Cancelled'));
  await expect(waiting).rejects.toThrow('Cancelled');
  expect(released).toBe(3);
  gate();
  await running;
});

test('the pool gives a browser with blocked input no new allocations and closes it once unused', async (t) => {
  const browsers: any[] = [];
  t.mock.method(Browser, 'launch', async () => {
    browsers.push(fakeBrowser());
    return browsers.at(-1);
  });
  const pool = new BrowserPool({}, 2, 4, 32);
  const a = await pool.acquire(free),
    b = await pool.acquire(free);
  expect(a.browser).toBe(browsers[0]);
  expect(b.browser).toBe(browsers[0]);
  browsers[0].input.blocked = new Error('Input cleanup was not confirmed');
  const c = await pool.acquire(free);
  expect(c.browser).toBe(browsers[1]);
  // Both slots are taken while the blocked browser still has users.
  browsers[1].input.blocked = new Error('Input cleanup was not confirmed');
  await expect(pool.acquire(free)).rejects.toThrow('capacity');
  await a.release();
  expect(browsers[0].closes).toBe(0);
  await b.release();
  expect(browsers[0].closes).toBe(1);
  expect(pool.stats()).toMatchObject({ browsers: 1, allocations: 1 });
  await c.release();
  expect(browsers[1].closes).toBe(1);
  expect(pool.stats()).toMatchObject({ browsers: 0, allocations: 0 });
  // A browser that blocks while idle is replaced by the next allocation.
  const d = await pool.acquire(free);
  await d.release();
  browsers[2].input.blocked = new Error('Input cleanup was not confirmed');
  const e = await pool.acquire(free);
  expect(browsers[2].closes).toBe(1);
  expect(e.browser).toBe(browsers[3]);
  expect(pool.stats().browsers).toBe(1);
  await pool.close();
});

test('a browser that fails to close does not keep its pool slot', async (t) => {
  const failure = new Error('Browser did not close');
  let closing: Error | undefined = failure,
    contextClosing: Error | undefined;
  const browsers: any[] = [];
  t.mock.method(Browser, 'launch', async () => {
    browsers.push(fakeBrowser(closing, contextClosing));
    return browsers.at(-1);
  });
  // A persistent profile closes its browser on every release.
  const exclusive = new BrowserPool({ launch: { userDataDir: 'profile' } }, 1, 1, 32);
  const held = await exclusive.acquire(free);
  await expect(held.release()).rejects.toBe(failure);
  expect(exclusive.stats()).toMatchObject({ browsers: 0, allocations: 0 });
  closing = undefined;
  await (await exclusive.acquire(free)).release();
  expect(exclusive.stats().browsers).toBe(0);

  // A closed browser found by the next allocation: that allocation reports it once.
  closing = failure;
  const shared = new BrowserPool({}, 1, 4, 32);
  const allocation = await shared.acquire(free);
  await allocation.release();
  browsers.at(-1).input.blocked = new Error('Input cleanup was not confirmed');
  await expect(shared.acquire(free)).rejects.toBe(failure);
  expect(shared.stats().browsers).toBe(0);
  closing = undefined;
  const next = await shared.acquire(free);
  expect(shared.stats()).toMatchObject({ browsers: 1, allocations: 1 });

  // A context that fails to close still gives up its allocation.
  contextClosing = new Error('Context did not close');
  const third = new BrowserPool({}, 1, 4, 32);
  const failing = await third.acquire(free);
  await expect(failing.release()).rejects.toBe(contextClosing);
  expect(third.stats()).toMatchObject({ browsers: 1, allocations: 0 });
  await third.close();
  await next.release();
  await shared.close();
});

test('closing the pool closes every browser and reports the first failure', async (t) => {
  const failure = new Error('Browser did not close');
  const browsers = [fakeBrowser(failure), fakeBrowser()];
  let launches = 0;
  t.mock.method(Browser, 'launch', async () => browsers[launches++]);
  const pool = new BrowserPool({}, 2, 1, 32);
  await pool.acquire(free);
  await pool.acquire(free);
  await expect(pool.close()).rejects.toBe(failure);
  expect(browsers.map((browser) => browser.closes)).toEqual([1, 1]);
  expect(pool.stats().browsers).toBe(0);
});

test('a closing lease does not count against capacity', async () => {
  const manager = new BrowserSessionManager({ maxLeases: 1 });
  try {
    const first = manager.create('alice');
    let finish!: () => void;
    const running = manager
      .session('alice', first.id)
      .run(free, () => new Promise<void>((resolve) => (finish = resolve)));
    const releasing = manager.release('alice', first.id);
    expect(manager.stats().leases).toBe(1);
    const second = manager.create('alice');
    expect(manager.stats().leases).toBe(2);
    expect(() => manager.create('alice')).toThrow('capacity');
    finish();
    await running;
    await releasing;
    expect(manager.list('alice').map((lease) => lease.id)).toEqual([second.id]);
  } finally {
    await manager.close();
  }
});

test('closing the manager closes the pool after failed leases and reports the first failure', async (t) => {
  const manager = new BrowserSessionManager();
  const failing = manager.create('alice'),
    healthy = manager.create('alice');
  const failure = new Error('Lease did not close');
  t.mock.method(manager.session('alice', failing.id), 'dispose', async () => {
    throw failure;
  });
  const disposed = t.mock.method(manager.session('alice', healthy.id), 'dispose');
  const pool = t.mock.method(BrowserPool.prototype, 'close');
  manager.retired.on(() => {});
  await expect(manager.close()).rejects.toBe(failure);
  expect(disposed.mock.callCount()).toBe(1);
  expect(pool.mock.callCount()).toBe(1);
  expect(manager.retired.size).toBe(0);
  expect(manager.stats().leases).toBe(0);
  await expect(manager.close()).rejects.toBe(failure);
  pool.mock.restore();

  const second = new BrowserSessionManager();
  const closing = new Error('Pool did not close');
  t.mock.method(BrowserPool.prototype, 'close', async () => {
    throw closing;
  });
  second.retired.on(() => {});
  await expect(second.close()).rejects.toBe(closing);
  expect(second.retired.size).toBe(0);
});
