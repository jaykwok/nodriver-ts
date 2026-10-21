# Pi 1.3.0 interoperability

[简体中文](zh-CN/pi.md)

The target is [Pi 1.3.0](https://pi.dev/changelog/releases/1.3.0), published as `@earendil-works/pi-coding-agent@1.3.0`, with pinned `@earendil-works/pi-mcp@1.3.0`. Its built-in MCP extension supports stdio and Streamable HTTP. No third-party extension or model credentials were used.

## Actual connection probe

On 2026-10-21, Windows x64 / Node.js 24.22.0 / Chrome 155.0.8059.85, `test/pi-compat.mjs` exercised Pi's own wire client and the built-in extension's `McpServerConnection` against built stdio and real loopback HTTP:

| Entrance                   | Wire client and native extension, both transports                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Default modern path        | All four reject initialize 2025-11-25 before launching a browser: stdio -32022, HTTP 400        |
| Generic compatibility path | All four negotiate 2025-11-25, discover 26 tools and complete browser operations                |
| Cancellation               | Pending selector wait is aborted; the next click completes, with click count exactly one        |
| Human handoff              | Explicit unsupported-capability error; the native extension does not advertise elicitation.form |

The successful flow opens a tab, evaluates a fixture, obtains refs, fills Unicode, snapshots, cancels a wait, clicks, reads the click count, screenshots, navigates, rejects a stale ref and closes the browser. It tests the actual built-in connection layer without running the interactive TUI or a model. Physical human handoff and model-driven tool selection remain untested.

## Use and reproduce

Add `--mcp-compat` to Pi's stdio server arguments. For HTTP, enable that flag on the server and use `/mcp/compat` with the Bearer token. See [generic agent compatibility](agent-compatibility.md) for configuration and lifecycle limits, and [Pi's pinned MCP configuration documentation](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/mcp.md).

```sh
npm install --prefix tmp/pi-1.3.0 --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.3.0
npm run build
node test/pi-compat.mjs
```

`tmp/` is ignored. The optional probe checks exact package identity/version, retains the strict-path negative assertions and records the positive compatibility results. `PI_MCP_PACKAGE` may point to the same pinned package elsewhere. Pi is never a project dependency or runtime branch.

The pinned [client](https://github.com/earendil-works/pi/blob/v1.3.0/packages/mcp/src/client.ts) sends initialize/initialized and notifications/cancelled; the [extension runtime](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/extensions/mcp/runtime.ts) lacks a form elicitation handler. Merely changing a version string would not implement these semantics. The generic entrance uses SDK negotiation, cancellation and continuation handling instead.
