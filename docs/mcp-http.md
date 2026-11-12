# Local Streamable HTTP and browser leases

[简体中文](zh-CN/mcp-http.md)

HTTP is the main entry point for a long-running local service. It shares the tool implementation, `BrowserSessionManager`, browser pool and leases, and the CDP core with stdio, socket and InMemory; tools and limits are described in [MCP](mcp.md). The service runs a fetch handler on `node:http`, with backpressure on streamed SSE. The default `/mcp` route requires MCP **2026-07-28** and keeps state through the application-level `Browser-Lease-Id` header instead of MCP sessions. Opt-in [agent compatibility](agent-compatibility.md) adds stateful 2025-era MCP sessions on `/mcp/compat`, scoped to the same authenticated browser leases. The service is meant for locally provisioned clients.

## Starting the server

```sh
npm run build
# First set NODRIVER_MCP_TOKEN to a random secret (at least 32 characters)
node dist/mcp/cli.js --mcp-transport http --port 3100 --browser-transport pipe
```

By default the service listens only on 127.0.0.1, runs in the foreground and logs to stderr. The token is read from an environment variable and never printed; `--token-env NAME` reads a different variable. Chrome is launched headful by default; add `--headless` without a desktop, or set `browser: { launch: { headless: true } }` when embedding.

## Leases

The simplest setup configures only Authorization. A request without `Browser-Lease-Id` uses the `default` lease of the principal that the token maps to. For several independent browser states, send a lease name in the header (1–64 letters, digits, `.`, `_` or `-`); within one principal, the same name means the same lease. Named and default leases are created on the first POST. Names are scoped to the principal and cannot reach another identity's leases.

| Case                                 | Result                     |
| ------------------------------------ | -------------------------- |
| Invalid lease name                   | 400                        |
| Lease limit reached                  | 429                        |
| Unknown or expired random ID         | 404                        |
| Non-POST requests such as GET/DELETE | Look up only, never create |

Responses to MCP messages on `/mcp` carry a `Browser-Lease-Id` response header with the actual lease ID. When embedding, `requireLeaseHeader: true` makes the request header mandatory; its value is a lease name or ID either way.

You can also create a lease with a random ID explicitly, using the same Bearer token:

```http
POST /leases
Authorization: Bearer <secret>
Content-Type: application/json

{}
```

The 201 response contains the random `id`, the verified principal, the creation time and the last-used time. The body must be an empty object; it cannot choose a profile, an identity or browser launch options. `GET /leases` lists only this identity's leases, and `DELETE /leases/{id}` releases the whole lease: 204, 404 for an unknown or unauthorized lease, or 500 when closing its browser state fails (the cause goes to `onError`). These are application APIs, not MCP methods. With a random ID, configure the client's `/mcp` connection with:

```text
Authorization: Bearer <secret>
Browser-Lease-Id: <id from POST /leases>
```

Every request re-verifies the token and lease ownership; clientInfo, tabId, the lease name and the random ID itself never act as an identity. Only `POST /mcp` is accepted: initialize, older protocol versions and `Mcp-Session-Id` are rejected, and `GET /mcp` and `DELETE /mcp` return 405 (or 404 first if they carry an unknown or foreign lease). A lease outlives any single request or connection: a new client with the same token and lease can keep using refs that are still valid.

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

Modern clients must send the standard headers for the protocol version, method, name and so on. tabId is declared with `x-mcp-header: Tab-Id`, which maps to `Mcp-Param-Tab-Id`; the official SDK decodes it and checks that header and body agree, and the service still checks that the tab and ref belong to the lease. The version in the headers and in the per-request `_meta` must match and be 2026-07-28.

The service checks the exact Host and port, and the Origin. A missing Origin is allowed (local non-browser clients); when present, it must by default equal the service's own origin. When embedding, `allowedOrigins` can widen this, but it does not waive authentication. There is no general CORS or OAuth. A rejected Host or Origin gets 403, a missing or wrong token 401, a POST without `Content-Type: application/json` 415, and a body over the limit 413.

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

The mapping from tokens to principals comes from the host's trusted configuration; clients cannot choose it. `createBrowserMcpHttpService()` provides the same fetch/close interface for a host to mount, and the host must keep the loopback and exact-authority restrictions. Pass either `browser` options or an existing `manager`, not both. `service.close()` closes an injected manager too, so it should be owned by a single application service; a `startBrowserMcpHttpServer()` call that fails to listen leaves an injected manager open.

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

`createBrowserMcpServer(options)` without a binding creates a private manager and lease. The connection keeps that lease until EOF or close, then cleans up its own Chrome; an external Chrome is only disconnected. InMemory skips transport encoding, but MCP images are still base64; use the library's `screenshot()` directly if you need a Buffer.

## Browser allocation

- **Ordinary leases**: each lazily gets its own BrowserContext, and several can share one managed Chrome process. Operations on the same browser process run one at a time, so leases never fight over focus; `browser_tabs`, `browser_dialog` and `browser_downloads` skip the queue. A BrowserContext isolates cookies and storage, but it is not a security sandbox between adversarial tenants. Once processes reach their configured capacity, allocation is refused rather than creating more or waiting. A browser whose input is blocked gets no new allocations and is closed once unused.
- **Persistent profiles and external connections**: `userDataDir` and `connect` use exclusive allocation, with at most one active allocation per manager, so two Chromes are never launched on the same profile. The persistent directory is kept after closing; an external connection is only disconnected and its pages are kept.
- **Release**: releasing an ordinary lease closes its context. An idle process can be reused briefly; when it expires or the service exits, it is closed and its temporary profile removed. `browser_close` releases the current allocation and refs but keeps the lease, so you can open again; `DELETE /leases/{id}` ends the lease for good. After a browser crash, old refs become invalid; close and open again. Actions are not replayed.

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

The CLI options for these limits are listed in [MCP](mcp.md#cli-options); finer limits are set through embedding options. Requests and operations in progress protect a lease from idle expiry. Long subscriptions are bounded by the response stream lifetime, so clients should resubscribe and read the latest resources.

A dropped SSE stream cancels its request, but does not release the lease or affect other requests. JSON mode returns only the final result; use SSE when you need progress or cancellation on disconnect. Clicks and input already dispatched cannot be rolled back. Cancelling a queued operation removes it from the queue, while a running operation holds the write lock until it finishes. On shutdown the service refuses new requests with 503, cancels and waits for existing work, then releases leases and processes. Neither MRTR nor network recovery replays page actions, and a request with `Last-Event-ID` is rejected with 400 because streams cannot be resumed.

## Resources, progress and human interaction

Two standard resources contain only the current lease's information. `browser://state` holds the tabs, frames, dialogs, owning context, queue and ref counts. `browser://events` keeps the most recent 64 ordered state events (navigation, tabs, dialogs, downloads, the outcome of an action a dialog left pending and so on); it is not a full DOM or network event bus. On `/mcp`, subscriptions select URIs through resourceSubscriptions in `subscriptions/listen`; the old `resources/subscribe` and GET SSE are not supported. Each lease has its own notification bus, and state changes are coalesced before notifying. After a disconnect, read the latest resources; evicted events are not backfilled.

When a request carries a progressToken, tools report three stages in order: Queued, Running and Completed. Auto mode upgrades to SSE when it needs to notify; forced JSON mode omits intermediate notifications, as the SDK defines. Progress reports the current stage; percentage and latency are not included.

`browser_handoff({ tabId })` asks the user to complete a manual task in an accessible browser UI and confirm. It does not collect passwords, provide a remote desktop, log in automatically or resume earlier clicks. It requires an explicit `--headful` / `launch.headless: false`, or `humanInteraction: true` (`--allow-handoff`) from a host that has confirmed the UI is accessible, and the client must declare `elicitation.form`; otherwise a clear error is returned. Enable handoff after arranging browser UI access for the caller, including when the service runs remotely.

On `/mcp`, human interaction uses the 2026-07-28 InputRequiredResult/MRTR; the compatibility route enables the SDK's legacy elicitation shim. requestState is a random identifier that expires after five minutes; the server stores its tab, lease and stage. Tampered, cross-lease or unknown states are rejected, and a completed state never reruns earlier steps. On completion only the current page state is returned, and the caller should take a new snapshot. Secrets should be typed by the user directly in the browser.

## Remote handoff

`browser_handoff({ tabId, mode: "remote", resumeCondition })` lets a person operate a tab from a viewer page served by this HTTP service, for example to solve a sign-in step on a server without a screen. It needs `--remote-handoff` (`remoteHandoff: true` or options when embedding) and works in headless mode as well. It is not available over stdio or the socket transport.

The tool gives the client a private link through URL elicitation, so the link does not enter the model's context, and needs the client's `elicitation.url` capability. A declined prompt ends the handoff. Only with `--remote-handoff-link-in-result` (`linkInResult: true`) is the link returned in the tool result, where the model can read it. The call returns `{ handoffId, expiresAt }`; call `browser_handoff_wait({ handoffId, timeout })` repeatedly until `state` is `ended`, or pass `cancel: true`. `browser://events` reports `handoff-started`, `handoff-connected` and `handoff-ended`.

A handoff ends when `resumeCondition` holds, when the user presses Done, on cancellation, when the tab closes, or at expiry. `resumeCondition` is `{ url?, selector?, timeout }`: `url` is the whole main-frame URL where `*` matches anything, `selector` is looked up in an isolated world, and both must hold when both are given. `reason` is `condition`, `completed`, `cancelled`, `expired`, `tab-closed` or `released`. A handoff lasts at most 15 minutes unless the host sets `maxDuration`.

While it runs, the lease's other tools fail at once with `HandoffActiveError` instead of queueing, except `browser_tabs` and `browser_handoff_wait`. Once `browser_handoff_wait` reports `ended`, they run again. Idle cleanup does not reclaim the lease. Read a fresh snapshot afterwards: refs may have expired.

The service stays on the loopback interface with its Host and Origin checks; to reach it from another machine, create a tunnel such as `ssh -L 3100:127.0.0.1:3100 host`, keeping the same local port. The link holds a 256-bit token that works once and expires after 5 minutes (`tokenTtl`), bound to one principal, lease and tab; a handoff whose link is not opened by then ends as `expired`. Opening it exchanges the token for an `HttpOnly; SameSite=Strict` cookie limited to that handoff's path, and leaves the token out of the address bar. Requests from the page must be same-origin. The page runs under a CSP of `default-src 'self'` with `frame-ancestors 'none'`, without inline script. Anyone holding the unopened link can use it, so treat it as a secret. The tunnel, not this service, provides encryption between machines.

The picture is a `Page.startScreencast` stream over server-sent events, and each frame is acknowledged after the viewer has read it, so a slow connection lowers the frame rate. One viewer receives the stream at a time: a newer `/frames` request replaces the earlier stream, and requests open in turn. Input is sent as POST requests and dispatched as CDP input: mouse, wheel and keys, with composed text and paste through `Input.insertText`. The `audit` option receives `started`, `connected` and `ended` entries with the input count, never the input; the CLI writes them to stderr.

## Test coverage

The tests cover JSON and SSE, rejection of older protocols, reuse across requests and connections, authentication and headers, tab and ref permissions, cancellation, timeouts and quotas, subscription filtering, human interaction, remote handoff with a click on a real page, profile ownership, and forbidden commands in the real CDP traffic. HTTP and a real stdio subprocess run the same behavioural assertions. Platforms and versions are listed in [Support](support.md).
