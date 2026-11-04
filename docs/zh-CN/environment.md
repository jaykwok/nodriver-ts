# 环境采样、诊断与对齐

[English](../environment.md)

三个接口逐层递进：`inspectEnvironment()` 只采样、不应用覆盖，`diagnoseEnvironment()` 汇总整个标签页的观测，`alignEnvironment()` 按明确配置应用覆盖并核验。默认不改写 navigator、UA 或设备属性，也不访问外网。MCP 工具 `browser_environment` 使用同一套接口。

## 如何选择诊断流程

这些 API 用于排查配置、复现 Locale/视口问题，或比较受控的浏览器运行结果。建议从自己控制的测试页面开始，保持 Chrome 版本、Profile 初始配置与宿主环境可比，并把请求的配置与报告一同保存。

| 需求                                                 | API                     |
| ---------------------------------------------------- | ----------------------- |
| 采样单个 Frame 的当前环境                            | `inspectEnvironment()`  |
| 比较 Frame、读取实际渲染字体或执行显式配置的网络探针 | `diagnoseEnvironment()` |
| 应用指定测试配置并检查结果                           | `alignEnvironment()`    |

不应用覆盖不等于零开销或不可观察：Worker/WebGL 探针会创建临时资源，字体探针会附加临时 DOM/CSS session，显式请求的 HTTP/STUN 探针会产生流量。只开启排查所需的测量项。衡量某项操作的影响时，对照组和实验组应运行相同的探针，让探针本身成为被测负载的一部分。

`worker` 选项采样的是**新建的 Dedicated Worker**，不检查已有 Worker、Shared Worker、Service Worker、它们的初始脚本请求或首段脚本执行；[差分审计夹具](differential-audit.md)说明了它对 Worker 和请求头的覆盖范围。报告匹配、CDP 命令成功或检测网站的标签，都不能单独证明未测量上下文的一致性。

`alignEnvironment()` 会改变浏览器状态，且可能只部分成功。它适合显式的测试配置，而不是自动修复设备指纹：它不改变 OS 字体、GPU 硬件或原生窗口装饰。应将几何尺寸、媒体设置和渲染器信息与匹配的原生基线比较，而不是强制固定浏览器工具栏高度，或认定软件渲染就是异常。

## 采样：inspectEnvironment

```ts
const report = await tab.inspectEnvironment({ worker: true, webgl: true });
console.log(report.document.userAgent, report.document.userAgentData);
console.log(report.document.screen, report.document.viewport);
console.log(report.worker, report.differences);
```

`Tab.inspectEnvironment()` 与 `Frame.inspectEnvironment()` 读取所选文档的真实环境：UA、UA-CH（可用时含高熵值）、platform、语言、hardwareConcurrency、deviceMemory（可用时）、webdriver、Intl locale 与时区、屏幕和视口/DPR。报告不包含字体、IP、WebRTC 或完整的设备指纹。

- **执行世界**：默认使用隔离世界。`{ world: 'main' }` 可用于对照，但页面在主世界安装的钩子能观察或修改这次采样。
- **Worker**：`worker: true` 创建临时 Blob dedicated Worker 读取同类字段，`differences` 逐字段比较文档与 Worker（忽略对象键顺序，保留数组顺序，不比较 Worker 中不存在的 webdriver）。无论成功、失败还是超时，Worker 都会被 terminate，Blob URL 也会被撤销。受 CSP 阻止时 `worker.status` 为 `unavailable`；绝不绕过 CSP。
- **WebGL**：`webgl: true` 从一个从未插入 DOM 的临时 canvas 读取 vendor/renderer，随后释放上下文。WebGL 不可用时返回错误字段。
- **UA-CH**：在没有 UA-CH 的非安全上下文中省略该字段。高熵值的错误保留在 `highEntropyError`。
- **期限**：默认 5000 ms，可用 `timeout` 与 `signal` 调整。跨越导航、session 切换或文档失效时抛出 `StaleElementError`；执行上下文在采样中途消失时，以 Chrome 的错误作为 `cause`。不同文档的结果绝不合并，也不重试。取消只停止等待；已创建的 Worker 仍会在原期限内清理。

`differences` 为空只说明比较的字段一致，不代表整个环境一致。

## 诊断：diagnoseEnvironment

```ts
const diagnosis = await tab.diagnoseEnvironment({
  worker: true,
  webgl: true,
  fontSelectors: ['body', 'input'],
  // 只有显式填写才发起网络请求；示例为自有同源 JSON {ip, headers?}
  httpProbe: 'http://127.0.0.1:8080/signals/ip',
  stunServers: [], // 空数组只收集本地 ICE；省略则不创建 peer
});
```

诊断汇总标签页内所有 frame 的文档与 Worker、字体、WebGL 和显式网络探针。报告区分 observed / unavailable / not-requested，以及 match / mismatch / unavailable / not-tested；未采集的项目不算通过。

所有探针共用一个期限：默认 10000 ms，可用 `timeout` 与 `signal` 调整，到期时抛出 `TimeoutError`。不可用的探针选项（超过 16 个 `fontSelectors`、`httpProbe` 不是普通 HTTP(S) 或带 URL 凭证、`stunServers` 超过四个或格式错误）会在采样前被拒绝。

- **字体**：在独立的临时 session 上显式启用 DOM/CSS，结束时在 1 秒内分离，不会关闭调用方的订阅；读取 `CSS.getPlatformFontsForNode` 返回的实际渲染字体。结果是浏览器选用的字体，不保证每个字符都有字形，也不会安装字体。
- **HTTP 探针**：由页面发起，不带凭证、禁止重定向，受 CSP/CORS 与网络影响。返回的请求头只是调用方服务回显的内容。
- **STUN**：只使用显式列出的 STUN 端点，最多四个。不请求音视频权限或 TURN 凭证，超时后关闭数据通道和对端。
- **地址差异**：HTTP 与 STUN 的出口地址可能不同，仅凭这一点不能认定存在伪装、泄漏或某种代理机制。网络调用失败时会保留未测得的原因。

## 对齐：alignEnvironment

```ts
const aligned = await tab.alignEnvironment({
  environment: { timezone: 'Europe/Paris', viewport: { width: 900, height: 700 } },
  inspect: { worker: true },
});
console.log(aligned.applicationError, aligned.verificationError, aligned.verification);

await tab.alignEnvironment(
  { geoip: { address: '由调用方获得的地址', fields: ['timezone'] } },
  async (address, { signal }) => {
    // 本地数据库或调用方自己的 resolver；库不内置第三方 GeoIP 请求
    return { timezone: 'Europe/Paris', label: 'local database' };
  },
);
```

报告分别保存：当前观测、首次覆盖前的文档基线、请求的配置及其在各 session 上的应用结果、解析器的返回值，以及调用方提供的站点标签。首次覆盖前没有完整的 OS 原生值快照；来自外部 CDP 客户端、扩展或浏览器已有配置的值记为未知。

- **应用方式**：时区、locale、视口、UA 与 UA-CH、Accept-Language 和地理位置都通过 CDP 设置，不修补全局 getter 或原型。配置作用于当前及之后附加的页面 session，不会追溯改变页面已有的脚本和网络连接。
- **GeoIP**：只应用 `fields` 选中的 时区/地理位置字段，显式的 `environment` 优先。品牌、UA-CH、硬件、精确位置和语言绝不从 IP 推导。解析器会收到取消信号和剩余期限，由宿主负责取消其外部工作。
- **单独设置 Accept-Language**：保留当前 UA 和可取得的 UA-CH，不生成其他品牌身份。
- **核验**：每个 frame 的文档和新建的 dedicated Worker 分别核验；`expected` 与 `actual` 保留原始值。Worker 不支持的字段（如视口）记为 unavailable，真正不一致的记为 mismatch。视口只在主 frame 上核验，因为 iframe 的视口是它自己的布局框。locale 与时区按规范形式比较，因此 `fr-fr` 与 `fr-FR` 匹配，`Asia/Kolkata` 与 Chrome 报告的 `Asia/Calcutta` 匹配。Accept-Language 按有序的语言标签列表比较，忽略 `;q=` 权重；除非 `httpProbe` 在其 `headers` 中以 `accept-language` 回显该请求头，否则记为 not-tested。locale 只在页面根 session 上设置，因此不保证每个渲染进程/Worker 中的 Intl 都一致。UA-CH 按配置的字段比较，高熵值不可用时不会伪造成功。地理位置绝不自动授权；只有权限已是 granted 时才读取位置用于核验，否则记为 unavailable。
- **期限与部分失败**：整个调用共用一个期限，默认 10000 ms，可用 `timeout` 与 `signal` 调整，到期时抛出 `TimeoutError`。`inspect` 选项在应用任何配置前校验。覆盖不会原子回滚；`applicationError`、session 记录和实际报告都会保留。如果应用后的采样失败或超时，`after` 为 undefined，`verificationError` 保存原因，所有请求的字段记为 not-tested；从此时起，只有调用方的 `signal` 会让调用拒绝。

`setEnvironment()` 是不带核验的显式覆盖接口。UA、Client Hints、时区等覆盖不保证到达每个 Worker、SharedWorker 或 Service Worker。有界面和 headless 模式默认都保留原生值。显式启用的 `maskHeadless: true` 会改变页面 UA/UA-CH 与 Dedicated Worker，但可能与 Shared/Service Worker 及其请求不一致；见[差分审计](differential-audit.md)和[自动化痕迹审计](automation-audit.md)。

MCP 宿主可在 `BrowserSessionManagerOptions.environmentDiagnostics` 中配置 `httpProbe`/`stunServers`，并注入 `geoIPResolver`。工具只能选择是否使用这些配置，不能传入任意探测 URL。

## 代理与 WebRTC

`launch` / `newContext` 的 `proxyServer` 直接传给 Chrome。`newContext` 的 `proxy` 经由本机转发器，支持带认证的 HTTP(S)/SOCKS 上游，scheme 可以是 `http`、`https`、`socks`、`socks4`、`socks4a`、`socks5` 或 `socks5h`。使用 `socks`、`socks4a` 和 `socks5h` 时，所有主机名都由代理解析；使用 `socks4` 和 `socks5` 时，明文 HTTP 的主机名由转发器自行解析。转发器运行在宿主进程中，因此用 `proxy` 创建的上下文只在创建它的连接存续期间有效：连接关闭时，Chrome 会销毁该上下文及其标签页。诊断报告只记录是否配置了代理，绝不输出代理凭证；对于连接的浏览器，路由来源记为 unknown。

`Browser.launch({ webRtcIPHandlingPolicy })` 显式设置 WebRTC 路由策略，取值为 `default`、`default_public_interface_only`、`default_public_and_private_interfaces` 或 `disable_non_proxied_udp`。库会传入启动开关，同时写入 `webrtc.ip_handling_policy` 偏好，因为仅靠启动开关时，Chrome 155 仍会产生 UDP 候选。偏好只写入库自有的临时 profile；对持久 profile，库会拒绝该选项，由其所有者自行配置。测试验证：`disable_non_proxied_udp` 下本地 ICE 没有 UDP 候选；未设置策略时原生数据通道能正常建立。

该策略可能降低直连和媒体的可用性，因此默认不启用。它不会关闭整个 WebRTC，也不保证 HTTP 与 WebRTC 使用相同的公网出口。定义见 [Chromium WebRTC 偏好](https://chromium.googlesource.com/chromium/src/+/fdaf45e57c902c85d3ff281fe5a56677e6f9b7fa%5E%21/)。库不改写 profile 的 exit_type/exited_cleanly，以免掩盖真实的崩溃。

## 测试

启动 UA/语言参数、暂停 Worker 后的覆盖、首段脚本观测和初始请求头，请参阅 [Worker 启动环境基准](worker-environment.md)。

```sh
npm run test:compat    # 用 CHROME_PATH 指定待验证的 Chrome
npm run test:signals   # 渲染字体、本机 HTTP 地址与 WebRTC 数据通道
```

| 变量                                       | 作用                                          |
| ------------------------------------------ | --------------------------------------------- |
| `NODRIVER_HEADFUL=1`                       | 以有界面模式运行（Linux 需要桌面、X 或 WSLg） |
| `NODRIVER_CHURN_CYCLES=100`                | 压力轮数；日常回归每种传输 12 轮              |
| `NODRIVER_ENV_REPORT=/absolute/path.jsonl` | 追加保存原始环境观测，每行一个 JSON 对象      |

兼容测试覆盖主页面、同进程 iframe、跨站及嵌套 OOPIF 中的 main/isolated 求值，以及 Worker、中文输入、弹出页、导航/BFCache、外部重连和协议阳性对照。压力循环反复创建和移除 iframe，并创建、关闭带 BFCache 历史的上下文，检查 frame/session 映射、监听器、初始化任务和待响应请求都回到基线。所有默认路径都断言禁用命令为零；阳性对照在独立的浏览器中显式启用 Runtime。普通 Worker 启动时，其辅助 target session 只会被恢复运行，随后即断开，不启用 Runtime 域。

信号测试覆盖四类 frame 中拉丁字母、中文和 emoji 的实际渲染字体，以及在不使用 STUN 的本地双对端 WebRTC 数据通道上的中文/emoji 往返。不同系统会根据已安装的字体选用不同字体，例如 Windows 上为 Arial、Microsoft YaHei 和 Segoe UI Emoji，WSL 上为 DejaVu Sans。

支持的平台见[支持范围](support.md)。
