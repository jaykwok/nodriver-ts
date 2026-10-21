import {
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCNotification,
  type Transport,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';

/** Deliberately pinned, independent of the SDK's wider compatibility list. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_COMPATIBLE_VERSIONS = ['2025-11-25', '2025-06-18'] as const;
export type McpProtocolProfile = 'modern' | '2025';

/** Dedicated legacy connection: handshake first, no modern-envelope downgrade. */
export function legacyOnlyTransport(transport: Transport): Transport {
  let initializing: string | number | undefined;
  let answered = false;
  let ready = false;
  const reject = (message: JSONRPCMessage, text: string) => {
    if (isJSONRPCRequest(message))
      void transport
        .send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: text } })
        .catch((error: Error) => transport.onerror?.(error));
  };
  return new Proxy(transport, {
    get(target, key) {
      if (key === 'send')
        return async (...args: Parameters<Transport['send']>) => {
          const [message] = args;
          if (isJSONRPCResponse(message) && message.id === initializing) {
            answered = 'result' in message;
            initializing = undefined;
          }
          return target.send(...args);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) {
      if (key === 'onmessage' && typeof value === 'function') {
        const receive = value as NonNullable<Transport['onmessage']>;
        target.onmessage = (message, extra) => {
          if (
            (isJSONRPCRequest(message) || isJSONRPCNotification(message)) &&
            message.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== undefined
          ) {
            reject(message, 'Modern envelopes belong to the modern MCP endpoint');
            return;
          }
          if (isJSONRPCRequest(message)) {
            if (message.method === 'initialize') {
              if (ready || answered || initializing !== undefined) {
                reject(message, 'MCP connection is already initialized');
                return;
              }
              initializing = message.id;
            } else if (!ready) {
              reject(message, 'Complete initialize and notifications/initialized first');
              return;
            }
          }
          if (isJSONRPCNotification(message) && message.method === 'notifications/initialized') {
            if (!answered) return;
            ready = true;
          }
          receive(message, extra);
        };
        return true;
      }
      return Reflect.set(target, key, value, target);
    },
  });
}

/** Version boundary only; parsing, envelope validation and dispatch remain SDK-owned. */
export function modernOnlyTransport(transport: Transport): Transport {
  return new Proxy(transport, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) {
      if (key === 'onmessage' && typeof value === 'function') {
        const receive = value as NonNullable<Transport['onmessage']>;
        target.onmessage = (message: JSONRPCMessage, extra) => {
          if (isJSONRPCRequest(message)) {
            const version = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
            if (message.method === 'initialize' || version !== MCP_PROTOCOL_VERSION) {
              const requested =
                message.method === 'initialize' ? message.params?.protocolVersion : version;
              void target
                .send({
                  jsonrpc: '2.0',
                  id: message.id,
                  error: {
                    code:
                      requested === undefined && message.method !== 'initialize' ? -32602 : -32022,
                    message: `Only MCP ${MCP_PROTOCOL_VERSION} with per-request metadata is supported; use server/discover`,
                    data: { supported: [MCP_PROTOCOL_VERSION], requested: requested ?? 'unknown' },
                  },
                })
                .catch((error: Error) => target.onerror?.(error));
              return;
            }
          }
          receive(message, extra);
        };
        return true;
      }
      return Reflect.set(target, key, value, target);
    },
  });
}
