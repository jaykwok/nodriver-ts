// Bounded semantic experiment, never a production fallback or a completeness claim.
import assert from 'node:assert/strict';
import { BrowserMcpSession } from '../src/mcp/session.ts';
import { fixtureServer } from '../test/fixtures/server.ts';

const results: unknown[] = [];
for (const transport of ['pipe', 'websocket'] as const) {
  const fixture = await fixtureServer();
  const session = new BrowserMcpSession({ launch: { headless: true, transport } });
  try {
    const tab = await session.newTab(new AbortController().signal);
    await tab.goto(`${fixture.base}/page?frames=1`);
    const browser = await session.getBrowser(new AbortController().signal);
    const wire = browser.connection.transport;
    const send = wire.send.bind(wire);
    let backendNodeId: number | undefined;
    wire.send = (message) => {
      const request = JSON.parse(message);
      if (backendNodeId && request.method === 'Accessibility.getFullAXTree') {
        request.method = 'Accessibility.queryAXTree';
        request.params = { backendNodeId };
      }
      return send(JSON.stringify(request));
    };
    for (const frame of tab.frames) {
      await frame.evaluate(
        `document.body.insertAdjacentHTML('afterbegin', '<section id="scope" aria-label="Scope"><button>First</button><div><button>Deep</button></div><input type="password" value="private-secret"></section>')`,
      );
      for (const selector of frame === tab.mainFrame
        ? ['body', '#scope', '#host']
        : ['body', '#scope']) {
        const element = (await frame.query(selector))!;
        const root = session.addRef(element);
        const expected = await session.snapshot(tab.id, { limit: 500, root }, {});
        assert.ok(!JSON.stringify(expected).includes('private-secret'));
        backendNodeId = element.backendNodeId;
        const start = performance.now();
        try {
          const actual = await session.snapshot(tab.id, { limit: 500, root }, { timeout: 1000 });
          results.push({
            transport,
            frame: frame.url,
            selector,
            elapsedMs: performance.now() - start,
            equivalent: JSON.stringify(actual) === JSON.stringify(expected),
          });
        } catch (error) {
          results.push({
            transport,
            frame: frame.url,
            selector,
            elapsedMs: performance.now() - start,
            error: String(error),
          });
        } finally {
          backendNodeId = undefined;
        }
      }
    }
  } finally {
    await session.dispose();
    await fixture.server.stop();
  }
}
console.log(JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
