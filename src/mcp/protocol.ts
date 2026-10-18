import {
  isJSONRPCRequest,
  type Transport,
  type JSONRPCMessage,
} from '@modelcontextprotocol/server';

/** Deliberately pinned, independent of the SDK's wider compatibility list. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

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
