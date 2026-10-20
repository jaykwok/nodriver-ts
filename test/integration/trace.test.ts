import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Browser, type TraceEntry } from '../../src/index.ts';

for (const transport of ['websocket', 'pipe'] as const) {
  test(`${transport}: launch trace receives startup, durations, failures and cancellation without params`, async () => {
    const traces: TraceEntry[] = [];
    await using browser = await Browser.launch({
      headless: true,
      maskHeadless: false,
      transport,
      trace: (entry) => traces.push(entry),
    });
    assert.ok(traces.some((entry) => entry.method === 'Browser.getVersion'));
    const tab = browser.tabs[0]!;
    await tab.cdp.send('Runtime.evaluate', { expression: '"secret-marker"' });
    await assert.rejects(tab.cdp.send('DOM.describeNode', { nodeId: -1 }));
    const controller = new AbortController();
    const pending = assert.rejects(
      tab.cdp.sendWith(
        'Runtime.evaluate',
        { signal: controller.signal },
        {
          expression: 'new Promise(() => {})',
          awaitPromise: true,
        },
      ),
      /cancel/,
    );
    controller.abort(new Error('cancel'));
    await pending;
    assert.ok(traces.some((entry) => entry.method === 'DOM.describeNode' && entry.error));
    assert.ok(
      traces.some((entry) => entry.method === 'Runtime.evaluate' && entry.error === 'Error'),
    );
    assert.ok(traces.every((entry) => Number.isFinite(entry.durationMs) && entry.durationMs >= 0));
    assert.ok(traces.some((entry) => entry.sessionId === tab.cdp.id));
    assert.equal(JSON.stringify(traces).includes('secret-marker'), false);
  });
}
