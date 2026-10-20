# Environment sampling, diagnostics and alignment

[简体中文](zh-CN/environment.md)

Three APIs build on each other: `inspectEnvironment()` only reads, `diagnoseEnvironment()` summarizes observations across a whole tab, and `alignEnvironment()` applies an explicit configuration and verifies it. By default nothing rewrites navigator, the UA or device properties, and nothing goes out to the network. The MCP tool `browser_environment` uses the same APIs.

## Sampling: inspectEnvironment

```ts
const report = await tab.inspectEnvironment({ worker: true, webgl: true });
console.log(report.document.userAgent, report.document.userAgentData);
console.log(report.document.screen, report.document.viewport);
console.log(report.worker, report.differences);
```

`Tab.inspectEnvironment()` and `Frame.inspectEnvironment()` read the real environment of the selected document: UA, UA-CH (with high-entropy values when available), platform, languages, hardwareConcurrency, deviceMemory (when available), webdriver, the Intl locale and timezone, screen, and viewport/DPR. The report does not include fonts, IP, WebRTC or a full device fingerprint.

- **Execution world**: an isolated world by default. `{ world: 'main' }` is available for comparison; hooks the page installed in the main world can observe or change the sample.
- **Worker**: `worker: true` creates a temporary Blob dedicated worker that reads the same fields, and `differences` compares the document and the worker field by field (object key order is ignored, array order is kept, and webdriver, which workers lack, is not compared). The worker is terminated and the Blob URL revoked whether it succeeds, fails or times out. When CSP blocks it, `worker.status` is `unavailable`; CSP is never bypassed.
- **WebGL**: `webgl: true` reads the vendor/renderer from a temporary canvas that is never inserted into the DOM, then releases the context. When WebGL is unavailable, an error field is returned.
- **UA-CH**: in an insecure context without UA-CH the field is omitted. Errors from high-entropy values are kept in `highEntropyError`.
- **Deadline**: 5000 ms by default, adjustable with `timeout` and `signal`. Crossing a navigation, a session switch or a document invalidation throws `StaleElementError`; results from different documents are never merged, and there are no retries. Cancellation only stops waiting; a worker that was already created is still cleaned up within the original deadline.

An empty `differences` only means that the compared fields agree. It does not prove the whole environment is consistent.

## Diagnostics: diagnoseEnvironment

```ts
const diagnosis = await tab.diagnoseEnvironment({
  worker: true,
  webgl: true,
  fontSelectors: ['body', 'input'],
  // Network requests happen only when set explicitly; this example is your own same-origin JSON {ip, headers?}
  httpProbe: 'http://127.0.0.1:8080/signals/ip',
  stunServers: [], // an empty array collects only local ICE; omit it to create no peer
});
```

The diagnosis summarizes the documents and workers of every frame in the tab, fonts, WebGL and explicit network probes. The report distinguishes observed / unavailable / not-requested, and match / mismatch / unavailable / not-tested. Items that were not collected do not count as passing.

- **Fonts**: the DOM/CSS domains are enabled explicitly to read the fonts actually used for rendering, as returned by `CSS.getPlatformFontsForNode`. The result is the font the browser picked; it does not guarantee a glyph for every character, and no fonts are installed.
- **HTTP probe**: sent by the page, without credentials and with redirects forbidden, and subject to CSP/CORS and the network. The returned headers are only what the caller's service reflects back.
- **STUN**: only explicitly listed STUN endpoints are used, at most four. No audio/video permission or TURN credentials are requested, and the data channel and peer are closed after a time limit.
- **Address differences**: the HTTP and STUN egress addresses can differ; that alone does not indicate spoofing, a leak or any particular proxy mechanism. When a network call fails, the reason it was not measured is kept.

## Alignment: alignEnvironment

```ts
const aligned = await tab.alignEnvironment({
  environment: { timezone: 'Europe/Paris', viewport: { width: 900, height: 700 } },
  inspect: { worker: true },
});
console.log(aligned.applicationError, aligned.verification);

await tab.alignEnvironment(
  { geoip: { address: 'address obtained by the caller', fields: ['timezone'] } },
  async (address, { signal }) => {
    // A local database or the caller's own resolver; the library makes no third-party GeoIP requests
    return { timezone: 'Europe/Paris', label: 'local database' };
  },
);
```

The report keeps, separately: the current observation, the document baseline before the first override, the requested configuration and the result of applying it to each session, the resolver's return value, and any site labels the caller supplied. There is no full snapshot of native OS values from before the first override; values that come from an external CDP client, extensions or existing browser configuration are recorded as unknown.

- **How it is applied**: timezone, locale, viewport, UA and UA-CH, Accept-Language and geolocation are all set through CDP, with no global getter or prototype patches. The configuration applies to the current page sessions and those attached later; it does not retroactively change scripts or network connections the page already has.
- **GeoIP**: only the timezone/geolocation fields selected in `fields` are applied, and an explicit `environment` takes precedence. Brand, UA-CH, hardware, precise location and language are never derived from an IP. The resolver receives a cancellation signal and the remaining deadline; the host is responsible for cancelling its external work.
- **Accept-Language on its own**: the current UA and any available UA-CH are kept; no other brand identity is generated.
- **Verification**: the document of each frame and a freshly created dedicated worker are verified separately. Fields that workers do not support (such as viewport) are recorded as unavailable, and real disagreements as mismatch. The locale is set only on the page's root session, so Intl is not guaranteed to agree in every renderer/worker. UA-CH is compared by the configured fields; when high-entropy values are unavailable, success is not faked. Geolocation is never granted automatically; the location is read for verification only if permission is already granted, otherwise it is unavailable.
- **Partial failure**: `applicationError`, the session records and the actual report are kept. There is no claim of atomic rollback.

`setEnvironment()` is the explicit override API without verification. Overrides of the UA, Client Hints, timezone and so on are not guaranteed to reach every Worker, SharedWorker or Service Worker. Headful mode keeps the real values by default; headless by default only changes HeadlessChrome to Chrome in the UA/UA-CH (`maskHeadless: false` turns this off). See the [automation audit](automation-audit.md).

An MCP host can configure `httpProbe`/`stunServers` in `BrowserSessionManagerOptions.environmentDiagnostics` and inject a `geoIPResolver`. Tools can only choose whether to use this configuration; they cannot pass arbitrary probe URLs.

## Proxies and WebRTC

`proxyServer` on `launch` / `newContext` is passed straight to Chrome. `proxy` goes through a local forwarder and supports authenticated HTTP(S)/SOCKS upstreams. The diagnosis report only records whether a proxy is configured and never outputs proxy credentials; for external connections the routing source is recorded as unknown.

`Browser.launch({ webRtcIPHandlingPolicy })` sets the WebRTC routing policy explicitly. Values are `default`, `default_public_interface_only`, `default_public_and_private_interfaces` and `disable_non_proxied_udp`. The library writes the `webrtc.ip_handling_policy` preference only for its own temporary profiles, and passes the launch switch. Persistent profiles are configured by their owners; the library refuses to write the preference for them. With the launch switch alone, Chrome 155 still produces UDP candidates, so the preference and the switch are set together. Tests verify that under `disable_non_proxied_udp` local ICE has no UDP candidates, and that the default policy completes a native data channel.

This policy can reduce direct connectivity and media availability, so it is off by default. It does not turn off WebRTC as a whole, and it does not guarantee that HTTP and WebRTC share the same public egress. For the definitions, see [Chromium's WebRTC preference](https://chromium.googlesource.com/chromium/src/+/fdaf45e57c902c85d3ff281fe5a56677e6f9b7fa%5E%21/). The library does not rewrite the profile's exit_type/exited_cleanly, so real crashes are not masked.

## Tests

```sh
npm run test:compat    # set CHROME_PATH to the Chrome under test
npm run test:signals   # rendered fonts, local HTTP address and WebRTC data channel
```

| Variable                                   | Effect                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `NODRIVER_HEADFUL=1`                       | Run headful (Linux needs a desktop, X or WSLg)                    |
| `NODRIVER_CHURN_CYCLES=100`                | Number of stress cycles; routine regression runs 12 per transport |
| `NODRIVER_ENV_REPORT=/absolute/path.jsonl` | Append raw environment observations, one JSON object per line     |

The compatibility tests cover main/isolated evaluation in main pages, same-process iframes, and cross-site and nested OOPIFs, plus workers, Chinese text input, popups, navigation/BFCache, external reconnects and the protocol positive control. The stress loop repeatedly creates and removes iframes, and creates and closes contexts with BFCache history, checking that the frame/session maps, listeners, initialization tasks and pending requests return to their baseline. Every default path asserts zero disabled commands; the positive control enables Runtime explicitly in a separate browser. When an ordinary worker starts, its helper target session is only briefly resumed and then detached; the Runtime domain is not enabled.

The signal tests cover the fonts actually rendered for Latin letters, Chinese and emoji in all four kinds of frame, and a Chinese/emoji round trip over a local two-peer WebRTC data channel without STUN. Different systems pick different fonts (for example Arial, Microsoft YaHei and Segoe UI Emoji on Windows, and DejaVu Sans on WSL); this reflects differences in installed system fonts.

Verified platforms and versions are listed in [Support](support.md).
