# MCP server

[简体中文](zh-CN/mcp.md)

The built-in MCP server has four entry points: stdio launched by the client, a long-running local Streamable HTTP service ([MCP over HTTP](mcp-http.md)), a local socket or Windows named pipe ([MCP over socket](mcp-socket.md)), and in-process InMemory. They share `createBrowserMcpServer`, `BrowserSessionManager`, the browser pool and leases, tool schemas, element refs, the operation queue and the CDP core.

- The default protocol is MCP **2026-07-28** (`server/discover` with per-request `_meta` version metadata), and legacy `initialize` is rejected. `--mcp-compat` adds **2025-11-25 / 2025-06-18** on stdio or on the separate HTTP route `/mcp/compat`; see [generic agent compatibility](agent-compatibility.md), including [Pi](pi.md). The official TypeScript client 2.3.1 must pin `versionNegotiation: { mode: { pin: '2026-07-28' } }` for modern requests. `nodriver-ts/mcp` exports `MCP_PROTOCOL_VERSION`.
- `Runtime.enable` is never sent automatically. `browser_evaluate` runs JavaScript in the page; no tool runs arbitrary CDP commands or code on the host.
- Chrome launches lazily on the first `browser_open`, headful by default. Without a desktop pass `--headless`, or `launch: { headless: true }` when embedding. Connecting to an existing Chrome does not change its window mode.

## Starting the server

```sh
npm run build

# stdio (the default when --mcp-transport is omitted): launched by the client
node dist/mcp/cli.js --browser-transport pipe
node dist/mcp/cli.js --endpoint http://127.0.0.1:9222

# HTTP: a long-running local service; first set NODRIVER_MCP_TOKEN to a random secret of at least 32 characters
node dist/mcp/cli.js --mcp-transport http --port 3100
```

The package provides the `nodriver-mcp` command; from source, use `npm run mcp`. stdout carries only the protocol; logs and help go to stderr. The server runs in the foreground: it installs no system service or autostart and does not modify client configuration.

An example stdio client configuration (mcpServers format):

```json
{
  "mcpServers": {
    "nodriver": {
      "command": "node",
      "args": ["/path/to/nodriver-ts/dist/mcp/cli.js"]
    }
  }
}
```

A stdio connection owns one private lease until EOF or close. Then its own Chrome is closed and the temporary profile deleted; a persistent profile is kept, and an external Chrome is only disconnected.

The HTTP and socket services accept only local connections and require the token from `NODRIVER_MCP_TOKEN` (or the variable named by `--token-env`). An HTTP request without `Browser-Lease-Id` uses the token's `default` lease; agents that need independent state each send a different lease name, created on first use. The end of a request or a client disconnect does not destroy the lease, browser or refs.

## CLI options

Run `nodriver-mcp --help` for every option.

| Option                                                     | Effect                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mcp-transport stdio\|http\|socket`                      | MCP transport; stdio by default                                                                                                                                                                                                                                                                                                                                                                           |
| `--mcp-compat`                                             | Serve 2025-era clients on stdio or HTTP `/mcp/compat`; `/mcp` stays modern. Not available with socket                                                                                                                                                                                                                                                                                                     |
| `--port`, `--socket-path`, `--token-env NAME`              | HTTP port (3100 by default; HTTP only), socket path (socket only), environment variable holding the token (`NODRIVER_MCP_TOKEN` by default)                                                                                                                                                                                                                                                               |
| `--headful` / `--headless`                                 | Window mode; headful by default. The two cannot be combined                                                                                                                                                                                                                                                                                                                                               |
| `--virtual-display`                                        | Run headful Chrome on its own Xvfb server, on Linux machines without a display. Requires Xvfb; cannot be combined with `--headless`                                                                                                                                                                                                                                                                       |
| `--browser-transport pipe\|websocket`                      | CDP transport; pipe by default. `--transport` is an alias                                                                                                                                                                                                                                                                                                                                                 |
| `--executable`, `--user-data-dir`                          | Chrome path; persistent profile (a single browser, no per-lease contexts)                                                                                                                                                                                                                                                                                                                                 |
| `--endpoint URL`, `--expose-existing-tabs`                 | Connect to an existing Chrome instead of launching one; by default only tabs opened by this server are attached. `--endpoint` cannot be combined with launch options (window mode, browser transport, executable, profile, proxy, user agent, language, window size, preset)                                                                                                                              |
| `--proxy URL`                                              | Upstream proxy; with credentials it needs per-lease contexts, so it cannot be combined with `--user-data-dir`                                                                                                                                                                                                                                                                                             |
| `--user-agent`, `--lang`, `--window-size WxH`              | Set at launch                                                                                                                                                                                                                                                                                                                                                                                             |
| `--preset agent\|default`                                  | agent by default: hides the search engine choice screen and the crash-restore bubble, disables background throttling, and sets `--password-store=basic`. On Linux, Chrome then encrypts saved passwords and cookies with its built-in key instead of the system keyring, so it never prompts for the keyring, and a persistent profile whose data was encrypted through the keyring cannot read that data |
| `--input-policy instant\|human`                            | Default input policy for new tabs                                                                                                                                                                                                                                                                                                                                                                         |
| `--read-only`, `--disable-tool NAME[,NAME]`                | Keep only observation, navigation and tab lifecycle tools ([listed below](#read-only-mode)); disable individual tools (repeatable)                                                                                                                                                                                                                                                                        |
| `--upload-dir`, `--download-dir`, `--state-dir`            | Enable the matching file tool, restricted to that directory                                                                                                                                                                                                                                                                                                                                               |
| `--state-key-env`                                          | Environment variable with the passphrase that encrypts `--state-dir` files                                                                                                                                                                                                                                                                                                                                |
| `--allow-handoff`                                          | Allow `browser_handoff` without an explicit `--headful`                                                                                                                                                                                                                                                                                                                                                   |
| `--remote-handoff`, `--remote-handoff-link-in-result`      | Allow a user to operate a tab through a loopback viewer link; see [MCP over HTTP](mcp-http.md#remote-handoff). HTTP transport only                                                                                                                                                                                                                                                                        |
| `--max-browsers`, `--contexts-per-browser`, `--max-leases` | Resource limits                                                                                                                                                                                                                                                                                                                                                                                           |
| `--lease-idle-ms`, `--queue-limit`, `--operation-timeout`  | Lease idle timeout, queue length, operation deadline                                                                                                                                                                                                                                                                                                                                                      |

## Tools

The 26 default tools:

| Tool                   | Purpose                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_tabs`         | Show connection state, tabs, frames and pending JS dialogs; does not launch a browser                                                                                                                                           |
| `browser_open`         | Lazily launch or connect to a browser and open a new tab; returns a tabId                                                                                                                                                       |
| `browser_navigate`     | Navigate an open tab; waitUntil supports commit/domcontentloaded/load/networkidle                                                                                                                                               |
| `browser_history`      | Back, forward or reload; returns moved:false when there is no history entry                                                                                                                                                     |
| `browser_close_tab`    | Close the given tab                                                                                                                                                                                                             |
| `browser_snapshot`     | Indented accessibility tree with `[e12]` refs and layout boxes; interactiveOnly, viewportOnly, root, offset                                                                                                                     |
| `browser_find`         | CSS/XPath/text query returning refs, role, name, tag, text summary and visibility                                                                                                                                               |
| `browser_wait`         | Wait for a matching element (optionally visible) in the selected frame; returns a new ref and description                                                                                                                       |
| `browser_click`        | Click after checking stability, visibility and obstruction; supports button and clickCount                                                                                                                                      |
| `browser_click_at`     | Click viewport coordinates (canvas, maps and so on) without an obstruction check                                                                                                                                                |
| `browser_hover`        | Move the pointer over an element without pressing                                                                                                                                                                               |
| `browser_drag`         | Drag from an element to another element (`to`) or to viewport coordinates (`toX` and `toY`)                                                                                                                                     |
| `browser_fill`         | Replace an input's content; supports Chinese and emoji                                                                                                                                                                          |
| `browser_type`         | Type at the caret/selection; in human mode US-layout characters use key events                                                                                                                                                  |
| `browser_press_key`    | Send a key or chord to the focused element, such as Enter, Shift+Tab, Control+A (Meta+A selects all on macOS)                                                                                                                   |
| `browser_select`       | Change the selected value of a select                                                                                                                                                                                           |
| `browser_check`        | Set the checked state of a checkbox/radio                                                                                                                                                                                       |
| `browser_scroll`       | Scroll an element into view (ref), or send a wheel delta at given coordinates                                                                                                                                                   |
| `browser_dialog`       | Accept or dismiss the current JS dialog; supports promptText                                                                                                                                                                    |
| `browser_screenshot`   | PNG/JPEG/WebP of the viewport, full page or an element (ref); quality, scale, and marks to label refs                                                                                                                           |
| `browser_network`      | Record recent responses on demand (URL, status, type, MIME), without headers or bodies                                                                                                                                          |
| `browser_evaluate`     | Run an async JS function body in a given tab/frame, with JSON arguments and result                                                                                                                                              |
| `browser_input_policy` | Set a tab's instant/human policy, seed, time and step ranges, wheel profile and `wheelNotch`, `pointerGrid`, `lateMoves`, `targetInset`, typing and scroll mode, and `presentationRecovery` ([parameters](input.md#parameters)) |
| `browser_environment`  | Structured diagnostics or explicit alignment; network probes and the GeoIP resolver are configured by the host                                                                                                                  |
| `browser_close`        | Close an owned browser or disconnect from an external one; you can open again afterwards                                                                                                                                        |
| `browser_handoff`      | Ask the user to finish a manual step, in a visible window or (mode remote, HTTP) through a private viewer link                                                                                                                  |

Optional tools that appear once the host configures a directory:

- **`browser_upload`** (`--upload-dir`): file names must resolve to a path inside that directory. A name that leaves the directory is refused before the file system is consulted, and so is a link that leaves it once resolved. Errors name the file as given, never a host path.
- **`browser_downloads`** (`--download-dir`): lists or waits for the most recent 100 download records; files are saved in that directory under GUID names. Each record has an increasing `sequence`, and list returns `latestSequence`. wait does not occupy the operation queue, so it can be called before or after the click that triggers the download. It waits for the first record with a sequence greater than `after` to complete or be cancelled; `after` defaults to the sequence returned by this tab's previous wait (initially 0). A timeout reports an error without advancing the cursor, so the next wait keeps waiting for the same download.
- **`browser_storage_state`** (`--state-dir`): saves or loads, by name, cookies and first-party localStorage for every HTTP(S) origin that any frame in the context has used, including closed tabs. Empty storage is not exported, nor is the partitioned localStorage of cross-site iframes. Reads and writes happen in a temporary blank page that intercepts document requests, so the site is never contacted and redirects are not followed. State files refuse existing symbolic and hard links, are saved by atomic replacement through a temporary file, and have POSIX mode 0600. Their content never enters the conversation; only counts are returned. Files live at `<state-dir>/<principal>/<name>.json`, so names are private to the authenticated principal. `include` on save adds `sessionStorage` or `indexedDB`, as in [`storageState`](api.md#state-and-storage); loading a state with sessionStorage needs `tabId`, whose tab is left on about:blank. With `--state-key-env NAME` (`stateKey` when embedding: 32 bytes or a passphrase), files are encrypted with AES-256-GCM and plain files are refused, so replacing a file with plain text cannot downgrade it. The key comes only from the host; no tool argument takes it. The directory is the principal itself when it matches `[a-z0-9_-]{1,64}`, and otherwise `p-` followed by the SHA-256 hex of the principal; a server without a binding uses `private`, and the HTTP and socket services of the CLI use `local-operator`. A link in place of a principal directory is refused. Loading an unknown name reports `No saved state named <name>`, whoever else may have saved it.

With `--remote-handoff` (HTTP only), `browser_handoff_wait` also appears: it waits for a remote handoff to end, or cancels it. See [remote handoff](mcp-http.md#remote-handoff).

### Read-only mode

`--read-only` (`readOnly` when embedding) registers `browser_tabs`, `browser_open`, `browser_navigate`, `browser_history`, `browser_close_tab`, `browser_snapshot`, `browser_find`, `browser_wait`, `browser_screenshot`, `browser_network` and `browser_close`. Page input, scripts, input policy, environment changes, uploads, downloads, storage state, dialogs and handoff are not registered. The browser is not left unchanged: navigation loads pages, and the two close tools end the lease's tabs and browser (with `--expose-existing-tabs`, also the exposed tabs; an external browser is only disconnected). They stay so that an agent can clean up after itself; add `--disable-tool browser_close_tab,browser_close` to remove them as well.

### Actions and waiting

Action tools (click, click_at, hover, drag, fill, type, press_key, select, check) accept `waitFor`:

- `auto`: the default for click, click_at and press_key. Observe for 250 ms after the action; if a navigation starts, wait until loading finishes or a dialog appears.
- `load`: a completed navigation must be observed; same-document navigations and BFCache restores count.
- `none`: the default for the other actions.

The navigation wait shares the action's `timeout` (10 s by default, at most the operation deadline). A wait timeout returns an error, and the action already performed is neither rolled back nor replayed; when the operation deadline or a cancellation ends the wait, the error also starts with `Action completed, but`. The result contains tabId, url, navigated, loading, tabClosed, newTabs and dialog. With `snapshot: true` it also includes one interactiveOnly snapshot, saving a round trip; if that snapshot fails, the result stays successful and carries `snapshotError` instead.

Chrome holds the replies to an action's input while a JS dialog is open on its tab. An action that has not settled when a dialog is open returns at once with `dialog` set and `pending: true`, without the fields it reports on completion (such as `clicked`) and without a snapshot. The action keeps running behind that result, up to its `timeout`:

- The operation queue of the lease and the queue of its browser process stay taken until the action settles. Other tools wait behind them, each with its own operation deadline and cancellation; `browser_dialog`, `browser_tabs`, `browser_downloads` and `browser_handoff_wait` skip the queues.
- `browser_dialog` answers the dialog. The action then continues, and the next tool runs once it has settled.
- The outcome reaches `browser://events` as `action-completed`, or `action-failed` with an `error` message, and the `lastInput` of the tab.
- At its `timeout` the action fails and frees the queues, so `browser_close_tab` or `browser_close` can end a tab whose dialog nobody answers. Input on that browser then waits until the dialog is answered or the tab is closed, each tool within its own deadline.

Recommended flow:

1. `browser_open({ url })` to get a `tabId`.
2. `browser_snapshot({ tabId })` to observe the page and get element `ref`s; use `browser_find` for complex selections.
3. `browser_click({ tabId, ref: "e12" })` or `browser_fill({ tabId, ref, text })`; add `snapshot: true` to see the result immediately.
4. Decide the next step from the action summary (navigation, new tabs, dialogs), or wait for an expected element.

### Snapshots and refs

Tabs and frames are always named by their returned IDs; there is no implicit "current tab". `browser_snapshot` reads the main frame by default; same-process and cross-process iframes are selected by the returned `frameId`. The snapshot reads `Accessibility.getFullAXTree`, so it contains only the semantic information the browser rendered, not a full DOM export; use `browser_find` for targets that the AX tree does not expose. The output drops unnamed generic/none/presentation wrappers and static text that repeats the parent, shows hierarchy by indentation, and also returns structured nodes (depth, role, name, states, value, url, box).

Each node line carries its layout box as `@x,y WxH`: the top-left corner and size in CSS pixels of the tab viewport, for nodes in iframes too, so `- button "Send" [e12] @412,300 96x32 disabled`. Nodes outside the viewport are marked `offscreen`; nodes without layout, such as hidden elements, have no box (`box: null`). The response also has `viewport`, the viewport size in CSS pixels. `viewportOnly: true` returns only nodes whose box overlaps the viewport; paging and `totalNodes` then count those nodes. Boxes come from one `DOMSnapshot.captureSnapshot` of the frame's session, plus `Page.getLayoutMetrics` and, for an iframe, the content box of each owning `<iframe>` element; no page script runs. They describe layout, not paint: an element covered by another or clipped by a scrolling container still has its box. Pinch zoom is not accounted for in iframes. If Chrome does not report layout, nodes have no boxes and `viewport` is null, and `viewportOnly` fails.

`browser_screenshot` with `marks: "interactive"` (controls, as `interactiveOnly`) or `marks: "all"` (every node with a ref) captures the viewport as PNG and draws an outlined box with its ref label (`e12`) on each visible node of the main frame, up to 500. The result also contains a text and structured `legend` of `{ ref, role, name, box }`, with boxes in CSS pixels like the snapshot, and `truncated` when more nodes were visible. marks cannot be combined with `ref`, `fullPage`, `format` other than png or `quality`; `scale` works. The snapshot is read just before the capture, so a page that moves in between can shift the marks. Captures over 16,777,216 pixels (4096 × 4096) are refused when marking.

Refs are short IDs such as `e1` and `e2`, stored on the server and bound to the actual element, session and document generation; no markers are written into the DOM. The same node in the same document keeps its ref. After navigation, a process swap, node removal or tab close, an old ref reports an error instead of being replaced by a similar new element. Each lease keeps at most 2000 refs and evicts the least recently used; snapshot or find again when that happens.

Snapshots return 200 nodes by default and at most 500 per page, with names truncated to 300 characters. The response includes `truncated`, `totalNodes` and `nextOffset`; use `offset` to continue reading. Paging limits only the output; the full AX tree is read underneath. One snapshot covers at most 20,000 nodes: past that, traversal stops, `capped` and `truncated` are true on every page, `totalNodes` ends at the limit and the last page has no `nextOffset`. Read the rest through `root` or a `frameId`.

Text results provide both `structuredContent` and JSON text. Screenshots are returned directly as an image, up to 5 MiB; no output file path is accepted. Snapshots return the current values of input controls, but password fields are always masked, and `browser_find` text summaries never echo passwords either. Page text and dialog messages are untrusted data, not instructions to the agent.

### Input policy and environment

The default policy is instant; human mode is described in [Input](input.md). A tool error from an input action that stopped early carries `partialInput`, the report of that action (`action`, `status`, `completedSegments`, `events`, `dispatched`, `sent`, `skippedMoves`, `lateReplies`, `presentationRecoveries`, `plannedMs`, `actualMs`, `phase`, `cleanup`, `cleanupErrors`, `trace`, `seed` and `randomState`; see [Input](input.md)). It shows how far the input got, since nothing is replayed. `browser_tabs` shows the last action of each tab as `lastInput`, reduced to `action`, `status`, `events`, `completedSegments` and `cleanup`.

Environment fields, override verification and network restrictions are described in [Environment](environment.md); nothing on the external network is probed unless the host configures a probe. Diagnostics and alignment create temporary resources or send explicit Emulation configuration, so `browser_environment` is not marked readOnly.

## Page JavaScript

`browser_evaluate` is for bulk DOM extraction, reading application state, calling page functions or changing the DOM explicitly. `script` is an **async function body**: use `return` to return a result, and `await` directly. The JSON argument is named `arg` in the page, and is null when omitted.

```json
{
  "name": "browser_evaluate",
  "arguments": {
    "tabId": "tabId returned by browser_open",
    "script": "return [...document.querySelectorAll(arg.selector)].map(a => ({ text: a.textContent.trim(), href: a.href }));",
    "arg": { "selector": "a[href]" },
    "world": "isolated",
    "timeout": 10000
  }
}
```

- **Result**: `{ "type": "json", "value": ... }`; without a return, or when returning undefined, `{ "type": "undefined" }`. Objects follow `JSON.stringify` semantics (Date becomes a string, nested undefined is omitted, NaN becomes null); BigInt, circular references and a top-level function/symbol are errors. Map DOM nodes to the fields you need; remote handles are never returned.
- **Size**: the script and the argument (after JSON serialization) are each limited to 32,768 characters, and the result JSON to 262,144 characters. Exceeding a limit is an error; nothing is truncated.
- **Scope**: `frameId` is optional and defaults to the main frame. It must belong to a tab of the current lease; same-process iframes and OOPIFs are supported. `world` defaults to main, which can reach page globals; isolated is separated from the page's JS globals but shares the DOM, and is not a security sandbox. Scripts run only in Chrome and cannot reach the host's Node, file system or processes; requests, cookies, storage and same-origin restrictions follow the page's own permissions. Because the tool can read and write sensitive page state, it is marked as state-changing.
- **Deadline**: timeout defaults to 10 s, at most the operation deadline (30 s by default). The CDP execution deadline limits the initial synchronous computation, and the host-side wait deadline and cancellation apply at the same time. **Timers, network requests and async continuations already scheduled are not guaranteed to stop, and side effects are not rolled back.** Nothing is replayed after a timeout or cancellation, and later operations may interleave with leftover page tasks; close the tab to stop everything on the page.
- **Input behaviour**: `element.click()`, assigning value directly or `dispatchEvent()` bypass the input policy and produce no trusted input events. For real input use `browser_click`, `browser_fill`, `browser_type` and `browser_scroll`. For cross-page navigation use `browser_navigate`, so the document is not destroyed during execution.

## Embedding

The plain `nodriver-ts` entry point does not load MCP; import it from the subpath:

```ts
import { createBrowserMcpServer } from 'nodriver-ts/mcp';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const handle = serveStdio(() => createBrowserMcpServer({ launch: { transport: 'pipe' } }), {
  legacy: 'reject',
});
// When the application exits: await handle.close();
```

`launch` and `connect: { endpoint }` are mutually exclusive. Each factory call creates an independent instance and ref registry; do not let unrelated agents share one instance. The return value is a standard `McpServer`, so you can register your own application tools. Closing the server or EOF on stdin cleans up the Chrome and temporary profile it owns and keeps persistent profiles; the CLI also does this on SIGINT/SIGTERM. Cleanup cannot be guaranteed if the process is force-killed or loses power.

The second argument, `BrowserMcpBinding`, passes an existing `BrowserSessionManager`, a verified principal and a leaseId. `server.close()` then only closes the adapter, and the manager owns the lease; see [MCP over HTTP](mcp-http.md#embedding-and-ownership).

The server depends on pinned versions of the official SDK `@modelcontextprotocol/server` 2.3.1 and Zod 4.6.7. The default HTTP and byte-stream entry points use the SDK's `legacy: 'reject'`, and `server.connect(InMemory)` goes through the same modern routing, behind a thin layer that rejects initialize, other versions and requests without version metadata. Parsing, envelope validation, MRTR, subscriptions and cancellation are handled by the SDK. See the [protocol specification](https://modelcontextprotocol.io/specification/2026-07-28).

## Concurrency, cancellation and limits

- **Serialization**: browser operations within one lease run serially, so input, navigation and ref observation do not interfere. `browser_tabs`, `browser_dialog`, `browser_downloads` and `browser_handoff_wait` skip the operation queue: the first two find and answer a JS dialog that blocks an action, a download wait can run alongside the click that triggers it, and `browser_handoff_wait` waits on a remote handoff without operating the page. The answering round of `browser_handoff` skips the queue too; its first round takes a turn to move focus.
- **Cancellation**: cancellation reaches navigation, waits, queries, snapshots and actions that support it. CDP commands and input already sent cannot be undone, and the queue does not start the next write operation early just because the client stopped waiting.
- **Errors**: tool errors return `isError: true` with the error name and message. Clicks, submits and other actions are never replayed automatically. Input schemas reject extra fields, and tools reject with a `TypeError` the combinations whose arguments they would otherwise ignore: `environment` or `geoip` with `browser_environment` in inspect mode, `to` together with `toX` or `toY` on `browser_drag` (which needs either `to` or both coordinates), `ref` with non-zero deltas or coordinates on `browser_scroll`, and, on `browser_screenshot`, `ref` with `fullPage`, `quality` with PNG, and `marks` with `ref`, `fullPage`, a format other than PNG or `quality`. Navigation accepts only HTTP(S) and about:blank; this is not network isolation, and page redirects, links and the browser's own requests still behave as Chrome does.
- **Scope**: no remote multi-tenancy, arbitrary CDP or host script execution. File tools appear only once the host configures a directory, and are restricted to it. Tool descriptions and annotations are for clients to display; they are not access control.
- **Traces**: AX snapshots do not enable Runtime. `browser_network` with `start` enables the CDP Network domain for the rest of the tab's lifetime; `stop` ends only the recording. Other observable signals are described in the [automation audit](automation-audit.md).

## Tests

```sh
npm run test:mcp
npm run test:all
```

The tests drive a real stdio subprocess with the official MCP client over both Chrome transports and check that older protocols are rejected on the default entry point; compatibility tests cover negotiation of both 2025 revisions, cancellation, session isolation and capability gating. They also cover four kinds of frame, closed shadow roots, ref invalidation and cross-tab rejection, Chinese text input, checkbox/select, screenshots, invalid arguments, cancellation, JS dialogs and download waits. The embedding tests audit the actual CDP commands and check that closing cleans up the owned profile and keeps an external Chrome. The EOF test only closes stdin and waits for the server to exit, then checks that the persistent profile is kept, the lock and `DevToolsActivePort` are deleted, and the debugging port is closed.
