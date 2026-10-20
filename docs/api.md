# API 与行为约定

除只读属性和事件订阅外，所有操作都是异步的。公开类型从根入口 `nodriver-ts` 导出，构建产物附带 `.d.ts`；CDP 类型来自随包安装的 `devtools-protocol`。

## 入口

| 入口                     | 导出                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `nodriver-ts`            | Browser、BrowserContext、Tab、Frame、Element、Network、输入、环境诊断、错误类型，以及 `InputPolicy`、`InputReport` 等配套类型 |
| `nodriver-ts/mcp`        | `createBrowserMcpServer`、`BrowserSessionManager`、`MCP_PROTOCOL_VERSION`，见 [MCP](mcp.md)                                   |
| `nodriver-ts/mcp/http`   | `startBrowserMcpHttpServer`、`createBrowserMcpHttpService`，见 [HTTP 接入](mcp-http.md)                                       |
| `nodriver-ts/mcp/socket` | `startBrowserMcpSocketServer`、`BrowserMcpSocketClientTransport`，见 [socket 接入](mcp-socket.md)                             |

## 对象

| 对象           | 高层入口                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser        | `launch`, `connect`, `newTab`, `newContext`, `tabs`, `contexts`, `defaultContext`, `version`, `owned`, `endpoint`, `close`, `disconnect`, `waitForTab`, `errors`, `cdp`                                 |
| BrowserContext | `newTab`, `tabs`, `cookies`, `setCookies`, `clearCookies`, `saveCookies`, `loadCookies`, `storageState`, `restoreStorage`, `grantPermissions`, `resetPermissions`, `setDownloadDirectory`, `close`      |
| Tab            | `goto`, `reload`, `go(delta)`, `waitForNavigation`, `stopLoading`, `bringToFront`, `activate`, `windowBounds`, `mainFrame`, `frames`, `waitForPopup`, `handleDialog`, `setInputPolicy`                  |
| Tab 文件/环境  | `setContent`, `screenshot`, `pdf`, `resources`, `resourceContent`, `setEnvironment`, `addInitScript`, `waitForDownload`, `inspectEnvironment`, `diagnoseEnvironment`, `alignEnvironment`                |
| Tab / Frame    | `evaluate`, `evaluateHandle`, `query`, `queryAll`, `waitForSelector`, `waitForFunction`, `content`                                                                                                      |
| Frame          | `parent`, `children`, `session`, `url`, `generation`, `storage`, `setStorage`, `inspectEnvironment`                                                                                                     |
| Element        | `text`, `html`, `attribute`, `describe`, `evaluate`, `query`, `queryAll`, `focus`, `click`, `hover`, `scrollIntoView`, `clickablePoint`, `fill`, `type`, `select`, `setChecked`, `upload`, `screenshot` |
| Network        | `route`, `authenticate`, `setExtraHeaders`, `setCacheEnabled`, `setOffline`, `waitForResponse`, `responses`, `enable`, `networkEnabled`                                                                 |
| Route          | `request`, `continue`, `fulfill`, `abort`；只能处理一次，handler 未处理时默认 continue                                                                                                                  |
| Download       | `guid`, `url`, `suggestedFilename`, `status`, `updates`, `path`, `saveAs`, `cancel`                                                                                                                     |
| Mouse          | `move`, `click`, `wheel`, `drag`；顶层视口 CSS 坐标                                                                                                                                                     |
| Keyboard       | `insertText`, `type`, `down`, `up`, `press('Control+A')`                                                                                                                                                |
| JSHandle       | `jsonValue`, `dispose`, `Symbol.asyncDispose`                                                                                                                                                           |
| Session        | `send`, `sendWith`, `on`, `onAny`, `waitFor`, `disconnected`, `id`, `closed`                                                                                                                            |
| Transport      | WebSocket / Pipe；自定义传输实现 `send`, `close`, `onmessage`, `onclose`                                                                                                                                |

输入策略与 `InputReport` 见 [输入](input.md)，环境采样、诊断与对齐见 [环境](environment.md)。

## 期限与取消

`WaitOptions` 由毫秒 `timeout` 和 `AbortSignal` 组成。0 表示立即到期，不表示无限等待。

| 操作                                           | 默认期限                                                 |
| ---------------------------------------------- | -------------------------------------------------------- |
| 启动或连接 Chrome 并完成 CDP 握手              | 30 秒                                                    |
| 单条协议命令                                   | 30 秒；`launch({ timeout })` 同时设置启动/握手与命令期限 |
| `waitForSelector`、`waitForFunction`、动作轮询 | 10 秒，轮询间隔 50 毫秒                                  |
| `inspectEnvironment`                           | 5 秒                                                     |

`sendWith(method, { timeout, signal }, ...params)` 为单条命令设置期限与取消。多步骤操作共用一个预算：选择器查询的执行上下文等待和其中每个 DOM/Runtime 请求只使用剩余时间，`waitForSelector()` / `waitForFunction()` 的各次尝试也共用总预算。执行上下文的查找由并发调用者共享，单个调用者到期或取消只结束自己的等待。查询的对象组释放有独立的 1 秒期限，不推迟调用者返回。

宿主侧的期限或取消只停止等待，已发出的 CDP 命令、已执行的页面脚本和已派发的输入不会撤销或重放。

## 导航与事件等待

导航默认等待 `load`，另支持 `domcontentloaded`、`commit` 和 `networkidle`（Chrome 生命周期事件 networkIdle）。SPA/hash 导航以同文档导航事件完成，BFCache 恢复以恢复事件完成。

导航、下载、弹窗和响应等待须在触发动作之前注册。关闭的 session 会拒绝其上的请求和事件等待，迟到的响应被丢弃。页面崩溃后可调用 `reload()` 恢复，旧句柄保持失效。连接断开后应建立新连接；框架不重放脚本或输入。

## 查询

- 选择器为 CSS 字符串、`{ css }`、`{ xpath }` 或 `{ text, exact? }`。
- CSS 和文本查询默认穿透 open 与 closed shadow root，`pierce: false` 关闭。XPath 遵循标准语义，不穿越 shadow root。
- 文本匹配折叠空白，默认只返回可见、且不包含同样匹配子元素的最小元素。
- `Frame.query()` 只查所选 frame，不跨 iframe；`Element.query()` 限定在该元素子树。
- 查询在随机命名的隔离世界中一次遍历文档与 open shadow root。默认穿透时用 `DOM.getDocument` 识别 closed shadow root：没有发现时，同一文档在无结构变化的 1 秒内复用该结论；发现时缓存到 DOM 结构变化，再把这些根一并交给同一次遍历。
- `QueryOptions` 接受 `pierce`、`visible`、`limit`、`timeout`、`signal`。轮询不适合对大页面做高频全量抓取。

## 求值与执行世界

`evaluate()` 默认在 main world 执行，`{ world: 'isolated' }` 使用隔离世界；DOM 辅助操作始终使用随机命名的隔离世界。隔离世界与页面共享 DOM，页面能观察 DOM 变化和输入事件。

函数参数在浏览器中执行，不能捕获宿主闭包；参数以单个可序列化值传递，`JSHandle` 可作为参数。用户脚本异常抛出 `EvaluationError`。字符串形式的 `evaluate` / `evaluateHandle` 可传正数 `executionTimeout`（毫秒），对应 `Runtime.evaluate.timeout`，只限制初始同步执行，不能终止已安排的定时器、请求或异步续体，也不是资源沙箱。

框架不调用 `Runtime.enable`：主世界通过所属 frame 的 Document 与 `DOM.resolveNode` 解析并校验，详见 [自动化痕迹审计](automation-audit.md)。因此不能等待默认未启用的 Runtime 事件；显式 `cdp.send('Runtime.enable')` 会改变这一点及检测面。`addInitScript()` 应在 `goto()` 前注册；新 OOPIF 在暂停状态下完成初始化后恢复，有 watchdog 兜底。已经开始执行的 popup 或外部页面没有首段脚本前注入保证。

## 启动与连接

| 选项                              | 行为                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `headless`                        | 默认 `false`。无图形桌面时须显式 `true`；显示环境不可用时不会自动切换                                                                          |
| `maskHeadless`                    | headless 且未指定 `userAgent` 时默认开启，去掉 UA 与 UA-CH 中的 HeadlessChrome                                                                 |
| `automationControlled`            | 默认 `false`：加入 `--disable-blink-features=AutomationControlled`（与调用者的其他禁用特性合并），webdriver getter 保持原生；`true` 不加该开关 |
| `preset: 'agent'`                 | 追加 `AGENT_ARGS`：关闭首次运行、搜索引擎选择、崩溃恢复气泡与后台节流                                                                          |
| `userAgent`、`lang`、`windowSize` | 启动时设置 UA、BCP 47 语言和窗口尺寸                                                                                                           |
| `userDataDir`                     | 持久 profile，由 `acquireProfileLock()` 加锁（见下文）                                                                                         |
| `handleSignals`                   | 默认不接管宿主信号；`true` 时为自有进程注册 SIGINT/SIGTERM 清理                                                                                |

持久 profile 的锁文件记录 PID 与主机名，只有确认本机持有进程已退出时才回收陈旧锁；回收过程由独立的 `.nodriver.lock.reclaim` 文件互斥。若回收期间进程被强杀而留下该文件，会明确报错，确认记录的进程已退出后再手动删除。profile 中残留的 `DevToolsActivePort`（Chrome 未正常退出时留下，例如 MCP 宿主强制结束了服务进程）会被探测：记录的端口上仍有同一浏览器在服务时拒绝启动，无响应时删除该文件后继续。启动失败且 Chrome 已退出时，错误包含退出码与 stderr。

`Browser.connect({ endpoint, attach })` 连接已有浏览器：`'all'`（默认）附加全部标签页，`'created'` 只附加本客户端创建的标签页及其弹出页。启动参数对已连接的浏览器无效，`close()` 只断开连接。

`await using` 在正常退出和异常展开时关闭资源，`close()` 幂等。宿主被强制终止或断电时，JavaScript 无法保证清理。

## 输入与元素操作

- 点击前滚动到视口，检查可见、启用、位置稳定和命中，不自动重放已经派发的动作。
- `fill()` 支持可编辑 input、textarea 和 contenteditable，通过焦点/选择区和 `Input.insertText` 写入 Unicode，只承诺最终文本和浏览器 input 语义，不模拟 OS IME 候选窗或剪贴板。
- `select()` 通过 DOM 改值并派发 input/change。
- 物理按键支持命名键、F1–F12、修饰键组合与 US 布局字符（含上档符号）。
- `Mouse.drag()` 是指针拖动，复杂 HTML5 DataTransfer 需要自行使用协议扩展。

## 截图、PDF 与错误

`screenshot()` 返回 Buffer，`path` 可选。元素截图适用于轴对齐元素，旋转/透视元素请用页面截图加显式 clip。`pdf()` 依赖 Chrome 的 headless 打印能力。权限问题、实验性命令和不同浏览器实现的差异以 `ProtocolError` 暴露，不统一视为不支持。

## 网络

`Network.enable` 只在需要时发送：订阅 `responses`、调用 `waitForResponse`、显式 `enable()`，或设置非默认 headers/cache/offline。`route()` 和 `authenticate()` 只使用 Fetch 域。路由覆盖所选 Tab 及其 OOPIF，不覆盖 Service Worker、浏览器自身请求和其他 Tab。响应的 `body()` 须在内容可用后调用；缓存被驱逐或发生重定向时 CDP 可能拒绝。

## 状态与存储

BrowserContext 之间的 Cookie 与存储相互隔离；这不等于独立的操作系统、GPU 或字体环境。

`storageState(path?)` 保存 Cookie，以及该上下文中任一 frame 访问过的 HTTP(S) origin 的第一方 localStorage，包括 iframe 和已关闭标签页用过的 origin；空存储不导出。跨站 iframe 在其他顶层站点下的分区 localStorage、sessionStorage 和 IndexedDB 不在快照内。仍打开的主页面原地读取，其余 origin 在一个临时标签页中读取。

`restoreStorage(state)` 先设置 Cookie，再替换列出的各 origin 的 localStorage：该 origin 仍打开的主页面原地写入，返回时即可读到；其余 origin 在一个临时标签页中写入。临时标签页拦截文档请求、返回空白页并绕过 Service Worker，因此不访问站点、不跟随重定向、不运行站点脚本。同一 origin 的其他已打开文档与浏览器中跨标签页写入一样，异步收到变更。

`Frame.storage(kind = 'local', origin?)` 与 `Frame.setStorage(values, kind = 'local', clear = false, origin?)` 可指定预期 origin：读取、清空与写入和 `location.origin` 检查在同一段脚本中执行，不匹配时抛出 `EvaluationError`，页面存储保持不变。

Cookie 快照与状态文件包含凭证，存放位置由调用者负责。

## 协议与追踪

严格的命令参数元组与返回、事件类型来自固定版本的 `devtools-protocol`。事件按 session 路由：`session.on(method, listener)` 和 `session.onAny(listener)` 只接收该 session 的事件，先于全局 `connection.events` 执行；`connection.listenerCount` 汇总两者。

`Connection` 选项 `trace: true` 把每条命令的方法、session、耗时和错误码写到 stderr；传函数则接收 `TraceEntry`。环境变量 `NODRIVER_TRACE=1` 等价于 `true`。参数和结果从不记录。
