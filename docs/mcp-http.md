# Local Streamable HTTP and browser leases

[简体中文](zh-CN/mcp-http.md)

HTTP is the main entry point for a long-running local service. It shares the tool implementation, `BrowserSessionManager`, browser pool and leases, and the CDP core with stdio, socket and InMemory; tools and limits are described in [MCP](mcp.md). On Node.js 24.22.0+ the service is adapted to `node:http` (a fetch handler, with backpressure for streaming SSE). The default `/mcp` route requires MCP **2026-07-28** and uses application-level `Browser-Lease-Id`, without MCP sessions. Opt-in [agent compatibility](agent-compatibility.md) adds stateful 2025-era MCP sessions on `/mcp/compat`, scoped within the same authenticated browser leases. The service is intended for local provisioned clients.

## Starting the server

```sh
npm run build
# First set NODRIVER_MCP_TOKEN to a random secret (at least 32 characters)
node dist/mcp/cli.js --mcp-transport http --port 3100 --browser-transport pipe
```

By default the service listens only on 127.0.0.1, runs in the foreground and logs to stderr. The token is read from an environment variable and never printed; `--token-env NAME` reads a different variable. Chrome is launched headful by default; add `--headless` without a desktop, or set `browser: { launch: { headless: true } }` when embedding.

## Leases

The simplest setup configures only Authorization. A request without `Browser-Lease-Id` uses the `default` lease of the principal that the token maps to, created on the first POST. When you need several independent browser states, send a lease name in the header (1–64 letters, digits, `.`, `_` or `-`). Within one principal, the same name means the same lease, created on the first POST. Names are scoped to the principal and cannot be used to reach another identity's leases.

| Case                                 | Result                     |
| ------------------------------------ | -------------------------- |
| Invalid lease name                   | 400                        |
| Lease limit reached                  | 429                        |
| Unknown or expired random ID         | 404                        |
| Non-POST requests such as GET/DELETE | Look up only, never create |

Every `/mcp` response carries a `Browser-Lease-Id` response header with the actual lease ID. When embedding, `requireLeaseHeader: true` makes the header mandatory.

You can also create a lease with a random ID explicitly, using the same Bearer token:

```http
POST /leases
Authorization: Bearer <secret>
Content-Type: application/json

{}
```

The 201 response contains the random `id`, the verified principal, the creation time and the last-used time. The request body must be an empty object; it cannot choose a profile, an identity or browser launch options. The management API also has `GET /leases` (lists only this identity's leases) and `DELETE /leases/{id}` (releases the whole lease). These are application APIs, not MCP methods. With a random ID, configure the client's `/mcp` connection with:

```text
Authorization: Bearer <secret>
Browser-Lease-Id: <id from POST /leases>
```

Every request re-verifies the token and lease ownership; clientInfo, tabId, the lease name and the random ID itself never act as an identity. Only `POST /mcp` is accepted: initialize, older protocol versions and `Mcp-Session-Id` are rejected, and `GET /mcp` and `DELETE /mcp` return 405 (or 404 first if they carry an unknown or foreign lease). A lease is independent of any single request or connection. After a disconnect, a new client with the same token and lease can keep using refs that are still valid.

An example with the official client (`@modelcontextprotocol/client` 2.3.1):

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client(
  { name: 'local-agent', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3100/mcp'), {
    // Omit Browser-Lease-Id to use the default lease; 'Browser-Lease-Id': 'agent-a' selects a named lease
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
await client.listTools();
await client.callTool({ name: 'browser_open', arguments: { url: 'https://example.com' } });
// Later snapshot/find/click calls use the same lease; the end of an HTTP request does not destroy the browser or refs
await client.close();
// When the task is done, release the lease with DELETE /leases/{id} (the id is in the Browser-Lease-Id response header or GET /leases)
```

## Headers and origin checks

Modern clients must send the standard headers for the protocol version, method, name and so on. tabId is declared with `x-mcp-header: Tab-Id`, which maps to `Mcp-Param-Tab-Id`. The official SDK decodes it and checks that the header and body agree; the service then still checks ownership of the tab and the ref's lease. The version in the headers and in the per-request `_meta` must match and be 2026-07-28.

The entry point checks the exact Host and port, and the Origin. A missing Origin is allowed (local non-browser clients); when present, it must by default equal the service's own origin. When embedding, `allowedOrigins` can be configured, but this does not waive authentication. The service provides no general CORS or OAuth.

## Embedding and ownership

```ts
import { startBrowserMcpHttpServer } from 'nodriver-ts/mcp/http';

const service = await startBrowserMcpHttpServer({
  tokens: { [secretA]: 'operator-a', [secretB]: 'operator-b' },
  port: 3100,
  browser: { maxLeases: 16, maxBrowsers: 2, contextsPerBrowser: 4 },
});
// On exit: await service.close();
```

The mapping from tokens to principals comes from the host's trusted configuration; clients cannot choose it. `createBrowserMcpHttpService()` provides the same fetch/close interface for a host to mount, and the host must keep the loopback and exact-authority restrictions. When a manager is injected, `service.close()` closes that manager too, so it should be owned by a single application service.

`BrowserSessionManager` is exported from `nodriver-ts/mcp` and can also be used with stdio or InMemory:

```ts
const manager = new BrowserSessionManager();
const lease = manager.create('verified-local-identity');
const server = createBrowserMcpServer(
  {},
  { manager, principal: lease.principal, leaseId: lease.id },
);
// Connect server to the official InMemoryTransport; see examples/mcp-inmemory.ts for a full example.
// server.close() only closes the adapter; manager.release(principal, id) releases the lease.
```

`createBrowserMcpServer(options)` without a binding uses the same manager implementation to create a private manager and lease. The connection keeps that lease until EOF or close, then cleans up its own Chrome; an external Chrome is only disconnected. InMemory skips transport encoding, but MCP images are still base64; use the library's `screenshot()` directly if you need a Buffer.

## Browser allocation

- **Ordinary leases**: each lazily gets its own BrowserContext, and several can share one managed Chrome process. Complete operations on the same browser process run serially, so leases never fight over focus; `browser_tabs`, `browser_dialog` and `browser_downloads` skip the queue. A BrowserContext isolates cookies and storage, but it is not a security sandbox between adversarial tenants. Once processes reach their configured capacity, allocation is refused rather than creating more or waiting indefinitely.
- **Persistent profiles and external connections**: `userDataDir` and `connect` use exclusive allocation, with at most one active allocation per manager, so two Chromes are never launched on the same profile. The persistent directory is kept after closing; an external connection is only disconnected and its pages are kept.
- **Release**: releasing an ordinary lease closes its context. An idle process can be reused briefly, and is closed with its temporary profile cleaned up when it expires or the service exits. `browser_close` releases the current allocation and refs but keeps the lease, so you can open again; `DELETE /leases/{id}` ends the lease for good. After a browser crash, old refs become invalid; close and open again. Actions are not replayed.

## Limits, cancellation and shutdown

| Default                                       | Scope                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 16 leases / 2 Chromes / 4 contexts per Chrome | Manager-wide limits                                                                                        |
| 32 waiting operations                         | Queue per lease and per shared process; fails explicitly when full                                         |
| 30000 ms                                      | Operation deadline, including time in the queue                                                            |
| 1800000 ms / 30000 ms                         | Lease idle expiry / idle process shutdown                                                                  |
| 256 KiB                                       | HTTP request body limit (counted as the stream is read); reading also has a deadline                       |
| 16 requests / 4 subscriptions                 | Per-lease limits                                                                                           |
| ≥ 35000 ms / ≥ 60000 ms                       | Deadline to start a request stream / maximum response stream lifetime (raised with the operation deadline) |
| 64 KiB / 8 MiB                                | Subscription output buffer / general response output buffer; clients that are too slow are disconnected    |

The CLI provides `--max-browsers`, `--contexts-per-browser`, `--max-leases`, `--lease-idle-ms`, `--queue-limit` and `--operation-timeout`; finer limits are set through embedding options. Requests and operations in progress protect a lease from idle reclamation. Long subscriptions are bounded by the response stream lifetime, so clients should resubscribe and read the latest resources.

A dropped SSE stream cancels its request, but does not release the lease or affect other requests. JSON mode returns only the final result; use SSE when you need cancellation on disconnect or progress. Clicks and input already dispatched cannot be rolled back. Cancelling a queued operation removes it from the queue, while a running operation holds the write lock until it finishes. On shutdown the service stops accepting new requests, cancels and waits for existing work, then releases leases and processes. Neither MRTR nor network recovery replays page actions, and Last-Event-ID resumption is not supported.

## Resources, progress and human interaction

Two standard resources contain only the current lease's information. `browser://state` holds the tabs, frames, dialogs, owning context, queue and ref counts. `browser://events` keeps the most recent 64 ordered state events (navigation, tabs, dialogs, downloads and so on); it is not a full DOM or network event bus. Subscriptions select URIs through resourceSubscriptions in `subscriptions/listen`; the old `resources/subscribe` and GET SSE are not supported. Each lease has its own notification bus, and state changes are coalesced before notifying. After a disconnect, read the latest resources; evicted events are not guaranteed to be backfilled.

When a request carries a progressToken, tools send three stages in order: Queued, Running and Completed. Auto mode upgrades to SSE when it needs to notify; forced JSON mode omits intermediate notifications, as the SDK defines. Progress only indicates the stage, not a completion percentage or response latency.

`browser_handoff({ tabId })` asks the user to complete a manual task in an accessible browser UI and confirm. It does not collect passwords, provide a remote desktop, log in automatically or resume earlier clicks. It requires an explicit `--headful` / `launch.headless: false`, or `humanInteraction: true` set by a host that has confirmed the UI is accessible, and the client must declare `elicitation.form`; otherwise a clear error is returned. Having a window by default does not mean a remote caller can reach it, so human handoff is never enabled automatically.

On `/mcp`, human interaction uses the 2026-07-28 InputRequiredResult/MRTR; the optional compatibility route enables the SDK's legacy elicitation shim. requestState is a random identifier with a deadline; the server stores its tab, lease and stage. Tampered, cross-lease or unknown states are rejected, and a completed state never reruns earlier steps. On completion only the current page state is returned, and the caller should take a new snapshot. Secrets should be typed by the user directly in the browser.

## Test coverage

The tests cover JSON and SSE, rejection of older protocols, reuse across requests and connections, authentication and headers, tab and ref permissions, cancellation/timeouts/quotas, subscription filtering, human interaction, profile ownership, and forbidden commands in the real CDP traffic. HTTP and a real stdio subprocess run the same set of behavioural assertions. Platforms and versions are listed in [Support](support.md).
