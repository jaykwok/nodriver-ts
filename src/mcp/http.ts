import { timingSafeEqual } from 'node:crypto';
import {
  createMcpHandler,
  readRequestBody,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { createBrowserMcpServer } from './server.ts';
import { BrowserSessionManager, type BrowserSessionManagerOptions } from './manager.ts';
import { cancellableBody } from './body.ts';
import { MCP_PROTOCOL_VERSION } from './protocol.ts';
import { serveFetch } from './serve.ts';
import { LeaseError } from './manager.ts';
import { createCompatibleBrowserMcpHttpEndpoint } from './compat.ts';

export interface BrowserMcpHttpOptions {
  /** Enable a separate stateful 2025-era /mcp/compat endpoint. /mcp stays modern-only. */
  compatibility?: boolean;
  maxCompatibilitySessionsPerLease?: number;
  /** Idle MCP sessions expire independently of their browser lease; default five minutes. */
  compatibilitySessionIdleMs?: number;
  /** Local, explicitly provisioned bearer token -> trusted principal. Not clientInfo. */
  tokens: Record<string, string>;
  manager?: BrowserSessionManager;
  browser?: BrowserSessionManagerOptions;
  hostname?: '127.0.0.1' | '::1';
  port?: number;
  allowedOrigins?: string[];
  maxRequestBodySize?: number;
  maxRequestsPerLease?: number;
  /** Defaults to max(35s, operationTimeout + 5s). */
  requestTimeout?: number;
  /** Defaults to max(60s, operationTimeout + 10s). */
  streamTimeout?: number;
  /**
   * When false (default), /mcp requests without Browser-Lease-Id use the principal's "default"
   * lease, and a lease name (letters, digits, ".", "_", "-"; up to 64) is created on first use.
   * True requires a lease ID from POST /leases on every request.
   */
  requireLeaseHeader?: boolean;
  responseMode?: 'auto' | 'json' | 'sse';
  onError?: (error: Error) => void;
}
export interface BrowserMcpHttpService {
  readonly manager: BrowserSessionManager;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export interface BrowserMcpHttpServer extends BrowserMcpHttpService {
  readonly url: string;
}
interface Endpoint {
  modern: McpHttpHandler;
  compatible?: ReturnType<typeof createCompatibleBrowserMcpHttpEndpoint>;
  off: () => void;
  pending: number;
}
function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${label}`);
  return value;
}

/** Loopback service. Lease REST endpoints are an application API, not MCP sessions. */
export function createBrowserMcpHttpService(options: BrowserMcpHttpOptions): BrowserMcpHttpService {
  const credentials = Object.entries(options.tokens).map(([token, principal]) => {
    if (token.length < 32 || !principal || principal.length > 200)
      throw new TypeError('Provision tokens of at least 32 characters and a principal');
    return [Buffer.from(token), principal] as const;
  });
  if (!credentials.length) throw new TypeError('At least one local bearer credential is required');
  if (options.manager && options.browser) throw new TypeError('Choose manager or browser options');
  const manager = options.manager ?? new BrowserSessionManager(options.browser);
  const endpoints = new Map<string, Endpoint>();
  const lifetime = new AbortController();
  let closed = false,
    closing: Promise<void> | undefined;
  const maxBody = integer(options.maxRequestBodySize ?? 256 * 1024, 'body size');
  const maxRequests = integer(options.maxRequestsPerLease ?? 16, 'requests per lease');
  const maxCompatibilitySessions = integer(
    options.maxCompatibilitySessionsPerLease ?? 4,
    'compatibility sessions per lease',
  );
  const compatibilityIdleMs = integer(
    options.compatibilitySessionIdleMs ?? 300000,
    'compatibility session idle time',
  );
  const operation = manager.limits.operationTimeout;
  const timeout = integer(
    options.requestTimeout ?? Math.max(35000, operation + 5000),
    'request timeout',
  );
  const streamTimeout = integer(
    options.streamTimeout ?? Math.max(60000, operation + 10000),
    'stream timeout',
  );
  const report = (error: unknown) => {
    try {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {}
  };
  const remove = async (id: string) => {
    const endpoint = endpoints.get(id);
    if (!endpoint) return;
    endpoints.delete(id);
    endpoint.off();
    await endpoint.modern.close();
    await endpoint.compatible?.close();
  };
  const offRetired = manager.retired.on((id) => {
    void remove(id).catch(report);
  });
  function endpointFor(principal: string, id: string): Endpoint {
    let endpoint = endpoints.get(id);
    if (endpoint) return endpoint;
    const session = manager.session(principal, id);
    const factory = () => createBrowserMcpServer({}, { manager, principal, leaseId: id });
    const modern = createMcpHandler(factory, {
      legacy: 'reject',
      responseMode: options.responseMode ?? 'auto',
      maxRequestBodySize: maxBody,
      maxSubscriptions: 4,
      keepAliveMs: 15000,
      onerror: report,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = session.changes.on(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        modern.notify.resourceUpdated('browser://state');
        modern.notify.resourceUpdated('browser://events');
      }, 25);
    });
    endpoint = {
      modern,
      ...(options.compatibility
        ? {
            compatible: createCompatibleBrowserMcpHttpEndpoint(
              { manager, principal, leaseId: id },
              {
                maxSessions: maxCompatibilitySessions,
                maxBody,
                idleMs: compatibilityIdleMs,
                onerror: report,
              },
            ),
          }
        : {}),
      pending: 0,
      off: () => {
        off();
        if (timer) clearTimeout(timer);
      },
    };
    endpoints.set(id, endpoint);
    return endpoint;
  }
  const error = (status: number, message: string) => Response.json({ error: message }, { status });
  // Consume promptly with a bounded output queue. A slow subscription is closed,
  // never buffered indefinitely or resumed with a side-effecting request replay.
  function monitored(
    response: Response,
    done: () => void,
    abort: AbortController,
    ms: number,
    bufferLimit = 8 * 1024 * 1024,
  ): Response {
    if (!response.body) {
      done();
      return response;
    }
    const reader = response.body.getReader();
    let settled = false;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        done();
      }
    };
    const timer = setTimeout(() => {
      const reason = new Error('HTTP exchange deadline exceeded');
      abort.abort(reason);
      void reader.cancel(reason).catch(() => {});
      output?.error(reason);
      finish();
    }, ms);
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          output = controller;
          void (async () => {
            try {
              while (!settled) {
                const { done: ended, value } = await reader.read();
                if (settled) break;
                if (ended) {
                  controller.close();
                  break;
                }
                if (value) {
                  if ((controller.desiredSize ?? 0) < value.byteLength)
                    throw new Error('HTTP response buffer limit exceeded');
                  controller.enqueue(value);
                }
              }
            } catch (cause) {
              abort.abort(cause);
              await reader.cancel(cause).catch(() => {});
              controller.error(cause);
            } finally {
              finish();
            }
          })();
        },
        async cancel(reason) {
          abort.abort(reason);
          await reader.cancel(reason).catch(() => {});
          finish();
        },
      },
      { highWaterMark: bufferLimit, size: (chunk) => chunk?.byteLength ?? 0 },
    );
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  function withLease(response: Response, leaseId: string): Response {
    const headers = new Headers(response.headers);
    headers.set('browser-lease-id', leaseId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const service: BrowserMcpHttpService = {
    manager,
    async fetch(original: Request): Promise<Response> {
      if (closed) return error(503, 'Service stopping');
      const url = new URL(original.url),
        host = original.headers.get('host') ?? url.host;
      // Exact authority, including port. DNS names or forwarded headers are not trusted.
      if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || host !== url.host)
        return error(403, 'Host rejected');
      const origin = original.headers.get('origin');
      if (origin && ![url.origin, ...(options.allowedOrigins ?? [])].includes(origin))
        return error(403, 'Origin rejected');
      const authorization = original.headers.get('authorization');
      const token = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
      let principal: string | undefined;
      for (const [expected, identity] of credentials)
        if (token.length === expected.length && timingSafeEqual(token, expected))
          principal = identity;
      if (!principal)
        return new Response('Bearer authentication required', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="nodriver-local"' },
        });
      if (original.headers.has('last-event-id'))
        return error(400, 'Stream resumption is unsupported; do not replay actions');
      let body: unknown;
      if (original.method === 'POST') {
        const contentType = original.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase();
        if (contentType !== 'application/json') return error(415, 'Use application/json');
        try {
          const readController = new AbortController();
          const timer = setTimeout(
            () => readController.abort(new Error('Request body deadline exceeded')),
            timeout,
          );
          let read: Awaited<ReturnType<typeof readRequestBody>>;
          try {
            const bounded = new Request(original.url, {
              method: 'POST',
              headers: original.headers,
              body: cancellableBody(
                original.body,
                AbortSignal.any([original.signal, lifetime.signal, readController.signal]),
              ),
              signal: AbortSignal.any([original.signal, lifetime.signal, readController.signal]),
              duplex: 'half',
            } as RequestInit);
            read = await readRequestBody(bounded, maxBody);
          } finally {
            clearTimeout(timer);
          }
          if (read.tooLarge) return error(413, 'Request body too large');
          body = JSON.parse(read.text);
        } catch {
          return error(400, 'Invalid JSON body');
        }
      }
      if (url.pathname === '/leases') {
        if (original.method === 'GET') return Response.json({ leases: manager.list(principal) });
        if (original.method !== 'POST') return error(405, 'Method not allowed');
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
          return error(400, 'Lease creation accepts an empty object');
        try {
          return Response.json(manager.create(principal), { status: 201 });
        } catch (cause) {
          return error(429, String(cause));
        }
      }
      if (url.pathname.startsWith('/leases/')) {
        if (original.method !== 'DELETE') return error(405, 'Method not allowed');
        try {
          await manager.release(principal, url.pathname.slice(8));
          return new Response(null, { status: 204 });
        } catch {
          return error(404, 'Unknown or unauthorized lease');
        }
      }
      const compatible = options.compatibility === true && url.pathname === '/mcp/compat';
      if (url.pathname !== '/mcp' && !compatible) return error(404, 'Unknown endpoint');
      const requested = original.headers.get('browser-lease-id');
      if (!requested && options.requireLeaseHeader)
        return error(400, 'Browser-Lease-Id is required');
      let leaseId: string;
      let release: () => void;
      try {
        leaseId = manager.resolve(principal, requested ?? 'default', original.method === 'POST').id;
        release = manager.retain(principal, leaseId);
      } catch (cause) {
        // Without a lease header a GET/DELETE has nothing to look up; answer like any other
        // unsupported method instead of reporting a missing default lease.
        if (!requested && original.method !== 'POST')
          return error(
            compatible ? 400 : 405,
            compatible
              ? 'Initialize a compatibility MCP session first'
              : `MCP ${MCP_PROTOCOL_VERSION} only supports POST`,
          );
        if (cause instanceof LeaseError && cause.code === 'invalid')
          return error(400, 'Invalid Browser-Lease-Id or lease name');
        if (cause instanceof LeaseError && cause.code === 'capacity')
          return error(429, 'Lease capacity reached');
        return error(404, 'Unknown, unauthorized or expired browser lease');
      }
      const endpoint = endpointFor(principal, leaseId);
      if (!compatible && original.headers.has('mcp-session-id')) {
        release();
        return error(400, `MCP ${MCP_PROTOCOL_VERSION} uses Browser-Lease-Id, not MCP sessions`);
      }
      if (!compatible && original.method !== 'POST') {
        release();
        return error(405, `MCP ${MCP_PROTOCOL_VERSION} only supports POST`);
      }
      const version = original.headers.get('mcp-protocol-version');
      if (!compatible && version && version !== MCP_PROTOCOL_VERSION) {
        release();
        return Response.json(
          {
            jsonrpc: '2.0',
            id: (body as { id?: unknown })?.id ?? null,
            error: {
              code: -32022,
              message: `Only MCP ${MCP_PROTOCOL_VERSION} is supported`,
              data: { supported: [MCP_PROTOCOL_VERSION], requested: version },
            },
          },
          { status: 400 },
        );
      }
      if (endpoint.pending >= maxRequests) {
        release();
        return error(429, 'Lease request limit reached');
      }
      endpoint.pending++;
      let finished = false;
      const done = () => {
        if (!finished) {
          finished = true;
          endpoint.pending--;
          release();
        }
      };
      const abort = new AbortController();
      let streaming = false;
      const deadline = setTimeout(
        () => abort.abort(new Error('HTTP request deadline exceeded')),
        timeout,
      );
      const authInfo = {
        token: '[verified-local-token]',
        clientId: principal,
        scopes: ['browser'],
      };
      try {
        // Pass a parsed body under our bound. The original body is consumed above.
        const request = new Request(original.url, {
          method: original.method,
          headers: original.headers,
          signal: AbortSignal.any([original.signal, lifetime.signal, abort.signal]),
          ...(original.method === 'POST' ? { body: JSON.stringify(body) } : {}),
        });
        const response = compatible
          ? await endpoint.compatible!.fetch(request, body, authInfo)
          : await endpoint.modern.fetch(request, { authInfo, parsedBody: body });
        clearTimeout(deadline);
        streaming = true;
        return withLease(
          monitored(
            response,
            done,
            abort,
            streamTimeout,
            (body as { method?: string })?.method === 'subscriptions/listen'
              ? 64 * 1024
              : 8 * 1024 * 1024,
          ),
          leaseId,
        );
      } catch (cause) {
        report(cause);
        return error(500, 'MCP exchange failed');
      } finally {
        clearTimeout(deadline);
        if (!streaming) done();
      }
    },
    close() {
      return (closing ??= (async () => {
        closed = true;
        lifetime.abort(new Error('HTTP service stopping'));
        offRetired();
        await Promise.all([...endpoints.keys()].map(remove));
        await manager.close();
      })());
    },
  };
  return service;
}

/**
 * Explicit foreground loopback server using node:http.
 * No background process or client config changes.
 */
export async function startBrowserMcpHttpServer(
  options: BrowserMcpHttpOptions,
): Promise<BrowserMcpHttpServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(hostname))
    throw new TypeError('Only loopback binding is supported');
  const service = createBrowserMcpHttpService(options);
  let server: Awaited<ReturnType<typeof serveFetch>>;
  try {
    server = await serveFetch({
      hostname,
      port: options.port ?? 3100,
      maxRequestBodySize: options.maxRequestBodySize ?? 256 * 1024,
      fetch: (request, port) => {
        if (new URL(request.url).port !== String(port))
          return new Response('Host port rejected', { status: 403 });
        return service.fetch(request);
      },
    });
  } catch (error) {
    await service.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    manager: service.manager,
    url: `http://${hostname === '::1' ? '[::1]' : hostname}:${server.port}`,
    fetch: service.fetch,
    close: () =>
      (closing ??= (async () => {
        await service.close();
        await server.close();
      })()),
  };
}
