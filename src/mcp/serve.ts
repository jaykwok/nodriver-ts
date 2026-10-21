import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface FetchServerOptions {
  hostname: string;
  port: number;
  maxRequestBodySize: number;
  fetch: (request: Request, port: number) => Promise<Response> | Response;
}
export interface FetchServer {
  readonly port: number;
  close(): Promise<void>;
}
/** Serves a fetch handler with node:http. */
export async function serveFetch(options: FetchServerOptions): Promise<FetchServer> {
  const sockets = new Set<import('node:net').Socket>();
  let port = 0;
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
      else res.destroy();
    });
  });
  // Long-lived SSE responses are bounded by the service's own deadlines.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host;
    if (!host) {
      res.writeHead(400).end('Host header required');
      return;
    }
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort(new Error('Client disconnected'));
    });
    const method = req.method ?? 'GET';
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (value !== undefined)
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    const request = new Request(`http://${host}${req.url ?? '/'}`, {
      method,
      headers,
      signal: controller.signal,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>, duplex: 'half' }),
    } as RequestInit);
    const response = await options.fetch(request, port);
    // Disconnect may precede the response (and any response-body abort listener).
    if (controller.signal.aborted || res.destroyed) {
      await response.body?.cancel(controller.signal.reason);
      return;
    }
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
    res.flushHeaders();
    // pipeline propagates backpressure and cancels the source on abort or write failure.
    await pipeline(
      Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream),
      res,
      {
        signal: controller.signal,
      },
    );
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : options.port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
