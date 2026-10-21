import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { serveFetch } from '../dist/mcp/serve.js';
import { startBrowserMcpHttpServer } from '../dist/mcp/http.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { serveCompatibleBrowserMcpStdio } from '../dist/mcp/compat.js';

test('built compatibility exports negotiate both 2025 revisions on HTTP and stdio', async () => {
  assert.equal(typeof serveCompatibleBrowserMcpStdio, 'function');
  const token = 'local-built-compat-token-32-characters';
  const server = await startBrowserMcpHttpServer({
    tokens: { [token]: 'built-agent' },
    compatibility: true,
    port: 0,
  });
  try {
    for (const revision of ['2025-11-25', '2025-06-18'])
      for (const kind of ['stdio', 'http']) {
        const client = new Client(
          { name: 'built-compat', version: '1' },
          { supportedProtocolVersions: [revision], versionNegotiation: { mode: 'legacy' } },
        );
        const transport =
          kind === 'http'
            ? new StreamableHTTPClientTransport(new URL(server.url + '/mcp/compat'), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
              })
            : new StdioClientTransport({
                command: process.execPath,
                args: [
                  fileURLToPath(new URL('../dist/mcp/cli.js', import.meta.url)),
                  '--mcp-compat',
                ],
                stderr: 'pipe',
              });
        try {
          await client.connect(transport);
          assert.equal(client.getNegotiatedProtocolVersion(), revision);
          assert.equal((await client.listTools()).tools.length, 26);
          assert.equal(
            (await client.callTool({ name: 'browser_tabs' })).structuredContent.connected,
            false,
          );
        } finally {
          if (kind === 'http') await transport.terminateSession();
          await client.close();
        }
      }
    assert.equal(server.manager.stats().browsers, 0);
  } finally {
    await server.close();
  }
});

test('disconnecting an active streaming response cancels its producer', async () => {
  let canceled;
  const cancellation = new Promise((resolve) => {
    canceled = resolve;
  });
  const server = await serveFetch({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 1024,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: ready\n\n'));
          },
          cancel: canceled,
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const client = request(`http://127.0.0.1:${server.port}/`, (response) => {
    response.once('data', () => client.destroy());
  });
  client.on('error', () => {});
  client.end();
  let timer;
  try {
    await Promise.race([
      cancellation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('stream producer was not canceled')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    client.destroy();
    await server.close();
  }
});

test('a client disconnect before fetch resolves cancels the eventual response body', async () => {
  let requestReceived, reply, disconnected, canceled;
  const received = new Promise((resolve) => {
    requestReceived = resolve;
  });
  const responseReady = new Promise((resolve) => {
    reply = resolve;
  });
  const aborted = new Promise((resolve) => {
    disconnected = resolve;
  });
  const bodyCanceled = new Promise((resolve) => {
    canceled = resolve;
  });
  const server = await serveFetch({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 1024,
    async fetch(req) {
      req.signal.addEventListener('abort', disconnected, { once: true });
      requestReceived();
      await responseReady;
      return new Response(new ReadableStream({ cancel: canceled }));
    },
  });
  const client = request(`http://127.0.0.1:${server.port}/`);
  client.on('error', () => {});
  client.end();
  try {
    await received;
    client.destroy();
    await aborted;
    reply();
    let timer;
    try {
      await Promise.race([
        bodyCanceled,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('response body was not canceled')), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    reply();
    client.destroy();
    await server.close();
  }
});
