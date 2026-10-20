# Changelog

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/); before 1.0, minor versions may contain breaking changes.

## Unreleased

- `Browser.launch()` waits up to 30 seconds (was 15) for Chrome to start and complete the CDP handshake when no `timeout` is given. A first start on a fresh CI runner can exceed 15 seconds.

## 0.1.0 — 2026-10-20

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
- On macOS, key events carry Chrome's editing commands, so `Meta+A`, `Meta+C/X/V/Z`, `Shift+Meta+Z` and the Alt/Meta arrow and delete chords act as they do on a physical keyboard.
- `inspectEnvironment()`, `diagnoseEnvironment()` and `alignEnvironment()` sample the environment, produce structured diagnostics and apply explicit, verified overrides. No external network access happens unless configured.

### MCP server

- One tool implementation serves stdio, loopback Streamable HTTP, local socket / Windows named pipe and in-memory transports. Only MCP 2026-07-28 is supported.
- 26 default tools, plus `browser_upload`, `browser_downloads` and `browser_storage_state`, which are restricted to host-configured directories.
- Short element refs from an indented accessibility snapshot. Actions return summaries covering navigation, new tabs and dialogs.
- Application-level leases that persist across requests and reconnects, with a pooled set of browsers. A download wait does not block the click that triggers it.
- `nodriver-mcp` CLI with launch, tool-surface and limit flags.

### Runtimes

- Node.js ≥ 22 and Bun ≥ 1.4.3. The MCP HTTP server uses `node:http` on Node and `Bun.serve` on Bun.
- Windows, Linux (x64 and ARM64) and macOS (ARM64).

### Tooling

- One test suite (`node:test` with `expect`) runs unchanged on Node.js and Bun. Node.js ≥ 24 runs the TypeScript sources directly, so tests need no build step; CI runs both runtimes on Windows and Linux and checks the built package on Node.js 22. npm is the package manager.
- `npm run test:map` regenerates [docs/test-map.md](docs/test-map.md), which maps each public member, exported function and MCP tool to the tests that call it.
- `npm run bench:compare` runs the same workload against Python nodriver 0.50.6 on the same machine.

Verified platforms and known limits are listed in [docs/support.md](docs/support.md).
