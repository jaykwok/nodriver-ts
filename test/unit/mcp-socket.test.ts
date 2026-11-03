import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserSessionManager } from '../../src/mcp/manager.ts';
import { poll } from '../../src/utils.ts';
import {
  BrowserMcpSocketClientTransport,
  startBrowserMcpSocketServer,
} from '../../src/mcp/socket.ts';

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
    expect(client.leaseId).toEqual(expect.any(String));
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
    await sleep(5);
    for (let at = 13; at < opening.length; at += 7) socket.write(opening.subarray(at, at + 7));
    for (let i = 0; i < 200 && !Buffer.concat(received).toString().includes('protocolVersion'); i++)
      await sleep(5);
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

test('the socket client validates its options before it connects', () => {
  const path =
    process.platform === 'win32' ? '\\\\.\\pipe\\nodriver-unused' : join(tmpdir(), 'unused.sock');
  for (const handshakeTimeout of [0, -1, 1.5])
    expect(() => new BrowserMcpSocketClientTransport({ path, token, handshakeTimeout })).toThrow(
      'handshakeTimeout',
    );
  expect(() => new BrowserMcpSocketClientTransport({ path: 'relative.sock', token })).toThrow();
});

test('a client handshake keeps the socket error as its cause', async (t) => {
  const directory =
    process.platform === 'win32'
      ? undefined
      : await mkdtemp(join(await realpath(tmpdir()), 'nodriver-silent-'));
  const path = directory ? join(directory, 's') : `\\\\.\\pipe\\nodriver-${randomUUID()}`;
  const sockets: Array<{ destroy(): void }> = [];
  const silent = createServer((socket) => {
    socket.on('error', () => {});
    sockets.push(socket);
  });
  silent.listen(path);
  await once(silent, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    silent.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const client = new BrowserMcpSocketClientTransport({ path, token, handshakeTimeout: 30 });
  const failure = await client.start().catch((error: Error) => error);
  expect((failure as Error).message).toBe('Socket authentication failed or timed out');
  expect(((failure as Error).cause as Error).message).toBe('Socket connect deadline exceeded');
});

test('the socket server reports the cause of a refused connection, never the raw input', async () => {
  const errors: Error[] = [];
  const server = await startBrowserMcpSocketServer({
    tokens: { [token]: 'alice' },
    handshakeTimeout: 2000,
    onError: (error) => errors.push(error),
  });
  try {
    const send = async (line: string) => {
      const before = errors.length;
      const socket = createConnection(server.path);
      socket.on('error', () => {});
      await once(socket, 'connect');
      socket.write(line + '\n');
      await poll(async () => (errors.length > before ? true : undefined), { timeout: 3000 });
      socket.destroy();
      return errors.at(-1)!;
    };
    const secret = 'hunter2'.repeat(6);
    const wrong = await send(JSON.stringify({ type: 'nodriver-auth', token: secret }));
    expect(wrong.message).toBe('Socket authentication failed or connection closed');
    expect((wrong.cause as Error).message).toBe('Socket authentication failed');
    const malformed = await send(`{"token":"${secret}`);
    expect((malformed.cause as Error).message).toBe('Socket authentication failed or timed out');
    expect((malformed.cause as Error).cause).toBeUndefined();
    const unknown = await send(
      JSON.stringify({ type: 'nodriver-auth', token, leaseId: 'bad name!' }),
    );
    expect((unknown.cause as Error).message).toBe('Invalid lease name');
    for (const error of errors)
      for (let e: unknown = error; e; e = (e as Error).cause)
        expect(String((e as Error).message)).not.toContain('hunter2');
  } finally {
    await server.close();
  }
});

test('a socket server that fails to start leaves no manager or temporary directory behind', async (t) => {
  const closes = t.mock.method(BrowserSessionManager.prototype, 'close');
  const running = await startBrowserMcpSocketServer({ tokens: { [token]: 'alice' } });
  try {
    closes.mock.resetCalls();
    await expect(
      startBrowserMcpSocketServer({ tokens: { [token]: 'alice' }, path: running.path }),
    ).rejects.toThrow();
    expect(closes.mock.callCount()).toBe(1);
    // An injected manager belongs to the caller.
    closes.mock.resetCalls();
    const manager = new BrowserSessionManager();
    t.after(() => manager.close());
    await expect(
      startBrowserMcpSocketServer({ tokens: { [token]: 'alice' }, path: running.path, manager }),
    ).rejects.toThrow();
    expect(closes.mock.callCount()).toBe(0);
    expect(manager.retired.size).toBe(0);
  } finally {
    await running.close();
  }
  await expect(
    startBrowserMcpSocketServer({ tokens: { [token]: 'alice' }, browser: { maxLeases: 0 } }),
  ).rejects.toThrow('maxLeases');
  if (process.platform === 'win32') return;
  // macOS's own temporary directory leaves too little room for the socket path below it.
  const root = await mkdtemp(join(await realpath('/tmp'), 'nodriver-tmp-'));
  const previous = process.env.TMPDIR;
  t.after(async () => {
    process.env.TMPDIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  process.env.TMPDIR = root;
  await expect(
    startBrowserMcpSocketServer({ tokens: { [token]: 'alice' }, browser: { maxLeases: 0 } }),
  ).rejects.toThrow('maxLeases');
  expect(await readdir(root)).toEqual([]);
  // A default path too long for a Unix socket is refused before mkdtemp runs.
  const long = join(root, 'd'.repeat(100));
  await mkdir(long);
  process.env.TMPDIR = long;
  await expect(startBrowserMcpSocketServer({ tokens: { [token]: 'alice' } })).rejects.toThrow(
    '100 bytes',
  );
  expect(await readdir(long)).toEqual([]);
});
