# Differential browser audit

[简体中文](zh-CN/differential-audit.md)

`npm run bench:audit` emits JSON to stdout and progress to stderr. Node.js 24.22.0+ and a local Chrome are required. Run on an idle machine when interpreting timing; ordinary CI checks functionality and preserves observations, without timing thresholds or detector scores. `AUDIT_REPEATS` defaults to 2; `AUDIT_TRANSPORTS=websocket,pipe` and `AUDIT_VARIANTS` select the library matrix. `AUDIT_HEADFUL=1` is an explicit opt-in for an idle graphical desktop: the audit creates its own windows and tabs, which can affect focus. It never attaches to personal browsing profiles.

## Attribution and controls

Every run starts with its own empty disposable profile, no extensions, no inherited permissions/cache/Worker registrations, the same viewport request and the same local probes. Profiles are not copied or shared between runs. The only intentional within-run reuse is the Service Worker registration across a controlled reload. Browser process arguments, executable, actual library browser version, OS/runtime, transport, repeat, operation sequence, environment overrides and all CDP requests are recorded. Raw groups use the same executable and record the page's UA/high-entropy version; they do not query CDP for a version.

| Group         | Configuration and collector                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-native      | Chrome launched without a debugging flag or library automation-feature flag. Page self-reports; no CDP client exists. With the default audit settings this is native **headless**, not a physical human/headful baseline. |
| A-matched     | A plus `--disable-blink-features=AutomationControlled`, isolating that launch flag from the debugging endpoint.                                                                                                           |
| B-endpoint    | Matched flags plus a loopback debugging endpoint; no client connects.                                                                                                                                                     |
| C-raw         | Same as B, then a browser WebSocket opens without sending any CDP command. Both C and its B control receive the same sampling delay.                                                                                      |
| D-attached    | Sample an already loaded page, initialize `Browser.connect`, sample that same document, disconnect, and sample again. No navigation or input occurs between these three observations.                                     |
| D-initialized | Full `Browser.launch`, not merely a connection. Initialization is recorded before opening the test page; explicit masking includes its temporary `chrome://version` probe and overrides.                                  |
| E-operations  | Separate DOM read, full AX read, fill/click, wheel, background-tab and navigation phases, with page-owned sampling after each operation.                                                                                  |

Raw groups are WebSocket controls. Pipe has no equivalent of an unconnected TCP endpoint, and is not presented as an identical B/C control. D creates an initial blank tab and then the fixture tab, closes the initial tab and measures with one fixture tab; raw Chrome starts directly at that URL. The startup history therefore differs. Focus/visibility, screen/viewport and window geometry are reported; OS occlusion, GPU/OS scheduling and physical input are not controlled by the automated matrix. Backgrounding one of the audit's own tabs is distinct from OS occlusion and from headless mode.

## Shared probes and interpretation

The exact page script runs in every group. It collects navigator fields, low/high-entropy Client Hints, navigator/window/chrome descriptors, global names, a bounded mutation/event log, explicit form/click/scroll results, visibility/focus/lifecycle events and distributions of interval/rAF samples. Expected DOM changes are separate from extra mutations and descriptor/global differences. Sampling windows reset after each phase; `background-start` separates tab-switch transition from the following background window. Small samples, absent rAF callbacks and scheduler noise are observations, not detection verdicts.

The same script creates Dedicated and Shared Workers, registers/activates/claims a scoped Service Worker, reloads with that existing registration, then unregisters it and closes worker resources. Each context reports its native navigator and makes a request to the same loopback receiver. Worker creation, registration, local requests, MutationObserver, timers, rAF and JSON serialization all have costs; every group bears those costs. No native getters are patched and no code is injected into unrelated Workers. Service Worker code does not intercept requests.

Workers are sampled again after **every** operation, using response IDs to exclude late responses from a previous phase. HTTP records and navigator comparisons are matched by run, context, phase and document lifecycle. They are not reused from the initial sample. The attached group provides a same-document WebSocket initialization control.

Values distinguish `observed`, `unsupported`, `unavailable` and `not-observed`. Worker-only missing APIs are not required to equal Window APIs. The loopback origin is a secure context; JavaScript Client Hints availability and high-entropy promises are recorded separately from HTTP hints, which depend on request type and Accept-CH negotiation. A missing request hint is `not-observed`, not a claim that the corresponding JS field is unsupported. Requests and request-vs-navigator summaries preserve these differences.

Domain records include session IDs and actual enable/disable commands, plus `DOM.getDocument` because it starts DOM structure events. The default operations send only Page.enable and DOM.getDocument; other APIs enable CSS, Network or Accessibility on demand. Closing owned sessions/processes cleans up this run; the tool never blindly disables a domain used by another caller. Modern discovery and Main World objectId validation are covered separately by the audit/compat suites.

Font diagnostics enable DOM/CSS only on temporary independent target sessions and detach them afterward, so a caller-owned CSS subscription keeps receiving stylesheet events. The audit has a separate explicit fonts phase, reported apart from the basic-operation domain records.

## Regression gate

JSON schema version 2 includes `validation.passed`, the number of checks, failures with run/phase/criterion, and explicitly allowed exceptions. The command exits nonzero when required raw/attached controls or operation samples are missing, a Worker fails to report, native fields diverge, descriptors/globals change, an unexpected DOM mutation occurs, a context's HTTP UA differs from its own navigator, Service Worker control is lost, or scoped cleanup fails. Own navigator properties are checked as well as prototype descriptors.

Opt-in UA/locale/timezone differences are bounded: Worker values must match either their native control or the explicitly overridden document. This exception cannot excuse an unrelated field change or an arbitrary new value. Timing, display geometry, focus and visibility remain observations, not equality gates. `test/unit/audit-checks.test.ts` corrupts valid reports to exercise these failures, including missing samples, injections, wrong headers and failed cleanup. A passing report means these probes found no regression, not that the browser is undetectable.

## Findings

- **Native defaults are consistent.** With native UA values, comparable fields agree between the document and every Worker type, and each context's HTTP UA matches its own navigator. Relative to the matched raw controls, the library adds no navigator/window/chrome descriptor or global-name differences, and attaching to an already loaded page changes none of the sampled fields.
- **`maskHeadless: true` creates a cross-context contradiction.** The page and Dedicated Workers (and their requests) report Chrome, while Shared/Service Workers and their requests keep HeadlessChrome. This is why `maskHeadless` defaults to `false`; the library does not patch Workers.
- **Explicit UA, locale and timezone overrides do not reach every Worker.** Dedicated Workers inherit the UA but keep native language values; Shared/Service Workers keep native UA, language and Client Hints. HTTP headers follow each context's own UA.
- **Background tabs are throttled.** A tab pushed to the background by another tab reports hidden/unfocused, receives no rAF callbacks and runs 1 s intervals at roughly 1 s, with or without the `agent` preset's background flags. This describes tab backgrounding, not OS window occlusion.

## Physical/manual collection

Run `npm run bench:audit:manual` and keep the collector terminal open. It creates only a local service, prints a URL and never creates a browser, CDP connection or input. Launch Chrome yourself with a newly created empty disposable `--user-data-dir` and that URL, with **no debugging flags**, no extensions or personal profile. Record the full command, Chrome/OS version, display, window arrangement and focus alongside the JSON.

Use a physical keyboard/mouse to fill/click/scroll; use the page's Record button for repeated samples, reload once for the existing Service Worker stage, then compare foreground, background and genuinely covered windows manually. Keep those conditions separate. Check the attestation only if physical devices were used, then click Finish. The collector unregisters its own Worker and writes `test-results/audit-manual.json`; close this Chrome and remove only its disposable profile. Attestation is not independently verified, and CDP-generated or script events do not count as a physical baseline.

The Linux push CI runs a reduced native/masked/explicit-environment audit with these regression assertions and JSON artifacts. The Beta/Dev/Canary workflow runs the same gate alongside strict objectId and lifecycle suites. CI does not replace an idle-machine benchmark or physical/manual collection.
