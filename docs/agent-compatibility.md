# Generic agent compatibility

[简体中文](zh-CN/agent-compatibility.md)

Compatibility is based on MCP protocol revisions and advertised capabilities, with no agent-name branches. The default remains MCP 2026-07-28. An opt-in entrance serves 2025-11-25 and 2025-06-18 using the same tools, browser manager, refs, permissions and operation queues.

## Connect

For an agent that uses `initialize`, add `--mcp-compat` to its stdio server arguments:

```sh
node dist/mcp/cli.js --mcp-compat --headless
```

For HTTP, start the service with the same flag and connect to `http://127.0.0.1:3100/mcp/compat` with the provisioned Bearer token. `/mcp` continues to require modern per-request metadata. A compatible stdio connection supports either era, selected by the SDK at discovery; an established legacy connection rejects modern envelopes. The custom socket transport remains modern only.

```ts
import { startBrowserMcpHttpServer } from 'nodriver-ts/mcp/http';

const service = await startBrowserMcpHttpServer({
  tokens: { [process.env.NODRIVER_MCP_TOKEN!]: 'local-agent' },
  compatibility: true,
  maxCompatibilitySessionsPerLease: 4,
  compatibilitySessionIdleMs: 300_000,
  browser: { launch: { headless: true } },
});
// Close with await service.close().
```

For embedded stdio, `serveCompatibleBrowserMcpStdio(options)` is exported from `nodriver-ts/mcp/compat`. It returns the SDK's closeable stdio handle. An in-process legacy host may pass `'2025'` as the third argument to `createBrowserMcpServer(options, binding, profile)`; its transport must complete initialize and initialized before tools. `nodriver-ts/mcp` exports `MCP_COMPATIBLE_VERSIONS` and `McpProtocolProfile` for hosts to inspect the boundary.

## Semantics

The SDK handles revision negotiation, legacy request cancellation and server-initiated elicitation. Modern requests retain per-request capabilities. Legacy capabilities come from that connection's initialize message; capability caches are never shared between protocol sessions.

HTTP MCP session IDs are random and scoped to the authenticated principal **and** browser lease. They cannot authenticate a caller or address another lease. Existing token, Origin/Host, body, pending-request, response-buffer and deadline limits also apply to compatibility requests. At most four MCP sessions per lease are kept by default; inactive sessions expire after five minutes. Active responses/GET streams postpone idle expiry but remain bounded by the HTTP stream deadline. DELETE or MCP expiry closes protocol state; it preserves browser state until explicit browser/lease closure or the browser lease's own expiry. Releasing a browser lease or stopping the service closes its MCP sessions. A legacy HTTP client may settle a pending request only on its own timeout or explicit close when an SSE stream ends without a result; configure a finite client request timeout.

Cancellation must release the operation queue before a follow-up write can proceed. Neither errors nor disconnects trigger input replay. Element refs retain the same document and lease boundaries.

Human handoff is optional: the host must enable it, the client must advertise form elicitation and implement a handler. The June revision's pre-mode `elicitation: {}` is recognized as form support. The SDK converts input-required continuation into an elicitation exchange. Missing capabilities return an error; no automatic confirmation is substituted.

For a real acceptance run, use `npm run bench:handoff:manual` in an interactive terminal on a graphical desktop. It opens only a disposable browser and a local test page. Physically enter `manual-check` and click Complete, then answer `accept`, `decline` or `cancel` in the terminal. Acceptance checks that the fresh accessibility snapshot reflects the page change; declining/cancelling verifies an incomplete handoff. The collector never fills, clicks or confirms for you. `HANDOFF_TRANSPORT=http` selects HTTP (default stdio); `HANDOFF_PROTOCOL=2025-06-18` selects the June revision (default November). A dated JSON file in `test-results/` records the result and cleanup errors. Noninteractive execution is rejected. User attestation and trusted events do not independently prove physical input, and this SDK-based host does not exercise Pi's TUI or model. The physical run remains pending until a person completes it.

## Evidence and limits

The integration matrix covers both 2025 revisions over stdio and Streamable HTTP: discovery, resources, resource subscribe/unsubscribe notifications, progress, snapshots, refs, Unicode fill, click, screenshot, navigation invalidation, cancellation followed by a bounded write, and synthetic accept/decline/cancel elicitation. It also checks modern stdio, strict `/mcp` rejection, mixed-envelope rejection, principal/lease isolation, session capacity, DELETE, idle expiry preserving browser refs, and active lease release. `npm run test:mcp` includes these tests; the normal integration CI includes them too. Built-package acceptance also negotiates both revisions and transports on Node 22/24.

[Pi 1.3.0](pi.md) is an additional real external-client check, not the definition of this interface. Other agents have not been individually certified. Compatibility does not imply support for older MCP revisions, legacy HTTP+SSE transport, OAuth, resumable event replay, remote untrusted tenancy, or physical human acceptance. An agent needs a listed protocol revision, a matching transport and the capabilities required by its chosen tools.
