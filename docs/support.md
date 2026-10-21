# Support

[简体中文](zh-CN/support.md)

Version 0.4 requires Node.js 24.22.0 or newer for package use, development and tests. See the [migration guide](migration-0.4.md). Earlier release records below describe historical verification, not the current runtime support policy.

## Runtime environment

During 0.4 development, local checks ran on 2026-10-21 with Windows x64, Chrome 155.0.8059.85 and Node.js 24.22.0: the full run passed 95 unit tests, 107 integration tests and built-package acceptance. Pi's actual client/native extension operation flows also passed on Node.js 24.22.0. Separate headless and headful differential matrices passed 13,878 and 7,768 assertions. See [local differential audit](differential-audit.md), [performance phases](performance-phases.md), [generic compatibility](agent-compatibility.md) and [Pi 1.3.0](pi.md) for evidence boundaries.

[Merged-main regression](https://github.com/jaykwok/nodriver-ts/actions/runs/39565019989) passed Windows/Linux source suites and built-package checks, plus the exact Node.js 24.22.0 minimum. The [Worker experiment preview run](https://github.com/jaykwok/nodriver-ts/actions/runs/39563343110) passed on Beta 157.0.8103.6, Dev 158.0.8106.0 and Canary 158.0.8114.0; its artifacts include all six configurations. See [Worker evidence](worker-environment.md) for limits. These links identify tested commits, not future channel builds or a full new platform certification. One earlier Windows push run timed out waiting for a released Chrome process to exit; the same commit's PR run and merged-main run passed. That intermittent failure remains recorded and is not claimed fixed.

- **Runtime**: the package, development tools and tests require Node.js ≥ 24.22.0. Tests use `node:test` and `expect`, with TypeScript sources run directly. CI checks current Node.js 24 on Windows/Ubuntu and the minimum 24.22.0 release against the built package. npm is the package manager.
- **Browser**: a locally installed Chrome, Chromium or Edge. Common install locations on Windows, macOS and Linux, and `PATH`, are detected automatically; `CHROME_PATH` or `executablePath` can also be set.
- **Protocol**: CDP types are pinned to devtools-protocol 0.0.1718299; MCP 2026-07-28 is the default, with opt-in [2025-era compatibility](agent-compatibility.md).
- **Linux**: run as a normal user and install the shared libraries Chrome needs (such as libnspr4 and libnss3). The library never adds `--no-sandbox` and never turns off site isolation. Headful mode on WSL needs WSLg or another display server.
- **macOS**: when Chrome runs on macOS, key events carry Chrome's editing commands, so `Meta+A`, `Meta+C/X/V/Z`, `Shift+Meta+Z`, and arrow and delete keys combined with Alt/Meta behave as on a physical keyboard. Cross-platform scripts should select all with `Meta+A` or `Control+A` depending on the platform. GitHub-hosted macOS VMs cannot resolve mDNS (`.local`) host candidates, so local WebRTC stays at ICE `new`; in that environment the platform matrix launches the WebRTC test browser with `--disable-features=WebRtcHideLocalIpsWithMdns`. The project never adds this flag automatically.
- **WebSocket**: uses the JS protocol parser of the pinned npm `ws` 8.22.0, with per-message compression off. It is imported through the package's standard Node ESM entry.

## Verified combinations

The table keeps the Node.js verification records from the 0.1.0 release; test counts are unit / integration / compatibility matrix (WebSocket and Pipe transports). 0.2.0 passed 60 unit tests, 95 integration tests and the build-output tests locally on Windows, Node.js 24.22.0 and Chrome 155.0.8059.85. The current minimum is Node.js 24.22.0.

| Platform and browser                                                          | Runtime         | Result                                                                            |
| ----------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------- |
| Windows 11 x64, Chrome 155.0.8059.80 (local)                                  | Node.js 24.22.0 | 53 / 85 passed; type check, format check and build-output tests passed            |
| WSL2 Ubuntu 26.04, Chrome for Testing 155.0.8059.79 and 154.0.8037.92 (local) | Node.js 24.22.0 | 53 / 85 / 8 + 8 passed; 4 native signal tests and build-output tests passed       |
| GitHub Actions Windows x64, Chrome 155.0.8059.40                              | Node.js 24.21.0 | 53 / 85 passed, integration tests on the first attempt; build-output tests passed |
| GitHub Actions Ubuntu x64, Chrome 155.0.8059.84                               | Node.js 24.22.0 | 53 / 85 passed, integration tests on the first attempt; build-output tests passed |
| GitHub Actions macOS ARM64, Chrome 155.0.8059.40                              | Node.js 24.21.0 | 53 / 85 / 8 passed (for the WebRTC test, see the macOS note above)                |
| GitHub Actions Ubuntu ARM64, Chrome for Testing 155.0.8059.84                 | Node.js 24.22.0 | 53 / 85 / 8 passed                                                                |
| GitHub Actions Ubuntu x64, Chrome for Testing 154.0.8037.92                   | Node.js 24.21.0 | 53 / 85 / 8 passed                                                                |
| GitHub Actions Windows x64, Microsoft Edge 154.0.4258.62                      | Node.js 24.21.0 | 53 / 85 / 8 passed                                                                |

The last four rows come from the on-demand platform matrix (`.github/workflows/platforms.yml`), where each suite runs once without retries; all passed on the first attempt. In push CI, failed integration tests are retried once, and the first failure is recorded in the job summary and the log artifact. Which tests call each public API directly is listed in the [API test map](test-map.md).

Package: after the tarball produced by `npm pack` is installed into an empty project, Node.js 24 can import every entry point, TypeScript 7.0.2 and 5.9.3 type-check it with `skipLibCheck: false` under both `nodenext` and `bundler` resolution, and `npx nodriver-mcp` runs. A 24-hour soak run was completed on Windows with Node.js 24.22.0; see the [soak test](soak.md) for the results.

On supported Node.js versions, callers can use `await using` or manage resources with `try/finally` and `close()`.

Integration tests use only local fixtures. Cross-site OOPIFs are built from 127.0.0.1 and localhost, and the owning session confirms they are real out-of-process frames. The tests enable `--site-per-process` explicitly and turn off no isolation. Proxy tests use local HTTP/SOCKS fixtures, including deliberately fragmented responses.

## Core capabilities

| Capability  | Implementation and coverage                                                                                                                                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol    | Official command parameter tuples, return values and event types; out-of-order responses, session routing, timeouts, AbortSignal, late messages, rejection on disconnect and listener cleanup; Pipe split/coalesced frames, UTF-8, length limits and EOF                                                                                        |
| Lifecycle   | Chrome path detection, temporary/persistent profiles, loopback WebSocket, Pipe, external connections; idempotent close and cleanup after failed launches; on Windows the process tree is terminated, on Linux the separate process group is terminated and awaited before the temporary profile is deleted; external profiles are never deleted |
| Pages       | Create/close, popups, history, redirects, hash/SPA, DOMContentLoaded/load/commit/networkidle, BFCache (including nested frames), renderer crashes and reload, windows, content, resources, PDF                                                                                                                                                  |
| Frames      | Same-process iframes, OOPIFs, nested OOPIFs, recursive attach, moves in and out of process, owning session/context, handle invalidation by document generation                                                                                                                                                                                  |
| DOM         | CSS, XPath, smallest text match, open/closed shadow roots, element scoping; DOM helpers in isolated worlds and user scripts in the main world                                                                                                                                                                                                   |
| Input       | Scrolling, stable/visible/enabled/hit checks, obstruction and parent-iframe hit-testing, transformed quads, hover delivery confirmation; Chinese/emoji, focus and selection, physical keys, file inputs, select/checkbox, pointer drag; optional human policy                                                                                   |
| Evaluation  | Promises, exceptionDetails, top-level special numbers/BigInt/undefined, JSHandle, object release, invalidation on navigation and crashes, no replay of side effects                                                                                                                                                                             |
| State       | Saving and restoring cookies, local/sessionStorage, cookie + localStorage snapshots (including origins of iframes and closed tabs), permissions, isolation across 20 BrowserContexts and subscription cleanup                                                                                                                                   |
| Files       | PNG/JPEG/WebP, full-page and element screenshots, PDF, GUID-named downloads with completion/cancellation, saveAs, uploads                                                                                                                                                                                                                       |
| Network     | Fetch interception/fulfil/fail, authentication, responses and bodies, headers/cache/offline; covers the page and its recursive OOPIF sessions                                                                                                                                                                                                   |
| Proxy       | Direct Chrome proxy, a separate proxy per context, authenticated HTTP(S)/SOCKS upstreams forwarded through proxy-chain                                                                                                                                                                                                                          |
| Environment | Explicit viewport/DPR, timezone, locale, UA and Client Hints, geolocation; structured diagnostics and explicit alignment, see [Environment](environment.md)                                                                                                                                                                                     |
| MCP         | stdio, local HTTP, socket and InMemory share 26 default tools and 3 directory-restricted optional file tools; leases, a managed browser pool, state resources and subscriptions, progress, cancellation and human confirmation, see [MCP](mcp.md)                                                                                               |

## Limitations

- **Browser versions**: stable evidence is listed in the table above; additional preview versions have only the explicitly listed checks. There is no claim of compatibility with every version. Main-world discovery depends on the internal V8 objectId format, validated strictly; an incompatible format fails explicitly instead of falling back to `Runtime.enable`.
- **Detection**: `Runtime.enable` is not sent by default, and AutomationControlled is turned off with the native launch switch. Isolated worlds still share the DOM, and headless signals such as the screen size are still observable. There is no promise to pass any external challenge; see the [automation audit](automation-audit.md).
- **Queries**: XPath does not cross shadow roots, and frame queries never cross frames implicitly. Finding closed shadow roots needs the full DOM, and the cost of high-frequency polling on large pages has not been measured over the long term.
- **State**: snapshots exclude partitioned localStorage of cross-site iframes, sessionStorage, IndexedDB and Service Workers. Third-party partitioned cookies have no dedicated end-to-end test.
- **Geometry and screenshots**: nesting, borders, scrolling, scale/rotate, DPR and parent obstruction are covered; complex CSS perspective, pinch zoom and extreme clipping have no cross-platform matrix. Element screenshots suit axis-aligned elements.
- **Handles**: JSHandle/Element throw once their document is invalidated and are never relocated automatically. Cancelling a user script only stops waiting and does not roll back JS that already ran; an infinite loop in a user script ties up the renderer and needs a protocol execution deadline or closing the page.
- **Injection timing**: pages and popups that are already running get no guarantee that a script runs before their first script. Paused initialization of a new OOPIF has a watchdog; on timeout the page is resumed and an initialization error is reported.
- **Files**: upload and download paths are on the browser's host. When connected to a remote CDP endpoint, you need a shared file system or must transfer files yourself.
- **Input**: a pointer drag is not a full HTML5 DataTransfer or cross-application drag and drop; `insertText` does not simulate an OS IME candidate window or the real clipboard. The human policy is a reproducible programmatic model, not equivalent to physical input.
- **Network**: Fetch routing does not cover the browser's own traffic or separate Service Worker targets. HTTPS proxy certificates, IPv6 and complex DNS egress combinations are handled by proxy-chain, and this project does not cover every combination.
- **Out of scope**: no built-in OpenCV, video encoding, automatic CAPTCHA or challenge handling, or screen layout detection; these can be built with typed CDP, page scripts or external adapters.
- **MCP**: the HTTP service must be enabled explicitly and binds only to loopback; HTTP/socket enforce provisioned tokens and application leases. There is no remote untrusted multi-tenancy, no OAuth, and not every core capability is mapped to a tool. AX snapshots limit the output size, but the full AX tree is still read underneath. When you type and snapshot repeatedly on the same page, Chrome retains a little Blink memory (about 1 KB per iteration, released on navigation); see the [soak test](soak.md).
- **Cleanup**: `await using`, `finally` and optional signal handling cannot guarantee prompt cleanup if the host is force-killed or loses power. Reconnecting never replays operations automatically.

## To be verified

- Other native Linux distributions, Intel macOS and more adjacent Chrome versions.
- 24-hour soak runs on Linux and macOS.
- Comparisons against physical input and a real OS IME, and re-running the online detection pages against the current version.

## Reproducing the checks

```sh
npm ci
npm run check
npm test
npm run test:integration
npm run test:dist
npm run test:compat         # set CHROME_PATH to the Chrome under test
```
