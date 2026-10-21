import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

export interface Served {
  readonly port: number;
  /** Peer address of a request this server received. */
  requestIP(request: Request): { address: string } | undefined;
  /** Closes the listener and destroys open connections. */
  stop(): Promise<void>;
}
export interface ServeOptions {
  hostname: string;
  port?: number;
  fetch(request: Request): Response | Promise<Response>;
}

/** Test fixture server: a fetch-style handler on node:http. */
export async function serve(options: ServeOptions): Promise<Served> {
  const sockets = new Set<Socket>();
  const peers = new WeakMap<Request, string>();
  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort(new Error('Client disconnected'));
    });
    const method = req.method ?? 'GET';
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      for (const item of [value ?? []].flat()) headers.append(name, item);
    const request = new Request(`http://${req.headers.host}${req.url ?? '/'}`, {
      method,
      headers,
      signal: controller.signal,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }),
    } as RequestInit);
    if (req.socket.remoteAddress) peers.set(request, req.socket.remoteAddress);
    void (async () => {
      const response = await options.fetch(request);
      const outgoing: Record<string, string | string[]> = {};
      response.headers.forEach((value, name) => {
        outgoing[name] = name === 'set-cookie' ? response.headers.getSetCookie() : value;
      });
      res.writeHead(response.status, response.statusText, outgoing);
      if (!response.body || method === 'HEAD') {
        await response.body?.cancel();
        res.end();
        return;
      }
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream), res, {
        signal: controller.signal,
      });
    })().catch(() => {
      if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
      else res.destroy();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    requestIP: (request) => {
      const address = peers.get(request);
      return address === undefined ? undefined : { address };
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
