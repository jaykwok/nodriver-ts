# MCP server

[简体中文](zh-CN/mcp.md)
For clients using initialize, see [generic agent compatibility](agent-compatibility.md), including [Pi 1.3.0 evidence](pi.md).

The built-in MCP server has four entry points: a long-running local Streamable HTTP service, stdio launched by the client, a local socket (Unix socket / Windows named pipe), and in-process InMemory. They share `createBrowserMcpServer`, `BrowserSessionManager`, the browser pool and leases, tool schemas, element refs, the operation queue and the same CDP core.

- The default is MCP **2026-07-28** (`server/discover` with per-request `_meta` version metadata). Legacy initialize is rejected on the default entrance. Opt in with `--mcp-compat` for **2025-11-25 / 2025-06-18** on stdio or the separate HTTP `/mcp/compat` route. The official TypeScript client 2.3.1 must explicitly pin `versionNegotiation: { mode: { pin: '2026-07-28' } }` for modern requests. `MCP_PROTOCOL_VERSION` is exported by `nodriver-ts/mcp`.
- `Runtime.enable` is never sent automatically. The in-page JavaScript tool `browser_evaluate` is provided; there are no tools for arbitrary CDP or host code execution.
- Chrome launches lazily on the first `browser_open`, headful by default. Without a desktop pass `--headless`, or use `launch: { headless: true }` when embedding. `--headful` and `--headless` cannot be combined, and neither can be used with `--endpoint`; connecting to an existing Chrome does not change its window mode.

## Starting the server

```sh
npm run build

# stdio: launched by the client; this is the default when --mcp-transport is omitted
node dist/mcp/cli.js --browser-transport pipe
node dist/mcp/cli.js --endpoint http://127.0.0.1:9222

# HTTP: a long-running local service; first set a random NODRIVER_MCP_TOKEN (at least 32 characters)
node dist/mcp/cli.js --mcp-transport http --port 3100
```

The package provides the `nodriver-mcp` command; from source, use `npm run mcp`. stdout is reserved for the protocol, and logs and help go to stderr. The service runs in the foreground; it does not install a system service or start at boot, and it does not modify client configuration.

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

HTTP listens only on loopback and requires a Bearer token. Without `Browser-Lease-Id`, the token's `default` lease is used; when several agents need independent state, each sends a different lease name (created on first use). The end of a request or a client disconnect does not destroy the lease, browser or refs. Authentication, headers, Origin/Host and limits are described in [MCP over HTTP](mcp-http.md), and local IPC in [MCP over socket](mcp-socket.md).

## CLI options

Run `nodriver-mcp --help` for every option.

| Option                                                     | Effect                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--mcp-transport stdio\|http\|socket`                      | MCP transport; stdio by default                                                                                              |
| `--mcp-compat`                                             | Enable standard 2025-era clients on stdio or HTTP `/mcp/compat`; `/mcp` remains modern                                       |
| `--port`, `--socket-path`, `--token-env NAME`              | HTTP port (3100 by default), socket path, environment variable holding the token                                             |
| `--headful` / `--headless`                                 | Window mode; headful by default                                                                                              |
| `--browser-transport pipe\|websocket`                      | CDP transport; pipe by default. `--transport` is an alias                                                                    |
| `--executable`, `--user-data-dir`                          | Chrome path; persistent profile (a single browser, no per-lease contexts)                                                    |
| `--endpoint URL`, `--expose-existing-tabs`                 | Connect to an existing Chrome; by default only tabs opened by this service are attached                                      |
| `--proxy URL`                                              | Upstream proxy; with credentials it needs per-lease contexts, so it cannot be combined with `--user-data-dir`                |
| `--user-agent`, `--lang`, `--window-size WxH`              | Set at launch                                                                                                                |
| `--preset agent\|default`                                  | agent by default: disables first-run UI, the search engine choice screen, the crash-restore bubble and background throttling |
| `--input-policy instant\|human`                            | Default input policy for new tabs                                                                                            |
| `--read-only`, `--disable-tool NAME[,NAME]`                | Keep only observation and navigation tools; disable individual tools                                                         |
| `--upload-dir`, `--download-dir`, `--state-dir`            | Enable the matching file tool, restricted to that directory                                                                  |
| `--allow-handoff`                                          | Allow `browser_handoff` even without an explicit `--headful`                                                                 |
| `--max-browsers`, `--contexts-per-browser`, `--max-leases` | Resource limits                                                                                                              |
| `--lease-idle-ms`, `--queue-limit`, `--operation-timeout`  | Lease idle timeout, queue length, operation deadline                                                                         |

## Tools

The 26 default tools:

| Tool                   | Purpose                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `browser_tabs`         | Show connection state, tabs, frames and pending JS dialogs; does not launch a browser                          |
| `browser_open`         | Lazily launch or connect to a browser and open a new tab; returns a tabId                                      |
| `browser_navigate`     | Navigate an open tab; waitUntil supports commit/domcontentloaded/load/networkidle                              |
| `browser_history`      | Back, forward or reload; returns moved:false when there is no history entry                                    |
| `browser_close_tab`    | Close the given tab                                                                                            |
| `browser_snapshot`     | Indented accessibility tree with `[e12]` refs; interactiveOnly, root subtree, offset paging                    |
| `browser_find`         | CSS/XPath/text query returning refs, role, name, tag, text summary and visibility                              |
| `browser_wait`         | Wait for a matching element (optionally visible) in the selected frame; returns a new ref and description      |
| `browser_click`        | Click after checking stability, visibility and obstruction; supports button and clickCount                     |
| `browser_click_at`     | Click viewport coordinates (canvas, maps and so on) without an obstruction check                               |
| `browser_hover`        | Move the pointer over an element without pressing                                                              |
| `browser_drag`         | Drag from an element to another element or to viewport coordinates                                             |
| `browser_fill`         | Replace an input's content; supports Chinese and emoji                                                         |
| `browser_type`         | Type at the caret/selection; in human mode US-layout characters use key events                                 |
| `browser_press_key`    | Send a key or chord to the focused element, such as Enter, Shift+Tab, Control+A (Meta+A selects all on macOS)  |
| `browser_select`       | Change the selected value of a select                                                                          |
| `browser_check`        | Set the checked state of a checkbox/radio                                                                      |
| `browser_scroll`       | Scroll an element into view (ref), or send a wheel delta at given coordinates                                  |
| `browser_dialog`       | Accept or dismiss the current JS dialog; supports promptText                                                   |
| `browser_screenshot`   | PNG/JPEG/WebP of the viewport, full page or an element (ref); quality and scale can be set                     |
| `browser_network`      | Record recent responses on demand (URL, status, type, MIME), without headers or bodies                         |
| `browser_evaluate`     | Run an async JS function body in a given tab/frame, with JSON arguments and result                             |
| `browser_input_policy` | Set a tab's instant/human policy, seed, rhythm, typing and scroll mode                                         |
| `browser_environment`  | Structured diagnostics or explicit alignment; network probes and the GeoIP resolver are configured by the host |
| `browser_close`        | Close an owned browser or disconnect from an external one; you can open again afterwards                       |
| `browser_handoff`      | Ask the user to finish a manual step in the browser and confirm; needs an accessible UI and elicitation.form   |

Optional tools that appear once the host configures a directory:

- **`browser_upload`** (`--upload-dir`): file names must resolve to a path inside that directory.
- **`browser_downloads`** (`--download-dir`): lists or waits for the most recent 100 download records; files are saved in that directory under GUID names. Each record has an increasing `sequence`, and list returns `latestSequence`. wait does not occupy the operation queue and can be called before or after the click that triggers the download. It waits for the first record with a sequence greater than `after` to complete or be cancelled; `after` defaults to the sequence returned by this tab's previous wait (initially 0). A timeout reports an error without advancing the cursor, so the next wait keeps waiting for the same download.
- **`browser_storage_state`** (`--state-dir`): saves or loads, by name, cookies and first-party localStorage for every HTTP(S) origin that any frame in the context has used (including closed tabs). Empty storage is not exported, nor is partitioned localStorage of cross-site iframes. Reads and writes happen in a temporary blank page that intercepts document requests, so the site is never contacted and redirects are not followed. State files refuse existing symbolic and hard links, are saved by atomic replacement through a temporary file, and have POSIX mode 0600. Their content never enters the conversation; only counts are returned.

### Actions and waiting

Action tools (click, click_at, hover, drag, fill, type, press_key, select, check) accept `waitFor`:

- `auto`: the default for click, click_at and press_key. Observe for 250 ms after the action; if a navigation starts, wait until loading finishes or a dialog appears.
- `load`: a completed navigation must be observed; same-document navigations and BFCache restores count.
- `none`: the default for the other actions.

The navigation wait shares the action's `timeout`. A wait timeout returns an error, and an action already performed is neither rolled back nor replayed. The result contains tabId, url, navigated, loading, tabClosed, newTabs and dialog; with `snapshot: true` it also includes one interactiveOnly snapshot, saving a round trip.

Recommended flow:

1. `browser_open({ url })` to get a `tabId`.
2. `browser_snapshot({ tabId })` to observe the page and get element `ref`s; use `browser_find` for complex selections.
3. `browser_click({ tabId, ref: "e12" })` or `browser_fill({ tabId, ref, text })`; add `snapshot: true` to see the result immediately.
4. Decide the next step from the action summary (navigation, new tabs, dialogs), or wait for an expected element.

### Snapshots and refs

Tabs and frames are always named explicitly by their returned IDs; there is no implicit "current tab" state. `browser_snapshot` reads the main frame by default; same-process and cross-process iframes are selected by the returned `frameId`. The snapshot reads `Accessibility.getFullAXTree`, so it contains only the semantic information the browser rendered; it is not a full DOM export. Use `browser_find` for targets that the AX tree does not expose. The output drops unnamed generic/none/presentation wrappers and static text that repeats the parent, shows hierarchy by indentation, and also returns structured nodes (depth, role, name, states, value, url).

Refs are short IDs such as `e1` and `e2`, stored on the server and bound to the actual element, session and document generation; no markers are written into the DOM. When the same node reappears in the same document, it keeps its ref. After navigation, a process swap, node removal or tab close, an old ref reports an error instead of being replaced by a similar new element. Each lease keeps at most 2000 refs, and older ones may be evicted; snapshot or find again when that happens.

Snapshots return 200 nodes by default and at most 500, with names truncated to 300 characters. The response includes `truncated`, `totalNodes` and `nextOffset`; use `offset` to continue reading. This only limits output; the full AX tree is still read underneath.

Text results provide both `structuredContent` and JSON text. Screenshots are returned directly as an image, up to 5 MiB, and no file path for writing is accepted. Snapshots return the current values of input controls, but password fields are always masked, and `browser_find` text summaries never echo passwords either. Page text and dialog messages are untrusted data and should not be treated as instructions to the agent.

### Input policy and environment

The default policy is instant; human mode and `partialInput` after cancellation are described in [Input](input.md). Environment fields, override verification and network restrictions are described in [Environment](environment.md); nothing on the external network is probed unless an external probe is configured. Diagnostics and alignment create temporary resources or send explicit Emulation configuration, so `browser_environment` is not marked readOnly.

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

- **Result**: `{ "type": "json", "value": ... }`; without a return, or when returning undefined, `{ "type": "undefined" }`. Objects follow `JSON.stringify` semantics (Date becomes a string, nested undefined is omitted, NaN becomes null); BigInt, circular references and a top-level function/symbol are errors. DOM nodes must be mapped explicitly to the fields you need; remote handles are never returned.
- **Size**: the script and the argument (after JSON serialization) are each limited to 32,768 characters, and the result JSON to 262,144 characters. Exceeding a limit is an error; nothing is truncated.
- **Scope**: `frameId` is optional and defaults to the main frame. It must belong to a tab of the current lease; same-process iframes and OOPIFs are supported. `world` defaults to main, which can reach page globals. isolated is separated from the page's JS globals but shares the DOM, and is not a security sandbox. Scripts run only in Chrome and cannot reach the host's Node, file system or processes; requests, cookies, storage and same-origin restrictions follow the page's own permissions. Because the tool can read and write sensitive page state, it is marked as state-changing.
- **Deadline**: timeout defaults to 10 s, up to 60 s, and is also bounded by the operation deadline (30 s by default). The CDP execution deadline limits the initial synchronous computation, and the host-side wait deadline and cancellation signal apply at the same time. **There is no guarantee that timers, network requests or async continuations already scheduled are stopped, and side effects are not rolled back.** Nothing is replayed after a timeout or cancellation, and later operations may interleave with leftover page tasks; close the tab if you need to abort everything on the page.
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

`launch` and `connect: { endpoint }` are mutually exclusive. Each factory call creates an independent instance and ref registry; do not let unrelated agents share one instance. The return value is a standard `McpServer`, so you can register your own application tools. Closing the server, EOF on stdin and SIGINT/SIGTERM all clean up the Chrome and temporary profile it owns, and persistent profiles are kept; this cannot be guaranteed if the controller is force-killed or loses power.

The second argument, `BrowserMcpBinding`, can pass an existing `BrowserSessionManager`, a verified principal and a leaseId. In that case `server.close()` only closes the adapter, and the lease is managed by the manager; see [MCP over HTTP](mcp-http.md).

The server depends on pinned versions of the official SDK `@modelcontextprotocol/server` 2.3.1 and Zod 4.6.7. The default HTTP and byte-stream entry points use the SDK's `legacy: 'reject'`, and `server.connect(InMemory)` goes through modern routing. Opt-in compatibility uses a separate negotiated transport profile; see [Agent compatibility](agent-compatibility.md). An extra thin layer rejects initialize, other versions and requests without version metadata; parsing, envelope validation, MRTR, subscriptions and cancellation are handled by the SDK. See the [protocol specification](https://modelcontextprotocol.io/specification/2026-07-28).

## Concurrency, cancellation and limits

- **Serialization**: browser operations within one lease run serially, so input, navigation and ref observation do not interfere with each other. `browser_tabs`, `browser_dialog` and `browser_downloads` skip the operation queue: the first two are for finding and dismissing a JS dialog that blocks an action, and a download wait can run in parallel with the click that triggers it.
- **Cancellation**: cancellation signals reach navigation, waits, queries, snapshots and actions that support cancellation. CDP commands and input already sent cannot be undone, and the queue does not let the next write operation start early just because the client stopped waiting.
- **Errors**: tool errors return `isError: true` with the error name and message. Clicks, submits and other actions are never replayed automatically. Input schemas reject extra fields. Navigation entry points accept only HTTP(S) and about:blank; this is not network isolation, and page redirects, links and the browser's own requests still behave as Chrome does.
- **Scope**: no remote multi-tenancy, arbitrary CDP or host script execution. File tools appear only once the host configures a directory, and are restricted to it. Tool descriptions and annotations are for clients to display; they are not an access-control mechanism.
- **Traces**: AX snapshots do not require enabling Runtime, and tests confirm it is not enabled automatically. There is no claim that every means of observation is undetectable; see the [automation audit](automation-audit.md).

## Tests

```sh
npm run test:mcp
npm run test:all
```

The tests use the official MCP client with a real stdio subprocess and both Chrome transports, and verify that older protocols are rejected on the default entry point. Compatibility tests separately verify negotiation of the two supported 2025 revisions, cancellation, session isolation and capability gating. They cover four kinds of frame, closed shadow roots, ref invalidation and cross-tab rejection, Chinese text input, checkbox/select, screenshots, invalid arguments, cancellation, JS dialogs and download waits. The embedding tests audit the actual CDP commands and verify that closing cleans up the owned profile and keeps an external Chrome. The EOF test only closes stdin and waits for the server to exit on its own, verifying that the persistent profile is kept, the lock and `DevToolsActivePort` are deleted, and the debugging port has gone away.
