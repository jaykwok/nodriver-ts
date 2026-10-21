// Node.js smoke test against the built package (run: npm run test:dist).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Browser } from '../dist/index.js';
import { startBrowserMcpHttpServer } from '../dist/mcp/http.js';

const headless = process.env.NODRIVER_HEADFUL !== '1';
const page = `<!doctype html><title>smoke</title><button id="b" onclick="this.textContent='done'">Go</button><input id="i" aria-label="Name">`;
const site = createServer((_, res) =>
  res.writeHead(200, { 'content-type': 'text/html' }).end(page),
);
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${site.address().port}/`;

try {
  const browser = await Browser.launch({ headless, transport: 'pipe' });
  try {
    const tab = await browser.newTab(url);
    await (await tab.waitForSelector('#b')).click();
    assert.equal(await (await tab.query('#b')).text(), 'done');
    await (await tab.query('#i')).type('Ab!');
    assert.equal(await tab.evaluate(() => document.querySelector('input').value), 'Ab!');
  } finally {
    await browser.close();
  }

  const token = 't'.repeat(40);
  const server = await startBrowserMcpHttpServer({
    tokens: { [token]: 'smoke' },
    port: 0,
    browser: { launch: { headless } },
  });
  const client = new Client(
    { name: 'node-smoke', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    // No Browser-Lease-Id: the token's "default" lease is used.
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url + '/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'browser_snapshot'));
    const opened = await client.callTool({ name: 'browser_open', arguments: { url } });
    assert.ok(!opened.isError, JSON.stringify(opened.content));
    const tabId = opened.structuredContent.tabId;
    const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: { tabId } });
    assert.match(snapshot.content[0].text, /button "Go" \[e\d+\]/);
    const ref = /button "Go" \[(e\d+)\]/.exec(snapshot.content[0].text)[1];
    const clicked = await client.callTool({ name: 'browser_click', arguments: { tabId, ref } });
    assert.ok(!clicked.isError, JSON.stringify(clicked.content));
    await client.callTool({ name: 'browser_close', arguments: {} });
  } finally {
    await client.close().catch(() => {});
    await server.close();
  }
  console.log('node smoke ok');
} finally {
  site.close();
}
