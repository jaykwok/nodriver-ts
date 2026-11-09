# Native launch environment

[简体中文](zh-CN/native-environment.md)

`Browser.launch({ nativeEnvironment: { timezone: 'Europe/Paris', locale: 'fr-FR' } })` sets the timezone and language of the Chrome process on Linux before it starts. Only the child process receives `TZ`, `LANG`, `LC_ALL` and `LANGUAGE`; the environment of the Node host is unchanged. Chrome also receives `--lang` and the profile preferences `intl.accept_languages` and `intl.selected_languages`. Documents and Dedicated, Shared and Service Workers inherit the same process defaults from their first script. Nothing is emulated per target, and no getters, prototypes, Worker scripts or `Function.prototype.toString` are patched. Canvas, WebGL and Audio keep their native output; there is no fingerprint seed or synthetic noise.

## Requirements

- **Host**: Linux, with the zone in `/usr/share/zoneinfo` and the UTF-8 locale installed (see `locale -a`). `timezone` is an IANA name and is used as given. `locale` is a language-region tag such as `fr-FR`, which the process uses as `fr_FR.UTF-8`.
- **Profile**: a temporary profile, or a `userDataDir` that holds nothing from earlier launches. The preferences are written after `prepareProfile` returns. That profile is no longer empty afterwards, so a later launch of it with a native environment is refused; a launch without one keeps the languages stored in the profile, but not the process timezone and locale.
- **Pages**: `attach: 'none'` is refused, because the startup check needs a page.
- **One source per setting**: `maskHeadless`, `lang`, `--lang` or `--accept-lang` in `args`, and `TZ`, `LANG`, `LANGUAGE`, `LC_ALL` or `LC_MESSAGES` in `env` are refused. `nativeEnvironment` and `autoAlignEnv` exclude each other.

Invalid options are rejected before any request is sent or process started, and missing host data before Chrome starts.

## Startup check

Before `launch()` returns, a page that the library serves on loopback samples the timezone, the Intl locale, `navigator.language` and `navigator.languages` in its document and in a Dedicated, a Shared and a Service Worker:

- The timezone is the requested zone, or a name for the same zone.
- `navigator.language`, the first entry of `navigator.languages` and the first `Accept-Language` tag of the page request are the requested locale, and every context reports the same `navigator.languages`.
- Chrome resolves the Intl locale to a UI language it ships, which can be the language without its region (`fr` for `fr-FR`). It has the requested language, and every context reports the same one.

A missing sample, a mismatch or a timeout rejects the launch and closes the browser it started. The check shares the launch deadline and runs scripts only in its own page. It ends its Workers and closes its page and HTTP server, and `storageState()` and `clearSiteData()` do not visit its origin. Its failures report the `environment-configuration` [startup stage](startup-diagnostics.md).

The check covers the executable and host of this launch. A later override, such as `tab.setEnvironment()`, an external CDP client or an extension, can change what pages report. `tab.setEnvironment()` overrides values per tab through CDP and does not change the process defaults.

## Timezone through a proxy

`autoAlignEnv` looks up the timezone through the browser's proxy before launch. The caller names the lookup service and the language:

```ts
await using forward = await ProxyForwarder.create('socks5h://user:password@proxy.example:1080');
await using browser = await Browser.launch({
  proxyServer: forward.url,
  autoAlignEnv: { endpoint: 'https://your-geo-service.example/json', locale: 'fr-FR' },
  webRtcIPHandlingPolicy: 'disable_non_proxied_udp',
});
```

- **Endpoint**: an `http:` or `https:` URL without credentials or fragment, returning `{ "timezone": "Europe/Paris" }`. No service is built in.
- **Proxy**: `proxyServer` is one `http://` or `https://` proxy URL without credentials, and `proxyBypassList` and other `--proxy-` arguments are refused. Wrap SOCKS proxies and proxies that need credentials in `ProxyForwarder`, and keep it open for the browser's lifetime.
- **Request**: it goes only through that proxy, which also resolves the destination, with no direct fallback. A redirect, a status other than 200, malformed JSON, a reply over 64 KiB, the deadline and cancellation stop the launch. Within `launch()`, the lookup shares the launch deadline.
- **Without launching**: `resolveProxyEnvironment(proxyURL, options, { timeout, signal })` runs the same lookup, with a 10 s default timeout, and returns `{ timezone, locale }`.
- **Language and location**: an IP address does not tell a person's language, so `locale` is always given by the caller, and no geolocation is derived.

The settings apply to the launched process: contexts that `newContext()` creates with their own `proxy` share the launch timezone, and `Browser.connect()` does not apply them.
