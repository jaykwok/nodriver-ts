# nodriver-ts

TypeScript redesign of [nodriver](https://github.com/ultrafunkamsterdam/nodriver).

[简体中文](README.zh-CN.md)

nodriver-ts drives Chrome, Chromium and Edge directly over the Chrome DevTools Protocol (CDP), with no WebDriver and no Runtime.enable. A built-in [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28) server lets agents use the same engine over Streamable HTTP, stdio or a local socket.

- **Quiet by default.** The library never sends `Runtime.enable`, `Runtime.addBinding`, `Console.enable` or `Debugger.enable`, and never falls back to them. It finds the main world through the frame's document and `DOM.resolveNode`. It does not inject getters, init scripts or a bridge. Chrome's sandbox and site isolation stay on.
- **Frames.** Same-process iframes, out-of-process iframes (OOPIF) and nested OOPIFs each run in their own CDP session. Queries pierce open and closed shadow roots.
- **Input.** Clicks wait for the target to be visible, stable and unobscured before dispatching, and actions are never replayed. An optional seeded "human" policy adds pointer paths, key-event typing and wheel scrolling.
- **Agent-ready MCP.** Tools take short stable element refs (`e12`) from an indented accessibility snapshot. An action returns a summary of what happened: navigation, new tabs, dialogs. HTTP clients get application-level leases, so browser state survives across requests and reconnects. Only MCP **2026-07-28** is accepted.
- **Runtimes.** The same test suite runs on Node.js and Bun. The package runs on Node.js 22 or newer and Bun 1.4.3 or newer; the MCP HTTP server uses `node:http` on Node and `Bun.serve` on Bun.

> No automation framework is undetectable. nodriver-ts removes the common CDP and WebDriver tells; it does not promise that any site will let you through. Read [the automation audit](docs/automation-audit.md) for what has and has not been measured.

## Requirements

- Node.js ≥ 22 or Bun ≥ 1.4.3. The CLI and package entry points run on both. Building and testing from source needs Node.js ≥ 24, which runs the TypeScript sources directly.
- A locally installed Chrome, Chromium or Edge. It is auto-detected on Windows, macOS and Linux, including on `PATH`; otherwise set `CHROME_PATH` or `executablePath`.
- Chrome opens with a window by default (`headless: false`). Servers and CI without a display should pass `headless: true` / `--headless`. Run Linux as a normal user with Chrome's shared libraries installed; the library never adds `--no-sandbox`.

The verified platforms and versions are listed in [docs/support.md](docs/support.md).

## Install

Install from npm:

```sh
npm install nodriver-ts
```

Or build from source:

```sh
git clone https://github.com/jaykwok/nodriver-ts.git
cd nodriver-ts
npm ci
npm run build
```

## Library quick start

```ts
import { Browser } from 'nodriver-ts';

await using browser = await Browser.launch({ transport: 'pipe' }); // headful by default; WebSocket if omitted
const tab = await browser.newTab('https://example.com');
console.log(await (await tab.waitForSelector('h1')).text());

await (await tab.waitForSelector('#name')).fill('Unicode works: 中文 😀');
await Promise.all([
  tab.waitForNavigation({ waitUntil: 'networkidle' }),
  (await tab.query({ text: 'Submit', exact: true }))!.click(),
]);
await tab.screenshot({ path: 'page.png', fullPage: true });
```

- **Main world.** `evaluate` runs there by default (`{ world: 'isolated' }` is also available); functions are serialized into the page.
- **Frames.** `tab.frames` lists every frame, including OOPIFs, and queries never cross frames silently.
- **Browser contexts.** `browser.newContext({ proxy })` isolates cookies and storage per context, and supports authenticated HTTP(S) and SOCKS upstream proxies.
- **Network.** `tab.network.route()` intercepts and fulfils requests, `authenticate()` answers auth challenges, and `responses` subscribes to responses. `Network.enable` is only sent when you subscribe to responses or set headers/cache/offline.
- **Input policy.** `tab.setInputPolicy({ mode: 'human', seed })` switches on reproducible trajectories, key-event typing for US-layout characters, and wheel scrolling. Other text, such as CJK or emoji, goes through `insertText`.
- **Existing browsers.** `Browser.connect({ endpoint, attach: 'created' })` attaches only to tabs that this client opens or that they open (the default, `'all'`, attaches to every tab). `close()` only disconnects.
- **CDP tracing.** Pass `trace: (entry) => ...` to `launch` or `connect` to collect method, session, duration, and error code. `trace: true` or `NODRIVER_TRACE=1` logs to stderr; parameters and results are never logged.
- **Scripted tests.** `nodriver-ts/testing` provides a fake CDP peer that builds real Browser/Tab/Session objects, scripts replies and events, and records commands with parameters. See [testing](docs/testing.md).

See [docs/api.md](docs/api.md) and the [examples](examples/).

To keep Chrome open after the Node host exits, launch with `detached: true` and WebSocket,
then persist the endpoint returned by `await browser.release()`. Later, use
`Browser.connect({ endpoint })`. Release removes the controller's profile lock, retains the
profile, and makes subsequent `close()` / async disposal disconnect only. Pipe handoff is
rejected. Detached launch discards Chrome stderr; a host crash before release can leave Chrome
running. See [handoff and CDP event usage](docs/browser-handoff.md) for lifecycle limits.

## MCP server

Point a stdio MCP client at the CLI:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/nodriver-ts/dist/mcp/cli.js"]
    }
  }
}
```

Once the package is installed, the binary is `nodriver-mcp`. To run it as a long-lived local HTTP service:

```sh
export NODRIVER_MCP_TOKEN="$(openssl rand -hex 32)"   # at least 32 characters
nodriver-mcp --mcp-transport http --port 3100
# clients connect to http://127.0.0.1:3100/mcp with "Authorization: Bearer $NODRIVER_MCP_TOKEN"
```

- **HTTP leases.** HTTP listens on loopback only. A client that omits `Browser-Lease-Id` uses the token's `default` lease. Any lease name made of letters, digits and `. _ -` creates a separate lease on first use, which lets several agents keep independent browser state. The lease id is echoed in the `Browser-Lease-Id` response header.
- **Client requirements.** Clients must speak MCP 2026-07-28 (`server/discover` with per-request metadata). With the official TypeScript client 2.3.1, pin `versionNegotiation: { mode: { pin: '2026-07-28' } }`. Legacy `initialize` is rejected before any browser work.
- **Browser launch.** Chrome starts lazily on the first `browser_open`, using the `agent` launch preset, which suppresses first-run and search-engine-choice UI and background throttling.

Run `nodriver-mcp --help` for every flag. Some useful ones:

- `--headless`, `--user-data-dir`, `--endpoint http://127.0.0.1:9222`, `--proxy URL`
- `--lang`, `--window-size 1280x800`, `--user-agent`
- `--input-policy human`, `--read-only`, `--disable-tool NAME`
- `--upload-dir`, `--download-dir`, `--state-dir`: each enables the matching file tool, restricted to that directory.

### Tools

The 26 default tools are:

- **Tabs and navigation:** `browser_tabs`, `browser_open`, `browser_navigate`, `browser_history`, `browser_close_tab`, `browser_close`
- **Observation:** `browser_snapshot` (indented accessibility tree with refs, `interactiveOnly`, `root` and `offset` paging), `browser_find` (CSS, XPath or text), `browser_wait`, `browser_screenshot` (PNG/JPEG/WebP, element or full page, scale), `browser_network` (opt-in response log)
- **Actions:** `browser_click`, `browser_click_at`, `browser_hover`, `browser_drag`, `browser_fill`, `browser_type`, `browser_press_key`, `browser_select`, `browser_check`, `browser_scroll`, `browser_dialog`
- **Other:** `browser_evaluate` (async function body in the main or isolated world), `browser_input_policy`, `browser_environment` (diagnostics and explicit alignment), `browser_handoff` (asks the user to finish a manual step through elicitation)

Three tools are optional and appear only when their directory flag is set: `browser_upload`, `browser_downloads` and `browser_storage_state`.

Action tools accept `waitFor: "auto" | "load" | "none"` and `snapshot: true`. They return what happened (`navigated`, `newTabs`, `dialog`, `tabClosed`), so the agent does not need an extra round-trip after each step.

The stdio, HTTP, socket and in-memory entry points share one tool implementation, lease manager and browser pool. More detail is in [docs/mcp.md](docs/mcp.md), [docs/mcp-http.md](docs/mcp-http.md) and [docs/mcp-socket.md](docs/mcp-socket.md).

## Automation traces

What the defaults do:

- No automatic `Runtime`, `Console` or `Debugger` domains, no bindings and no init scripts in the main world.
- Chromium's `AutomationControlled` feature is disabled, so `navigator.webdriver` is natively `false`. No getter is patched.
- In headless mode, "HeadlessChrome" is removed from the UA string and the UA client hints by a per-target override (`maskHeadless`, on by default for headless). Dedicated workers inherit the override; shared and service workers may not. Headful remains the recommended mode.
- Human-mode input dispatches keyDown/keyUp pairs that match the US layout, gives pointer presses a realistic `pressure`, starts the pointer at a random point instead of (0, 0), and only brings a tab to the front when it is not already there.

These measures are not cloaking. They do not spoof fonts, WebGL, canvas, audio or hardware, and they do not solve CAPTCHAs. Environment overrides (timezone, locale, UA-CH, viewport, geolocation) are explicit opt-ins; see [docs/environment.md](docs/environment.md).

## Development

```sh
npm run check                # strict type check (src and tests)
npm test                     # unit tests on Node.js
npm run test:integration     # real Chrome, both CDP transports
npm run test:dist            # build, then a smoke test of the package and MCP over HTTP
npm run test:bun             # the same unit tests on Bun (also test:bun:integration)
npm run format:check
```

## Documentation

The documents under `docs/` are written in Chinese.

| Document                                     | Contents                                                          |
| -------------------------------------------- | ----------------------------------------------------------------- |
| [API](docs/api.md)                           | Objects, deadlines and cancellation, queries, evaluation, storage |
| [Input](docs/input.md)                       | The human input policy, typing, pointer checks, cancellation      |
| [Environment](docs/environment.md)           | Environment sampling, diagnostics, explicit alignment, WebRTC     |
| [Automation audit](docs/automation-audit.md) | Default protocol behaviour, regression evidence, detector results |
| [MCP](docs/mcp.md)                           | CLI, tools, refs, page JavaScript, embedding                      |
| [MCP over HTTP](docs/mcp-http.md)            | Leases, authentication, limits, resources, hand-off               |
| [MCP over socket](docs/mcp-socket.md)        | Unix socket / named pipe service and client                       |
| [Support](docs/support.md)                   | Verified platforms, capabilities, limitations                     |
| [Performance](docs/performance.md)           | Benchmark method and baseline                                     |
| [Soak test](docs/soak.md)                    | Long-running resource test                                        |
| [Upstream API map](docs/upstream-api-map.md) | nodriver members and their TypeScript counterparts                |
| [API test map](docs/test-map.md)             | Tests that call each public member and MCP tool (generated)       |

Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
