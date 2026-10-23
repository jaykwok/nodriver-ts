import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Connection,
  DisconnectedError,
  ProtocolError,
  TimeoutError,
  type ConnectionObserver,
  type ResponseObservation,
  type Transport,
} from '../../src/index.ts';
import { ScriptedChrome } from '../../src/testing/index.ts';
import { poll } from '../../src/utils.ts';

class ManualTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason: Error) => void;
  commands: Array<{ id: number; method: string; sessionId?: string }> = [];
  send(message: string): void | Promise<void> {
    this.commands.push(JSON.parse(message));
  }
  close(): void {}
  reply(index: number, fields: Record<string, unknown> = { result: {} }): void {
    const command = this.commands[index]!;
    this.onmessage?.(JSON.stringify({ id: command.id, sessionId: command.sessionId, ...fields }));
  }
}

function fixture() {
  const transport = new ManualTransport();
  const responses: ResponseObservation[] = [];
  const settles: Parameters<NonNullable<ConnectionObserver['onSettle']>>[0][] = [];
  const sends: Parameters<NonNullable<ConnectionObserver['onSend']>>[0][] = [];
  const connection = new Connection(transport, {
    observe: {
      onSend: (e) => {
        sends.push(e);
      },
      onSettle: (e) => {
        settles.push(e);
      },
      onResponse: (e) => {
        responses.push(e);
      },
    },
  });
  return { transport, connection, responses, settles, sends };
}

test('responses correlate out of order, omit payloads and ignore duplicate/unknown IDs', async () => {
  const { transport: t, connection: c, responses, sends, settles } = fixture();
  try {
    const a = c.root.send('Browser.getVersion');
    const b = c.session('page').send('Runtime.evaluate', { expression: 'secret expression' });
    const rejected = assert.rejects(b, ProtocolError);
    assert.equal(c.unansweredCount, 2);
    t.reply(1, { error: { code: -32000, message: 'secret message', data: 'secret data' } });
    t.reply(0, { result: { product: 'secret product' } });
    await Promise.all([a, rejected]);
    assert.deepEqual(
      responses.map((e) => [e.seq, e.method, e.sessionId, e.late, e.error]),
      [
        [sends[1]!.seq, 'Runtime.evaluate', 'page', false, '-32000'],
        [sends[0]!.seq, 'Browser.getVersion', undefined, false, undefined],
      ],
    );
    for (const e of responses) {
      const sent = sends.find((s) => s.seq === e.seq)!;
      assert.ok(e.at >= sent.at);
      assert.equal(e.durationMs, e.at - sent.at);
    }
    assert.equal(JSON.stringify(responses).includes('secret'), false);
    t.reply(0);
    t.onmessage?.(JSON.stringify({ id: 99999, result: {} }));
    assert.equal(responses.length, 2);
    assert.equal(settles.length, 2);
    assert.equal(c.unansweredCount, 0);
    assert.equal(c.pendingCount, 0);
  } finally {
    await c.close();
  }
});

for (const ending of ['abort', 'timeout', 'detach'] as const) {
  test(`${ending} settles once but retains debt through unrelated replies until the late response`, async () => {
    const { transport: t, connection: c, responses, settles } = fixture();
    try {
      const abort = new AbortController();
      const request = c.session('page').sendWith(
        'Runtime.evaluate',
        {
          signal: abort.signal,
          timeout: ending === 'timeout' ? 5 : 1000,
        },
        { expression: '42' },
      );
      const rejected = assert.rejects(request, ending === 'timeout' ? TimeoutError : Error);
      if (ending === 'abort') abort.abort(new Error('cancelled'));
      if (ending === 'detach') c.detach('page');
      await rejected;
      assert.equal(c.pendingCount, 0);
      assert.equal(c.unansweredCount, 1);
      assert.equal(settles.length, 1);
      assert.equal(responses.length, 0);
      for (let i = 0; i < 100; i++) {
        const other = c.root.send('Browser.getVersion');
        t.reply(i + 1);
        await other;
        assert.equal(c.unansweredCount, 1);
      }
      t.reply(0, { result: { result: { type: 'number', value: 42 } } });
      assert.equal(responses.at(-1)!.seq, t.commands[0]!.id);
      assert.equal(responses.at(-1)!.late, true);
      assert.equal(c.unansweredCount, 0);
      await Promise.resolve();
      assert.equal(settles.length, 101); // No second settlement for the late response.
    } finally {
      await c.close();
    }
  });
}

test('unanswered requests are tracked without observers and cleared before disconnection listeners', async () => {
  const t = new ManualTransport();
  const c = new Connection(t);
  const controller = new AbortController();
  const request = c.root.sendWith('Browser.getVersion', { signal: controller.signal });
  controller.abort();
  await assert.rejects(request);
  assert.equal(c.unansweredCount, 1);
  let countOnDisconnect: number | undefined;
  c.disconnected.on(() => {
    countOnDisconnect = c.unansweredCount;
  });
  t.onclose?.(new DisconnectedError('lost connection'));
  assert.equal(countOnDisconnect, 0);
  assert.equal(c.closed, true);
  t.reply(0);
  assert.equal(c.unansweredCount, 0);
});

test('pre-aborted and cancelled queued sends create no response debt', async () => {
  const { transport: t, connection: c, sends } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(c.root.sendWith('Browser.getVersion', { signal: controller.signal }));
  assert.equal(c.unansweredCount, 0);
  const queuedAbort = new AbortController();
  let queued: Promise<void> | undefined;
  c.options.observe!.onSend = (e) => {
    sends.push(e);
    const request = c.root.sendWith('Browser.getVersion', { signal: queuedAbort.signal });
    queued = assert.rejects(request);
    queuedAbort.abort();
  };
  const sent = c.root.send('Browser.getVersion');
  assert.equal(t.commands.length, 1);
  assert.equal(sends.length, 1);
  assert.equal(c.unansweredCount, 1);
  t.reply(0);
  await Promise.all([sent, queued]);
  assert.equal(c.unansweredCount, 0);
  await c.close();
});

test('synchronous response is not late even before send returns; observer reentry and errors are isolated', async () => {
  const { transport: t, connection: c, responses, settles } = fixture();
  t.send = (message) => {
    t.commands.push(JSON.parse(message));
    t.reply(t.commands.length - 1);
  };
  let nested: Promise<unknown> | undefined;
  c.options.observe!.onResponse = (e) => {
    responses.push(e);
    assert.equal(c.unansweredCount, 0);
    assert.equal(c.pendingCount, 0);
    if (responses.length === 1) nested = c.root.send('Browser.getVersion');
    throw new Error('observer failure');
  };
  await c.root.send('Browser.getVersion');
  await nested;
  assert.deepEqual(
    responses.map((e) => e.late),
    [false, false],
  );
  assert.equal(settles.length, 2);
  assert.equal(c.closed, false);
  await c.close();
});

test('abort inside onSend marks an immediate response late before the settlement microtask', async () => {
  const { transport: t, connection: c, responses, settles } = fixture();
  const controller = new AbortController();
  c.options.observe!.onSend = () => controller.abort(new Error('cancel in observer'));
  t.send = (message) => {
    t.commands.push(JSON.parse(message));
    t.reply(0);
  };
  const request = c.root.sendWith('Browser.getVersion', { signal: controller.signal });
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.late, true);
  assert.equal(settles.length, 0);
  await assert.rejects(request, /cancel in observer/);
  assert.equal(settles.length, 1);
  assert.equal(c.unansweredCount, 0);
  await c.close();
});

test('serialization failure produces neither a send attempt nor a response', async () => {
  const { transport: t, connection: c, sends, responses, settles } = fixture();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(
    c.root.send('Runtime.callFunctionOn', {
      functionDeclaration: 'function () {}',
      arguments: [{ value: circular }],
    }),
    /circular/i,
  );
  assert.equal(t.commands.length, 0);
  assert.equal(sends.length, 0);
  assert.equal(settles.length, 0);
  assert.equal(responses.length, 0);
  assert.equal(c.unansweredCount, 0);
  await c.close();
});

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? 'async' : 'sync'} send error retains uncertain delivery until response or close`, async () => {
    const { transport: t, connection: c, responses, settles } = fixture();
    t.send = (message) => {
      t.commands.push(JSON.parse(message));
      if (asynchronous) return Promise.reject(new Error('send failed'));
      throw new Error('send failed');
    };
    await assert.rejects(c.root.send('Browser.getVersion'), /send failed/);
    assert.equal(c.pendingCount, 0);
    assert.equal(c.unansweredCount, 1);
    t.reply(0);
    assert.equal(responses[0]!.late, true);
    assert.equal(c.unansweredCount, 0);
    assert.equal(settles.length, 1);
    await c.close();
  });
}

test('late browser-level detached-session errors are observed; mismatched sessions close without acknowledgement', async () => {
  for (const mismatch of [false, true]) {
    const { transport: t, connection: c, responses } = fixture();
    const abort = new AbortController();
    const request = c.session('page').sendWith('Page.getFrameTree', { signal: abort.signal });
    abort.abort();
    await assert.rejects(request);
    t.reply(
      0,
      mismatch
        ? { sessionId: 'wrong', result: {} }
        : { sessionId: undefined, error: { code: -32001, message: 'Session not found' } },
    );
    assert.equal(c.closed, mismatch);
    assert.equal(responses.length, mismatch ? 0 : 1);
    if (!mismatch) {
      assert.equal(responses[0]!.late, true);
      assert.equal(responses[0]!.sessionId, 'page');
      assert.equal(responses[0]!.error, '-32001');
    }
    assert.equal(c.unansweredCount, 0);
    await c.close();
  }
});

test('late attach observation includes independent cleanup debt until its detach response', async () => {
  await using chrome = await ScriptedChrome.start();
  const responses: ResponseObservation[] = [];
  const controller = new AbortController();
  let releaseAttach!: () => void;
  let releaseDetach!: () => void;
  const attachGate = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  const detachGate = new Promise<void>((resolve) => {
    releaseDetach = resolve;
  });
  chrome.replyOnce('Target.attachToTarget', async () => {
    await attachGate;
    return { sessionId: 'late-session' };
  });
  chrome.replyOnce('Target.detachFromTarget', async () => {
    await detachGate;
  });
  await using browser = await chrome.connect({ attach: 'none' });
  const c = browser.connection;
  const counts: number[] = [];
  c.options.observe = {
    onResponse: (e) => {
      responses.push(e);
      counts.push(c.unansweredCount);
    },
  };
  try {
    const attaching = browser.attachSession(browser.pageTargets[0]!.targetId, {
      signal: controller.signal,
    });
    await poll(
      async () => chrome.commands.some((c) => c.method === 'Target.attachToTarget') || undefined,
      { timeout: 1000 },
    );
    controller.abort(new Error('cancel attach'));
    await assert.rejects(attaching, /cancel attach/);
    assert.equal(c.pendingCount, 0);
    assert.equal(c.unansweredCount, 1);
    releaseAttach();
    await poll(async () => responses.length === 1 || undefined, { timeout: 1000 });
    assert.equal(responses[0]!.method, 'Target.attachToTarget');
    assert.equal(responses[0]!.late, true);
    assert.deepEqual(counts, [1]); // Cleanup was sent before user code observed the late reply.
    assert.equal(c.pendingCount, 1);
    releaseDetach();
    await poll(async () => c.unansweredCount === 0 || undefined, { timeout: 1000 });
    assert.deepEqual(
      responses.map((e) => [e.method, e.late]),
      [
        ['Target.attachToTarget', true],
        ['Target.detachFromTarget', false],
      ],
    );
    assert.deepEqual(counts, [1, 0]);
    assert.equal(c.pendingCount, 0);
    chrome.assertDone();
  } finally {
    releaseAttach();
    releaseDetach();
  }
});
