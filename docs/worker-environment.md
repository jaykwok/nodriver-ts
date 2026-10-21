# Worker startup and network consistency experiment

[简体中文](zh-CN/worker-environment.md)

This capability experiment evaluates startup flags and paused-target configuration before adding a browser-wide environment policy to the library. It uses only temporary browsers and local fixture pages. It does not change `Browser.launch()`, `maskHeadless`, default target attachment, or production Worker handling.

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

The stable Windows/Linux and Beta/Dev/Canary workflows collect the Pipe matrix and upload its raw report. Collection failures fail the job. Observed configuration differences remain in the report rather than being classified as a passing environment configuration.

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

The JSON keeps command results, first-script observations, requested-value comparisons, cross-context comparisons and request headers separately. A successful command does not suppress a mismatch. Missing contexts/requests, unexpected intrusive commands, duplicate preparation, failure to resume, or incomplete connection cleanup fail collection. A command rejection such as a Locale ownership conflict is capability evidence and is retained explicitly. The runner's successful exit means collection completed, not that every override worked.

Languages such as `zh-CN` and `en-US` are ordinary user preferences, not automation indicators. No particular language is required. `matchesFirstScriptLanguages` compares ordered ranges case-insensitively and the progress counter is named `languageHeaderDifferences`; these are observations, not failures. [Chromium expands language lists](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/http/http_util.h) with language-only fallbacks, and header weights and preference lists need not exactly equal `navigator.languages`. Classify a regression against the same browser/configuration's native baseline and the explicitly requested behavior, not literal equality alone. The library keeps native language defaults.

## Local evidence, 2026-10-21

Windows x64, Chrome **156.0.8078.48**, Node **24.22.0**: two headless repetitions of all five variants on both transports (**20 runs, 140 samples**), plus all five variants in headful Pipe (**5 runs, 35 samples**). All runs collected the expected contexts and initial/sample requests, resumed targets, and closed their connections with zero pending requests/listeners. No Runtime/Console/Debugger enable, binding or init-script injection was used.

- `native`: sampled fields and UA request headers agreed across contexts.
- `launch-flags`: UA strings and language values agreed in this Windows test. UA-CH retained Chromium brands and some high-entropy fields were empty; changing the UA string did not produce matching custom brands/metadata.
- `paused-overrides`: Shared/Service Worker `navigator.userAgent` retained the startup UA while their subsequent request headers used the override. The main document could execute its first fixture statement before configuration finished, despite an attachment event reporting `waitingForDebugger`. Initial script requests and later requests could differ.
- `combined`: the startup UA eliminated UA/header mismatches in this fixture, but direct navigation still exposed early language-list, Intl and UA-CH differences.
- `prepared-navigation`: requested synchronous fields, cross-context observations including asynchronous high-entropy values, and UA/header comparisons matched in all five local runs. Initial Service Worker and nested Worker requests used the startup Accept-Language list (`fr-FR,fr,en-US,en`), while subsequent requests used the CDP list (`fr-FR,fr`); q-values remain in the raw headers. This records which configuration reached each request, not a finding that English fallbacks or language-list differences imply automation. Each run also recorded **four Locale command conflicts**; values agreeing does not make those commands successful or establish independent per-target Locale control.

The follow-up `prepared-locale-check` comparison retained `prepared-navigation` as its control. Two headless repetitions on both transports (**eight runs, 56 samples**) and one headful repetition on both (**four runs, 28 samples**) reproduced four Locale ownership conflicts per control run. The new variant recorded zero command errors and the requested first-script fields agreed. All targets resumed and connection cleanup completed. The initial attempt to read Locale on a paused OOPIF failed because its default execution context did not exist yet; its raw report is retained locally. The revised experiment only reads existing blank-page/Worker contexts, applies the OOPIF override before context creation, and verifies the OOPIF through its fixture sample.

An `already-observed` Locale result is an observation, not ownership of an override. This variant executes additional `Runtime.evaluate` calls before the controlled fixture's first statement, without enabling Runtime events. It does not prove safe execution on arbitrary pages, persistence when another session detaches, or independently configurable Locales in contexts that share a renderer. A rejected command remains an error in the report even if a subsequent read agrees.

These observations describe this fixture/version/host. They do not prove arbitrary target startup, an absence of timing effects, or full HTTP Client Hints equivalence. Missing Worker Client Hints headers are recorded as absent; they are not fabricated to match page requests. Persistent profiles, Service Worker activation/update/restart, previously running workers, popups, external browser ownership and cross-client isolation remain outside this experiment.

## Constraints for a production policy

`userAgent`, `lang`, `windowSize` and unified `--headless=new` already exist in the launcher. The open problem is their measured scope and ordering. CDP identifies Dedicated Workers as `worker`; same-process frames do not each have their own Target. [`Target.setAutoAttach`](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Target.pdl) operates on related targets and may require recursive attachment.

The experiment assigns Shared/Service Workers to the browser-root attachment and Dedicated Workers/OOPIFs to child attachments. During development, overlapping root/page Service Worker attachments stalled preparation until the resume watchdog fired. The final fixture avoids that overlap, resumes every observed target within a bounded preparation attempt, and closes its owned browser on failure. These filters are a fixture policy, not a replacement for production ownership checks.

[Chromium's Locale controller](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/inspector/locale_controller.cc) shares renderer state and rejects a second agent claiming an override. A production implementation needs to account for that scope, define behavior on partial application, and verify values without silently treating command errors as success. It must also prepare owned pages before navigation, define startup-only versus dynamic settings, preserve `attach: 'none'`/external-browser behavior, and test Worker persistence and cleanup before enabling a general policy. The native default remains appropriate while these cases are unresolved.
