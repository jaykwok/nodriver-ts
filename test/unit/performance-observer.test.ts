import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Connection, type PerformanceObservation, type Transport } from '../../src/index.ts';

class ManualTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason: Error) => void;
  messages: string[] = [];
  send(message: string): void {
    this.messages.push(message);
  }
  close(): void {}
}

test('phase metrics reuse one parse, measure UTF-8 bytes and preserve late response semantics', async (t) => {
  const transport = new ManualTransport();
  const entries: PerformanceObservation[] = [];
  const connection = new Connection(transport, {
    observe: {
      onPerformance: (entry) => {
        entries.push(entry);
      },
    },
  });
  const controller = new AbortController();
  const pending = connection.root.sendWith(
    'Input.insertText',
    { signal: controller.signal },
    { text: 'private-input-π' },
  );
  controller.abort(new Error('cancel'));
  await assert.rejects(pending);
  const response = JSON.stringify({ id: 1, result: { value: 'private-output-π' } });
  const parse = JSON.parse;
  let parses = 0;
  t.mock.method(JSON, 'parse', (text: string) => {
    parses++;
    return parse(text);
  });
  transport.onmessage!(response);
  await connection.drain();
  assert.equal(parses, 1);
  assert.equal(entries.length, 2);
  const [send, receive] = entries;
  assert.ok(send?.direction === 'send');
  assert.ok(receive?.direction === 'receive');
  assert.equal(send.bytes, Buffer.byteLength(transport.messages[0]!));
  assert.equal(receive.bytes, Buffer.byteLength(response));
  assert.equal(receive.seq, send.seq);
  assert.equal(receive.method, 'Input.insertText');
  assert.ok(send.queueMs >= 0 && send.serializationMs >= 0);
  assert.ok(receive.responseWaitMs! >= 0 && receive.parseMs >= 0 && receive.dispatchMs >= 0);
  assert.doesNotMatch(JSON.stringify(entries), /private-input|private-output/);
  await connection.close();
});

test('receive metrics include synchronous event dispatch and isolate observer errors', async () => {
  const transport = new ManualTransport();
  let metric: PerformanceObservation | undefined;
  const connection = new Connection(transport, {
    observe: {
      onPerformance(entry) {
        metric = entry;
        throw new Error('observer');
      },
    },
  });
  let callbackDoneAt = 0;
  connection.root.on('Page.loadEventFired', () => {
    callbackDoneAt = performance.now();
  });
  transport.onmessage!(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } }));
  assert.ok(metric?.direction === 'receive');
  assert.equal(metric.kind, 'event');
  assert.ok(metric.at + metric.parseMs + metric.dispatchMs >= callbackDoneAt);
  assert.equal(metric.responseWaitMs, undefined);
  assert.equal(connection.closed, false);
  await connection.drain();
  await connection.close();
});
