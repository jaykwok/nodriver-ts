# Local socket / Windows named pipe

[简体中文](zh-CN/mcp-socket.md)

`--mcp-transport socket` or `nodriver-ts/mcp/socket` provides a long-running local IPC service: a Unix domain socket on Linux and macOS, a local named pipe on Windows. It shares the tools, application leases, browser pool, resources and cancellation with the other entry points ([MCP](mcp.md)), and supports only MCP 2026-07-28. It is a custom transport that needs the matching client; ordinary MCP clients should use stdio or HTTP.

The service runs the official SDK's `serveStdio(factory, { transport, legacy: 'reject' })` over `StdioServerTransport`, reusing its UTF-8 NDJSON framing, protocol discovery, subscriptions and cancellation. For the framing, see [MCP custom transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports); for path formats, see [Node IPC](https://nodejs.org/api/net.html#ipc-support).

## Starting the server

First set `NODRIVER_MCP_TOKEN` to a random secret (at least 32 characters):

```sh
npm run build
node dist/mcp/cli.js --mcp-transport socket
```

The service runs in the foreground and writes the actual path to stderr; stdout carries no logs or credentials. By default it uses a random path: `nodriver-mcp-*/mcp.sock` in a new directory under the system temporary directory, or `\\.\pipe\nodriver-<random>` on Windows. `--socket-path PATH` chooses the path instead, and `--token-env` names a different token variable. Chrome options are the same as for the other transports.

- **Linux and macOS**: the path must be absolute and at most 100 UTF-8 bytes. Its parent directory must be owned by the running user, grant no group or other permissions, and be reached without symbolic links. The socket gets mode 0600; the default temporary directory is 0700 and is deleted on close. An existing file or socket is never replaced, so leftovers from a crash must be checked and removed by the caller.
- **Windows**: only local pipes named `\\.\pipe\nodriver-` followed by 1–80 letters, digits, `.`, `_` or `-` are accepted, never remote pipes. The system default pipe ACL applies, with token authentication on top; there is no cross-user sandbox.

Options and paths are validated before the temporary directory or manager is created. If the service fails to start, it closes only a manager it created and removes its temporary directory. `close()` is idempotent.

## Client

```ts
import { Client } from '@modelcontextprotocol/client';
import {
  startBrowserMcpSocketServer,
  BrowserMcpSocketClientTransport,
} from 'nodriver-ts/mcp/socket';

const token = process.env.NODRIVER_MCP_TOKEN!;
const service = await startBrowserMcpSocketServer({ tokens: { [token]: 'local-operator' } });
const transport = new BrowserMcpSocketClientTransport({ path: service.path, token });
const client = new Client(
  { name: 'local-agent', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
try {
  await client.connect(transport);
  console.log((await client.listTools()).tools);
  const leaseId = transport.leaseId; // save it to reconnect explicitly; reconnecting also needs the token
} finally {
  await client.close();
  await service.close();
}
```

See `examples/mcp-socket.ts` for a full example. A lease is bound to the principal that the provisioned token maps to; clientInfo is not trusted, and one principal cannot use another's leases. Closing the client cancels that connection's in-flight requests, while the browser and refs remain until an explicit `browser_close`, lease release or idle expiry. To reconnect, authenticate again and pass `leaseId`; there is no automatic reconnect or action replay.

A trusted host can inject an existing `BrowserSessionManager` and call `manager.release(principal, leaseId)` to release a lease immediately; that closes the lease's connections. Closing the service also closes an injected manager, so hosts that share a manager should coordinate shutdown. Lifecycle rules for leases, the pool and owned or external browsers are described in [MCP over HTTP](mcp-http.md#browser-allocation).

## Authentication preamble

The first line of a connection is an application authentication preamble, not an MCP method:

```json
{
  "type": "nodriver-auth",
  "token": "provisioned random secret",
  "leaseId": "optional lease ID or lease name"
}
```

On success the service replies with one line, `{"type":"nodriver-auth","leaseId":"..."}`, and after that only standard NDJSON JSON-RPC is exchanged. Without `leaseId`, a new lease is created; with a lease name (1–64 letters, digits, `.`, `_` or `-`), the principal's lease of that name is used, created on first use. Chrome is not launched until the first `browser_open`. A failed authentication, including an unknown lease ID, closes the connection without echoing credentials. The preamble may be split across packets or arrive together with the first MCP message. The token travels in plain text over local IPC, so do not use this for remote connections or untrusted tenants.

## Limits

| Default                | Scope                                                    |
| ---------------------- | -------------------------------------------------------- |
| 32                     | Connections, including unauthenticated ones              |
| 4 KiB / 5 s            | Authentication preamble size and deadline                |
| 16 / 4                 | Outstanding requests / subscriptions per connection      |
| 256 KiB / 128 messages | Input message buffer / messages waiting to be dispatched |
| 8 MiB / 60 s           | Output buffer / write deadline                           |
| 8 MiB                  | Maximum response size accepted by the client             |
| 30 s / 30 min          | Browser operation deadline / lease idle expiry           |

A duplicate in-flight request ID, exceeding a limit, a JSON line that is not a JSON-RPC message and writes that are too slow all close the connection; a line that is not valid JSON is skipped. Apart from protocol notifications, no CDP events are written to the stream.

Cancellation uses `notifications/cancelled`, and EOF on a connection aborts all of its requests. Side effects that already happened cannot be undone, and connections still share the lease and browser write queues. Resource updates are filtered by the SDK's `subscriptions/listen`; the old `resources/subscribe` is not supported. Notifications and responses that arrive together are dispatched in order, so the SDK's async progress callbacks run before the request completes.
