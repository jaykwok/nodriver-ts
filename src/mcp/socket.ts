import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import {
  StdioServerTransport,
  serveStdio,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import {
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCNotification,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/server';
import { BrowserSessionManager, type BrowserSessionManagerOptions } from './manager.js';
import { createBrowserMcpServer } from './server.js';

export interface BrowserMcpSocketOptions {
  tokens: Record<string, string>;
  /** Absolute Unix socket in a private directory, or local \\.\pipe\nodriver-NAME. */
  path?: string;
  manager?: BrowserSessionManager;
  browser?: BrowserSessionManagerOptions;
  maxConnections?: number;
  maxRequestsPerConnection?: number;
  maxMessageSize?: number;
  maxOutputBufferSize?: number;
  handshakeTimeout?: number;
  writeTimeout?: number;
  onError?: (error: Error) => void;
}
export interface BrowserMcpSocketServer {
  readonly path: string;
  readonly manager: BrowserSessionManager;
  close(): Promise<void>;
}
export interface BrowserMcpSocketClientOptions {
  path: string;
  token: string;
  /** Omit to create a lease. Keep the returned leaseId to reconnect. */
  leaseId?: string;
  handshakeTimeout?: number;
}
function positive(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${label}`);
  return value;
}
function localPath(path: string) {
  if (process.platform === 'win32') {
    if (!/^\\\\\.\\pipe\\nodriver-[A-Za-z0-9._-]{1,80}$/.test(path))
      throw new TypeError('Use a local \\.\\pipe\\nodriver-NAME path');
  } else if (!isAbsolute(path) || Buffer.byteLength(path) > 100 || path.includes('\0'))
    throw new TypeError('Use an absolute Unix socket path of at most 100 bytes');
}
/** Only this application preamble is custom. Subsequent framing/parsing is SDK NDJSON. */
async function line(socket: Socket, timeout: number): Promise<unknown> {
  return new Promise((done, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => fail(), timeout);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', data);
      socket.off('error', fail);
      socket.off('end', fail);
      socket.off('close', fail);
    };
    const fail = () => {
      cleanup();
      reject(new Error('Socket authentication failed or timed out'));
    };
    const data = (chunk: Buffer) => {
      const newline = chunk.indexOf(10);
      const part = newline < 0 ? chunk : chunk.subarray(0, newline);
      if (buffer.length + part.length > 4096) return fail();
      buffer = Buffer.concat([buffer, part]);
      if (newline < 0) return;
      socket.pause();
      cleanup();
      try {
        const parsed: unknown = JSON.parse(buffer.toString('utf8'));
        if (newline + 1 < chunk.length) socket.unshift(chunk.subarray(newline + 1));
        done(parsed);
      } catch {
        fail();
      }
    };
    socket.on('data', data).once('error', fail).once('end', fail).once('close', fail);
    socket.resume();
  });
}

/** SDK byte framing plus bounded pending requests/output. No alternate MCP handshake. */
class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private wire: StdioServerTransport;
  private closed = false;
  private pending = new Set<string | number>();
  private inbox: JSONRPCMessage[] = [];
  private pumping = false;
  constructor(
    private socket: Socket,
    private limits = { messages: 256 * 1024, output: 8 * 1024 * 1024, requests: 16, write: 60000 },
  ) {
    this.wire = new StdioServerTransport(socket, socket, { maxBufferSize: limits.messages });
    socket.on('error', () => {});
  }
  async start() {
    this.wire.onmessage = (message) => {
      if (isJSONRPCRequest(message)) {
        if (this.pending.has(message.id) || this.pending.size >= this.limits.requests)
          return this.fail(new Error('Socket request limit or duplicate request id'));
        this.pending.add(message.id);
      } else if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
        const id = message.params?.requestId;
        if (typeof id === 'string' || typeof id === 'number') this.pending.delete(id);
      }
      if (this.inbox.length >= 128)
        return this.fail(new Error('Socket incoming message queue limit exceeded'));
      this.inbox.push(message);
      this.pump();
    };
    this.wire.onerror = (error) => this.fail(error);
    this.wire.onclose = () => {
      void this.close();
    };
    await this.wire.start();
    this.socket.resume();
  }
  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    const next = () => {
      if (this.closed || !this.inbox.length) {
        this.pumping = false;
        return;
      }
      this.onmessage?.(this.inbox.shift()!);
      // SDK notification handlers run asynchronously. Finish their microtasks
      // before delivering a coalesced response that retires progress handlers.
      setImmediate(next);
    };
    setImmediate(next);
  }
  private fail(error: Error) {
    this.onerror?.(error);
    void this.close();
  }
  async send(message: JSONRPCMessage) {
    if (this.closed || this.socket.destroyed || !this.socket.writable)
      throw new Error('Socket transport closed');
    const size = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (size + this.socket.writableLength > this.limits.output) {
      this.fail(new Error('Socket output buffer limit exceeded'));
      throw new Error('Socket output buffer limit exceeded');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.wire.send(message),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error('Socket write deadline exceeded');
            this.fail(error);
            reject(error);
          }, this.limits.write);
        }),
      ]);
      if (isJSONRPCResponse(message) && message.id !== undefined) this.pending.delete(message.id);
    } finally {
      clearTimeout(timer);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.pending.clear();
    this.inbox.length = 0;
    await this.wire.close();
    if (!this.socket.destroyed) this.socket.destroy(new Error('Socket transport closed'));
    this.onclose?.();
  }
}

/** Foreground local IPC service. Closing the service also closes its manager. */
export async function startBrowserMcpSocketServer(
  options: BrowserMcpSocketOptions,
): Promise<BrowserMcpSocketServer> {
  const credentials = Object.entries(options.tokens).map(([token, principal]) => {
    if (token.length < 32 || !principal || principal.length > 200)
      throw new TypeError('Provision tokens of at least 32 characters and a principal');
    return [Buffer.from(token), principal] as const;
  });
  if (!credentials.length) throw new TypeError('At least one local bearer credential is required');
  if (options.manager && options.browser) throw new TypeError('Choose manager or browser options');
  const connectionLimit = positive(options.maxConnections ?? 32, 'maxConnections');
  const handshakeTimeout = positive(options.handshakeTimeout ?? 5000, 'handshakeTimeout');
  const limits = {
    messages: positive(options.maxMessageSize ?? 256 * 1024, 'maxMessageSize'),
    output: positive(options.maxOutputBufferSize ?? 8 * 1024 * 1024, 'maxOutputBufferSize'),
    requests: positive(options.maxRequestsPerConnection ?? 16, 'maxRequestsPerConnection'),
    write: positive(options.writeTimeout ?? 60000, 'writeTimeout'),
  };
  let directory: string | undefined;
  const path =
    options.path ??
    (process.platform === 'win32'
      ? `\\\\.\\pipe\\nodriver-${randomUUID()}`
      : join((directory = await mkdtemp(join(tmpdir(), 'nodriver-mcp-'))), 'mcp.sock'));
  localPath(path);
  if (process.platform !== 'win32') {
    const parent = dirname(path),
      info = await lstat(parent);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(parent)) !== resolve(parent)
    )
      throw new Error('Unix socket parent must be a real, owner-only directory (0700)');
    try {
      await lstat(path);
      throw new Error('Socket path already exists; it will not be replaced');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const manager = options.manager ?? new BrowserSessionManager(options.browser);
  const connections = new Map<Socket, { leaseId?: string; handle?: StdioServerHandle }>();
  const cleanup = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const report = (error: unknown) => {
    try {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {}
  };
  const server = createServer((socket) => {
    socket.on('error', () => {});
    if (closing || connections.size >= connectionLimit) {
      socket.destroy();
      return;
    }
    const record: { leaseId?: string; handle?: StdioServerHandle } = {};
    connections.set(socket, record);
    socket.once('close', () => {
      connections.delete(socket);
      if (record.handle) track(record.handle.close());
    });
    track(
      (async () => {
        try {
          const auth = (await line(socket, handshakeTimeout)) as Record<string, unknown> | null;
          if (
            !auth ||
            auth.type !== 'nodriver-auth' ||
            typeof auth.token !== 'string' ||
            Object.keys(auth).some((k) => !['type', 'token', 'leaseId'].includes(k)) ||
            (auth.leaseId !== undefined &&
              (typeof auth.leaseId !== 'string' || auth.leaseId.length > 200))
          )
            throw new Error('Socket authentication failed');
          const bytes = Buffer.from(auth.token);
          const principal = credentials.find(
            ([key]) => key.length === bytes.length && timingSafeEqual(key, bytes),
          )?.[1];
          if (!principal || closing || socket.destroyed)
            throw new Error('Socket authentication failed');
          const id = auth.leaseId as string | undefined;
          // A lease ID reconnects; a lease name is created on first use (see resolve()).
          record.leaseId =
            id !== undefined ? manager.resolve(principal, id).id : manager.create(principal).id;
          socket.write(JSON.stringify({ type: 'nodriver-auth', leaseId: record.leaseId }) + '\n');
          const transport = new SocketTransport(socket, limits);
          record.handle = serveStdio(
            () => createBrowserMcpServer({}, { manager, principal, leaseId: record.leaseId! }),
            {
              transport,
              legacy: 'reject',
              maxSubscriptions: 4,
              onerror: report,
            },
          );
        } catch {
          // Never reflect a credential or raw client input into diagnostics.
          report(new Error('Socket authentication failed or connection closed'));
          socket.destroy();
        }
      })(),
    );
  });
  function track(task: Promise<void>) {
    cleanup.add(task);
    void task.catch(report).finally(() => cleanup.delete(task));
  }
  const off = manager.retired.on((id) => {
    for (const [socket, record] of connections) if (record.leaseId === id) socket.destroy();
  });
  server.on('error', report);
  try {
    const listening = once(server, 'listening');
    server.listen(path);
    await listening;
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } catch (error) {
    off();
    if (server.listening) server.close();
    if (!options.manager) await manager.close();
    if (directory) await rmdir(directory).catch(() => {});
    throw error;
  }
  return {
    path,
    manager,
    close() {
      return (closing ??= (async () => {
        off();
        const stopped = new Promise<void>((done) => server.close(() => done()));
        for (const [socket, record] of connections) {
          if (record.handle) track(record.handle.close());
          socket.destroy();
        }
        await stopped;
        await Promise.allSettled([...cleanup]);
        await manager.close();
        if (directory) await rmdir(directory);
      })());
    },
  };
}

/** Custom IPC transport for an official MCP Client. No automatic reconnect/replay. */
export class BrowserMcpSocketClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  leaseId?: string;
  private wire?: SocketTransport;
  private socket?: Socket;
  private started = false;
  private closed = false;
  constructor(private options: BrowserMcpSocketClientOptions) {
    localPath(options.path);
  }
  async start() {
    if (this.started || this.closed) throw new Error('Socket client already started or closed');
    this.started = true;
    const socket = (this.socket = createConnection(this.options.path));
    socket.on('error', () => {});
    const timeout = positive(this.options.handshakeTimeout ?? 5000, 'handshakeTimeout');
    const timer = setTimeout(
      () => socket.destroy(new Error('Socket connect deadline exceeded')),
      timeout,
    );
    try {
      await once(socket, 'connect');
      socket.write(
        JSON.stringify({
          type: 'nodriver-auth',
          token: this.options.token,
          leaseId: this.options.leaseId,
        }) + '\n',
      );
      const auth = (await line(socket, timeout)) as Record<string, unknown> | null;
      if (this.closed || !auth || auth.type !== 'nodriver-auth' || typeof auth.leaseId !== 'string')
        throw new Error('Socket authentication failed');
      this.leaseId = auth.leaseId;
      this.wire = new SocketTransport(socket, {
        messages: 8 * 1024 * 1024,
        output: 256 * 1024,
        requests: 64,
        write: 60000,
      });
      this.wire.onmessage = (message) => this.onmessage?.(message);
      this.wire.onerror = (error) => this.onerror?.(error);
      this.wire.onclose = () => this.onclose?.();
      await this.wire.start();
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async send(message: JSONRPCMessage) {
    if (!this.wire) throw new Error('Socket client not connected');
    await this.wire.send(message);
  }
  async close() {
    this.closed = true;
    if (this.wire) await this.wire.close();
    else if (this.socket && !this.socket.destroyed)
      this.socket.destroy(new Error('Socket client closed'));
  }
}
