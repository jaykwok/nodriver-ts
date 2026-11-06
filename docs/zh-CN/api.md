# API 与行为约定

[English](../api.md)

除只读属性和事件订阅外，所有操作都是异步的。公开类型从根入口 `nodriver-ts` 导出，构建产物附带 `.d.ts`；CDP 类型来自随包安装的 `devtools-protocol`。

自行管理 CDP 的应用可用 `attach: 'none'` 和 `browser.attachSession(targetId, options)`。`TargetSession` 继承 `Session`，新增 `targetId`、`ended`、`endReason`、`detach()`。生命周期、取消、`observe.onSend` / `onSettle` / `onResponse` 和 `connection.unansweredCount` 见 [原始 session 契约](raw-sessions.md)。

## 入口

| 入口                     | 导出                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `nodriver-ts`            | Browser、BrowserContext、Tab、Frame、Element、Network、输入、环境诊断、错误类型，以及 `InputPolicy`、`InputReport` 等配套类型 |
| `nodriver-ts/mcp`        | `createBrowserMcpServer`、`BrowserSessionManager`、`MCP_PROTOCOL_VERSION`，见 [MCP](mcp.md)                                   |
| `nodriver-ts/mcp/http`   | `startBrowserMcpHttpServer`、`createBrowserMcpHttpService`，见 [HTTP 接入](mcp-http.md)                                       |
| `nodriver-ts/mcp/socket` | `startBrowserMcpSocketServer`、`BrowserMcpSocketClientTransport`，见 [socket 接入](mcp-socket.md)                             |
| `nodriver-ts/mcp/compat` | `serveCompatibleBrowserMcpStdio`、`createCompatibleBrowserMcpHttpEndpoint`，见[通用 Agent 兼容](agent-compatibility.md)       |
| `nodriver-ts/testing`    | `ScriptedChrome`、`NO_REPLY` 及相关类型，主入口不导出它们，见[脚本化测试](testing.md)                                         |

## 对象

| 对象              | 高层入口                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser           | `launch`, `connect`, `newTab`, `newContext`, `tabScope`, `tabs`, `contexts`, `defaultContext`, `version`, `owned`, `closed`, `endpoint`, `process`, `connection`, `close`, `disconnect`, `release`, `drain`, `waitForTab`, `pageTargets`, `targetInfo`, `attachTarget`, `attachSession`, `inputScope`, `setDefaultInputPolicy`, `presentationLease`, `errors`, `cdp` |
| BrowserContext    | `newTab`, `tabScope`, `tabs`, `cookies`, `setCookies`, `clearCookies`, `clearSiteData`, `saveCookies`, `loadCookies`, `storageState`, `restoreStorage`, `grantPermissions`, `resetPermissions`, `setDownloadDirectory`, `setDefaultInputPolicy`, `close`                                                                                                             |
| Tab               | `goto`, `reload`, `go(delta)`, `waitForNavigation`, `stopLoading`, `bringToFront`, `activate`, `windowBounds`, `url`, `closed`, `crashed`, `mainFrame`, `frames`, `network`, `mouse`, `keyboard`, `waitForPopup`, `handleDialog`, `setInputPolicy`, `close`                                                                                                          |
| Tab 文件/环境     | `setContent`, `screenshot`, `pdf`, `resources`, `resourceContent`, `setEnvironment`, `addInitScript`, `waitForDownload`, `inspectEnvironment`, `diagnoseEnvironment`, `alignEnvironment`                                                                                                                                                                             |
| Tab / Frame       | `evaluate`, `evaluateHandle`, `fetch`, `locator`, `query`, `queryAll`, `waitForSelector`, `waitForFunction`, `content`                                                                                                                                                                                                                                               |
| Frame             | `parent`, `children`, `session`, `url`, `generation`, `storage`, `setStorage`, `inspectEnvironment`                                                                                                                                                                                                                                                                  |
| Element           | `frame`, `text`, `html`, `attribute`, `describe`, `evaluate`, `withObject`, `query`, `queryAll`, `focus`, `click`, `hover`, `scrollIntoView`, `clickablePoint`, `fill`, `type`, `select`, `setChecked`, `upload`, `screenshot`                                                                                                                                       |
| Locator           | `element`, `count`, `click`, `hover`, `fill`, `type`, `setChecked`, `text`, `attribute`                                                                                                                                                                                                                                                                              |
| TabScope          | `newTab`, `adopt`, `keep`, `tabs`, `closed`, `close`                                                                                                                                                                                                                                                                                                                 |
| Network           | `route`, `authenticate`, `setExtraHeaders`, `setCacheEnabled`, `setOffline`, `waitForResponse`, `responses`, `enable`, `networkEnabled`                                                                                                                                                                                                                              |
| Route             | `request`, `continue`, `fulfill`, `abort`；只能应答一次，处理函数未应答时默认放行（见[网络](#网络)）                                                                                                                                                                                                                                                                 |
| Download          | `guid`, `url`, `suggestedFilename`, `status`, `updates`, `path`, `saveAs`, `cancel`                                                                                                                                                                                                                                                                                  |
| Mouse             | `position`, `move`, `down`, `up`, `click`, `wheel`, `drag`；顶层视口 CSS 坐标                                                                                                                                                                                                                                                                                        |
| Keyboard          | `insertText`, `type`, `down`, `up`, `press('Control+A')`, `pressedKeys`, `compose`                                                                                                                                                                                                                                                                                   |
| JSHandle          | `jsonValue`, `dispose`, `Symbol.asyncDispose`                                                                                                                                                                                                                                                                                                                        |
| Session           | `send`, `sendWith`, `on`, `onAny`, `waitFor`, `disconnected`, `id`, `closed`, `closeReason`                                                                                                                                                                                                                                                                          |
| TargetSession     | `Session` 加 `targetId`, `ended`, `endReason`, `detach`，见 [原始 session 契约](raw-sessions.md)                                                                                                                                                                                                                                                                     |
| Connection        | `session`, `drain`, `pendingCount`, `unansweredCount`, `listenerCount`, `events`, `closed`, `closeReason`, `close`                                                                                                                                                                                                                                                   |
| InputScope        | `session`, `run`（回调接收 `mouse`, `keyboard`, `composition`, `wait`）, `recoverComposition`，见[输入](input.md)                                                                                                                                                                                                                                                    |
| Composition       | `update`, `commit`, `cancel`，见[输入](input.md)                                                                                                                                                                                                                                                                                                                     |
| PresentationLease | `state`, `report`, `start`, `close`，见 [原始 session 契约](raw-sessions.md)                                                                                                                                                                                                                                                                                         |
| ProxyForwarder    | `create`, `close`，见[环境](environment.md)                                                                                                                                                                                                                                                                                                                          |
| Transport         | WebSocket / Pipe；自定义传输实现 `send`, `close`, `onmessage`, `onclose`                                                                                                                                                                                                                                                                                             |
| 错误              | `NodriverError` 是 `TimeoutError`、`DisconnectedError`（及其子类 `SessionEndedError`）、`ProtocolError`、`EvaluationError`、`FetchCancelledError`、`StaleElementError`、`ActionabilityError`、`UnsupportedError`、`ProfileInUseError`、`ReleaseUncertainError`、`InputActionError`、`InputBlockedError` 的基类                                                       |
| 函数              | `findExecutable`, `acquireProfileLock`, `updateProfileSettings`, `getStartupDiagnostics`, `createInputScope`, `createPresentationLease`, `keyDefinition`, `parseChord`                                                                                                                                                                                               |

有些命令只能发给 browser、page 或 frame 会话中的某一种，因此 `ProtocolError` 会注明命令发往的会话：`sessionId`（browser 会话没有此字段）、`targetType`（`browser`、`page`、`iframe`、`worker` 等），以及消息末尾的说明，例如 `Storage.clearDataForOrigin: Internal error [browser session]`。`protocolMessage` 只包含 Chrome 返回的消息。

输入策略与 `InputReport` 见 [输入](input.md)，环境采样、诊断与对齐见 [环境](environment.md)。

## 期限与取消

`WaitOptions` 由毫秒 `timeout` 和 `AbortSignal` 组成。超时时间超出 0–2147483647 毫秒时抛出 `RangeError`；0 表示立即到期，不表示无限等待。

| 操作                                           | 默认期限                                                 |
| ---------------------------------------------- | -------------------------------------------------------- |
| 启动或连接 Chrome 并完成 CDP 握手              | 30 秒                                                    |
| 单条协议命令                                   | 30 秒；`launch({ timeout })` 同时设置启动/握手与命令期限 |
| `waitForSelector`、`waitForFunction`、动作轮询 | 10 秒，轮询间隔 50 毫秒                                  |
| `inspectEnvironment`                           | 5 秒                                                     |
| `diagnoseEnvironment`、`alignEnvironment`      | 10 秒                                                    |

`sendWith(method, { timeout, signal }, ...params)` 为单条命令设置期限与取消。多步骤操作共用一个预算：选择器查询的每一步（执行上下文等待和其中每个 DOM/Runtime 请求）只使用剩余时间，`waitForSelector()` / `waitForFunction()` 的每次尝试也是如此。并发调用者共享同一次执行上下文查找，到期或被取消的调用者只结束自己的等待。查询的对象组释放有独立的 1 秒期限，不推迟调用者返回。

宿主侧的期限或取消只停止等待，已发出的 CDP 命令、已执行的页面脚本和已派发的输入不会撤销或重放。

## 导航与事件等待

导航默认等待 `load`，另支持 `domcontentloaded`、`commit` 和 `networkidle`（Chrome 生命周期事件 networkIdle）。SPA/hash 导航以同文档导航事件完成，BFCache 恢复以恢复事件完成。新文档提交后，`history.replaceState()` 等同文档变更只更新等待返回的 URL，等待仍在所请求的生命周期事件结束。`reload()` 只随新文档完成；`go()` 的同文档历史导航只在页面到达该条目的 URL 时完成。

导航、下载、弹窗和响应等待须在触发动作之前注册。关闭的 session 会拒绝其上的请求和事件等待，迟到的响应被丢弃。`tab.crashed` 表示页面自身的渲染进程崩溃；进程外 iframe 崩溃不会设置它。`reload()` 或 `goto()` 可恢复崩溃的页面：主 frame 的新文档会清除该标志，旧句柄保持失效。连接断开后应建立新连接；框架不重放脚本或输入。

## 查询

- 选择器为 CSS 字符串、`{ css }`、`{ xpath }` 或 `{ text, exact? }`。
- CSS 和文本查询默认穿透 open 与 closed shadow root，`pierce: false` 关闭。XPath 遵循标准语义，不穿越 shadow root。
- 文本匹配折叠空白，默认只返回可见、且不包含同样匹配子元素的最小元素。
- `Frame.query()` 只查所选 frame，不跨 iframe；`Element.query()` 限定在该元素子树。
- 查询在随机命名的隔离世界中一次遍历文档与 open shadow root。默认穿透时用 `DOM.getDocument` 识别 closed shadow root：没有发现时，同一文档在无结构变化的 1 秒内复用该结论；发现时缓存到 DOM 结构变化，再把这些根一并交给同一次遍历。
- `tab.locator(selector, options?)` 与 `frame.locator()` 返回 `Locator`：每次操作（`click`、`hover`、`fill`、`type`、`setChecked`、`text`、`attribute`）之前都会重新查询，因此单页应用重新渲染元素后，操作仍作用于当前元素。一个超时同时覆盖查找元素和操作本身。若元素在操作发出按下、按键或文本之前被替换，操作会在新的匹配元素上重新执行；一旦这类输入已经发出，失败会直接报告，绝不重复执行。`element()` 等待第一个匹配元素，`count()` 统计当前匹配数。
- `QueryOptions` 接受 `pierce`、`visible`、`limit`（默认最多 10,000 个匹配）、`timeout`、`signal`。轮询不适合对大页面做高频全量抓取。

## 求值与执行世界

`evaluate()` 默认在主世界执行，`{ world: 'isolated' }` 使用隔离世界；DOM 辅助操作始终使用随机命名的隔离世界。隔离世界与页面共享 DOM，页面能观察 DOM 变化和输入事件。

函数参数在浏览器中执行，不能捕获宿主闭包；参数以单个可序列化值传递，`JSHandle` 可作为参数。用户脚本异常抛出 `EvaluationError`。字符串形式的 `evaluate` / `evaluateHandle` 可传正数 `executionTimeout`（毫秒），对应 `Runtime.evaluate.timeout`，只限制初始同步执行，不能终止已安排的定时器、请求或异步续体，也不是资源沙箱。`Element.withObject(fn)` 以隔离世界中的元素句柄运行 `fn(objectId, group)`；`fn` 在 `group` 中创建的对象随句柄一起释放。

框架不调用 `Runtime.enable`：主世界通过所属 frame 的 Document 与 `DOM.resolveNode` 解析并校验，详见 [自动化痕迹审计](automation-audit.md)。因此不会收到 Runtime 事件；自行通过 `cdp` 发送 `Runtime.enable` 可以收到，但会改变检测面。`addInitScript()` 应在 `goto()` 前注册；新 OOPIF 在暂停状态下完成初始化后恢复，有看门狗兜底。已经开始执行的弹出页或外部页面没有首段脚本前注入保证。

## 启动与连接

| 选项                              | 行为                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headless`                        | 默认 `false`。无图形桌面时须显式 `true`；显示环境不可用时不会自动切换                                                                                                                                                                                                                                                           |
| `maskHeadless`                    | 默认关闭；显式 true 且未指定 `userAgent` 时去掉页面 UA/UA-CH 中的 HeadlessChrome，Shared/Service Worker 可能不一致                                                                                                                                                                                                              |
| `automationControlled`            | 默认 `false`：加入 `--disable-blink-features=AutomationControlled`（与调用者的其他禁用特性合并），webdriver getter 保持原生；`true` 不加该开关                                                                                                                                                                                  |
| `preset: 'agent'`                 | 追加 `AGENT_ARGS`（`args` 已设置同一开关时以其为准）：关闭搜索引擎选择页、崩溃恢复气泡和后台节流，并设置 `--password-store=basic`。在 Linux 上，Chrome 随后改用内置密钥而不是系统密钥环来加密已保存的密码和 cookie，不会弹出密钥环提示；通过密钥环加密过数据的持久 profile 将无法读取这些数据。首次运行界面在任何启动中都已关闭 |
| `userAgent`、`lang`、`windowSize` | 启动时设置 UA、BCP 47 语言和窗口尺寸                                                                                                                                                                                                                                                                                            |
| `userDataDir`                     | 持久 profile，由 `acquireProfileLock()` 加锁（见下文）                                                                                                                                                                                                                                                                          |
| `prepareProfile`                  | 在 Chrome 启动之前调用，参数为 profile 目录，用于通过 `updateProfileSettings()` 写入或检查 `Local State` 等文件：临时 profile 在库准备好之后调用，`userDataDir` 在本进程持有其锁期间调用。受启动超时约束，它收到的取消信号在超时时也会中止。调用失败时启动终止                                                                  |
| `inputPolicy`                     | 所有标签页的输入策略，包括启动时的标签页和弹出页；见[输入](input.md#新标签页的默认策略)                                                                                                                                                                                                                                         |
| `handleSignals`                   | 默认不接管宿主信号。设为 `true` 时，SIGINT 和 SIGTERM 会关闭所有以该选项启动的浏览器；之后重新发出信号，使宿主按默认方式终止，除非宿主自己处理该信号                                                                                                                                                                            |
| `detached`                        | 默认 `false`；`true` 允许 Windows/Unix 独立启动与 `release()`，仅支持 WebSocket；未设置 `supervised` 时丢弃 Chrome stderr                                                                                                                                                                                                       |
| `supervised`                      | 配合 `detached: true`：宿主在 `release()` 前死亡时由辅助进程结束 Chrome，并保留有界的 stderr 尾部，见[监管启动](lifecycle-ownership-design.md)                                                                                                                                                                                  |
| `trace`                           | 与 `connect` 相同：布尔值或回调，见[协议与追踪](#协议与追踪)                                                                                                                                                                                                                                                                    |

持久 profile 的锁文件记录 PID 与主机名，只有确认本机持有进程已退出时才回收陈旧锁；回收过程由独立的 `.nodriver.lock.reclaim` 文件互斥。若回收期间进程被强杀而留下该文件，会明确报错，确认记录的进程已退出后再手动删除。profile 中残留的 `DevToolsActivePort`（Chrome 未正常退出时留下，例如 MCP 宿主强制结束了服务进程）会被探测：记录的浏览器仍在该端口上应答时拒绝启动，否则删除该文件后继续。启动失败且 Chrome 已退出时，错误包含退出码与 stderr。

`Browser.connect({ endpoint, attach })` 连接已有浏览器：`'all'`（默认）附加全部标签页，`'created'` 只附加本客户端创建的标签页及其弹出页。启动参数对已连接的浏览器无效，`close()` 只断开连接，同时结束本连接用 `proxy` 创建的上下文（见[环境](environment.md#代理与-webrtc)）。

确认同机 `.nodriver.lock` 持有进程仍存活、其他进程抢先回收了陈旧锁，或 `DevToolsActivePort` 仍由原浏览器提供服务时，抛出带 `profile` 路径的 `ProfileInUseError`。Windows 另探测 Chrome 原生 `lockfile` 的共享冲突（`EBUSY`），因此未开放调试端口的已运行 Chrome 也会得到该错误；未锁定的残留文件和权限错误都不算占用。Unix 不检查原生 `SingletonLock`/`SingletonSocket`，未开放调试端口时可能得到普通的启动退出错误。

`await using` 在正常退出和异常展开时关闭资源，也可使用 `try/finally` 与 `close()`。`close()` 幂等，失败后可再次调用。未设置 `detached` 启动的 Chrome 也会在宿主退出时结束，包括 `process.exit()` 和未捕获异常。宿主被强制终止或断电时，JavaScript 无法保证清理；这种情况下的遗留见[浏览器交接与事件](browser-handoff.md)。

`await browser.release()` 返回 WebSocket 端点并放弃进程所有权，之后 `owned` 为 `false`，`close()` 与异步析构只断开连接。自有浏览器必须以 `detached: true` 启动；pipe 会明确拒绝交接且不改变连接。交接保留 profile（临时 profile 也保留）与 `DevToolsActivePort`，移除记录宿主 PID 的 `.nodriver.lock`。`disconnect()` 不放弃所有权，pipe Chrome 在管道断开时会退出。未设置 `supervised` 时，交接前宿主崩溃可能遗留 Chrome。完整示例、清理责任和事件接口见[浏览器交接与事件](browser-handoff.md)。

## 输入与元素操作

- 点击前滚动到视口，检查可见、启用、位置稳定和命中。禁用的 `<fieldset>` 内的控件视为禁用；命中元素的 shadow 树或其包含的 frame 时，视为命中该元素。不自动重放已经派发的动作。
- `fill()` 支持可编辑 input、textarea 和 contenteditable，通过焦点/选择区和 `Input.insertText` 写入 Unicode，只承诺最终文本和浏览器 input 语义，不模拟 OS IME 候选窗或剪贴板。
- `select()` 通过 DOM 改值并派发 input/change。
- 物理按键支持命名键、F1–F12、修饰键组合与 US 布局字符（含上档符号）。
- `Mouse.drag()` 是指针拖动，复杂 HTML5 DataTransfer 需要自行使用协议扩展。
- 取消和超时会以 `InputActionError` 拒绝，其 `cleanup` 报告按住的键和鼠标按钮如何释放。元素输入在元素所在 frame 或任一祖先 frame 导航或分离时停止；Tab 上直接调用的鼠标/键盘输入只监视主 frame。
- `browser.inputScope(session)` 和 `createInputScope(session)` 把鼠标、键盘和组合输入放在同一个截止时间和报告下，详见[输入](input.md)。

## 截图、PDF 与错误

`screenshot()` 返回 Buffer，`path` 可选。元素截图适用于轴对齐元素，旋转/透视元素请用页面截图加显式 clip。`pdf()` 依赖 Chrome 的 headless 打印能力。权限问题、实验性命令和不同浏览器实现的差异以 `ProtocolError` 暴露，不统一视为不支持。

## 网络

`Network.enable` 只在需要时发送：订阅 `responses`、调用 `waitForResponse`、显式 `enable()`，或设置非默认请求头/缓存/离线。每次订阅或调用 `enable()` 都会重试失败的设置，已成功的设置不会重复发送。`route()` 和 `authenticate()` 只使用 Fetch 域；任一 session 上 Chrome 拒绝变更时，二者会拒绝并恢复之前的路由或凭证。`setExtraHeaders()` 在发送前以 `TypeError` 拒绝无效的请求头名称和值。请求头、缓存和离线 设置只有在 Chrome 接受后才会保留，并应用到之后的 session。调用期间关闭的 session 会被跳过。

`tab.fetch(url, options?)` 与 `frame.fetch()` 在 frame 的隔离世界中运行 `fetch()`，因此请求使用页面的 Cookie、源、代理和网络栈，相对 URL 按页面地址解析；页面脚本无法看到或替换它。选项包括常规请求字段（`method`、`headers`、`body`、`credentials`、`mode`、`redirect`、`referrer`、`referrerPolicy`）、`responseType`（`text`、`json` 或 `base64`）以及 `maxBytes`（默认 10 MiB，响应体超出时中止并拒绝）。任何状态码都解析为 `{ url, status, statusText, ok, redirected, type, headers, body }`；网络错误以 `EvaluationError` 拒绝。超时（默认 30 s）或中止时，页面中的请求也会被中止，调用以 `FetchCancelledError` 拒绝：`aborted` 为 `true` 表示页面请求已中止或随其文档结束；为 `false` 表示请求已经完成或无法触达，此时服务器可能已经收到请求。Service Worker 和页面的资源计时仍能观察到该请求。

路由处理函数在应答前抛错时，错误经 `onError` 和 `browser.errors` 上报，请求被中止。Chrome 拒绝的应答以 `ProtocolError` 拒绝，路由保持可应答：处理函数可以再次应答，未应答的请求会被放行。对 Chrome 已不再持有的请求（页面已取消或路由已移除）的应答直接完成，不产生效果。路由覆盖所选 Tab 及其 OOPIF，不覆盖 Service Worker、浏览器自身请求和其他 Tab。响应的 `body()` 须在内容可用后调用；缓存被驱逐或发生重定向时 CDP 可能拒绝。

## 标签页作用域

`browser.tabScope()` 与 `context.tabScope()` 在与其他工作共享的浏览器中，把一个任务的页面归为一组。作用域拥有通过 `scope.newTab()` 打开的标签页、传给 `adopt()` 的标签页，以及它们（逐级）打开的弹出页。`keep(tab)` 把某个页面移出作用域，例如留给人工处理的页面；它之后打开的弹出页不归作用域所有。`close()`（也可通过 `await using` 调用）先等待仍在通过作用域打开的标签页，再关闭所有归属页面，包括期间新打开的弹出页和尚未附加的弹出页，其他标签页保持打开。在 `close()` 开始之后才完成的 `newTab()` 会关闭其标签页并拒绝。结果列出已关闭和已保留的标签页 ID；无法关闭的页面以 `AggregateError` 拒绝。用 `noopener` 打开的弹出页在 Chrome 中仍会报告其打开者；由已保留或无关标签页打开的弹出页永远不归作用域所有。

```ts
await using scope = browser.tabScope();
const tab = await scope.newTab('https://example.com');
// ... 任务打开的弹出页随作用域一起关闭
scope.keep(reviewTab); // 留给人工处理
```

## 状态与存储

BrowserContext 之间的 Cookie 与存储相互隔离；这不等于独立的操作系统、GPU 或字体环境。

`storageState(path?)` 保存 Cookie，以及该上下文中任一 frame 访问过的 HTTP(S) 源的第一方 localStorage，包括 iframe 和已关闭标签页用过的源；空存储不导出。跨站 iframe 在其他顶层站点下的分区 localStorage、sessionStorage 和 IndexedDB 不在快照内。仍打开的主页面原地读取，其余源在一个临时标签页中读取。

`restoreStorage(state)` 先设置 Cookie，再替换列出的各源的 localStorage：该源仍打开的主页面原地写入，返回时即可读到；其余源在一个临时标签页中写入。临时标签页拦截文档请求、返回空白页并绕过 Service Worker，因此不访问站点、不跟随重定向、不运行站点脚本。同一源的其他已打开文档与浏览器中跨标签页写入一样，异步收到变更。

`clearSiteData({ domains, origins, types, openTabs })` 删除部分站点的数据，保留上下文中的其他数据，例如退出某个站点的登录，同时保持另一个站点的登录：

```ts
const result = await context.clearSiteData({ domains: ['platform.example'], openTabs: 'blank' });
// { cookies: [{ name, domain, path }], origins: [...], tabs: [...] }
```

- **匹配**：`domains` 覆盖每个域名及其子域名；`origins` 指定精确的 HTTP(S) 源。Cookie 按其域名匹配：属于所列域名、源的主机名或它们的子域名的 Cookie 会被删除，分区在这些站点之下的 Cookie 也会被删除。父域名的 Cookie（例如 `platform.example` 的 `.example`）由同级站点共享，除非列出父域名，否则保留。
- **类型**：`types` 可选 `cookies`、`localStorage`、`sessionStorage`、`indexedDB`、`cacheStorage` 和 `serviceWorkers`，默认全部。存储的清理范围为：所列的每个源、每个所列域名的 `http://` 与 `https://`，以及该上下文中任一 frame 提交过的、位于所列域名下的每个源。同一域名下的其他源（例如持久 profile 上一次运行留下的源）只有列入 `origins` 才会清理。sessionStorage 只存在于打开的标签页中，因此只在 `openTabs: 'blank'` 处理的标签页中清理。
- **打开的标签页**：含有匹配站点 frame 的标签页可能把数据重新写回。`openTabs: 'fail'`（默认）在清理任何数据之前抛出错误并列出这些标签页；`'close'` 关闭它们；`'blank'` 将它们导航到 about:blank。调用期间新打开的标签页不在处理范围内。
- **结果**：已删除的 Cookie（不含值）、已清理存储的源，以及被关闭或置空的标签页。删除后若仍存在匹配的 Cookie，调用抛出 `NodriverError`。

Chrome 在 browser 会话上执行 `Storage.clearDataForOrigin` 会返回 `Internal error`，因此这些命令发往该上下文中某个已打开标签页的会话；没有打开的标签页时，使用一个临时空白标签页。这些命令不会改变该页面。

`Frame.storage(kind = 'local', origin?)` 与 `Frame.setStorage(values, kind = 'local', clear = false, origin?)` 可指定预期源：读取、清空与写入和 `location.origin` 检查在同一段脚本中执行，不匹配时抛出 `EvaluationError`，页面存储保持不变。

Cookie 快照与状态文件包含凭证，存放位置由调用者负责。

## 协议与追踪

严格的命令参数元组与返回、事件类型来自固定版本的 `devtools-protocol`。事件按 session 路由：`session.on(method, listener)` 和 `session.onAny(listener)` 只接收该 session 的事件，先于全局 `connection.events` 执行；`connection.listenerCount` 汇总两者。

`launch()`、`connect()` 和 `Connection` 的 `trace` 选项接受 `true` 或函数：`true` 把每条命令的方法、session、耗时和错误码（或错误名）写到 stderr，函数则接收 `TraceEntry`。未设置该选项时，`NODRIVER_TRACE=1`（或 `true`）开启追踪；`trace: false` 始终关闭追踪。参数和结果从不记录。
