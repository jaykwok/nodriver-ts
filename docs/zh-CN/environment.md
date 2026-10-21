# 环境采样、诊断与对齐

[English](../environment.md)

三个接口按作用递进：`inspectEnvironment()` 只读取，`diagnoseEnvironment()` 汇总整个标签页的观测，`alignEnvironment()` 按明确配置覆盖并核验。默认不改写 navigator、UA 或设备属性，也不访问外网。MCP 的 `browser_environment` 复用同一套接口。

## 采样：inspectEnvironment

```ts
const report = await tab.inspectEnvironment({ worker: true, webgl: true });
console.log(report.document.userAgent, report.document.userAgentData);
console.log(report.document.screen, report.document.viewport);
console.log(report.worker, report.differences);
```

`Tab.inspectEnvironment()` 与 `Frame.inspectEnvironment()` 读取所选文档的真实环境：UA、UA-CH（可用时含高熵值）、platform、语言、hardwareConcurrency、deviceMemory（可用时）、webdriver、Intl locale 与时区、screen 和 viewport/DPR。报告不包含字体、IP、WebRTC 或完整设备指纹。

- **执行世界**：默认隔离世界；`{ world: 'main' }` 可作对照，页面在主世界安装的 hook 能观察或修改采样。
- **Worker**：`worker: true` 创建临时 Blob dedicated Worker 读取同类字段，`differences` 按字段比较文档与 Worker（忽略对象键顺序，保留数组顺序，不比较 Worker 中不存在的 webdriver）。Worker 成功、失败或到期后都会 terminate 并撤销 Blob URL；受 CSP 阻止时 `worker.status` 为 `unavailable`，不会绕过 CSP。
- **WebGL**：`webgl: true` 使用未插入 DOM 的临时 canvas 读取 vendor/renderer 并释放 context；不可用时返回错误字段。
- **UA-CH**：非安全上下文没有 UA-CH 时省略该字段，高熵值错误保留在 `highEntropyError`。
- **期限**：默认 5000 毫秒，可用 `timeout` 与 `signal` 调整。跨越导航、session 切换或文档失效时抛 `StaleElementError`，不合并不同文档的结果，也不重试。取消只停止等待；已创建的 Worker 仍在原期限内被清理。

空的 `differences` 只说明比较的字段一致，不证明完整环境一致。

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

- **字体**：在独立临时 session 上显式启用 DOM/CSS，结束时 detach，不会关闭调用方订阅；读取 `CSS.getPlatformFontsForNode` 返回的实际渲染字体。结果是浏览器选用的字体，不保证每个字符都有字形，也不安装字体。
- **HTTP 探针**：由页面发起，省略凭证、禁止重定向，受 CSP/CORS 与网络影响；返回的 headers 只是调用方服务的反射观测。
- **STUN**：只接受显式给出的最多四个 STUN 端点，不请求音视频权限或 TURN 凭证，限时后关闭数据通道和 peer。
- **地址差异**：HTTP 与 STUN 的出口地址可以不同，不能据此认定伪装、泄漏或某种代理机制。网络调用失败时保留缺测原因。

## 对齐：alignEnvironment

```ts
const aligned = await tab.alignEnvironment({
  environment: { timezone: 'Europe/Paris', viewport: { width: 900, height: 700 } },
  inspect: { worker: true },
});
console.log(aligned.applicationError, aligned.verification);

await tab.alignEnvironment(
  { geoip: { address: '由调用方获得的地址', fields: ['timezone'] } },
  async (address, { signal }) => {
    // 本地数据库或调用方自己的 resolver；库不内置第三方 GeoIP 请求
    return { timezone: 'Europe/Paris', label: 'local database' };
  },
);
```

报告分别保存当前观测、首次覆盖前的文档 baseline、请求的配置与各 session 的应用结果、resolver 返回值和调用方提供的站点标签。首次覆盖前没有完整的 OS 原生快照；外部 CDP、扩展和浏览器已有配置的来源记为未知。

- **应用方式**：timezone、locale、viewport、UA 与 UA-CH、Accept-Language、geolocation 都通过 CDP 设置，没有全局 getter 或原型补丁。配置作用于当前及之后附加的页面 session，不追溯改写页面已有脚本和网络连接。
- **GeoIP**：只应用 `fields` 选中的 timezone/geolocation，显式 `environment` 优先。不从 IP 推导品牌、UA-CH、硬件、精确位置或语言。resolver 收到取消信号和剩余期限，由宿主负责取消其外部工作。
- **单独设置 Accept-Language**：保留当前 UA 和可取得的 UA-CH，不生成另一品牌身份。
- **核验**：每个 frame 的文档与新建 dedicated Worker 分别核验；Worker 不支持的字段（如 viewport）记为 unavailable，实际不一致记为 mismatch。locale 只在页面根 session 设置，不保证所有 renderer/Worker 的 Intl 同步。UA-CH 按配置字段比较，高熵值不可用时不伪造成功。Geolocation 不自动授权，只有权限已为 granted 时才读取位置核验，否则为 unavailable。
- **部分失败**：保留 `applicationError`、session 记录和实际报告，不声称原子回滚。

`setEnvironment()` 是不带核验的显式覆盖接口。UA、Client Hints、时区等覆盖不保证传播到所有 Worker、SharedWorker 或 Service Worker。有界面模式默认保留真实值；headless 也默认保留原生值。显式 `maskHeadless: true` 改变页面 UA/UA-CH 与 Dedicated Worker，但会与 Shared/Service Worker 及其请求不一致，见[分阶段审计](differential-audit.md)，见 [自动化痕迹审计](automation-audit.md)。

MCP 宿主可在 `BrowserSessionManagerOptions.environmentDiagnostics` 中配置 `httpProbe`/`stunServers`，并注入 `geoIPResolver`；工具只能选择是否使用这些配置，不能传入任意探测 URL。

## 代理与 WebRTC

`launch` / `newContext` 的 `proxyServer` 直接交给 Chrome；`proxy` 经本机转发器支持认证 HTTP(S)/SOCKS 上游。诊断报告只记录是否配置代理，不输出代理凭证；外部连接的路由来源记为 unknown。

`Browser.launch({ webRtcIPHandlingPolicy })` 显式设置 WebRTC 路由策略，取值为 `default`、`default_public_interface_only`、`default_public_and_private_interfaces`、`disable_non_proxied_udp`。库只为自有临时 profile 写入 `webrtc.ip_handling_policy` 偏好并传启动开关；持久 profile 由所有者自行配置，库拒绝代写。仅靠启动开关时 Chrome 155 仍会产生 UDP 候选，因此偏好与开关同时设置。测试验证 `disable_non_proxied_udp` 下本地 ICE 没有 UDP 候选，默认策略能完成原生数据通道。

该策略可能降低直连和媒体可用性，默认不启用；它不关闭整个 WebRTC，也不保证 HTTP 与 WebRTC 的公网出口相同。定义见 [Chromium WebRTC 偏好](https://chromium.googlesource.com/chromium/src/+/fdaf45e57c902c85d3ff281fe5a56677e6f9b7fa%5E%21/)。库不改写 profile 的 exit_type/exited_cleanly，以免掩盖真实崩溃。

## 测试

```sh
npm run test:compat    # 用 CHROME_PATH 指定待验证的 Chrome
npm run test:signals   # 渲染字体、本机 HTTP 地址与 WebRTC 数据通道
```

| 变量                                       | 作用                                          |
| ------------------------------------------ | --------------------------------------------- |
| `NODRIVER_HEADFUL=1`                       | 以有界面模式运行（Linux 需要桌面、X 或 WSLg） |
| `NODRIVER_CHURN_CYCLES=100`                | 压力轮数；日常回归每条传输 12 轮              |
| `NODRIVER_ENV_REPORT=/absolute/path.jsonl` | 追加保存原始环境观测，每行一条 JSON           |

兼容测试覆盖主页面、同进程 iframe、跨站及嵌套 OOPIF 的 main/isolated 求值、Worker、中文输入、popup、导航/BFCache、外部重连和协议阳性对照。压力循环反复创建/移除 iframe，并创建含 BFCache 历史的 context 后关闭，检查 frame/session 映射、监听器、初始化任务和 pending 请求回到基线。所有默认路径断言禁用命令为零；阳性对照在独立浏览器中显式启用 Runtime。普通 Worker 启动时只短暂恢复并断开辅助 target session，不启用 Runtime 域。

信号测试覆盖四类 frame 中拉丁字母、中文和 emoji 的实际渲染字体，以及无 STUN 的本地双 peer WebRTC 数据通道中文/emoji 往返。不同系统选用的字体不同（例如 Windows 为 Arial、Microsoft YaHei、Segoe UI Emoji，WSL 为 DejaVu Sans），这是系统字体资源差异。

已验证的平台与版本见 [支持范围](support.md)。
