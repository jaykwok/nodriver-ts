# Changelog

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/); before 1.0, minor versions may contain breaking changes.

## Unreleased (0.1.0)

First public release under the name **nodriver-ts** (the development name was `nodriver-bun`).

### Breaking

- The package was renamed to `nodriver-ts`; the subpaths are `nodriver-ts/mcp`, `nodriver-ts/mcp/http` and `nodriver-ts/mcp/socket`. The CLI is still `nodriver-mcp`.
- `startBrowserMcpHttpServer()` is now async and returns `Promise<BrowserMcpHttpServer>`.
- MCP element refs are short ids (`e1`, `e2`, …) instead of UUIDs.
- `browser_snapshot` returns indented text, and its structured nodes gain `depth`, `value` and `url`. Pagination uses `offset` / `nextOffset`.
- `browser_wait` returns the element description (`ref`, `role`, `name`, …), not just a ref.
- The default `leaseIdleMs` changed from 300 000 to 1 800 000 ms.
- `connection.events.size` was replaced by `connection.listenerCount`, because per-session listeners are no longer global.

### Added

- **Node.js support (≥ 22).** The library and the MCP HTTP server run on Node; HTTP uses a `node:http` adapter with streaming backpressure. `bun run test:node` runs a smoke test.
- **MCP HTTP leases.** `Browser-Lease-Id` is optional, and omitting it uses a per-token `default` lease. Any valid name creates a named lease on first POST. Every response carries a `Browser-Lease-Id` header. `requireLeaseHeader` restores the old strict mode.
- **New MCP tools:**
  - `browser_history`, `browser_click_at`, `browser_hover`, `browser_drag` and `browser_network`;
  - `browser_upload`, `browser_downloads` and `browser_storage_state`, which are optional and limited to directories the host configures.
- **Changes to existing MCP tools:**
  - Action tools take `waitFor: auto | load | none` and `snapshot: true`, and return an action summary: navigation, new tabs, dialog, closed tab.
  - `browser_click` gains `button` and `clickCount`.
  - `browser_screenshot` supports JPEG/WebP, `quality`, `scale` and element capture.
  - `browser_scroll` can scroll an element into view.
  - `browser_snapshot` adds `interactiveOnly` and `root`, and masks password values.
  - `browser_find` and `browser_wait` describe each element: role, name, tag, text and visibility.
- **New CLI flags:** `--user-agent`, `--lang`, `--window-size`, `--preset`, `--proxy`, `--input-policy`, `--disable-tool`, `--read-only`, `--upload-dir`, `--download-dir`, `--state-dir`, `--expose-existing-tabs`, `--allow-handoff`, `--max-leases`, `--version` and `--help`.
- **Launch options:** `userAgent`, `lang`, `windowSize`, `maskHeadless` and `preset: 'agent'` (exported as `AGENT_ARGS`). Executable discovery covers PATH, Edge, Canary and more Linux locations. Persistent profiles get a PID/hostname lock (`acquireProfileLock`) that reclaims stale locks. When Chrome exits during startup, the error includes its exit code and stderr.
- **`Browser.connect({ attach: 'created' })`** attaches only to tabs that this client opens or that they open.
- **Input:**
  - Human-mode key-event typing for US-layout characters, with Shift handled automatically.
  - Wheel scrolling into view.
  - A random initial pointer position, and pointer `pressure` of 0.5 while a button is held.
  - `InputPolicy.typing` and `InputPolicy.scroll`.
  - `Element.hover()`, `Element.scrollIntoView()`, `Element.clickablePoint()` and `Tab.activate()`.
  - `keyDefinition()` and `parseChord()`, which supports `Control++`.
- **Diagnostics:** `waitUntil: 'networkidle'`. CDP command tracing through `ConnectionOptions.trace` or `NODRIVER_TRACE=1` records the method, session, duration and error code, never parameters.
- **Documentation:** an English README, SECURITY.md and CONTRIBUTING.md.

### Changed

- **Headless UA mask.** Headless launches remove "HeadlessChrome" from the UA string and the UA client hints by default (`maskHeadless`).
- **Lazy Network domain.** `Network.enable` is sent only when needed: response subscriptions, headers, cache or offline. Fetch-based routing and authentication no longer enable it.
- **Faster queries.** Queries run in a single isolated-world pass. The DOM-tree scan for closed shadow roots runs only when such roots exist, and its result is cached.
- **Per-session events.** CDP events are routed per session, so frame tracking no longer scans every event.
- **Tab focus.** `bringToFront` is called only when another tab may be in front.
- **Init scripts.** They use a random world name per tab.

### Fixed

- Dynamic closed shadow roots invalidate the query cache immediately; repeated queries on an unchanged document still reuse it.
- Concurrent Network users wait for the same pending domain setup and see its errors before retrying.
- Concurrent stale profile lock recovery grants ownership to only one caller.
- Node HTTP cancels response producers when a client disconnects before or during streaming.
- Action `waitFor: 'load'` reports navigation timeouts instead of returning success, and handles same-document navigation without waiting for a new load event.
- MCP storage state rejects symbolic and hard links, and saves through an atomic replacement to avoid following links or truncating a previous state on write failure.
- Temporary profile removal retries while Windows still reports files as busy. Bun ignores `fs.rm`'s `maxRetries`, so a Chrome helper process outliving the browser made `close()` fail with `EBUSY`.
- A browser-level error reply for a command whose session had already detached (Chrome omits the `sessionId`) fails only that command with `DisconnectedError` instead of closing the whole connection as a session mismatch.
- A page or frame session that detaches while it is still being set up (short-lived popups, lazy `Network.enable`) is no longer reported as an asynchronous error.
- `keyUp` for Space and other keys now mirrors the `keyDown` key value.
- Shift+letter chords send the shifted key, and modifier keys use `rawKeyDown`.
- Font diagnostics always disable the CSS and DOM domains they enable.
