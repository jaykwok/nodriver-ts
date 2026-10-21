# Using with Pi

[简体中文](zh-CN/pi.md)

[Pi 1.3.0](https://pi.dev/changelog/releases/1.3.0) (`@earendil-works/pi-coding-agent@1.3.0`) connects through its built-in MCP extension over stdio or Streamable HTTP. Pi uses `initialize` with MCP 2025-11-25, so it needs the [compatibility entry point](agent-compatibility.md).

## Configure

Add `--mcp-compat` to the stdio server arguments in Pi's MCP configuration. For HTTP, start the server with `--mcp-compat` and point Pi at `/mcp/compat` with the Bearer token. See [Pi's MCP configuration documentation](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/mcp.md).

## Behavior

| Entry point       | Result                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------- |
| Default `/mcp`    | Rejects initialize 2025-11-25 before launching a browser: stdio error -32022, HTTP 400  |
| `--mcp-compat`    | Negotiates 2025-11-25, lists 26 tools and runs browser operations                       |
| Cancellation      | Cancelling a pending wait releases the queue; the next action runs exactly once         |
| `browser_handoff` | Returns an unsupported-capability error, because Pi does not advertise form elicitation |

## Test

`test/pi-compat.mjs` drives Pi's own MCP client and its extension's `McpServerConnection` against the built server over stdio and loopback HTTP:

```sh
npm install --prefix tmp/pi-1.3.0 --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.3.0
npm run build
node test/pi-compat.mjs
```

`tmp/` is ignored, and `PI_MCP_PACKAGE` can point to the same package elsewhere. The script checks the exact package version, confirms the strict entry point rejects Pi, then opens a tab, fills Unicode text, snapshots, cancels a wait, clicks, screenshots, navigates, rejects a stale ref and closes the browser. Pi is not a project dependency, and the server has no Pi-specific code paths.
