# Automation audit

[简体中文](zh-CN/automation-audit.md)

By default the library never sends `Runtime.enable` and injects nothing into the page's main world. This removes one common class of CDP detection. It does not hide all signs of browser automation, and it does not promise that any site will let you through.

## Default behaviour

| Check                  | Behaviour                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime.enable         | Never sent automatically for main pages, popups, same-process iframes, nested OOPIFs or reconnects, and never enabled then disabled. The Console and Debugger domains are not enabled either                                                                                                                                                                                                  |
| Finding the main world | `Page.createIsolatedWorld` targets the exact frame; isolated-world Document → `DOM.describeNode` → `DOM.resolveNode` (without executionContextId) yields the main-world object for the same Document                                                                                                                                                                                          |
| objectId validation    | Strict checks of the V8 format, context scope, the isolated world's official ID, isolate identity and the main-world Document's backendNodeId. An incompatible format throws `UnsupportedError`; there is no fallback to enabling Runtime                                                                                                                                                     |
| Context lifecycle      | The cache is bound to the frame, session and document generation, and is invalidated by navigation, BFCache, process swaps, crashes and `setContent`. A vanished context is rediscovered on the next call; the current user script is not replayed                                                                                                                                            |
| Temporary objects      | Objects created during discovery are released by objectGroup in `finally`, and cleanup is still attempted after the caller cancels                                                                                                                                                                                                                                                            |
| Main-world injection   | No `Runtime.addBinding`, postMessage channel, inserted script or library global, and no fixed sourceURL. Explicit user evaluate/addInitScript calls keep their own semantics; init scripts use a random world name per tab                                                                                                                                                                    |
| DOM helpers            | Queries and action checks run in a randomly named isolated world without requesting universal cross-origin access                                                                                                                                                                                                                                                                             |
| navigator.webdriver    | Turned off with Chromium's AutomationControlled launch switch. The getter stays native, and no property is added to navigator                                                                                                                                                                                                                                                                 |
| Headless UA            | `maskHeadless` (opt-in, ignored when `userAgent` is set) uses `Emulation.setUserAgentOverride` on page sessions to remove HeadlessChrome, and attaches the native UA-CH read from `chrome://version` so Client Hints do not disappear. Documents, HTTP request headers and dedicated workers agree; shared and service workers are separate targets and may keep the original value           |
| Protocol surface       | `Network.enable` is sent on demand; routing and authentication use only the Fetch domain. Piercing queries (the default) use `DOM.getDocument` to find closed shadow roots, which makes that session receive DOM structure events                                                                                                                                                             |
| Input                  | In human mode, US-layout characters are sent as keyDown/keyUp pairs (Shift is added for capitals and shifted symbols), and modifiers and keys without text use rawKeyDown. Pointer pressure is 0.5 while pressed and while moving with a button held. The first pointer position is random within 15–85% of the viewport. `Page.bringToFront` is called only when another tab may be in front |
| Browser mechanisms     | The sandbox, site isolation and CSP stay on. Pipe does not listen on a debugging TCP port; WebSocket still supports local and remote connections. The agent preset only disables first-run UI, the search engine choice screen, the crash-restore bubble and background throttling                                                                                                            |

When no context is specified, Chromium wraps a DOM node in the main world of the frame it belongs to; see the [ResolveNode source](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/inspector/resolve_node.cc). [V8's objectId format](https://github.com/v8/v8/blob/main/src/inspector/remote-object-id.cc) is an internal implementation detail that CDP does not promise to keep stable. Evidence is limited to the exact stable and preview versions and suites recorded in [support](support.md).

The independent [Chromium preview workflow](../.github/workflows/chromium-preview.yml) runs Beta, Dev and Canary weekly, on manual dispatch and on PRs changing relevant core/audit files, on Linux/Node.js 24. It records the actual browser version and runs `test:audit`, `test:compat` (main-world discovery, navigation, OOPIF and context invalidation over Pipe and WebSocket), and the differential regression gate. Failures and logs are retained without retry; the workflow is independent of stable release requirements. [The first remote run passed all three channels](https://github.com/jaykwok/nodriver-ts/actions/runs/39541325419). This is evidence for those builds and checks, not for untested browser versions; a preview failure must be investigated without adding a `Runtime.enable` fallback.

AX computation/transfer/parse costs have been measured on 100/1000/10000-button fixtures; see [performance phases](performance-phases.md). The [soak investigation](soak.md) also reproduced Blink memory retention using raw CDP with text edits plus full AX reads; navigation released it, Accessibility.disable did not. These costs do not establish a stable page-visible detection signal. The existing page-owned probes have not found a dedicated direct AX signal under their tested conditions; they do not prove that AX is unobservable. The [local differential audit](differential-audit.md) separates launch flags, endpoint, raw connection, library initialization, overrides and operations, and records the remaining headful/physical/platform limits.

## Regression checks

```sh
npm run test:audit
npm run test:all
```

- `test/integration/runtime.test.ts` captures the real messages passed to `Transport.send` from before the browser starts. It covers both transports, four kinds of frame (including nested OOPIFs), Chinese text input, closed shadow roots, JSHandle, navigation, BFCache, popups and WebSocket reconnection, and asserts that there are zero disabled domains, bindings and automatic init-script commands. As a positive control, a separate browser enables Runtime explicitly, proving that the collector does see those commands and the executionContextCreated/consoleAPICalled events.
- Every integration test, the HTTP/socket/embedded MCP tests and the soak test also assert that no disabled command is sent automatically.
- A probe owned by the page compares main-world globals, element properties, DOM structure and attribute mutations, console functions and the webdriver getter before and after each operation. Queries and input leave none of these traces; in all four kinds of frame, webdriver is false and the getter is native. The page can still observe mouse events, form values and scrolling.
- In Chrome 155, the Error.stack getter is not read even in the positive control with Runtime enabled, and Error.name is read by the console call itself. Protocol commands and events are therefore the primary evidence; an old-style stack probe's result cannot show that CDP detection has been removed.
- `test/integration/stealth.test.ts` pins the UA/UA-CH, pointer pressure and key sequences. Unit tests cover incompatible objectIds, wrong worlds or documents, cleanup of temporary handles, navigation during discovery, and recovery after a context disappears.

## Third-party detectors

### Detectors pinned to a commit

Run on Windows Chrome 155.0.8059.80 and WSLg Chrome for Testing 155.0.8059.79, in four combinations of headful/headless × Pipe/WebSocket, without opening DevTools and without changing the UA, fonts, timezone or network egress. Detector sources were verified by Git blob SHA1, and their detection logic was not modified.

- [rebrowser-bot-detector e1a25b1](https://github.com/rebrowser/rebrowser-bot-detector/tree/e1a25b1ff264cc9a5b5ea7fe8a6dfc26e3b1c718): no positive hits in any of the four Windows combinations. On WSL, the UA check notes that Chrome for Testing's brand list lacks Google Chrome. The exposeFunction check does not apply; the validity of runtimeEnableLeak is limited by the positive-control finding above.
- [Brotector 98b3309](https://github.com/ttlns/brotector/tree/98b330999e9928a226ca0c8254dddf909d1583bd): each combination was run with the crash probe off and on, with a CSP that allows the required same-origin and Blob workers. No detection callback fired, and nothing crashed with the crash probe on.

### Online detection pages

With authorization, the live detection pages of CreepJS, BrowserScan and Pixelscan were visited on Windows Chrome 155.0.8059.80 / Pipe. Each cell used a new temporary profile, with no request interception, no UA or environment overrides, and no proxy or WebRTC restrictions. These historical results used native UA values, so the headless column reflects the native HeadlessChrome UA.

| Check                                       | Headful, instant       | Headless, instant   | Headful, human (seed=42) |
| ------------------------------------------- | ---------------------- | ------------------- | ------------------------ |
| CreepJS: like-headless / headless / stealth | 19% / 0% / 0%          | 25% / 67% / 0%      | 19% / 0% / 0%            |
| BrowserScan                                 | Normal                 | Robot               | Normal                   |
| Pixelscan: Bot check                        | No automation reported | Automation reported | No automation reported   |
| Pixelscan: fingerprint consistency          | inconsistent           | inconsistent        | inconsistent             |

- On WSLg Linux (with unauthorized third-party subrequests blocked) the conclusions were the same: headless was Robot and reported as automated, and headful was Normal. CreepJS like-headless was 44% headful and 50% headless.
- Pixelscan also showed Timezone spoofed and Proxy detected. The native JS timezone differed from the timezone the site inferred from the egress address; these labels do not mean the library spoofed the environment.
- The human column produced 9/8/7/4 events for two moves and two scrolls (instant produced 1 each), and the verdicts did not change. There was no click or typing detection and no physical-input control, and pages may cache their first verdict, so this neither shows that the human policy works nor that it does not.
- In all nine cells, zero forbidden protocol commands were sent, webdriver was false, and every temporary profile was cleaned up. CreepJS scores are not detection probabilities.

Third-party sources, raw results, screenshots and egress addresses are kept locally by the maintainer and are not part of the repository or the package.

## Signals that remain observable

1. **Headless**: `maskHeadless` changes only the UA and UA-CH. Other headless signals such as the screen size (for example 800×600) are unchanged, and headful mode does not hide every signal either. Headful mode is recommended; without a graphical desktop, choose headless explicitly — there is no automatic fallback.
2. **Execution world**: `evaluate()` runs in the main world by default so that it can reach the page's own objects, which means the page can hook its own methods. For generic DOM reads use `query()` or `evaluate(fn, arg, { world: 'isolated' })`; isolated worlds still share the DOM.
3. **Environment consistency**: the UA, Client Hints, language, timezone, screen, fonts, GPU, worker values and proxy egress each need to be measured. Headful mode keeps the browser's original values; headless also keeps native values by default; the optional mask changes only page/Dedicated Worker UA and can disagree with Shared/Service Workers. Changing a single field creates inconsistencies, and `setEnvironment()` does not take care of full worker/device consistency.
4. **Input**: clicks and text are dispatched through CDP Input, and the page can still observe timing and trajectories. DOM value changes such as select dispatch synthetic events. There is no promise that every action looks like input from a physical device.
5. **External factors**: DevTools or other CDP clients that were already attached, domains the caller enables manually, TLS/IP reputation, and proxy and WebRTC egress are outside what the defaults cover. Pipe only reduces exposure of a local debugging port.

## Not covered

Re-running the online detection pages against the current version, side-by-side comparisons with an ordinary physically operated browser or with Python nodriver on the same machine, logins to external services, and long-term adversarial testing.
