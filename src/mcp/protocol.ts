import {
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCNotification,
  type Transport,
  type TransportSendOptions,
  type JSONRPCMessage,
  type ScopeChallengeHandler,
} from '@modelcontextprotocol/server';

/** Deliberately pinned, independent of the SDK's wider compatibility list. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_COMPATIBLE_VERSIONS = ['2025-11-25', '2025-06-18'] as const;
export type McpProtocolProfile = 'modern' | '2025';

/** A JSON-RPC error that answers a gated request; a gated notification is dropped. */
export interface Rejection {
  code: number;
  message: string;
  data?: unknown;
}
export interface TransportGate {
  /** Returns a rejection to keep an inbound message from the SDK. */
  receive(message: JSONRPCMessage): Rejection | undefined;
  /** Observes each message the SDK sends. */
  sent?(message: JSONRPCMessage): void;
}

/**
 * Decorates an SDK transport with an inbound boundary. The callbacks the SDK installs on the
 * decorator run from the inner transport's, after any callbacks the inner transport already had,
 * as Protocol.connect chains them. `closed` runs after the SDK's close callback.
 */
export class GatedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];
  declare setProtocolVersion?: (version: string) => void;
  declare setSupportedProtocolVersions?: (versions: string[]) => void;
  declare setScopeChallengeResolver?: (resolver: ScopeChallengeHandler) => void;
  private readonly inner: Transport;
  private readonly gate?: TransportGate;
  constructor(inner: Transport, gate?: TransportGate, closed?: () => void) {
    this.inner = inner;
    this.gate = gate;
    const { onclose, onerror, onmessage } = inner;
    inner.onclose = () => {
      try {
        onclose?.();
      } finally {
        try {
          this.onclose?.();
        } finally {
          closed?.();
        }
      }
    };
    inner.onerror = (error) => {
      onerror?.(error);
      this.onerror?.(error);
    };
    inner.onmessage = (message, extra) => {
      onmessage?.(message, extra);
      const rejection = gate?.receive(message);
      if (!rejection) this.onmessage?.(message, extra);
      else if (isJSONRPCRequest(message))
        void inner
          .send({ jsonrpc: '2.0', id: message.id, error: rejection })
          .catch((error: Error) => inner.onerror?.(error));
    };
    // The SDK feature-tests these, so they exist only when the inner transport has them.
    if (inner.setProtocolVersion)
      this.setProtocolVersion = (version) => inner.setProtocolVersion?.(version);
    if (inner.setSupportedProtocolVersions)
      this.setSupportedProtocolVersions = (versions) =>
        inner.setSupportedProtocolVersions?.(versions);
    const scoped = inner as {
      setScopeChallengeResolver?: (resolver: ScopeChallengeHandler) => void;
    };
    if (typeof scoped.setScopeChallengeResolver === 'function')
      this.setScopeChallengeResolver = (resolver) => scoped.setScopeChallengeResolver?.(resolver);
  }
  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }
  get hasPerRequestStream(): boolean | undefined {
    return this.inner.hasPerRequestStream;
  }
  start(): Promise<void> {
    return this.inner.start();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.gate?.sent?.(message);
    return this.inner.send(message, options);
  }
}

const invalid = (message: string): Rejection => ({ code: -32600, message });

/** Dedicated legacy connection: handshake first, no modern-envelope downgrade. */
export function legacyOnlyTransport(transport: Transport, closed?: () => void): Transport {
  let initializing: string | number | undefined;
  let answered = false;
  let ready = false;
  return new GatedTransport(
    transport,
    {
      receive(message) {
        if (
          (isJSONRPCRequest(message) || isJSONRPCNotification(message)) &&
          message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== undefined
        )
          return invalid('Modern envelopes belong to the modern MCP endpoint');
        if (isJSONRPCRequest(message)) {
          if (message.method === 'initialize') {
            if (ready || answered || initializing !== undefined)
              return invalid('MCP connection is already initialized');
            initializing = message.id;
          } else if (!ready && message.method !== 'ping')
            return invalid('Complete initialize and notifications/initialized first');
        }
        if (isJSONRPCNotification(message) && message.method === 'notifications/initialized') {
          if (!answered) return invalid('Initialize has not succeeded');
          ready = true;
        }
        return undefined;
      },
      sent(message) {
        if (isJSONRPCResponse(message) && message.id === initializing) {
          answered = 'result' in message;
          initializing = undefined;
        }
      },
    },
    closed,
  );
}

/** Version boundary only; parsing, envelope validation and dispatch remain SDK-owned. */
export function modernOnlyTransport(transport: Transport, closed?: () => void): Transport {
  return new GatedTransport(
    transport,
    {
      receive(message) {
        if (!isJSONRPCRequest(message)) return undefined;
        const version = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
        if (message.method !== 'initialize' && version === MCP_PROTOCOL_VERSION) return undefined;
        const requested =
          message.method === 'initialize' ? message.params?.protocolVersion : version;
        return {
          code: requested === undefined && message.method !== 'initialize' ? -32602 : -32022,
          message: `Only MCP ${MCP_PROTOCOL_VERSION} with per-request metadata is supported; use server/discover`,
          data: { supported: [MCP_PROTOCOL_VERSION], requested: requested ?? 'unknown' },
        };
      },
    },
    closed,
  );
}
