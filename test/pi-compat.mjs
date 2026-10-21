// Optional acceptance probe against the exact external Pi client, never a project dependency.
// npm install --prefix tmp/pi-1.3.0 --ignore-scripts @earendil-works/pi-coding-agent@1.3.0
// npm run build && node test/pi-compat.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startBrowserMcpHttpServer } from '../dist/mcp/http.js';

const packageDir = resolve(
  process.env.PI_MCP_PACKAGE ?? 'tmp/pi-1.3.0/node_modules/@earendil-works/pi-mcp',
);
const pkg = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@earendil-works/pi-mcp');
assert.equal(pkg.version, '1.3.0');
const { McpClient, StdioTransport, StreamableHttpTransport, SUPPORTED_PROTOCOL_VERSIONS } =
  await import(pathToFileURL(resolve(packageDir, 'dist/index.js')).href);
const { McpServerConnection, createDefaultTransport } = await import(
  pathToFileURL(resolve(packageDir, '../pi-coding-agent/dist/extensions/mcp/runtime.js')).href
);
const token = 'pi-compat-local-test-token-32-characters';
const server = await startBrowserMcpHttpServer({
  tokens: { [token]: 'pi-probe' },
  port: 0,
  compatibility: true,
  browser: { launch: { headless: true, transport: 'pipe' }, humanInteraction: true },
});
const report = {
  date: new Date().toISOString(),
  client: `${pkg.name}@${pkg.version}`,
  runtime: process.version,
  supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
  attempts: [],
  nativeExtension: [],
  compatible: [],
};
try {
  for (const kind of ['stdio', 'http']) {
    const transport =
      kind === 'stdio'
        ? new StdioTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/mcp/cli.js', import.meta.url)), '--headless'],
          })
        : new StreamableHttpTransport({
            url: `${server.url}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          });
    const requests = [];
    const send = transport.send.bind(transport);
    transport.send = (message, ...rest) => {
      if (message.method) requests.push(message);
      return send(message, ...rest);
    };
    const client = new McpClient({ name: 'pi', version: '1.3.0', requestTimeoutMs: 5000 });
    let failure;
    try {
      await client.connect(transport);
      assert.fail('Re-evaluate compatibility: Pi connected successfully');
    } catch (error) {
      failure = { name: error.name, code: error.code, message: error.message };
      assert.match(error.message, /2026-07-28|Unsupported protocol version/);
    } finally {
      await client.close();
    }
    assert.equal(requests[0]?.method, 'initialize');
    assert.equal(
      requests.some((r) => r.method === 'tools/call'),
      false,
    );
    report.attempts.push({ transport: kind, requests, failure });
    // Exercise Pi's actual built-in extension connection path as well as its wire client.
    const config =
      kind === 'stdio'
        ? {
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/mcp/cli.js', import.meta.url)), '--headless'],
          }
        : { url: `${server.url}/mcp`, headers: { Authorization: `Bearer ${token}` } };
    const connection = new McpServerConnection({
      entry: { name: 'nodriver', config, source: 'isolated-probe' },
      cwd: process.cwd(),
      createTransport: createDefaultTransport,
      credentials: {
        forServer() {
          throw new Error('Probe must not access OAuth credentials');
        },
      },
      onTools() {},
    });
    try {
      await assert.rejects(connection.getClient(), /Unsupported protocol version/);
      assert.equal(connection.state, 'failed');
      assert.equal(connection.tools.length, 0);
      report.nativeExtension.push({
        transport: kind,
        state: connection.state,
        tools: connection.tools.length,
        error: connection.error,
      });
    } finally {
      await connection.close();
    }
  }
  assert.equal(server.manager.stats().browsers, 0);
  report.browsersLaunched = server.manager.stats().browsers;
  for (const kind of ['stdio', 'http']) {
    const config =
      kind === 'stdio'
        ? {
            command: process.execPath,
            args: [
              fileURLToPath(new URL('../dist/mcp/cli.js', import.meta.url)),
              '--headless',
              '--mcp-compat',
              '--allow-handoff',
            ],
          }
        : { url: `${server.url}/mcp/compat`, headers: { Authorization: `Bearer ${token}` } };
    for (const layer of ['client', 'native-extension']) {
      const connection =
        layer === 'native-extension'
          ? new McpServerConnection({
              entry: { name: 'nodriver', config, source: 'isolated-probe' },
              cwd: process.cwd(),
              createTransport: createDefaultTransport,
              credentials: {
                forServer() {
                  throw new Error('Probe must not access OAuth credentials');
                },
              },
              onTools() {},
            })
          : undefined;
      const client = connection
        ? await connection.getClient()
        : new McpClient({ name: 'pi', version: '1.3.0', requestTimeoutMs: 10000 });
      const requests = [];
      try {
        if (!connection) {
          const transport =
            kind === 'stdio' ? new StdioTransport(config) : new StreamableHttpTransport(config);
          const send = transport.send.bind(transport);
          transport.send = (message, ...rest) => {
            if (message.method) requests.push(message.method);
            return send(message, ...rest);
          };
          await client.connect(transport);
        }
        assert.equal(client.protocolVersion, '2025-11-25');
        const tools = await client.listTools();
        assert.ok(tools.some((tool) => tool.name === 'browser_snapshot'));
        const invoke = (name, args = {}, options) =>
          connection
            ? connection.callTool(name, args, options)
            : client.callTool(name, args, options);
        const call = async (name, args = {}) => {
          const reply = await invoke(name, args);
          assert.ok(!reply.isError, JSON.stringify(reply));
          return reply.structuredContent;
        };
        const { tabId } = await call('browser_open', { url: 'about:blank' });
        await call('browser_evaluate', {
          tabId,
          script: `document.body.innerHTML='<button id="go">Go</button><input id="text">'; globalThis.clicks=0; document.querySelector('#go').onclick=()=>globalThis.clicks++;`,
        });
        const find = async (selector) =>
          (await call('browser_find', { tabId, selector })).elements[0].ref;
        const stale = await find('#go');
        await call('browser_fill', { tabId, ref: await find('#text'), text: 'Pi 中文😀' });
        assert.match(JSON.stringify(await call('browser_snapshot', { tabId })), /Pi 中文😀/);
        const abort = new AbortController();
        const waiting = invoke(
          'browser_wait',
          { tabId, selector: '#never', timeout: 10000 },
          { signal: abort.signal },
        );
        const rejected = assert.rejects(waiting);
        await new Promise((resolve) => setTimeout(resolve, 80));
        abort.abort();
        await rejected;
        assert.ok(
          !(await invoke('browser_click', { tabId, ref: stale }, { timeoutMs: 4000 })).isError,
        );
        assert.equal(
          (await call('browser_evaluate', { tabId, script: 'return clicks;' })).value,
          1,
        );
        assert.equal((await invoke('browser_handoff', { tabId })).isError, true);
        const image = (await invoke('browser_screenshot', { tabId })).content[0];
        assert.equal(image.type, 'image');
        await call('browser_navigate', { tabId, url: 'about:blank' });
        assert.equal((await invoke('browser_click', { tabId, ref: stale })).isError, true);
        await call('browser_close');
        if (!connection) assert.ok(requests.includes('notifications/cancelled'));
        report.compatible.push({
          transport: kind,
          layer,
          protocol: client.protocolVersion,
          tools: tools.length,
          browserFlow: 'passed',
          cancellation: 'passed',
          handoff: 'unsupported-capability',
          requests,
        });
      } finally {
        if (connection) await connection.close();
        else await client.close();
      }
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await server.close();
}
