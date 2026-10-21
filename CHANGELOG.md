# Changelog

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/); before 1.0, minor versions may contain breaking changes.

## 0.4.0 — 2026-10-21

### Breaking changes

- Node.js ≥ 24.22.0 is required for package use, development and tests. Bun is no longer supported; the package uses Node.js HTTP and standard ESM throughout.
- `maskHeadless` defaults to `false`: headless Chrome keeps its native UA and Client Hints. Pass `maskHeadless: true` for the previous behavior. Masking changes only the page and Dedicated Workers, so Shared/Service Workers can disagree with it.
- Without an explicit seed, each input behavior picks a random seed once instead of using `1`. Pass `seed: 1` to keep the old repeatable sequence. Reconfiguring without a seed keeps the current stream, and input reports include the action-start PRNG state.

### Added

- Opt-in MCP 2025-11-25 / 2025-06-18 compatibility (`--mcp-compat`) on stdio and the HTTP `/mcp/compat` route, sharing the browser core, permissions and queues. The default `/mcp` entry point stays strict. Works with Pi 1.3.0's built-in MCP extension; see [agent compatibility](docs/agent-compatibility.md).
- `npm run bench:audit`, a differential audit with a regression gate over native fields, descriptors, Worker/request consistency and cleanup, plus a manual collector for physical-input baselines.
- `npm run bench:worker-environment`, which compares Worker startup configuration strategies across seven execution contexts.
- `npm run bench:handoff:manual`, an interactive collector for testing human handoff end to end.
- AX phase and queue benchmarks, and a Chrome Beta/Dev/Canary regression workflow.

### Fixed

- Font diagnostics run in independent temporary CDP sessions, so they no longer disable caller-owned DOM/CSS subscriptions.

## 0.3.0 — 2026-10-21

- Add `attach: 'none'` to launch/connect and independent `Browser.attachSession()` attachments without Tab/Frame initialization. Raw mode skips headless UA masking and rejects high-level Tab creation.
- Add `TargetSession.ended`, `endReason`, `detach()` and typed `SessionEndedError`. Detach, target destruction/crash and connection loss immediately reject pending requests and event waits and clear subscriptions.
- Cancelled attaches clean up late responses with independent bounded detach requests; unconfirmed cleanup disconnects the connection. Crash ends raw sessions; recovery requires reattachment.
- Apply a single initialization deadline and AbortSignal across endpoint discovery and the complete browser handshake, with owned-process cleanup on launch failure.
- Add payload-free synchronous send observation (`observe.onSend`) and correlated settlement (`onSettle`), preserving existing trace behavior.
- Extend ScriptedChrome with modeled detach and delayed attach replies. Add raw-session unit, real Chrome and built-package acceptance.

## 0.2.1 — 2026-10-21

- CI and platform workflows now run only Node.js, with source tests and package smoke tests. Runtime guidance and validation documentation focus on Node.js.
- Documentation under `docs/` is now in English; the Simplified Chinese versions move to `docs/zh-CN/` and ship in the package. `npm run test:map` writes both language versions of the API test map.

## 0.2.0 — 2026-10-20

- `Browser.launch()` accepts the same `trace` callback/boolean as `connect()`, including startup commands, duration, failures and cancellation.
- Add `nodriver-ts/testing`: `ScriptedChrome` provides a strict loopback CDP peer with startup replies, real Browser/Tab/Session objects, typed scripts, command records, target events, crashes and disconnection.
- Add `ProfileInUseError` for verified live controller/endpoint ownership and Windows Chrome's native `lockfile` sharing conflict, including browsers without a debugging port. Unlocked leftover files do not count as ownership; native Unix singleton inspection is not added.

- Add opt-in `detached: true` WebSocket launch and `Browser.release()` for handing Chrome to a later process, including on Windows. Release returns the endpoint, drops process ownership and signal hooks, removes the controller profile lock, and retains the profile; later close/disposal only disconnects. Pipe handoff and host-dependent proxy contexts are rejected. Detached launch discards stderr and documents the pre-release crash window.

- Without a `timeout`, `Browser.launch()` and `Browser.connect()` wait up to 30 seconds for Chrome to start or answer and complete the CDP handshake (was 15 s for launch, 10 s for connect and the WebSocket handshake). A first start on a fresh CI runner can exceed 15 seconds. The MCP server uses the same default for launching and for `--endpoint`, and its per-command deadline rises from 10 to 30 seconds; operations stay bounded by the operation deadline.

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

- Node.js. The MCP HTTP server uses `node:http`.
- Windows, Linux (x64 and ARM64) and macOS (ARM64).

### Tooling

- The test suite uses `node:test` with `expect`. Node.js runs the TypeScript sources directly, so tests need no build step; CI covers Windows and Linux and checks the built package. npm is the package manager.
- `npm run test:map` regenerates [docs/test-map.md](docs/test-map.md), which maps each public member, exported function and MCP tool to the tests that call it.
- `npm run bench:compare` runs the same workload against Python nodriver 0.50.6 on the same machine.

Verified platforms and known limits are listed in [docs/support.md](docs/support.md).
