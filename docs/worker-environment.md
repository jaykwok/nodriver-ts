# Worker startup environment benchmark

[简体中文](zh-CN/worker-environment.md)

This benchmark compares ways of applying a UA, language and timezone to every execution context, from startup flags to configuring paused targets over CDP. It uses only temporary browsers and local fixture pages, and is separate from the library: `Browser.launch()`, `maskHeadless` and target attachment do not use these strategies.

## Reproduce

```sh
npm run bench:worker-environment
```

Node.js 24.22.0 or newer and an installed Chromium browser are required. `CHROME_PATH` selects an executable. The default runs the six configurations below over WebSocket and Pipe, writing `test-results/worker-environment.json` and compact progress lines to stdout.

| Variable                  | Default / meaning                                            |
| ------------------------- | ------------------------------------------------------------ |
| `WORKER_AUDIT_VARIANTS`   | All six variants; comma-separated names from the table below |
| `WORKER_AUDIT_TRANSPORTS` | `websocket,pipe`                                             |
| `WORKER_AUDIT_REPEATS`    | `1`, allowed range 1–5                                       |
| `WORKER_AUDIT_HEADFUL`    | `1` selects headful; otherwise headless                      |
| `WORKER_AUDIT_REPORT`     | Output JSON path                                             |

The stable Windows/Linux and Beta/Dev/Canary workflows collect the Pipe matrix and upload the report. Collection failures fail the job; configuration differences are recorded in the report, not treated as failures.

## What is measured

The first statement of the same fixture script captures UA, languages, Intl locale/timezone and low-entropy UA-CH. It runs in seven contexts: main document, same-process frame, OOPIF, Dedicated Worker, nested Dedicated Worker, Shared Worker and Service Worker. High-entropy UA-CH is collected asynchronously and labelled separately. The server records each document/worker's initial request and subsequent sample POST, including UA, Accept-Language and available Client Hints.

| Variant                 | Configuration                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `native`                | Discover-only CDP connection; native environment                                                                               |
| `launch-flags`          | Startup `--user-agent` and `--lang` only                                                                                       |
| `paused-overrides`      | Browser/child auto-attach, then UA/CH, timezone and Locale commands before resume; create the page directly at its fixture URL |
| `combined`              | Both startup flags and paused overrides; direct URL creation                                                                   |
| `prepared-navigation`   | Combined configuration, but create a blank page, finish configuration, then issue `Page.navigate`                              |
| `prepared-locale-check` | Prepared navigation; read the effective Locale on the blank page and Workers before deciding whether to request an override    |

The marker UA and Client Hints are intentionally synthetic test values. They are not a proposed device identity. `native` is not a no-CDP or physical-input baseline; use the [differential audit](differential-audit.md) for those controls.

The JSON keeps command results, first-script observations, requested-value comparisons, cross-context comparisons and request headers separately. A successful command does not suppress a mismatch. Missing contexts/requests, unexpected intrusive commands, duplicate preparation, failure to resume, or incomplete connection cleanup fail collection. A command rejection such as a Locale ownership conflict is recorded explicitly. A successful exit means collection completed, not that every override worked.

Languages such as `zh-CN` and `en-US` are ordinary user preferences, not automation indicators. No particular language is required. `matchesFirstScriptLanguages` compares ordered ranges case-insensitively and the progress counter is named `languageHeaderDifferences`; these are observations, not failures. [Chromium expands language lists](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/http/http_util.h) with language-only fallbacks, and header weights and preference lists need not exactly equal `navigator.languages`. Compare against the same browser and configuration's native baseline and the explicitly requested values, not literal equality alone. The library keeps native language defaults.

## Observed behavior

- `native`: sampled fields and UA request headers agree across all contexts.
- `launch-flags`: UA strings and language values agree, but UA-CH keeps Chromium's brands and some high-entropy fields are empty; a UA string alone does not produce matching brands or metadata.
- `paused-overrides`: Shared/Service Worker `navigator.userAgent` keeps the startup UA while their later requests use the override. The main document can run its first statement before configuration finishes even when the attach event reports `waitingForDebugger`, so initial and later requests can differ.
- `combined`: the startup UA removes UA/header mismatches, but direct navigation still exposes early language, Intl and UA-CH differences.
- `prepared-navigation`: requested fields, cross-context values (including high-entropy UA-CH) and UA headers all agree. Initial Service Worker and nested Worker requests use the startup `Accept-Language` list (for example `fr-FR,fr,en-US,en`), later requests the CDP list (`fr-FR,fr`). Each run also gets four Locale command conflicts, because the Locale override is shared per renderer.
- `prepared-locale-check`: reads the Locale already in effect on the blank page and Workers first, and requests an override only where needed. It produces no command errors and the requested first-script fields agree. A paused OOPIF has no default execution context yet, so its override is applied before context creation and checked through its fixture sample.

An `already-observed` Locale result is an observation, not ownership of an override. The check runs extra `Runtime.evaluate` calls before the fixture's first statement, without enabling Runtime events. Missing Worker Client Hints headers are recorded as absent, not filled in to match page requests. Persistent profiles, Service Worker update/restart, already running workers, popups and external browsers are outside this benchmark.

## Constraints for a browser-wide policy

The launcher already supports `userAgent`, `lang`, `windowSize` and `--headless=new`; what differs between strategies is which contexts each setting reaches, and when. CDP identifies Dedicated Workers as `worker`; same-process frames do not each have their own Target. [`Target.setAutoAttach`](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Target.pdl) operates on related targets and may require recursive attachment.

The benchmark assigns Shared/Service Workers to the browser-root attachment and Dedicated Workers/OOPIFs to child attachments; overlapping root and page attachments for the same Service Worker stall preparation. Every observed target is resumed within a bounded preparation step, and the owned browser is closed on failure.

[Chromium's Locale controller](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/inspector/locale_controller.cc) shares renderer state and rejects a second agent claiming an override. A browser-wide policy would have to account for that scope, handle partial application, prepare owned pages before navigation, separate startup-only from dynamic settings, and keep `attach: 'none'` and external-browser behavior unchanged. The library therefore keeps native values by default.
