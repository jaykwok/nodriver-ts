# Changelog

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/); before 1.0, minor versions may contain breaking changes.

## Unreleased (0.1.0)

First public release.

### Browser engine

- Drives Chrome, Chromium and Edge over CDP through WebSocket or Pipe, with typed commands and events from a pinned `devtools-protocol`. Every command and wait takes a `timeout` and an `AbortSignal`.
- Never sends `Runtime.enable`, `Runtime.addBinding`, `Console.enable` or `Debugger.enable`, and never falls back to them. The main world is found through the frame's document and `DOM.resolveNode`, with the result validated.
- Launches headful by default. In headless mode, `maskHeadless` removes "HeadlessChrome" from the UA string and UA client hints, and `AutomationControlled` is disabled so `navigator.webdriver` is natively `false`. Chrome's sandbox and site isolation stay on.
- Temporary and persistent profiles. Persistent profiles get a PID/hostname lock that reclaims stale locks. Close is idempotent and cleans up the process tree, and `Browser.connect()` can attach only to the tabs this client created.
- Same-process iframes, OOPIFs and nested OOPIFs each run in their own session, and handles are invalidated per document generation. BFCache, crashes and process swaps are handled.
- CSS, XPath and text queries pierce open and closed shadow roots. A query's `timeout` and `signal` bound every CDP request it makes.
- Browser contexts with per-context proxies, including authenticated HTTP(S) and SOCKS upstreams.
- Cookies, permissions, and storage snapshots. A snapshot covers the first-party localStorage of every origin the context's frames have used, including closed tabs. Restores run on an intercepted blank page, so sites are never contacted and redirects are never followed.
- Fetch-based routing and authentication. `Network.enable` is sent only when a feature needs it.
- Downloads with completion and cancellation, uploads, PNG/JPEG/WebP screenshots (full page or element), and PDF.
- `NODRIVER_TRACE=1` traces CDP commands (method, session, duration and error code) without logging parameters.

### Input and environment

- Clicks check visibility, stability and occlusion, including through parent frames, and are never replayed.
- An optional seeded `human` input policy adds pointer trajectories, key-event typing for US-layout characters and wheel scrolling. Other text goes through `insertText`. Input actions return an `InputReport`.
- `inspectEnvironment()`, `diagnoseEnvironment()` and `alignEnvironment()` sample the environment, produce structured diagnostics and apply explicit, verified overrides. No external network access happens unless configured.

### MCP server

- One tool implementation serves stdio, loopback Streamable HTTP, local socket / Windows named pipe and in-memory transports. Only MCP 2026-07-28 is supported.
- 26 default tools, plus `browser_upload`, `browser_downloads` and `browser_storage_state`, which are restricted to host-configured directories.
- Short element refs from an indented accessibility snapshot. Actions return summaries covering navigation, new tabs and dialogs.
- Application-level leases that persist across requests and reconnects, with a pooled set of browsers. A download wait does not block the click that triggers it.
- `nodriver-mcp` CLI with launch, tool-surface and limit flags.

### Runtimes

- Bun ≥ 1.4.3 and Node.js ≥ 22. The MCP HTTP server uses `Bun.serve` on Bun and `node:http` on Node.

Verified platforms and known limits are listed in [docs/support.md](docs/support.md).
