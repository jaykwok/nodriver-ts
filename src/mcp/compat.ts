import { randomUUID } from 'node:crypto';
import {
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpServer,
  type Transport,
} from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createBrowserMcpServer, type BrowserMcpBinding } from './server.ts';
import { MCP_COMPATIBLE_VERSIONS } from './protocol.ts';
import type { BrowserSessionManagerOptions } from './manager.ts';
import { jsonError, positiveMs } from './auth.ts';
import { positiveInt, settleAll } from '../utils.ts';

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
  positiveInt(options.maxSessions, 'maxSessions');
  positiveInt(options.maxBody, 'maxBody');
  positiveMs(options.idleMs, 'idleMs');
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
  function tracked(response: Response, record: LegacySession, ended?: () => void): Response {
    record.lastUsed = Date.now();
    if (!response.body) {
      ended?.();
      return response;
    }
    record.active++;
    const reader = response.body.getReader();
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        record.active--;
        record.lastUsed = Date.now();
        ended?.();
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
          finish();
          await reader.cancel(reason).catch(() => {});
        },
      }),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  }
  return {
    async fetch(request: Request, body: unknown, authInfo: AuthInfo): Promise<Response> {
      if (closed) return jsonError(503, 'Compatibility endpoint stopping');
      const id = request.headers.get('mcp-session-id');
      const message = body as { method?: string } | undefined;
      let record = id ? sessions.get(id) : undefined;
      if (id && !record)
        return jsonError(404, 'Unknown MCP session for this authenticated browser lease');
      if (!record) {
        if (request.method !== 'POST' || message?.method !== 'initialize')
          return jsonError(400, 'Initialize a compatibility MCP session first');
        if (records.size >= options.maxSessions) return jsonError(429, 'MCP session limit reached');
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          maxRequestBodySize: options.maxBody,
          keepAliveMs: 15000,
          // SSE preserves progress and related server requests; no resumable event store.
          enableJsonResponse: false,
          supportedProtocolVersions: [...MCP_COMPATIBLE_VERSIONS],
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, record!);
          },
        });
        // Protocol.connect chains these with its own callbacks.
        transport.onclose = () => void close(record!).catch(options.onerror);
        transport.onerror = options.onerror;
        record = {
          server: createBrowserMcpServer({}, binding, '2025'),
          transport,
          active: 0,
          lastUsed: Date.now(),
        };
        records.add(record);
        try {
          await record.server.connect(transport);
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
        if (message?.method !== 'initialize') return tracked(response, record);
        if (response.status >= 400) await close(record);
        const opened = record;
        // An error answer travels in a 200 stream; a session that never negotiated frees its slot.
        return tracked(response, opened, () => {
          if (!opened.server.server.getNegotiatedProtocolVersion())
            void close(opened).catch(options.onerror);
        });
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
      await settleAll([...records].map(close));
      await settleAll([...closing]);
    },
  };
}
