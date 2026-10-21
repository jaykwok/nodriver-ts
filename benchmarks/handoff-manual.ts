// Interactive acceptance only. Never auto-confirms or synthesizes browser input.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startBrowserMcpHttpServer } from '../src/mcp/http.ts';
import { MCP_COMPATIBLE_VERSIONS } from '../src/mcp/protocol.ts';
import { serve } from '../test/fixtures/serve.ts';
import { findExecutable } from '../src/index.ts';

if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error(
    'Run in an interactive terminal: a person must operate Chrome and answer the prompt.',
  );
const protocol = process.env.HANDOFF_PROTOCOL ?? '2025-11-25';
const kind = process.env.HANDOFF_TRANSPORT ?? 'stdio';
assert.ok((MCP_COMPATIBLE_VERSIONS as readonly string[]).includes(protocol));
assert.ok(kind === 'stdio' || kind === 'http');
const deadline = 15 * 60 * 1000;
const controller = new AbortController();
const stop = () => controller.abort(new Error('Manual acceptance interrupted'));
process.once('SIGINT', stop);
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const evidence: Record<string, unknown> = {
  date: new Date().toISOString(),
  runtime: process.version,
  platform: process.platform,
  protocol,
  transport: kind,
  physicalInput: 'not-verified',
  limitations:
    'Interactive SDK host, not a Pi TUI/model test. Trust flags and user attestation do not independently prove physical input.',
};
const fixture = await serve({
  hostname: '127.0.0.1',
  fetch: () =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>Manual MCP handoff</title>
    <h1>Manual MCP handoff / 人工交接验收</h1>
    <p>Use your physical keyboard and mouse. Enter <b>manual-check</b> below and click Complete.
    Then return to the terminal. 本地测试：请勿输入密码或个人资料。</p>
    <input id="value" aria-label="Test value" autocomplete="off">
    <button id="complete">Complete / 完成</button><p id="status">Waiting for manual input</p>
    <script>
      const input = document.querySelector('#value');
      const status = document.querySelector('#status');
      document.querySelector('#complete').addEventListener('click', event => {
        status.textContent = input.value === 'manual-check' && event.isTrusted
          ? 'Manual interaction completed' : 'Enter manual-check and click the button';
      });
    </script>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
});
const client = new Client(
  { name: 'interactive-handoff-acceptance', version: '1' },
  {
    supportedProtocolVersions: [protocol],
    versionNegotiation: { mode: 'legacy' },
    capabilities: { elicitation: protocol === '2025-06-18' ? {} : { form: {} } },
  },
);
let answer: 'accept' | 'decline' | 'cancel' | undefined;
client.setRequestHandler('elicitation/create', async ({ params }) => {
  console.log(`\n${params.message}`);
  while (true) {
    const value = (
      await terminal.question(
        'After physically completing the test page, type accept; otherwise decline or cancel: ',
        { signal: controller.signal },
      )
    )
      .trim()
      .toLowerCase();
    if (value !== 'accept' && value !== 'decline' && value !== 'cancel') continue;
    answer = value;
    evidence.answer = value;
    evidence.physicalInput =
      value === 'accept' ? 'user-attested; not independently verified' : 'not-verified';
    return value === 'accept' ? { action: value, content: { finished: true } } : { action: value };
  }
});
const token = randomBytes(32).toString('hex');
let service: Awaited<ReturnType<typeof startBrowserMcpHttpServer>> | undefined;
let transport: StreamableHTTPClientTransport | StdioClientTransport | undefined;
try {
  if (kind === 'http') {
    service = await startBrowserMcpHttpServer({
      tokens: { [token]: 'manual-acceptance' },
      port: 0,
      compatibility: true,
      requestTimeout: deadline,
      streamTimeout: deadline,
      browser: { launch: { headless: false, transport: 'pipe' }, humanInteraction: true },
    });
    transport = new StreamableHTTPClientTransport(new URL(`${service.url}/mcp/compat`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
  } else
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../src/mcp/cli.ts', import.meta.url)),
        '--executable',
        await findExecutable(),
        '--headful',
        '--mcp-compat',
        '--allow-handoff',
      ],
      stderr: 'inherit',
    });
  await client.connect(transport);
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }, { timeout: deadline, signal: controller.signal });
  const opened = await call('browser_open', { url: `http://127.0.0.1:${fixture.port}` });
  assert.ok(!opened.isError, JSON.stringify(opened));
  const tabId = (opened.structuredContent as Record<string, unknown>).tabId;
  assert.equal(typeof tabId, 'string');
  const before = await call('browser_snapshot', { tabId });
  assert.ok(!before.isError, JSON.stringify(before));
  evidence.before = before.structuredContent;
  console.log(
    'A disposable Chrome window is ready. Only operate its local test page. No automation will type or click.',
  );
  const result = await call('browser_handoff', { tabId });
  evidence.result = result;
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(answer, 'The client did not receive a real confirmation prompt');
  assert.equal(
    (result.structuredContent as Record<string, unknown>)?.completed,
    answer === 'accept',
  );
  const after = await call('browser_snapshot', { tabId });
  assert.ok(!after.isError, JSON.stringify(after));
  evidence.after = after.structuredContent;
  if (answer === 'accept') {
    assert.doesNotMatch(JSON.stringify(before.structuredContent), /Manual interaction completed/);
    assert.match(JSON.stringify(after.structuredContent), /Manual interaction completed/);
  }
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = String(error);
  process.exitCode = 1;
} finally {
  controller.abort();
  terminal.close();
  process.removeListener('SIGINT', stop);
  const cleanupErrors: string[] = [];
  for (const cleanup of [
    async () => {
      if (transport instanceof StreamableHTTPClientTransport) await transport.terminateSession();
    },
    () => client.close(),
    async () => service?.close(),
    () => fixture.stop(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  if (cleanupErrors.length) {
    evidence.cleanupErrors = cleanupErrors;
    evidence.passed = false;
    process.exitCode = 1;
  }
  await mkdir(resolve('test-results'), { recursive: true });
  const output = resolve(`test-results/handoff-manual-${Date.now()}.json`);
  await writeFile(output, JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${output}; passed: ${evidence.passed === true}`);
}
