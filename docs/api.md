# API 与行为约定

新增 `tab.setInputPolicy(policy)`、`Element.type(textOrSegments,options)`、`Keyboard.type` 及可取消 Mouse.move/click/wheel/drag、Keyboard.press。策略在共享输入层执行，报告/能力边界见 [输入](input.md)。`Tab.diagnoseEnvironment(options)` 与 `Tab.alignEnvironment(options,resolver?)` 汇总实际观测和覆盖验证，见 [环境](environment.md)；相关 InputPolicy/InputReport/InputActionError 与诊断类型从根入口导出。默认有界面 Chrome 的行为保持不变。

所有操作异步，除只读属性和事件订阅。公开类型从 `src/index.ts` 导出，构建生成 `.d.ts`。协议类型依赖随发布安装。

`Tab.inspectEnvironment()` / `Frame.inspectEnvironment()` 读取 UA/UA-CH、语言、时区、屏幕与可选 Worker/WebGL，返回 `EnvironmentReport` 和文档/Worker 字段差异。默认隔离世界、5000ms，Worker/WebGL 默认关闭；不会修改设备属性。资源、取消及 CSP 语义见 [环境采样](environment.md)。

MCP 适配从 `nodriver-ts/mcp` 导出 `createBrowserMcpServer(options?: BrowserSessionManagerOptions)` 和 `MCP_PROTOCOL_VERSION`，返回官方 SDK `McpServer`，仅支持 2026-07-28。私有实例与 HTTP 共用 manager/池/租约和工具实现，`options.launch` 与 `options.connect` 互斥，浏览器懒启动。CLI 为 `nodriver-mcp`；HTTP 常驻模式、stdio 兼容接入和生命周期见 [MCP 文档](mcp.md)。

第二参数 `BrowserMcpBinding` 可显式传入 `BrowserSessionManager`、已验证 principal 与 leaseId，使 Server.close() 只关闭适配器。管理器提供 create/list/release/sweep/close 和受控池，负责 context、引用、队列及资源回收。从 `nodriver-ts/mcp/http` 导出 `startBrowserMcpHttpServer(options)` 与 `createBrowserMcpHttpService(options)`，返回有 fetch/close 的服务；HTTP 只监听 loopback，要求 Bearer 与应用租约。不会自动修改客户端配置，详细接口与限额见 [HTTP 文档](mcp-http.md)。

`nodriver-ts/mcp/socket` 导出异步 `startBrowserMcpSocketServer(options)`、`BrowserMcpSocketClientTransport` 和对应配置类型。服务返回 path/manager/close；客户端适配官方 Client，认证后可读取 leaseId 以显式重连。Linux Unix socket 与 Windows 本机命名管道的路径、权限、认证和消息限制见 [socket 文档](mcp-socket.md)。

| 对象           | 高层入口                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser        | `launch`, `connect`, `newTab`, `newContext`, `tabs`, `contexts`, `defaultContext`, `version`, `owned`, `endpoint`, `close`, `disconnect`, `waitForTab`, `errors`, `cdp`                            |
| BrowserContext | `newTab`, `tabs`, `cookies`, `setCookies`, `clearCookies`, `saveCookies`, `loadCookies`, `storageState`, `restoreStorage`, `grantPermissions`, `resetPermissions`, `setDownloadDirectory`, `close` |
| Tab            | `goto`, `reload`, `go(delta)`, `waitForNavigation`, `stopLoading`, `bringToFront`, `activate`, `windowBounds`, `mainFrame`, `frames`, `waitForPopup`, `handleDialog`                               |
| Tab / Frame    | `evaluate`, `evaluateHandle`, `query`, `queryAll`, `waitForSelector`, `waitForFunction`, `content`                                                                                                 |
| Frame          | `parent`, `children`, `session`, `url`, `generation`, `storage`, `setStorage`                                                                                                                      |
| Tab 文件/环境  | `setContent`, `screenshot`, `pdf`, `resources`, `resourceContent`, `setEnvironment`, `addInitScript`, `waitForDownload`                                                                            |
| Element        | `text`, `html`, `attribute`, `describe`, `evaluate`, `query`, `queryAll`, `focus`, `click`, `hover`, `scrollIntoView`, `clickablePoint`, `fill`, `select`, `setChecked`, `upload`, `screenshot`    |
| Network        | `route`, `authenticate`, `setExtraHeaders`, `setCacheEnabled`, `setOffline`, `waitForResponse`, `responses`, `enable`, `networkEnabled`                                                            |
| Route          | `request`, `continue`, `fulfill`, `abort`; 只能处理一次，handler 未处理时默认 continue                                                                                                             |
| Download       | `guid`, `url`, `suggestedFilename`, `path`, `saveAs`, `cancel`                                                                                                                                     |
| Mouse          | `move`, `click`, `wheel`, `drag`; 顶层视口 CSS 坐标                                                                                                                                                |
| Keyboard       | `insertText`, `type`, `down`, `up`, `press('Control+A')`                                                                                                                                           |
| JSHandle       | `jsonValue`, `dispose`, `Symbol.asyncDispose`                                                                                                                                                      |
| Session        | `send`, `sendWith`, `on`, `waitFor`, `disconnected`, `id`, `closed`                                                                                                                                |
| Transport      | WebSocket / Pipe，可自行实现 `send`, `close`, `onmessage`, `onclose`                                                                                                                               |

`WaitOptions` 使用毫秒 `timeout` 和 `AbortSignal`。默认协议请求 30 秒；`launch({ timeout })` 同时设置启动/握手及默认命令期限。`waitForSelector`、动作轮询默认 10 秒。0 表示立即期限，不代表无限等待。导航默认等待 `load`，还支持 `domcontentloaded`、`commit` 和 `networkidle`（Chrome 生命周期事件 networkIdle）；SPA/hash 导航在同文档事件完成，BFCache 恢复按恢复事件完成。

字符串 `evaluate` / `evaluateHandle` 可额外传正数 `executionTimeout`（毫秒），映射到 CDP Runtime.evaluate.timeout，限制初始同步执行；函数参数形式不支持此选项。默认省略，保持原有行为。宿主 timeout/signal 停止等待不能保证终止页面的定时器、请求或异步续体；执行期限也不是硬资源沙箱。MCP browser_evaluate 显式设置此期限。

必须在触发动作前注册导航、下载、弹窗和响应等待。关闭 session 会拒绝关联请求/事件等待；迟到响应被丢弃。页面 crash 可调用 `reload()` 恢复，旧句柄保持失效。断线后应建立新连接，不静默重放脚本或输入。

CSS 查询默认匹配所选文档和 shadow 树中的后代。`Element.query()` 限定在该元素子树，`Frame.query()` 不跨 iframe。常见查询在 isolated world 中一次遍历文档与 open shadow root；页面存在 closed shadow root 时才额外用 DOM 树取得这些根（按文档代次缓存，未发现时 1 秒内不重扫）。轮询间隔 50 毫秒，不建议用来全页面高频抓取。

JS 默认 main world；DOM 辅助使用随机命名的隔离世界。隔离世界共享 DOM，页面可以观察 DOM 变化及输入。框架不自动调用 `Runtime.enable`；通过所属 frame 的 Document 解析并验证主世界上下文，详见 [自动化痕迹审计](automation-audit.md)。不能等待默认未启用的 Runtime 事件；显式 `cdp.send('Runtime.enable')` 会改变这一状态及检测面。`addInitScript` 应先于 `goto()` 注册；新 OOPIF 暂停初始化后恢复，并有 watchdog。已经开始执行的 popup 或外部页面没有首段脚本前注入保证。

`Browser.launch({ automationControlled: false })` 为默认值，合并 `--disable-blink-features=AutomationControlled` 与调用者指定的其他禁用特性，保留原生 webdriver getter。`true` 不添加该禁用特性，用于恢复 Chrome 的原生自动化标志。此选项仅影响新启动的浏览器，不能改变 `connect()` 连接的浏览器启动参数。`headless` 默认 `false`，使用有界面 Chrome；`maskHeadless` 在 headless 且未指定 `userAgent` 时默认开启。其他启动选项：`userAgent`、`lang`（BCP 47）、`windowSize`、`preset: 'agent'`（追加 `AGENT_ARGS`）。持久 `userDataDir` 由 `acquireProfileLock()` 加锁，锁文件记录 PID 与主机名。陈旧锁回收由独立的 `.nodriver.lock.reclaim` 文件互斥；若在回收期间强杀进程留下该文件，会明确报错，须确认记录的进程已退出后再手动清理。启动失败且 Chrome 已退出时，错误包含退出码与 stderr。`Browser.connect({ attach })` 选择 `'all'`（默认）或 `'created'`（只附加本客户端创建的标签页及其弹出页）。无图形桌面的服务器或 CI 应显式设 `headless: true`。不会在显示环境不可用时自动切换为 headless；连接已有浏览器时沿用其原有模式。

`fill()` 支持可编辑 input、textarea 和 contenteditable，通过焦点/选择加 `Input.insertText` 输入 Unicode；只承诺最终文本与浏览器 input 语义，不模拟完整 OS IME 候选窗或剪贴板。`select()` 使用 DOM 改值并派发 input/change。物理键支持命名键、F1–F12、修饰键与 US 布局字符（含上档符号）。`Mouse.drag()` 是指针拖动；复杂 HTML5 DataTransfer 需自行使用协议扩展。

`screenshot()` 返回 Buffer；`path` 可选。元素截图目前适合轴对齐元素，旋转/透视元素应使用页面截图或显式 clip。PDF 依赖 Chrome 的 headless 打印能力。权限、实验性 CDP 命令和不同浏览器实现的错误以 `ProtocolError` 暴露，不把所有协议错误当成不支持。

网络响应 `body()` 在响应内容可用后调用，缓存被浏览器驱逐或重定向时 CDP 可能拒绝。请求路由覆盖所选 Tab 及其 OOPIF；Service Worker、浏览器自身请求、其他 Tab 不在这个范围。BrowserContext 状态互相隔离，不等于独立 OS/GPU/字体。

`Connection` 选项 `trace: true` 把每条命令的方法、session、耗时和错误码写到 stderr，传函数则接收 `TraceEntry`；环境变量 `NODRIVER_TRACE=1` 等价于 `true`。不记录参数和结果。事件按 session 路由：`session.on(method, listener)`、`session.onAny(listener)` 只接收该 session 的事件，先于全局 `connection.events` 执行；`connection.listenerCount` 汇总两者。

`Network.enable` 只在需要时发送：订阅 `responses`、调用 `waitForResponse`、显式 `enable()`，或设置非默认 headers/cache/offline。`route()` 和 `authenticate()` 使用 Fetch 域，不需要 Network。
