# 原生启动环境

[English](../native-environment.md)

`Browser.launch({ nativeEnvironment: { timezone: 'Europe/Paris', locale: 'fr-FR' } })` 在 Linux 上于 Chrome 启动前设置其进程的时区和语言。只有子进程接收 `TZ`、`LANG`、`LC_ALL` 和 `LANGUAGE`，Node 宿主的环境保持不变。Chrome 还会收到 `--lang` 以及 Profile 偏好 `intl.accept_languages` 和 `intl.selected_languages`。主文档和 Dedicated、Shared、Service Worker 从第一段脚本起继承同一组进程默认值。不按 target 模拟任何值，也不改写 getter、原型、Worker 脚本或 `Function.prototype.toString`。Canvas、WebGL 和 Audio 保持原生输出，没有指纹种子，也没有合成噪声。

## 要求

- **宿主**：Linux，`/usr/share/zoneinfo` 中有该时区，并已安装对应的 UTF-8 locale（见 `locale -a`）。`timezone` 是 IANA 名称，按原样使用。`locale` 是语言-地区标签，例如 `fr-FR`，进程以 `fr_FR.UTF-8` 的形式使用它。
- **Profile**：临时 Profile，或不含任何早先启动数据的 `userDataDir`。偏好在 `prepareProfile` 返回之后写入。此后该 Profile 不再为空，所以之后再以原生环境启动它会被拒绝；不带原生环境启动时，Profile 中保存的语言仍然有效，但进程的时区和 locale 不再设置。
- **页面**：拒绝 `attach: 'none'`，因为启动检查需要一个页面。
- **每项设置只有一个来源**：拒绝 `maskHeadless`、`lang`、`args` 中的 `--lang` 或 `--accept-lang`，以及 `env` 中的 `TZ`、`LANG`、`LANGUAGE`、`LC_ALL` 或 `LC_MESSAGES`。`nativeEnvironment` 与 `autoAlignEnv` 互斥。

无效的选项会在发出任何请求、启动任何进程之前被拒绝；缺少宿主数据会在 Chrome 启动之前被拒绝。

## 启动检查

`launch()` 返回之前，库在回环地址上提供的页面会在其主文档以及一个 Dedicated、一个 Shared 和一个 Service Worker 中采集时区、Intl locale、`navigator.language` 和 `navigator.languages`：

- 时区是所请求的时区，或同一时区的另一个名称。
- `navigator.language`、`navigator.languages` 的第一项以及页面请求的第一个 `Accept-Language` 标签都是所请求的 locale，且每个上下文报告的 `navigator.languages` 相同。
- Chrome 会把 Intl locale 解析为它自带的某种界面语言，可能是去掉地区的语言（`fr-FR` 解析为 `fr`）。其语言须与请求一致，且每个上下文报告的值相同。

缺少样本、不一致或超时都会拒绝本次启动，并关闭它启动的浏览器。检查与启动共用同一期限，脚本只在它自己的页面中运行。检查结束时会终止其 Worker、关闭其页面和 HTTP 服务，`storageState()` 和 `clearSiteData()` 也不会访问它的源。检查失败时报告的[启动阶段](startup-diagnostics.md)为 `environment-configuration`。

检查只针对本次启动的可执行文件和宿主。之后的覆盖，例如 `tab.setEnvironment()`、外部 CDP 客户端或扩展，可能改变页面报告的值。`tab.setEnvironment()` 通过 CDP 按标签页覆盖取值，不改变进程默认值。

## 通过代理确定时区

`autoAlignEnv` 在启动前通过浏览器的代理查询时区。调用方须指定查询服务和语言：

```ts
await using forward = await ProxyForwarder.create('socks5h://user:password@proxy.example:1080');
await using browser = await Browser.launch({
  proxyServer: forward.url,
  autoAlignEnv: { endpoint: 'https://your-geo-service.example/json', locale: 'fr-FR' },
  webRtcIPHandlingPolicy: 'disable_non_proxied_udp',
});
```

- **端点**：不含凭证和片段的 `http:` 或 `https:` URL，返回 `{ "timezone": "Europe/Paris" }`。库不内置任何服务。
- **代理**：`proxyServer` 是一个不含凭证的 `http://` 或 `https://` 代理 URL；拒绝 `proxyBypassList` 和其他 `--proxy-` 参数。SOCKS 代理和需要凭证的代理请用 `ProxyForwarder` 包装，并在浏览器的整个生命周期内保持其开启。
- **请求**：只经由该代理发出，目标地址也由代理解析，不回退直连。重定向、200 以外的状态、格式错误的 JSON、超过 64 KiB 的响应、期限到达和取消都会终止启动。在 `launch()` 中，查询与启动共用同一期限。
- **不启动浏览器时**：`resolveProxyEnvironment(proxyURL, options, { timeout, signal })` 执行同样的查询，默认超时 10 秒，返回 `{ timezone, locale }`。
- **语言与位置**：IP 地址无法说明一个人的语言，所以 `locale` 总由调用方给出，也不推导地理位置。

这些设置作用于启动的进程：`newContext()` 用自己的 `proxy` 创建的上下文同样使用启动时的时区，`Browser.connect()` 则不应用这些设置。
