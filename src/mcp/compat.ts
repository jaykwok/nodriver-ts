import { randomUUID } from 'node:crypto';
import {
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpServer,
  type Transport,
} from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createBrowserMcpServer, type BrowserMcpBinding } from './server.ts';
import type { BrowserSessionManagerOptions } from './manager.ts';

/** Same tools and queues, SDK-owned era negotiation, one instance per stdio connection. */
export function serveCompatibleBrowserMcpStdio(
  options: BrowserSessionManagerOptions = {},
  transport?: Transport,
  onerror?: (error: Error) => void,
): StdioServerHandle {
  return serveStdio(
    (context) =>
      createBrowserMcpServer(options, undefined, context.era === 'legacy' ? '2025' : 'modern'),
    { legacy: 'serve', transport, maxSubscriptions: 4, onerror },
  );
}

interface LegacySession {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  closing?: Promise<void>;
  active: number;
  lastUsed: number;
}

/** One endpoint per authenticated browser lease. MCP sessions never identify a principal. */
export function createCompatibleBrowserMcpHttpEndpoint(
  binding: BrowserMcpBinding,
  options: {
    maxSessions: number;
    maxBody: number;
    idleMs: number;
    onerror: (error: Error) => void;
  },
) {
  for (const [name, value] of Object.entries({
    maxSessions: options.maxSessions,
    maxBody: options.maxBody,
    idleMs: options.idleMs,
  }))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError(`${name} must be a positive safe integer`);
  const sessions = new Map<string, LegacySession>();
  const records = new Set<LegacySession>();
  const closing = new Set<Promise<void>>();
  let closed = false;
  const timer = setInterval(
    () => {
      for (const record of records)
        if (!record.active && Date.now() - record.lastUsed >= options.idleMs)
          void close(record).catch(options.onerror);
    },
    Math.min(options.idleMs, 1000),
  );
  timer.unref();
  async function close(record: LegacySession): Promise<void> {
    if (record.closing) return record.closing;
    records.delete(record);
    if (record.transport.sessionId) sessions.delete(record.transport.sessionId);
    record.closing = Promise.resolve().then(async () => {
      try {
        await record.server.close();
      } finally {
        await record.transport.close();
      }
    });
    closing.add(record.closing);
    void record.closing.finally(() => closing.delete(record.closing!)).catch(() => {});
    return record.closing;
  }
  function tracked(response: Response, record: LegacySession): Response {
    record.lastUsed = Date.now();
    if (!response.body) return response;
    record.active++;
    const reader = response.body.getReader();
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        record.active--;
        record.lastUsed = Date.now();
      }
    };
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (finished) return;
            if (next.done) {
              controller.close();
              finish();
            } else controller.enqueue(next.value);
          } catch (error) {
            if (!finished) {
              controller.error(error);
              finish();
            }
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            finish();
          }
        },
      }),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  }
  return {
    async fetch(request: Request, body: unknown, authInfo: AuthInfo): Promise<Response> {
      if (closed) return new Response('Compatibility endpoint stopping', { status: 503 });
      const id = request.headers.get('mcp-session-id');
      const message = body as { method?: string } | undefined;
      let record = id ? sessions.get(id) : undefined;
      if (id && !record)
        return new Response('Unknown MCP session for this authenticated browser lease', {
          status: 404,
        });
      if (!record) {
        if (request.method !== 'POST' || message?.method !== 'initialize')
          return new Response('Initialize a compatibility MCP session first', { status: 400 });
        if (records.size >= options.maxSessions)
          return new Response('MCP session limit reached', { status: 429 });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          maxRequestBodySize: options.maxBody,
          keepAliveMs: 15000,
          // SSE preserves progress and related server requests; no resumable event store.
          enableJsonResponse: false,
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, record!);
          },
        });
        record = {
          server: createBrowserMcpServer({}, binding, '2025'),
          transport,
          active: 0,
          lastUsed: Date.now(),
        };
        records.add(record);
        try {
          await record.server.connect(transport);
          const onclose = transport.onclose;
          transport.onclose = () => {
            onclose?.();
            void close(record!).catch(options.onerror);
          };
          transport.onerror = options.onerror;
        } catch (error) {
          await close(record);
          throw error;
        }
      }
      record.lastUsed = Date.now();
      record.active++;
      try {
        const response = await record.transport.handleRequest(request, {
          parsedBody: body,
          authInfo,
        });
        if (message?.method === 'initialize' && response.status >= 400) await close(record);
        return tracked(response, record);
      } catch (error) {
        await close(record);
        throw error;
      } finally {
        record.active--;
        record.lastUsed = Date.now();
      }
    },
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      await Promise.all([...records].map(close));
      await Promise.all([...closing]);
    },
  };
}
