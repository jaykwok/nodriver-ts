# Changelog

All notable changes are recorded here. The project follows [Semantic Versioning](https://semver.org/); before 1.0, minor versions may contain breaking changes.

## Unreleased

### Breaking changes

- `clearSiteData()` failures other than refusing open tabs are `ClearSiteDataError`s, with the original error, such as a `TimeoutError`, as `cause`; they used to be thrown directly. A cookie set again during the call is also reported as `ClearSiteDataError`, which extends `NodriverError` as before.
- `TabScope.adopt(tab)` no longer owns popups the tab opened before it was adopted; popups it opens afterwards are owned as before. Whether a popup is owned is decided when Chrome reports it, by its opener's role at that moment, and roles belong to the page, so a page attached again keeps its role. `TabScopeCloseResult` has a `borrowed` list, and `closed` also lists tabs that did not finish opening through `scope.newTab()`.
- MCP snapshot lines carry each node's layout box, `@x,y WxH` in CSS pixels of the tab viewport, and `offscreen` for nodes outside the viewport, after a `Viewport WxH` line. Structured nodes have `box` (`{ x, y, width, height }` or null), and snapshots have `viewport`. Code that parses snapshot text needs to allow the new fields.
- `storageState()` takes an options object; `storageState(path)` becomes `storageState({ path })`. Its result has `version: 2`, and an export over `maxBytes` (64 MiB by default) fails with a `RangeError`.

### MCP

- `browser_storage_state` takes `include` to save sessionStorage or IndexedDB. With `stateKey` (`--state-key-env`), state files are encrypted and plain files are refused.
- `browser_snapshot` takes `viewportOnly` to return only nodes visible in the viewport. Boxes come from one DOMSnapshot capture per snapshot; no page script runs.
- `browser_screenshot` takes `marks: 'interactive' | 'all'` to draw each visible node's box and ref on a PNG of the viewport, and returns a `legend` of `{ ref, role, name, box }`.

### Pages and queries

- Navigation waits follow documents that replace the one being loaded before it reaches the awaited event, such as a sign-in page that submits a form or calls `location.replace()` while loading, and complete when one of them reaches the event, within the same deadline. Only the first navigation is sent, and the wait resolves with the URL of the document that completed it. Such a `goto(url, { waitUntil: 'domcontentloaded' })` used to time out although the final page had loaded.

### Tabs

- `browser.newTab(url, context, options)`, `context.newTab(url, options)` and `scope.newTab(url, options)` take a `timeout` and `signal` that cover creating the tab, attaching it and the first navigation together. A tab that does not finish opening is closed, including one Chrome creates after the caller stopped waiting or after the connection's command timeout; once the deadline has passed or the signal has aborted, the call does not wait for that close. `scope.close()` waits for such tabs and reports them. One deadline, the connection's command timeout, covers the waiting and closing of `scope.close()`: a page not closed by then is reported as a `TimeoutError` in its `AggregateError` and closes in the background.
- `TabScope.borrow(tab)` lends the scope a tab that outlives it, such as a reused start page: popups it opens from now on close with the scope, and the tab itself stays open.

### State and storage

- `storageState({ include: ['sessionStorage', 'indexedDB'] })` also exports the sessionStorage of open tabs and IndexedDB databases with their structure and typed values. `restoreStorage(state, { sessionStorageTab })` restores them; replacing a database is refused while a tab shows its origin.
- `encryptState()` and `decryptState()` seal a state with AES-256-GCM, using a 32-byte key or a passphrase.
- `clearSiteData({ timeout, signal })` bounds the whole call. A call that stops, by timeout, abort or a failed step, throws `ClearSiteDataError`, whose `result` lists the cookies deleted, origins cleared and tabs handled so far. The request interception it sets on a tab stops when the call ends, also after it stops, and the Service Worker bypass is undone even when Chrome did not confirm it in time. A temporary tab the call opens is closed within its deadline, or after it returns once the deadline has passed. When undoing fails after the call has already failed, the call keeps its own error, so `cause` stays the original error, such as the abort reason.
- `storageState()` and `restoreStorage()` keep the error of a failed visit when their temporary tab cannot be closed either; the close failure used to replace it.

### Browser and process lifecycle

- Cleanup the library does after an operation failed or after its caller stopped waiting, such as closing a tab that did not finish opening, never replaces the operation's own error. When such cleanup fails, the failure is reported through `onError` and `browser.errors`.
- `prepareProfile(dir, options)` receives `temporary` and `empty` in its options (`ProfilePreparation`): whether the library created the profile for this launch, and whether the profile held nothing from earlier launches. `empty` is read under the profile lock and ignores only the library's lock files, `.nodriver.lock` and `.nodriver.lock.reclaim`.

## 0.8.0 — 2026-11-07

### Breaking changes

- `setChecked()` failures are `InputActionError`s, as with `click()`, with the original error as `cause`; they used to be thrown directly.
- `ProtocolError.message` ends with the session the command was sent to, such as `[browser session]`. Compare `protocolMessage` instead of the whole message.

### Input

- `setChecked()` takes `InputOptions` and runs as one input action: the timeout, signal and guard cover reading the state, the click and waiting for the result, and no other input runs in between. It waits up to 1 s for the requested state instead of reading it once right after the click, and resolves to `{ changed, clicked }`. When a click at the control's center would not reach it, as with a native checkbox hidden behind a styled label, it clicks the control's first rendered `<label>`; it used to time out. `setChecked(false)` on a checked radio is refused before any input; it used to click and then fail. A disabled control, including one in a disabled `<fieldset>`, is waited for until it is enabled; neither it nor its label is clicked meanwhile.
- Default input policies: the `inputPolicy` option of `Browser.launch()`, `Browser.connect()` and `newContext()`, and `setDefaultInputPolicy()` on `Browser` and `BrowserContext`, apply a policy to tabs that open later, popups included. A context's default overrides the browser's, and `tab.setInputPolicy()` overrides both for one tab.
- `type(text, { replace: true })` selects the whole value first and types over it, for typing that replaces a value key by key; `fill()` still replaces it with one insertion.
- `InputReport.dispatched` counts the input commands an action sent that can change the page (presses, releases, keys, text and composition, including releases sent during cleanup), when they are sent rather than when Chrome acknowledges them. Moves and wheel scrolling are not counted.

### Pages and queries

- `tab.locator(selector)` and `frame.locator()` return a `Locator`, a query that runs again before each action, so `click`, `hover`, `fill`, `type`, `setChecked`, `text` and `attribute` reach the current element after a re-render. One timeout and signal cover finding the element and the action, reads included. `Element.text()`, `html()` and `attribute()` take `{ timeout, signal }`. An action whose element is replaced before it sends a press, key or text runs again on a new match; once such input was sent, its failure is reported and it is never repeated.
- `tab.fetch(url, options)` and `frame.fetch()` run `fetch()` in the frame's isolated world with the page's cookies, origin and network, and return the status, headers and body as text, JSON or base64 up to `maxBytes`. On timeout or abort, with any abort reason, the page request is aborted too, and `FetchCancelledError.aborted` tells whether that was confirmed or the request may have reached the server.

### State and storage

- `BrowserContext.clearSiteData({ domains, origins, types, openTabs })` deletes the cookies and storage (localStorage, sessionStorage, IndexedDB, Cache Storage, Service Workers) of some sites and keeps the rest of the context, for example to log out of one site while staying logged in to another. Origins match exactly, port included; cookies match by host or domain. Origins are collected before any tab changes, from committed frames, tab history and pages the client has not attached. Open tabs of a matching site, tabs that still hold its sessionStorage after navigating away, and pages of the context this client has not attached make it throw unless `openTabs` is `'close'` or `'blank'`; `'blank'` clears such sessionStorage by loading the origin in the tab with an empty, library-served document, and refuses unattached pages. The call covers the pages open when it starts, whether attached, still being attached or not attached, and leaves pages opened during the call alone. It reports the deleted cookies, the cleared origins and the handled tabs and pages, and throws if a matching cookie exists again afterwards. Its storage commands go to a page session, as Chrome refuses `Storage.clearDataForOrigin` on the browser session.

### Browser and process lifecycle

- `browser.attachTarget(id)` reconnects a page whose previous session detached while the page stayed open. It disposes the closed Tab and returns a new initialized Tab instead of returning the unusable cached object; concurrent calls share the new attachment. If this happens while `clearSiteData()` collects origins, it reads the new session's history as well and keeps origins already collected for the page.
- `browser.tabScope()` and `context.tabScope()` group the pages of one task in a shared browser: tabs opened through the scope, adopted tabs and their popups, transitively. `close()` closes them, including popups that open meanwhile or are still attaching, popups opened while `newTab(url)` loads its page, and a tab still opening through the scope, which it waits for and reports; other tabs and tabs released with `keep()` stay open.
- `Browser.launch({ prepareProfile })` calls a function with the profile directory before Chrome starts, to write or check files such as `Local State`: for a temporary profile after the library has prepared it, for a `userDataDir` while this process holds its lock. It runs before every launch, so a persistent profile is checked each time. It is bounded by the launch timeout, and a failure ends the launch. A persistent profile serves one browser at a time. The [API guide](docs/api.md#profiles) describes how a fixed profile relates to Chrome's Windows blank-password check; the library ships no settings for it.
- `updateProfileSettings(directory, { localState, preferences, profile })` merges settings into a profile's `Local State` and `Preferences`, keeping other keys, and reads each file back to check every given value. It refuses to rewrite a file that is not valid JSON. The check covers the files, not whether a browser version honours a setting.
- `Browser.close()` gives Chrome up to 10 s, up from 3 s, to exit after `Browser.close`. On Windows, a Chrome that is still running is then terminated directly instead of through `taskkill`, and Chrome's other processes exit with it. After terminating Chrome, `close()` waits up to 15 s, up from 5 s, before it reports that Chrome did not exit. Busy Windows hosts can take seconds both to shut Chrome down and to finish a terminated process, and such a close used to fail although Chrome was exiting.

### Protocol

- `ProtocolError` names the session a failed command was sent to: `sessionId`, `targetType` (`browser`, `page`, `iframe`, `worker` ...) and a suffix such as `[browser session]` or `[page session <id>]` at the end of the message. `protocolMessage` holds Chrome's message alone. A command sent to the wrong kind of session, which Chrome may answer only with `Internal error`, is now recognisable from the error.

### Tooling

- `ScriptedChrome.addPage({ openerId })` models a popup of a page.

## 0.7.0 — 2026-11-04

### Breaking changes

- MCP: `browser_storage_state` files move to `<state-dir>/<principal>/<name>.json` (`p-<sha256>` for principals outside `[a-z0-9_-]{1,64}`), so principals can no longer read or overwrite each other's states. To keep existing states, move `<state-dir>/<name>.json` into `<state-dir>/private/` (stdio and embedded servers without a binding) or `<state-dir>/local-operator/` (CLI HTTP and socket services).
- MCP: tools reject arguments they would ignore with a `TypeError`: `browser_environment` inspect with `environment`/`geoip`, `browser_drag` `to` with `toX`/`toY`, `browser_scroll` `ref` with non-zero deltas or coordinates, `browser_screenshot` `ref` with `fullPage`.
- A context created with `newContext({ proxy })` ends with the connection that created it. Its forwarder runs in the host process; such a context used to stay open in Chrome, pointing at a closed port.
- `PresentationLeaseReason` drops `'stop-failed'`: a failed `Page.stopScreencast` keeps the original `reason`, sets `state` to `failed` and records the error in `cleanupErrors`.
- `Observation.source` drops the unused `'explicit-configuration'`.
- The `after` field of the `alignEnvironment()` report is optional; see below.

### Input

- `click()`, `hover()` and `clickablePoint()` work on `<input>`, `<textarea>`, custom elements with a shadow root and buttons that contain shadow-DOM icons, which used to time out: hit tests ignore user-agent shadow DOM and follow the composed tree.
- A control inside a disabled `<fieldset>` counts as disabled; `click()` used to report success without a click event.
- Remote objects that die with their context or session count as released, so a click or typing that races a navigation no longer blocks managed input on the connection.
- While a JavaScript dialog is open on a page the action used, the cleanup budget pauses, because Chrome holds the replies to input until the dialog closes. Such a click no longer blocks managed input on the connection. The trace records `dialogWait`.
- A page that closes during an action takes its input state with it: requests it leaves unanswered and steps that fail because its session ended are not cleanup failures, and other failures on that page block no input. The trace records `pageClosed`.
- With Shift held through `keyboard.down('Shift')`, `type()` produces the given text: characters that need no Shift use `insertText`.
- Launched browsers select macOS editing commands by the host platform, so a Mac `userAgent` option no longer changes `Control+A` on other systems. Connected browsers use the user agent that `Browser.getVersion` reports.
- `Keyboard.compose()` and input scope `run()` accept `forceCancel: true` to cancel at the session's current focus during explicit cancellation and cleanup, including when focus moved during `compositionstart`. Updates and commits retain their original focus/document checks. Cleanup is armed only after the first update's focus checks pass. Away from the original editor, the cancel is sent only at an inspectable editor with a collapsed selection, because Chrome deletes selected text on an empty update without a composition.
- A composition that ended by itself, for example because focus left and came back, is cancelled only over a collapsed selection. The empty update used to delete a range selection and report success.
- Composing through an out-of-process frame's own session works; its focus check always failed.
- An explicit `executionContextId` is resolved to its global object once, before the first update, so a newer document that reuses the numeric ID is never probed.
- Input cleanup waits only for the action's own late replies (input commands, element preparation, raw commands issued from its callback on any connection, and the detach sent for an attach that answers late) instead of every pending command on the connection, so unrelated work on other tabs no longer delays cleanup or blocks managed input after `cleanupTimeout`. A connection the action used that closes with nothing outstanding is not a failure.
- `InputScope.recoverComposition()` lets callers acknowledge an inspected/restored page and clear its composition-only block across attachments and child frames without destroying the target. Recovery shares the input queue, sends no CDP commands, preserves failed cleanup reports, and refuses connection-wide failures or managed holds on that page.
- `InputActionError` and `InputBlockedError` extend `NodriverError`; `InputBlockedError` keeps the first cleanup failure as `cause`.

### Pages and queries

- `goto()` no longer completes before `load` or `networkidle` when the new document changes its URL with `history.replaceState()` or a hash; the change only updates the returned URL. `reload()` completes only with a new document, and `go()` completes a same-document history navigation only at the entry's URL.
- `tab.crashed` reports a crash of the page's own renderer, not of an out-of-process iframe, and a new main-frame document clears it, including after `goto()` or `go()`.
- `waitForSelector()` and `waitForFunction()` keep polling through the moment a navigation replaces the execution context.
- `addInitScript()` registers a script once per session, including new out-of-process frames that attach meanwhile, and a removal that overlaps a registration holds. A removal that failed can be retried.
- Closed shadow roots found by a query are cached until the DOM structure changes, so later queries on an unchanged document do not scan it again.
- `evaluate()`, `clickablePoint()` and `go()` share one deadline across their steps. `Frame.content()` runs in the isolated world. A failed evaluation releases its exception object, and `EvaluationError` includes a thrown primitive's value.
- `Tab.close()` can be retried after a failure, and a navigation wait on a closed session rejects instead of throwing synchronously.
- `Element.withObject()` passes an object group to its callback; objects created in the group are released with the handle.

### Browser and process lifecycle

- `handleSignals` closes every browser launched with it before the host terminates, and a host handler registered with `process.once()` counts as handling the signal.
- On macOS and Linux, Chrome launched without `detached` ends when the host exits, including through `process.exit()` or an uncaught exception. Its process group is signalled when Chrome exits, and `close()` no longer signals a group whose ID the system may have reused.
- `release()` rejects once Chrome has exited. In supervised mode, a request the helper refused or never received rejects and keeps ownership; `ReleaseUncertainError` is only for a request that was sent and not answered, and not for one that Chrome's exit overtook.
- A failed `Browser.close()` can be retried, including in supervised mode; `release()` stays refused once closing began.
- The supervision helper does not inherit `NODE_OPTIONS`, so a preload that writes to stdout cannot corrupt its protocol and end a healthy Chrome. On Windows, its private directory is removed with retries when it closes, and a supervised launch removes directories that earlier launches left behind after a release or a host crash, once their helper has exited and they are more than an hour old.
- A page that closes during the initial attach no longer fails `launch()` or `connect()`, and concurrent attaches no longer create duplicate context objects.
- A leftover `DevToolsActivePort` whose port is held by another HTTP service no longer fails launch. Losing the race for a stale profile lock raises `ProfileInUseError` instead of a bare `EEXIST`.
- Chrome's stderr is decoded across chunk boundaries, so startup diagnostics no longer corrupt multi-byte characters.

### Protocol

- `SessionEndedError`, `Session.closeReason` and WebSocket errors keep the error that caused them as `cause`. Errors thrown by `Session.disconnected` listeners reach `onError`.
- `TargetSession.detach()` succeeds without another command when Chrome no longer has the attachment, and an attach still queued when its target is destroyed is not cleaned up as if it had been sent.
- `attachSession()` ends a plain `Session` that a root listener created for the same attachment with `connection.session(id)`; it used to stop receiving events without closing.
- Deadlines use the monotonic clock. Fractional budgets are rounded up for APIs that accept only whole milliseconds.
- The root entry point exports the `EventHub`, `Listener` and `WaitOptions` types.
- `ScriptedChrome` answers like Chrome for unknown sessions and targets, and no longer repeats the method and data of a `ProtocolError` that a handler throws.

### Network and environment

- `alignEnvironment()` verifies the viewport on the main frame only, compares locale and timezone in canonical form (`fr-fr` matches `fr-FR`, `Asia/Kolkata` matches Chrome's `Asia/Calcutta`), and compares Accept-Language as ordered language tags without `;q=` weights; `expected` and `actual` keep the raw values.
- `alignEnvironment()` validates `inspect` options before applying anything. If the sample after applying fails or times out, the report is returned with a `verificationError`, an undefined `after` and every requested field `not-tested`; only the caller's `signal` rejects once overrides are applied.
- `diagnoseEnvironment()` spends one `timeout`/`signal` budget across all probes including fonts, detaches font-probe sessions within 1 s, rejects unusable probe options before sampling, and expires with `TimeoutError`. The alignment deadline is a `TimeoutError` too.
- `inspectEnvironment()` throws `StaleElementError` with Chrome's error as `cause` when the document goes away mid-sample.
- `setExtraHeaders()` rejects invalid header names and values with `TypeError` before sending; headers, cache and offline settings are kept only after Chrome accepts them.
- Each step of a new frame session's setup is attempted on its own. Refused Network and Fetch setup is reported through `onError` / `browser.errors`, and a refused environment override no longer costs the session its init scripts. Each `responses` subscription and `enable()` call retries a failed setup.
- A Route answer that Chrome refuses rejects with `ProtocolError` and reopens the route instead of leaving the request paused. Answers and auth replies for a request Chrome no longer holds resolve without reporting an error.
- A refused `route()` or `authenticate()` restores the previous routes or credentials on every session; Network operations skip sessions that close while they run.
- `route()` never reads or changes a RegExp's `lastIndex`; sticky patterns stay anchored at the start of the URL.
- `proxy` accepts `socks4a://` upstreams, which leave hostname resolution to the proxy.

### MCP

- An action that a JS dialog interrupts returns at once with `dialog` and `pending: true`. It keeps the lease and browser queues until it settles (bounded by its timeout and the operation deadline), and reports `action-completed` or `action-failed` in `browser://events`. The pool gives no new allocations to a browser whose input is blocked and closes it once unused.
- A failed follow-up snapshot returns the action result with `snapshotError`. A cancellation or deadline after the action ran reports a `TimeoutError` starting with `Action completed, but`.
- Snapshots stop at 20,000 nodes and report `capped: true`. Password values are masked whatever other attribute values say. Refs are evicted least recently used first.
- `lastInput` in `browser_tabs` carries only `action`, `status`, `events`, `completedSegments` and `cleanup`. Queue changes notify subscribers without `state` events in the log. Resource update notifications are coalesced over 25 ms.
- `browser_network` `clear` reports whether recording is active. Screenshot, select, upload, tab close and storage state honour the operation deadline and cancellation. `browser_upload` refuses names leaving its directory before touching the file system and hides host paths in errors.
- `browser_handoff` takes its first round through the operation queue, and a refused or expired handoff no longer sends the next click to a background tab.
- HTTP: `DELETE /leases/{id}` answers 500 when a release fails (cause through `onError`) and 404 for unknown leases. A failed body read keeps its cause. A failed `startBrowserMcpHttpServer()` closes only a manager it created. Closing continues past failures. Requests without a port are checked as port 80. Closing leases do not count against `maxLeases`. A failed compatibility initialize frees its session slot.
- The manager and pool close every browser even when one fails, and a browser that fails to close no longer keeps its pool slot. Socket options and paths are validated before connecting or creating the temporary directory, and handshake errors keep their `cause`.
- SDK transports are wrapped by an explicit decorator instead of being patched in place.

### Tooling

- Releases are published by a separate job that alone can request the npm OIDC token. It installs no dependencies and publishes, with `--ignore-scripts`, the tarball that the verification job built and tested.
- The release gate depends only on the regression and platform workflows on the tagged commit. It ignores pull-request runs, and the Chromium preview never blocks a release.
- The platform matrix tests Chrome for Testing one major version behind the current stable release, resolved at run time.
- `@types/node` is pinned to 24.19.2, matching `engines: >=24.22.0`, so type checks no longer accept APIs from later Node.js majors.
- `npm run test:mcp` runs every MCP unit test (`test/unit/mcp-*.test.ts`), including the action and state tests. The test map derives the public API from the package's entry points.
- Soak runs fail when a forbidden command is attempted, and `status.json` is replaced atomically. `bench:compare` reports `coldStart` and `coldStartMasked`. The unused `example` script is removed.

## 0.6.1 — 2026-11-01

- Unconfirmed composition cancellation blocks only its top-level page and child frames when all other cleanup and replies have settled and no managed keys/buttons remain held. Other pages keep using the connection. Only destruction of that top-level target clears its block; unknown ownership and other cleanup failures retain connection-wide blocking.
- Managed held keys and mouse buttons are tracked per top-level page: an acknowledged release through any attachment or destruction of the page clears the hold, avoiding unnecessary connection-wide blocking.
- `Keyboard.compose()` and input scopes accept `pageEvents: false`, which sends no `*.enable` command. Navigation then stops input only through the caller's signal; compositions still check focus and document before every step.
- Composition focus probes run in an isolated world instead of the page's main world, and no longer send `DOM.getDocument`, which implicitly enabled the DOM domain. `compose()` and input scope `run()` accept `executionContextId` to use the caller's own context.
- Composition requires an editable focus. The first `update()` fails with an `ActionabilityError` cause before any composition command unless the focus is a writable text input or textarea, or contenteditable content. Previously such a composition reported `completed` without inserting text.
- Composition follows focus into closed shadow roots, so a focus change between two inputs of one closed root is detected, and checks contenteditable content by its editing host. Focus in a cross-origin frame has unknown editability: composition proceeds and the report trace records `compositionFocusUnknown`.
- `PresentationLease` accepts `screencast` parameters (`format`, `quality`, `maxWidth`, `maxHeight`, `everyNthFrame`) for `Page.startScreencast`.
- Timeouts, durations and input `wait()` reject values above 2147483647 ms instead of firing after 1 ms.
- Starting a presentation lease on an ended session keeps the session's end reason as `cause`. Add `Session.closeReason` and `Connection.closeReason`.
- `keyDefinition()` rejects `Object.prototype` names such as `toString` instead of returning inherited functions.
- `handleSignals: true` re-raises SIGINT/SIGTERM after closing the owned Chrome when no other handler is registered, so the host terminates as it would by default.
- A failed `close()` of an owned browser can be retried; launch cleanup failures no longer replace the original startup error.
- `BrowserContext.close()` stops its proxy forwarder even when `Target.disposeBrowserContext` fails. A tab whose initialization fails is detached from Chrome.
- `Tab.addInitScript()` removes the script again when registration fails.
- MCP: the legacy transport answers `ping` during initialization; `POST /leases` answers 503 instead of 429 for non-capacity failures; idle sweeps no longer overlap.
- `nodriver-mcp` rejects an option whose value is missing, `--port` without the HTTP transport and `--socket-path` without the socket transport.

## 0.6.0 — 2026-10-30

- Apply one input deadline and cancellation signal to queueing, preparation and each effective CDP command. Expose prompt interruption snapshots and `InputActionError.cleanup`, with an independent cleanup budget and blocked input after unconfirmed cleanup. Inputs are never replayed.
- Element action preparation failures also use `InputActionError`; inspect `cause` for the original timeout, cancellation or actionability error.
- High-level input watches the target frame and its ancestors; unrelated iframe navigation or removal does not interrupt the action.
- Add explicit `Keyboard.compose()` with UTF-16 selections, update/commit/cancel, focus and document checks, and at most one commit attempt. Ordinary `type()` keeps its existing behavior.
- Add `Browser.inputScope()` and `createInputScope()` for raw target sessions, sharing the connection's Tab input queue, step budgets and guards, reverse-order resource release and structured partial results.
- Add bounded `Browser.presentationLease()` for background raw target presentation with frame, byte, duration and ACK limits, explicit stop cleanup and disconnect-aware reports. It never activates targets, enables Runtime or replays input.
- Presentation leases are exclusive per session, process frames received during startup, separate lease state from cleanup state, and freeze the final report with outstanding ACK counts when cleanup reaches its deadline.

## 0.5.0 — 2026-10-25

- Add event-driven `Connection.drain()` and `Browser.drain()` for pending requests, late replies and library attachment cleanup. Resolve only while connected and drained; reject distinctly on disconnect, timeout or abort. Drain never replays input.
- Add `getStartupDiagnostics(error)` with startup stage, total/stage elapsed time and available PID, exit status and bounded stderr, captured before failure cleanup. Preserve error types and caller cancellation identity. Plain detached stderr remains explicitly marked as discarded; supervised detached mode captures it.
- Add opt-in payload-free `observe.onPerformance` for connection queue, serialization, response wait, JSON parse, synchronous dispatch timings and UTF-8 message sizes, without another JSON parse.
- Add opt-in `supervised: true` with detached WebSocket launch: Windows Job Object or macOS/Linux process-group helper supervises Chrome until explicit release, retaining at most 16 KiB stderr before handoff. `ReleaseUncertainError` reports lost commit acknowledgements without killing potentially released browsers.

## 0.4.2 — 2026-10-24

- Maintenance release with CI and test-suite changes only; the API is the same as in 0.4.1.

## 0.4.1 — 2026-10-23

- Add payload-free `observe.onResponse` with correlated CDP request IDs and late-response status, plus `Connection.unansweredCount` for send attempts still awaiting replies after cancellation, timeout or session end. Existing `onSettle`, trace and `pendingCount` semantics are unchanged. See [raw sessions](docs/raw-sessions.md) for cleanup and disconnection boundaries.

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
