# 环境采样与兼容性复验

`Tab.inspectEnvironment()` 与 `Frame.inspectEnvironment()` 读取所选文档的真实环境。默认使用隔离世界，不改写 navigator、UA 或设备属性，不自动启动 Worker/WebGL。新增的 `Tab.diagnoseEnvironment()` 整合全 tab 的文档/Worker、字体、WebGL 和显式网络探针；`Tab.alignEnvironment()` 只按明确配置对齐并返回实际验证。MCP 的 browser_environment 复用相同接口；另有页面脚本 browser_evaluate，见 [MCP](mcp.md)，没有任意 CDP 工具。

```ts
const report = await tab.inspectEnvironment({ worker: true, webgl: true });
console.log(report.document.userAgent, report.document.userAgentData);
console.log(report.document.screen, report.document.viewport);
console.log(report.worker, report.differences);
```

报告包含 UA、UA-CH（可用时含高熵值）、platform、语言、hardwareConcurrency、deviceMemory（可用时）、webdriver、Intl locale/时区、screen 与 viewport/DPR。`webgl:true` 另建未插入 DOM 的临时 canvas，读取 vendor/renderer 并释放 context；没有 WebGL 时返回错误字段。报告不包含字体、IP、WebRTC 或完整设备指纹。

`worker:true` 显式创建临时 Blob dedicated Worker，用它读取同类 navigator/Intl 字段。`differences` 按字段比较文档与 Worker，忽略对象键顺序，保留数组顺序；不比较 Worker 中不存在的 webdriver。结果只是观测，空差异不证明完整环境一致。没有 UA-CH 的非安全上下文会省略该字段；高熵值访问错误保留在 `highEntropyError`。

Worker 成功、失败或到达内部期限后都会 terminate 并撤销 Blob URL；受 CSP 阻止或无法完成时，`worker.status` 为 `unavailable`，不会禁用 CSP。支持 `{world:'main'}` 对照；页面在该世界安装的 hook 能观察或修改采样行为。默认隔离世界仍共享 DOM。

整个调用默认期限 5000 毫秒，可用 `timeout` 与 `signal` 调整。0 是立即期限。跨越导航、session 切换或文档失效时抛 `StaleElementError`，不合并不同文档的结果，也不重试。取消只停止客户端等待；若 Worker 已创建，浏览器端清理仍在本次原期限内执行，关闭或导航也会销毁其文档资源。

`setEnvironment()` 继续是显式覆盖接口。UA、Client Hints、时区等覆盖不保证传播到所有 Worker/Service Worker 或所有设备字段；采样不会自动“修补”差异。有界面模式默认保留真实值；headless 默认只把 UA/UA-CH 中的 HeadlessChrome 改为 Chrome（`maskHeadless: false` 可关闭），见 [自动化痕迹审计](automation-audit.md)。

## 矩阵与压力测试

```sh
# 设置 CHROME_PATH 指向待验的 Chrome，可分别运行相邻版本
bun run test:compat
```

兼容测试通过 `NODRIVER_HEADFUL=1` 使用有界面模式（Linux 需要桌面/X/WSLg），`NODRIVER_CHURN_CYCLES=100` 提高压力轮数。这两个变量只影响相应测试，不改变库默认配置。`NODRIVER_ENV_REPORT=/absolute/path/report.jsonl` 可保存环境原始观测；文件每行一条 JSON，追加写入。默认日常回归每条传输执行 12 轮，独立压力矩阵每条传输执行 100 轮。

覆盖主页面、同进程 iframe、跨站及嵌套 OOPIF 的 main/isolated 求值、Worker、中文输入、popup、导航/BFCache、外部重连及协议阳性对照。压力循环创建/移除 iframe，并反复创建含 BFCache 历史的 context 后关闭，检查 frame/session 映射、监听器、初始化任务和 pending 请求回到基线。缓存尚存的活文档可能保留 session，回收断言在所属 context 关闭后执行。

所有默认路径审计禁止 `Runtime.enable/disable/addBinding`、`Console.enable`、`Debugger.enable` 和自动 init script。阳性对照在独立浏览器中显式启用 Runtime；它不计入默认路径。普通 Worker 启动时短暂恢复并断开辅助 target session，不启用 Runtime 域。

具体平台、浏览器版本和测试结果见 [支持范围](support.md)，原有检测信号的边界见 [自动化痕迹审计](automation-audit.md)。压力循环属于有限回归，不代表数日运行或所有 Chrome 版本保证。

2026-10-16，Windows 与 WSLg 的 Chrome 154/155、有界面/无界面、双传输 16 种组合均通过；每个版本/窗口组为 8 项测试、874 断言。最终代码额外在 WSLg Chrome 154.0.8037.92 headed/Pipe 完成 1000 轮（3502 断言），回到 1 个 frame、2 个 browser session、17 个连接监听器、0 pending，41277 条命令中禁止自动发送的命令为 0。这些计数属于该 fixture 与当次初始标签，不是公开 API 的固定数量约定。

## 字体和网络原生信号补测

`bun run test:signals` 另测 CSS.getPlatformFontsForNode 返回的实际渲染字体，覆盖主页面、同进程 iframe、跨站及嵌套 OOPIF 的拉丁字母、中文和 emoji，以及 HTTP 本机地址和原生 WebRTC 本地数据通道。该诊断显式启用 DOM/CSS 域，不改动 inspectEnvironment 的报告结构或默认浏览器配置；platform fonts 表示浏览器选用的字体，不保证系统具备每一个字符的字形。

本次 Windows 选用了 Arial、Microsoft YaHei、Segoe UI Emoji；WSL 选用了 DejaVu Sans，显示出两个系统的字体资源差异。WebRTC 在不配置 STUN 的本地双 peer 之间完成中文/emoji 往返，关闭事件和 peer 清理通过。所有新增默认路径仍审计禁止 Runtime.enable 等命令。

经用户明确授权，另使用 api.ipify.org 和 Google STUN 采样公网出口。两平台均取得 HTTP 地址、host 与 srflx 候选，观察到 HTTP 与 STUN 地址不同，同时有候选级 701 错误。这只记录当前网络配置，不据此断定具体代理机制或宣称不存在 IP 泄漏；原始地址仅保存在忽略的开发目录。没有改写网络、字体、UA 或设备特征来改变结果。

连续资源回收的运行方式与状态解释见 [长稳测试](soak.md)。物理输入和普通浏览器／Python 对照按本轮范围暂未开展。

## 结构化诊断与显式对齐

```ts
const diagnosis = await tab.diagnoseEnvironment({
  worker: true,
  webgl: true,
  fontSelectors: ['body', 'input'],
  // 只有显式填写才请求网络。示例使用自有同源 JSON {ip,headers?}。
  httpProbe: 'http://127.0.0.1:8080/signals/ip',
  stunServers: [], // 空数组仅本地 ICE；省略则不创建 peer
});
const aligned = await tab.alignEnvironment({
  environment: { timezone: 'Europe/Paris', viewport: { width: 900, height: 700 } },
  inspect: { worker: true },
});
console.log(aligned.applicationError, aligned.verification);
```

报告分别保存当前浏览器观测、首次 library override 之前的文档 baseline、显式 requested 配置及 session 应用结果、可选 resolver 返回值、调用方提供的站点标签。observed/unavailable/not-requested 与 match/mismatch/unavailable/not-tested 分开，未采集的项目不是通过。首次覆盖前没有完整 OS 原生快照；外部 CDP、扩展和浏览器已有配置来源未知。字体诊断显式启用 DOM/CSS 域，读取实际 platform fonts，不安装字体，也不保证每个 glyph 都存在。WebGL 使用临时 canvas 并释放 context。Dedicated Worker 创建后终止并撤销 Blob，CSP 阻止时记录 unavailable；不覆盖所有已存在的 Worker、SharedWorker 或 Service Worker。

```ts
await tab.alignEnvironment(
  {
    geoip: { address: '由调用方获得的地址', fields: ['timezone'] },
  },
  async (address, { signal }) => {
    // 本地数据库或调用方自己的 resolver；库不内置第三方 GeoIP 请求。
    return { timezone: 'Europe/Paris', label: 'local database' };
  },
);
```

只应用 fields 明确选中的 timezone/geolocation；显式 environment 优先。不会从 IP 推导品牌、UA-CH、硬件、精确位置或用户语言，也不强迫语言随出口所在地改变。resolver 接收取消信号/剩余期限；宿主 resolver 自己负责取消其外部工作。setEnvironment 的 timezone/locale、viewport、UA+metadata、Accept-Language 和 geolocation 通过 CDP 实施，没有全局 getter/原型补丁。acceptLanguage 单独配置时保留当前 UA/可取得的 UA-CH，不生成另一品牌身份。

每个 frame 的文档及新建 dedicated Worker 分别核验字段；Worker 不支持的 viewport 等明确为 unavailable，UA/语言等实际不一致记录 mismatch。locale 在页面根 session 设置，避免同 renderer/OOPIF 重复覆盖错误，不能承诺所有 renderer/Worker 的 Intl 已同步。UA-CH 按配置字段比较；高熵值不可用时不伪造成功。Geolocation 不自动授予权限，只在已有 permission=granted 时读位置验证，否则报告 unavailable。部分 Emulation 失败时保留 applicationError/session 记录和实际报告，不声称原子回滚。配置会影响当前及以后附加的页面 session，页面自身脚本和已有网络连接不追溯重写。

HTTP 探针由页面发起，凭证省略、禁重定向、受 CSP/CORS/网络影响；返回的 headers 仅是调用方服务反射的观测。STUN 仅接受显式最多四个 STUN 端点，不请求音视频权限或 TURN 凭证，限时后关闭数据通道和 peer。没有默认外网请求；网络调用失败保留缺测原因。来源不同的 HTTP/STUN 地址可以不同，不自动认定为伪装、泄漏或代理机制证明。

MCP host 可在 BrowserSessionManagerOptions 的 environmentDiagnostics 配置 httpProbe/stunServers，并注入 geoIPResolver；工具只选择是否使用该配置，不能传入任意探测 URL。没有配置时 network 请求不会产生外部访问。显式环境字段通过 browser_environment(mode:align) 提交。

## 代理与 WebRTC 路由策略

现有 launch/context proxyServer 和认证 HTTP/SOCKS 适配继续使用，报告只记录是否配置，不输出代理秘密或声称涵盖全部流量。外部连接的路由配置来源记 unknown。

`Browser.launch({webRtcIPHandlingPolicy:'disable_non_proxied_udp'})` 是显式启动策略，可选 default、default_public_interface_only、default_public_and_private_interfaces、disable_non_proxied_udp。只对自有临时 profile 准备 webrtc.ip_handling_policy 偏好并传启动开关；持久 profile 要由所有者自行配置，库拒绝替写。仅开关在本机 Chrome 155 探针中仍出现 UDP 候选，因此不能单凭启动参数认定生效。测试实际验证显式限制后的本地 ICE 无 UDP 候选，默认路径仍能完成原生数据通道；这不是所有代理/STUN/媒体应用的保证。

该限制可能降低直连和媒体可用性，不默认启用，不等于关闭整个 WebRTC，也不保证 HTTP 与 WebRTC 公网出口相同。定义见 [Chromium WebRTC 偏好](https://chromium.googlesource.com/chromium/src/+/fdaf45e57c902c85d3ff281fe5a56677e6f9b7fa%5E%21/)。未采用默认 exit_type/exited_cleanly Preferences 写入：自有进程已经正常回收，伪写“正常退出”会掩盖真实崩溃；不修改用户 profile 的崩溃记录。
