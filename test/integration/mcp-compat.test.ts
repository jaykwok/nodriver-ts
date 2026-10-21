import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startBrowserMcpHttpServer, type BrowserMcpHttpServer } from '../../src/mcp/http.ts';
import { MCP_COMPATIBLE_VERSIONS } from '../../src/mcp/protocol.ts';
import { fixtureServer } from '../fixtures/server.ts';
import { poll } from '../../src/utils.ts';
import { findExecutable } from '../../src/index.ts';

const alice = 'a'.repeat(40),
  bob = 'b'.repeat(40);
const tokens = { [alice]: 'alice', [bob]: 'bob' };
const cli = fileURLToPath(new URL('../../src/mcp/cli.ts', import.meta.url));
function clientFor(version: string, elicitation = false) {
  return new Client(
    { name: 'generic-agent', version: '1' },
    {
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === '2026-07-28' ? { pin: version } : 'legacy' },
      capabilities: elicitation
        ? { elicitation: version === '2025-06-18' ? {} : { form: {} } }
        : {},
    },
  );
}
function httpTransport(server: BrowserMcpHttpServer, id = 'default', token = alice) {
  return new StreamableHTTPClientTransport(new URL(server.url + '/mcp/compat'), {
    requestInit: { headers: { authorization: `Bearer ${token}`, 'Browser-Lease-Id': id } },
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 1000,
      initialReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1,
    },
  });
}
function data(reply: CallToolResult): Record<string, any> {
  assert.ok(!reply.isError, JSON.stringify(reply));
  return reply.structuredContent!;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return data(await client.callTool({ name, arguments: args }));
}
async function find(client: Client, tabId: string, selector: string) {
  return (await call(client, 'browser_find', { tabId, selector })).elements[0].ref as string;
}
for (const version of MCP_COMPATIBLE_VERSIONS)
  for (const kind of ['stdio', 'http'] as const)
    test(`generic MCP ${version} ${kind}: tools, refs, cancellation, capability gating and elicitation`, async () => {
      const fixture = await fixtureServer();
      const service =
        kind === 'http'
          ? await startBrowserMcpHttpServer({
              tokens,
              port: 0,
              compatibility: true,
              browser: { launch: { headless: true, transport: 'pipe' }, humanInteraction: true },
            })
          : undefined;
      const client = clientFor(version, true);
      let prompts = 0;
      let action: 'accept' | 'decline' | 'cancel' = 'accept';
      client.setRequestHandler('elicitation/create', async () => {
        prompts++;
        return action === 'accept' ? { action, content: { finished: true } } : { action };
      });
      const transport = service
        ? httpTransport(service)
        : new StdioClientTransport({
            command: process.execPath,
            args: [
              cli,
              // The SDK intentionally filters child environment variables, including CHROME_PATH.
              '--executable',
              await findExecutable(),
              '--headless',
              '--browser-transport',
              'pipe',
              '--mcp-compat',
              '--allow-handoff',
            ],
            stderr: 'pipe',
          });
      try {
        await client.connect(transport);
        assert.equal(client.getNegotiatedProtocolVersion(), version);
        assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'browser_handoff'));
        assert.equal((await client.listResources()).resources.length, 2);
        let notifications = 0;
        client.setNotificationHandler('notifications/resources/updated', () => {
          notifications++;
        });
        await assert.rejects(client.subscribeResource({ uri: 'browser://foreign' }));
        await client.subscribeResource({ uri: 'browser://state' });
        const progress: number[] = [];
        const { tabId } = data(
          await client.callTool(
            { name: 'browser_open', arguments: { url: fixture.base + '/page?frames=1' } },
            {
              onprogress: (update) => {
                progress.push(update.progress);
              },
            },
          ),
        );
        assert.deepEqual(progress, [0, 1, 2]);
        await poll(async () => (notifications > 0 ? true : undefined), { timeout: 2000 });
        await client.unsubscribeResource({ uri: 'browser://state' });
        const snapshot = await call(client, 'browser_snapshot', { tabId });
        const button = snapshot.nodes.find(
          (node: { name: string }) => node.name === 'Closed shadow',
        );
        assert.ok(button?.ref);
        await call(client, 'browser_click', { tabId, ref: button.ref });
        await call(client, 'browser_fill', {
          tabId,
          ref: await find(client, tabId, '#input'),
          text: '通用 agent 😀',
        });
        assert.match(
          JSON.stringify(await call(client, 'browser_snapshot', { tabId })),
          /通用 agent 😀/,
        );
        const image = (await client.callTool({ name: 'browser_screenshot', arguments: { tabId } }))
          .content[0];
        assert.equal(image?.type, 'image');
        const controller = new AbortController();
        const clickRef = await find(client, tabId, '#button');
        const waiting = client.callTool(
          { name: 'browser_wait', arguments: { tabId, selector: '#never', timeout: 10000 } },
          { signal: controller.signal },
        );
        const rejected = assert.rejects(waiting);
        await sleep(80);
        controller.abort();
        await rejected;
        // Follow-up write must acquire the same queue after the cancelled wait.
        data(
          await client.callTool(
            { name: 'browser_click', arguments: { tabId, ref: clickRef } },
            { timeout: 4000 },
          ),
        );
        for (action of ['accept', 'decline', 'cancel'] as const) {
          assert.equal(
            (await call(client, 'browser_handoff', { tabId })).completed,
            action === 'accept',
          );
        }
        assert.equal(prompts, 3); // Synthetic protocol responses, not a physical human acceptance test.
        assert.equal(
          (
            await call(client, 'browser_evaluate', {
              tabId,
              script: 'return globalThis.clicks;',
              world: 'main',
            })
          ).value,
          1,
        );
        await call(client, 'browser_navigate', { tabId, url: fixture.base + '/empty' });
        assert.equal(
          (await client.callTool({ name: 'browser_click', arguments: { tabId, ref: button.ref } }))
            .isError,
          true,
        );
        if (service) {
          const limited = clientFor(version);
          const limitedTransport = httpTransport(service);
          try {
            await limited.connect(limitedTransport);
            assert.equal(
              (await limited.callTool({ name: 'browser_handoff', arguments: { tabId } })).isError,
              true,
            );
            assert.equal((await call(limited, 'browser_tabs')).tabs.length, 1);
          } finally {
            await limitedTransport.terminateSession();
            await limited.close();
          }
        }
      } finally {
        if (transport instanceof StreamableHTTPClientTransport) await transport.terminateSession();
        await client.close();
        await service?.close();
        await fixture.server.stop();
      }
    });

test('compatible stdio still serves modern request envelopes', async () => {
  const client = clientFor('2026-07-28');
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, '--mcp-compat'],
        stderr: 'pipe',
      }),
    );
    assert.equal((await client.listTools()).tools.length, 26);
    assert.equal((await call(client, 'browser_tabs')).connected, false);
  } finally {
    await client.close();
  }
});

test('HTTP compatibility sessions: principal/lease isolation, capacity, DELETE and idle expiry', async () => {
  const service = await startBrowserMcpHttpServer({
    tokens,
    port: 0,
    compatibility: true,
    maxCompatibilitySessionsPerLease: 1,
    compatibilitySessionIdleMs: 150,
  });
  const client = clientFor('2025-11-25'),
    transport = httpTransport(service);
  const headers = {
    authorization: `Bearer ${alice}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'generic', version: '1' },
    },
  };
  try {
    // The default modern route never downgrades even when compatibility is enabled.
    assert.equal(
      (
        await fetch(service.url + '/mcp', {
          method: 'POST',
          headers,
          body: JSON.stringify(initialize),
        })
      ).status,
      400,
    );
    await client.connect(transport);
    const session = transport.sessionId!;
    assert.ok(session);
    for (const token of [bob, alice]) {
      const foreign = {
        ...headers,
        authorization: `Bearer ${token}`,
        'Browser-Lease-Id': token === alice ? 'other' : 'default',
        'mcp-session-id': session,
      };
      for (const method of ['POST', 'DELETE']) {
        assert.equal(
          (
            await fetch(service.url + '/mcp/compat', {
              method,
              headers: foreign,
              ...(method === 'POST'
                ? { body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }
                : {}),
            })
          ).status,
          404,
        );
      }
    }
    assert.equal((await client.listTools()).tools.length, 26);
    assert.equal(
      (
        await fetch(service.url + '/mcp/compat', {
          method: 'POST',
          headers,
          body: JSON.stringify(initialize),
        })
      ).status,
      429,
    );
    // Supplying a modern envelope must not use the cached initialize capabilities.
    const mixed = await fetch(service.url + '/mcp/compat', {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': session },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
      }),
    });
    assert.match(await mixed.text(), /Modern envelopes/);
    await transport.terminateSession();
    assert.equal(
      (
        await fetch(service.url + '/mcp/compat', {
          method: 'DELETE',
          headers: { ...headers, 'mcp-session-id': session },
        })
      ).status,
      404,
    );
    // A fresh connection can use the freed slot; close leaves no GET stream alive.
    const next = clientFor('2025-11-25'),
      nextTransport = httpTransport(service);
    await next.connect(nextTransport);
    const nextId = nextTransport.sessionId!;
    await next.close();
    await sleep(450);
    assert.equal(
      (
        await fetch(service.url + '/mcp/compat', {
          method: 'DELETE',
          headers: { ...headers, 'mcp-session-id': nextId },
        })
      ).status,
      404,
    );
  } finally {
    await client.close();
    await service.close();
  }
});

test('HTTP MCP session expiry preserves the browser lease; lease release closes active sessions', async () => {
  const fixture = await fixtureServer();
  const service = await startBrowserMcpHttpServer({
    tokens,
    port: 0,
    compatibility: true,
    compatibilitySessionIdleMs: 150,
    browser: { launch: { headless: true, transport: 'pipe' } },
  });
  const first = clientFor('2025-11-25'),
    firstTransport = httpTransport(service);
  const second = clientFor('2025-11-25'),
    secondTransport = httpTransport(service);
  try {
    await first.connect(firstTransport);
    // Browser startup and this call exceed MCP idle time, but active responses must survive.
    const { tabId } = await call(first, 'browser_open', { url: fixture.base + '/page' });
    const ref = await find(first, tabId, '#input');
    const leaseId = service.manager.list('alice')[0]!.id;
    const expired = firstTransport.sessionId!;
    await first.close(); // No DELETE: let the protocol idle timer expire it.
    await sleep(450);
    assert.equal(
      (
        await fetch(service.url + '/mcp/compat', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${alice}`, 'mcp-session-id': expired },
        })
      ).status,
      404,
    );
    await second.connect(secondTransport);
    await call(second, 'browser_fill', { tabId, ref, text: 'same browser lease' });
    assert.match(
      JSON.stringify(await call(second, 'browser_snapshot', { tabId })),
      /same browser lease/,
    );
    const pending = second.callTool(
      { name: 'browser_wait', arguments: { tabId, selector: '#never', timeout: 10000 } },
      { timeout: 4000 },
    );
    const caught = pending.catch((error) => error);
    await sleep(80);
    const released = await fetch(service.url + '/leases/' + leaseId, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${alice}` },
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(released.status, 204);
    // A legacy HTTP client's pending promise may wait for its own timeout when SSE
    // ends without a result. Explicit local close settles it; the server release
    // above must already have aborted/drained the ten-second operation.
    await second.close();
    const result = await caught;
    assert.ok(result instanceof Error || result.isError);
    assert.equal(service.manager.stats().allocations, 0);
    assert.equal(
      (
        await fetch(service.url + '/mcp/compat', {
          method: 'DELETE',
          headers: {
            authorization: `Bearer ${alice}`,
            'Browser-Lease-Id': leaseId,
            'mcp-session-id': secondTransport.sessionId!,
          },
        })
      ).status,
      404,
    );
  } finally {
    await first.close();
    await second.close();
    await service.close();
    await fixture.server.stop();
  }
});
