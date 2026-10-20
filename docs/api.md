# API and behaviour

[简体中文](zh-CN/api.md)

Every operation is asynchronous except read-only properties and event subscriptions. Public types are exported from the root entry point `nodriver-ts`, and the build ships `.d.ts` files. CDP types come from `devtools-protocol`, which is installed with the package.

## Entry points

| Entry point              | Exports                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodriver-ts`            | Browser, BrowserContext, Tab, Frame, Element, Network, input, environment diagnostics, error types, and supporting types such as `InputPolicy` and `InputReport` |
| `nodriver-ts/mcp`        | `createBrowserMcpServer`, `BrowserSessionManager`, `MCP_PROTOCOL_VERSION`; see [MCP](mcp.md)                                                                     |
| `nodriver-ts/mcp/http`   | `startBrowserMcpHttpServer`, `createBrowserMcpHttpService`; see [MCP over HTTP](mcp-http.md)                                                                     |
| `nodriver-ts/mcp/socket` | `startBrowserMcpSocketServer`, `BrowserMcpSocketClientTransport`; see [MCP over socket](mcp-socket.md)                                                           |

## Objects

The test entry point `nodriver-ts/testing` exports `ScriptedChrome`, `NO_REPLY` and related types; see [scripted testing](testing.md). They are not exported from the main entry point.

| Object                | High-level members                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser               | `launch`, `connect`, `newTab`, `newContext`, `tabs`, `contexts`, `defaultContext`, `version`, `owned`, `endpoint`, `close`, `disconnect`, `release`, `waitForTab`, `errors`, `cdp`                      |
| BrowserContext        | `newTab`, `tabs`, `cookies`, `setCookies`, `clearCookies`, `saveCookies`, `loadCookies`, `storageState`, `restoreStorage`, `grantPermissions`, `resetPermissions`, `setDownloadDirectory`, `close`      |
| Tab                   | `goto`, `reload`, `go(delta)`, `waitForNavigation`, `stopLoading`, `bringToFront`, `activate`, `windowBounds`, `mainFrame`, `frames`, `waitForPopup`, `handleDialog`, `setInputPolicy`                  |
| Tab files/environment | `setContent`, `screenshot`, `pdf`, `resources`, `resourceContent`, `setEnvironment`, `addInitScript`, `waitForDownload`, `inspectEnvironment`, `diagnoseEnvironment`, `alignEnvironment`                |
| Tab / Frame           | `evaluate`, `evaluateHandle`, `query`, `queryAll`, `waitForSelector`, `waitForFunction`, `content`                                                                                                      |
| Frame                 | `parent`, `children`, `session`, `url`, `generation`, `storage`, `setStorage`, `inspectEnvironment`                                                                                                     |
| Element               | `text`, `html`, `attribute`, `describe`, `evaluate`, `query`, `queryAll`, `focus`, `click`, `hover`, `scrollIntoView`, `clickablePoint`, `fill`, `type`, `select`, `setChecked`, `upload`, `screenshot` |
| Network               | `route`, `authenticate`, `setExtraHeaders`, `setCacheEnabled`, `setOffline`, `waitForResponse`, `responses`, `enable`, `networkEnabled`                                                                 |
| Route                 | `request`, `continue`, `fulfill`, `abort`; a route can be handled once, and a route the handler leaves unhandled is continued                                                                           |
| Download              | `guid`, `url`, `suggestedFilename`, `status`, `updates`, `path`, `saveAs`, `cancel`                                                                                                                     |
| Mouse                 | `move`, `click`, `wheel`, `drag`; CSS coordinates in the top-level viewport                                                                                                                             |
| Keyboard              | `insertText`, `type`, `down`, `up`, `press('Control+A')`                                                                                                                                                |
| JSHandle              | `jsonValue`, `dispose`, `Symbol.asyncDispose`                                                                                                                                                           |
| Session               | `send`, `sendWith`, `on`, `onAny`, `waitFor`, `disconnected`, `id`, `closed`                                                                                                                            |
| Transport             | WebSocket / Pipe; a custom transport implements `send`, `close`, `onmessage`, `onclose`                                                                                                                 |

The input policy and `InputReport` are described in [Input](input.md). Environment sampling, diagnostics and alignment are described in [Environment](environment.md).

## Deadlines and cancellation

`WaitOptions` combines a `timeout` in milliseconds with an `AbortSignal`. A timeout of 0 expires immediately; it does not mean "wait forever".

| Operation                                            | Default deadline                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Launching or connecting to Chrome, CDP handshake     | 30 s                                                                            |
| A single protocol command                            | 30 s; `launch({ timeout })` sets both the launch/handshake and command deadline |
| `waitForSelector`, `waitForFunction`, action polling | 10 s, polling every 50 ms                                                       |
| `inspectEnvironment`                                 | 5 s                                                                             |

`sendWith(method, { timeout, signal }, ...params)` sets a deadline and cancellation for one command. Multi-step operations share one budget: a selector query's wait for an execution context, and each DOM/Runtime request inside it, only gets the remaining time, and the attempts of `waitForSelector()` / `waitForFunction()` share the total budget too. Concurrent callers share one execution-context lookup; when one caller times out or is cancelled, only that caller's wait ends. Releasing a query's object group has its own 1 s deadline and does not delay the caller's return.

A host-side deadline or cancellation only stops waiting. CDP commands already sent, page scripts already run and input already dispatched are neither undone nor replayed.

## Navigation and event waits

Navigation waits for `load` by default; `domcontentloaded`, `commit` and `networkidle` (Chrome's networkIdle lifecycle event) are also supported. SPA/hash navigations complete on the same-document navigation event, and BFCache restores complete on the restore event.

Register waits for navigation, downloads, popups and responses before triggering the action. A closed session rejects its pending requests and event waits, and late responses are dropped. After a page crash, `reload()` recovers the page; old handles stay invalid. After a disconnect, open a new connection; the library does not replay scripts or input.

## Queries

- A selector is a CSS string, `{ css }`, `{ xpath }` or `{ text, exact? }`.
- CSS and text queries pierce open and closed shadow roots by default; `pierce: false` turns this off. XPath follows standard semantics and does not cross shadow roots.
- Text matching collapses whitespace and, by default, returns only the smallest visible elements that do not contain a matching child.
- `Frame.query()` searches only the selected frame and never crosses into iframes. `Element.query()` is scoped to the element's subtree.
- A query walks the document and open shadow roots in a single pass inside a randomly named isolated world. When piercing (the default), closed shadow roots are found with `DOM.getDocument`. If none are found, that result is reused for the same document for up to 1 s while the structure is unchanged; if some are found, they are cached until the DOM structure changes and passed to the same single pass.
- `QueryOptions` accepts `pierce`, `visible`, `limit`, `timeout` and `signal`. Polling is not meant for high-frequency full scans of large pages.

## Evaluation and execution worlds

`evaluate()` runs in the main world by default; `{ world: 'isolated' }` uses an isolated world. DOM helpers always use a randomly named isolated world. Isolated worlds share the DOM with the page, so the page can observe DOM changes and input events.

Functions run in the browser and cannot capture host closures. Arguments are passed as one serializable value, and a `JSHandle` can be an argument. Exceptions in user scripts throw `EvaluationError`. The string form of `evaluate` / `evaluateHandle` accepts a positive `executionTimeout` in milliseconds. It maps to `Runtime.evaluate.timeout`: it limits only the initial synchronous run, cannot stop timers, requests or async continuations that were already scheduled, and is not a resource sandbox.

The library does not call `Runtime.enable`. The main world is resolved and validated through the owning frame's Document and `DOM.resolveNode`; see the [automation audit](automation-audit.md). As a result, you cannot wait for Runtime events, which are not enabled by default. An explicit `cdp.send('Runtime.enable')` changes this, and changes the detection surface. Register `addInitScript()` before `goto()`. A new OOPIF is initialized while paused and then resumed, with a watchdog as a fallback. Popups or external pages that have already started running get no guarantee that the script runs before their first script.

## Launch and connect

| Option                            | Behaviour                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `headless`                        | `false` by default. Must be set to `true` explicitly without a graphical desktop; the library never switches automatically when no display is available                                    |
| `maskHeadless`                    | On by default when headless and no `userAgent` is given; removes HeadlessChrome from the UA and UA-CH                                                                                      |
| `automationControlled`            | `false` by default: adds `--disable-blink-features=AutomationControlled` (merged with the caller's other disabled features) and keeps the native webdriver getter; `true` omits the switch |
| `preset: 'agent'`                 | Appends `AGENT_ARGS`: disables first-run UI, the search engine choice screen, the crash-restore bubble and background throttling                                                           |
| `userAgent`, `lang`, `windowSize` | Set the UA, BCP 47 language and window size at launch                                                                                                                                      |
| `userDataDir`                     | Persistent profile, locked by `acquireProfileLock()` (see below)                                                                                                                           |
| `handleSignals`                   | Host signals are not handled by default; `true` registers SIGINT/SIGTERM cleanup for the owned process                                                                                     |
| `detached`                        | `false` by default; `true` allows a detached launch on Windows/Unix and `release()`. WebSocket only; Chrome stderr is discarded                                                            |
| `trace`                           | Same as `connect`: a boolean or a callback that receives method, session, duration and error. `false` overrides `NODRIVER_TRACE`. Parameters and results are never logged                  |

The lock file of a persistent profile records the PID and host name. A stale lock is reclaimed only once the owning process on this host is confirmed to have exited, and reclamation is serialized by a separate `.nodriver.lock.reclaim` file. If a process is killed during reclamation and leaves that file behind, launch fails with a clear error; delete the file manually after confirming the recorded process has exited. A leftover `DevToolsActivePort` in the profile (left when Chrome did not exit cleanly, for example because an MCP host force-killed the server) is probed: if the same browser still answers on the recorded port, launch is refused; if nothing answers, the file is deleted and launch continues. When launch fails and Chrome has exited, the error includes the exit code and stderr.

`Browser.connect({ endpoint, attach })` connects to an existing browser. `'all'` (the default) attaches to every tab; `'created'` attaches only to tabs that this client creates and their popups. Launch options have no effect on a connected browser, and `close()` only disconnects.

`ProfileInUseError`, carrying the `profile` path, is thrown when the process holding `.nodriver.lock` on this host is still alive, or when `DevToolsActivePort` is still served by the original browser. On Windows the library also probes Chrome's native `lockfile` for a sharing violation (`EBUSY`), so a running Chrome without a debugging port also produces this error type; a leftover file that is not locked is not treated as in use, and permission errors are not misreported as in use. On Unix the native `SingletonLock`/`SingletonSocket` are not parsed yet, so without a debugging port you may still get an ordinary launch-exit error.

`await using` closes resources on normal exit and during exception unwinding, and `close()` is idempotent. JavaScript cannot guarantee cleanup if the host is force-killed or loses power.

`await browser.release()` returns the WebSocket endpoint and gives up ownership of the process. Afterwards `owned` is `false`, and `close()` and async disposal only disconnect. An owned browser must have been launched with `detached: true`; a pipe connection rejects handoff explicitly and is left unchanged. Handoff keeps the profile and `DevToolsActivePort`, and removes the `.nodriver.lock` that records the host PID. `disconnect()` does not give up ownership, and a pipe Chrome exits when its pipe closes. A detached launch has no stderr, and a host crash before handoff can leave Chrome running. See [browser handoff and events](browser-handoff.md) for a full example, cleanup responsibilities and the event API.

## Input and element actions

- Before a click, the element is scrolled into the viewport and checked for visibility, enabled state, stable position and hit-testing. Actions already dispatched are never replayed.
- `fill()` supports editable inputs, textareas and contenteditable elements. It writes Unicode through focus/selection and `Input.insertText`, and promises only the final text and the browser's input semantics; it does not simulate an OS IME candidate window or the clipboard.
- `select()` changes the value through the DOM and dispatches input/change.
- Physical keys support named keys, F1–F12, modifier combinations and US-layout characters (including shifted symbols).
- `Mouse.drag()` is a pointer drag; complex HTML5 DataTransfer needs your own protocol code.

## Screenshots, PDF and errors

`screenshot()` returns a Buffer; `path` is optional. Element screenshots suit axis-aligned elements; for rotated or perspective-transformed elements, take a page screenshot with an explicit clip. `pdf()` relies on Chrome's headless printing. Permission problems, experimental commands and differences between browser implementations surface as `ProtocolError`; they are not all treated as "unsupported".

## Network

`Network.enable` is sent only when needed: subscribing to `responses`, calling `waitForResponse`, calling `enable()` explicitly, or setting non-default headers/cache/offline. `route()` and `authenticate()` use only the Fetch domain. Routes cover the selected Tab and its OOPIFs, but not Service Workers, the browser's own requests or other tabs. Call a response's `body()` after its content is available; CDP may refuse when the cache entry was evicted or the response was redirected.

## State and storage

Cookies and storage are isolated between BrowserContexts. That isolation does not extend to the operating system, GPU or fonts.

`storageState(path?)` saves cookies, plus first-party localStorage for every HTTP(S) origin that any frame in the context has visited, including iframes and origins used by tabs that have since closed. Empty storage is not exported. Partitioned localStorage of cross-site iframes under other top-level sites, sessionStorage and IndexedDB are not in the snapshot. Main pages that are still open are read in place; other origins are read in one temporary tab.

`restoreStorage(state)` sets cookies first, then replaces the localStorage of each listed origin. If a main page for that origin is still open, it is written in place and readable once the call returns; other origins are written in one temporary tab. The temporary tab intercepts document requests, serves a blank page and bypasses Service Workers, so it never contacts the site, follows redirects or runs site scripts. Other open documents of the same origin receive the change asynchronously, just as with cross-tab writes in the browser.

`Frame.storage(kind = 'local', origin?)` and `Frame.setStorage(values, kind = 'local', clear = false, origin?)` accept an expected origin. Reading, clearing and writing happen in the same script as the `location.origin` check; on a mismatch they throw `EvaluationError` and the page's storage is left unchanged.

Cookie snapshots and state files contain credentials. Where they are stored is the caller's responsibility.

## Protocol and tracing

Strict command parameter tuples, return types and event types come from a pinned version of `devtools-protocol`. Events are routed by session: `session.on(method, listener)` and `session.onAny(listener)` receive only that session's events, and run before the global `connection.events`. `connection.listenerCount` counts both.

The `Connection` option `trace: true` writes each command's method, session, duration and error code to stderr; a function receives a `TraceEntry` instead. The environment variable `NODRIVER_TRACE=1` is equivalent to `true`. Parameters and results are never logged.
