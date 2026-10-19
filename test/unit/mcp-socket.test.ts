import { expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserMcpSocketClientTransport,
  startBrowserMcpSocketServer,
} from '../../src/mcp/socket.js';

const token = 'a'.repeat(40);
test('socket rejects bad credentials, oversized/slow preambles and excess connections without a lease', async () => {
  const server = await startBrowserMcpSocketServer({
    tokens: { [token]: 'alice' },
    maxConnections: 1,
    handshakeTimeout: 150,
  });
  try {
    const bad = new BrowserMcpSocketClientTransport({ path: server.path, token: 'wrong' });
    await expect(bad.start()).rejects.toThrow();
    const raw = createConnection(server.path);
    await once(raw, 'connect');
    const closed = once(raw, 'close');
    const excess = createConnection(server.path);
    excess.on('error', () => {});
    await once(excess, 'close');
    await closed;
    const oversized = createConnection(server.path);
    await once(oversized, 'connect');
    const rejected = once(oversized, 'close');
    oversized.write('x'.repeat(4097));
    await rejected;
    expect(server.manager.stats().leases).toBe(0);
    await bad.close();
  } finally {
    await server.close();
  }
});

test('socket validates credentials, limits and local paths before listening', async () => {
  await expect(startBrowserMcpSocketServer({ tokens: {} })).rejects.toThrow('credential');
  await expect(startBrowserMcpSocketServer({ tokens: { short: 'alice' } })).rejects.toThrow('32');
  await expect(
    startBrowserMcpSocketServer({ tokens: { [token]: 'alice' }, maxConnections: 0 }),
  ).rejects.toThrow('maxConnections');
  await expect(
    startBrowserMcpSocketServer({ tokens: { [token]: 'alice' }, path: 'relative.sock' }),
  ).rejects.toThrow();
  if (process.platform === 'win32') {
    await expect(
      startBrowserMcpSocketServer({
        tokens: { [token]: 'alice' },
        path: '\\\\remote\\pipe\\nodriver-x',
      }),
    ).rejects.toThrow('local');
  } else {
    await expect(
      startBrowserMcpSocketServer({
        tokens: { [token]: 'alice' },
        path: join(tmpdir(), 'nodriver-insecure.sock'),
      }),
    ).rejects.toThrow('0700');
  }
});

test('socket permissions, existing endpoint preservation and cleanup', async () => {
  const server = await startBrowserMcpSocketServer({ tokens: { [token]: 'alice' } });
  try {
    await expect(
      startBrowserMcpSocketServer({ tokens: { [token]: 'alice' }, path: server.path }),
    ).rejects.toThrow();
    const client = new BrowserMcpSocketClientTransport({ path: server.path, token });
    await client.start();
    expect(client.leaseId).toBeString();
    await client.close();
    if (process.platform !== 'win32') expect((await lstat(server.path)).mode & 0o777).toBe(0o600);
  } finally {
    await server.close();
  }
  const after = new BrowserMcpSocketClientTransport({ path: server.path, token });
  await expect(after.start()).rejects.toThrow();
  if (process.platform !== 'win32') {
    await expect(lstat(server.path)).rejects.toThrow();
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'nodriver-preserve-'));
    const path = join(dir, 'existing');
    try {
      await writeFile(path, 'preserve me');
      await expect(
        startBrowserMcpSocketServer({ tokens: { [token]: 'alice' }, path }),
      ).rejects.toThrow('exists');
      expect(await readFile(path, 'utf8')).toBe('preserve me');
    } finally {
      await rm(dir, { recursive: true });
    }
  }
});

test('socket authentication tolerates fragmentation and pipelined MCP bytes', async () => {
  const server = await startBrowserMcpSocketServer({ tokens: { [token]: 'alice' } });
  const socket = createConnection(server.path);
  const received: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => received.push(chunk));
  try {
    await once(socket, 'connect');
    const opening = Buffer.from(
      JSON.stringify({ type: 'nodriver-auth', token }) +
        '\n' +
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            clientInfo: { name: '中文😀', version: '1' },
            capabilities: {},
          },
        }) +
        '\n',
    );
    socket.write(opening.subarray(0, 13));
    await Bun.sleep(5);
    for (let at = 13; at < opening.length; at += 7) socket.write(opening.subarray(at, at + 7));
    for (let i = 0; i < 200 && !Buffer.concat(received).toString().includes('protocolVersion'); i++)
      await Bun.sleep(5);
    const messages = Buffer.concat(received)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    expect(messages[0]).toMatchObject({ type: 'nodriver-auth' });
    expect(messages[1]).toMatchObject({
      id: 1,
      error: { code: -32022, data: { supported: ['2026-07-28'] } },
    });
  } finally {
    socket.destroy();
    await server.close();
  }
});

test('socket endpoint collisions and repeated close survive 100 lifecycle cycles', async () => {
  for (let i = 0; i < 100; i++) {
    const server = await startBrowserMcpSocketServer({ tokens: { [token]: 'alice' } });
    try {
      await expect(
        startBrowserMcpSocketServer({ tokens: { [token]: 'alice' }, path: server.path }),
      ).rejects.toThrow();
      const client = new BrowserMcpSocketClientTransport({ path: server.path, token });
      await client.start();
      await client.close();
      await client.close();
    } finally {
      await server.close();
      await server.close();
    }
    expect(server.manager.stats().leases).toBe(0);
  }
});
