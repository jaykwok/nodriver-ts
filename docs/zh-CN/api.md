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
| TabScope          | `newTab`, `adopt`, `borrow`, `keep`, `tabs`, `closed`, `close`                                                                                                                                                                                                                                                                                                       |
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
| XvfbSession       | `start`, `display`, `env`, `stop`，见[虚拟显示](#虚拟显示)                                                                                                                                                                                                                                                                                                           |
| Transport         | WebSocket / Pipe；自定义传输实现 `send`, `close`, `onmessage`, `onclose`                                                                                                                                                                                                                                                                                             |
| 错误              | `NodriverError` 是 `TimeoutError`、`DisconnectedError`（及其子类 `SessionEndedError`）、`ProtocolError`、`EvaluationError`、`FetchCancelledError`、`StaleElementError`、`ActionabilityError`、`UnsupportedError`、`ProfileInUseError`、`ReleaseUncertainError`、`InputActionError`、`InputBlockedError`、`ClearSiteDataError`、`HandoffActiveError` 的基类           |
| 函数              | `findExecutable`, `acquireProfileLock`, `updateProfileSettings`, `getStartupDiagnostics`, `createInputScope`, `createPresentationLease`, `keyDefinition`, `parseChord`, `encryptState`, `decryptState`                                                                                                                                                               |

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

`sendWith(method, { timeout, signal }, ...params)` 为单条命令设置期限与取消。多步骤操作共用一个预算：选择器查询的每一步（执行上下文等待和其中每个 DOM/Runtime 请求）只使用剩余时间，`waitForSelector()` / `waitForFunction()` 的每次尝试也是如此。`browser.newTab(url, context, options)`、`context.newTab(url, options)` 与 `scope.newTab(url, options)` 用同一个期限覆盖创建标签页、附加和首次导航；未能打开完成的标签页会被关闭，包括调用者停止等待之后 Chrome 才创建的标签页。期限已过或取消信号已中止时，调用不等待该关闭即返回。并发调用者共享同一次执行上下文查找，到期或被取消的调用者只结束自己的等待。查询的对象组释放有独立的 1 秒期限，不推迟调用者返回。

宿主侧的期限或取消只停止等待，已发出的 CDP 命令、已执行的页面脚本和已派发的输入不会撤销或重放。操作失败或调用者停止等待之后，库所做的清理（例如关闭未能打开完成的标签页、撤销 `clearSiteData()` 在标签页上的设置）不会取代操作本身的错误；清理失败时，通过 `onError` 和 `browser.errors` 报告。

## 导航与事件等待

导航默认等待 `load`，另支持 `domcontentloaded`、`commit` 和 `networkidle`（Chrome 生命周期事件 networkIdle）。SPA/hash 导航以同文档导航事件完成，BFCache 恢复以恢复事件完成。新文档提交后，`history.replaceState()` 等同文档变更只更新等待返回的 URL，等待仍在所请求的生命周期事件结束。如果文档在到达所等待的事件之前被替换，例如登录流程中页面在加载期间提交表单或调用 `location.replace()`，等待会在同一期限内跟随主 frame 的每个新文档，其中任一文档到达该事件时完成。整个过程只发起第一次导航；等待返回完成它的那个文档的 URL。文档若在被替换之前已到达该事件，等待即随它完成。`reload()` 只随新文档完成；`go()` 的同文档历史导航只在页面到达该条目的 URL 时完成。

导航、下载、弹窗和响应等待须在触发动作之前注册。关闭的 session 会拒绝其上的请求和事件等待，迟到的响应被丢弃。`tab.crashed` 表示页面自身的渲染进程崩溃；进程外 iframe 崩溃不会设置它。`reload()` 或 `goto()` 可恢复崩溃的页面：主 frame 的新文档会清除该标志，旧句柄保持失效。连接断开后应建立新连接；框架不重放脚本或输入。

## 查询

- 选择器为 CSS 字符串、`{ css }`、`{ xpath }` 或 `{ text, exact? }`。
- CSS 和文本查询默认穿透 open 与 closed shadow root，`pierce: false` 关闭。XPath 遵循标准语义，不穿越 shadow root。
- 文本匹配折叠空白，默认只返回可见、且不包含同样匹配子元素的最小元素。
- `Frame.query()` 只查所选 frame，不跨 iframe；`Element.query()` 限定在该元素子树。
- 查询在随机命名的隔离世界中一次遍历文档与 open shadow root。默认穿透时用 `DOM.getDocument` 识别 closed shadow root：没有发现时，同一文档在无结构变化的 1 秒内复用该结论；发现时缓存到 DOM 结构变化，再把这些根一并交给同一次遍历。
- `tab.locator(selector, options?)` 与 `frame.locator()` 返回 `Locator`：每次操作（`click`、`hover`、`fill`、`type`、`setChecked`、`text`、`attribute`）之前都会重新查询，因此单页应用重新渲染元素后，操作仍作用于当前元素。同一个超时和取消信号覆盖查找元素和操作本身，读取操作也不例外。若元素在操作发出按下、按键或文本之前被替换，操作会在新的匹配元素上重新执行；一旦这类输入已经发出，失败会直接报告，绝不重复执行。`element()` 等待第一个匹配元素，`count()` 统计当前匹配数。
- `Element.text()`、`html()` 与 `attribute()` 接受 `{ timeout, signal }`。
- `QueryOptions` 接受 `pierce`、`visible`、`limit`（默认最多 10,000 个匹配）、`timeout`、`signal`。轮询不适合对大页面做高频全量抓取。

## 求值与执行世界

`evaluate()` 默认在主世界执行，`{ world: 'isolated' }` 使用隔离世界；DOM 辅助操作始终使用随机命名的隔离世界。隔离世界与页面共享 DOM，页面能观察 DOM 变化和输入事件。

函数参数在浏览器中执行，不能捕获宿主闭包；参数以单个可序列化值传递，`JSHandle` 可作为参数。用户脚本异常抛出 `EvaluationError`。字符串形式的 `evaluate` / `evaluateHandle` 可传正数 `executionTimeout`（毫秒），对应 `Runtime.evaluate.timeout`，只限制初始同步执行，不能终止已安排的定时器、请求或异步续体，也不是资源沙箱。`Element.withObject(fn)` 以隔离世界中的元素句柄运行 `fn(objectId, group)`；`fn` 在 `group` 中创建的对象随句柄一起释放。

框架不调用 `Runtime.enable`：主世界通过所属 frame 的 Document 与 `DOM.resolveNode` 解析并校验，详见 [自动化痕迹审计](automation-audit.md)。因此不会收到 Runtime 事件；自行通过 `cdp` 发送 `Runtime.enable` 可以收到，但会改变检测面。`addInitScript()` 应在 `goto()` 前注册；新 OOPIF 在暂停状态下完成初始化后恢复，有看门狗兜底。已经开始执行的弹出页或外部页面没有首段脚本前注入保证。

## 启动与连接

| 选项                              | 行为                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headless`                        | 默认 `false`。无图形桌面时须显式 `true`；显示环境不可用时不会自动切换                                                                                                                                                                                                                                                                                       |
| `maskHeadless`                    | 默认关闭；显式 true 且未指定 `userAgent` 时去掉页面 UA/UA-CH 中的 HeadlessChrome，Shared/Service Worker 可能不一致                                                                                                                                                                                                                                          |
| `automationControlled`            | 默认 `false`：加入 `--disable-blink-features=AutomationControlled`（与调用者的其他禁用特性合并），webdriver getter 保持原生；`true` 不加该开关                                                                                                                                                                                                              |
| `preset: 'agent'`                 | 追加 `AGENT_ARGS`（`args` 已设置同一开关时以其为准）：关闭搜索引擎选择页、崩溃恢复气泡和后台节流，并设置 `--password-store=basic`。在 Linux 上，Chrome 随后改用内置密钥而不是系统密钥环来加密已保存的密码和 cookie，不会弹出密钥环提示；通过密钥环加密过数据的持久 profile 将无法读取这些数据。首次运行界面在任何启动中都已关闭                             |
| `userAgent`、`lang`、`windowSize` | 启动时设置 UA、BCP 47 语言和窗口尺寸                                                                                                                                                                                                                                                                                                                        |
| `userDataDir`                     | 持久 profile，由 `acquireProfileLock()` 加锁（见 [Profile](#profile)）                                                                                                                                                                                                                                                                                      |
| `prepareProfile`                  | 在 Chrome 启动之前调用，参数为 profile 目录，用于通过 `updateProfileSettings()` 写入或检查 `Local State` 等文件：临时 profile 在库准备好之后调用，`userDataDir` 在本进程持有其锁期间调用。其选项还说明 profile 是否为临时（`temporary`）、是否为空（`empty`），见 [Profile](#profile)。受启动超时约束，它收到的取消信号在超时时也会中止。调用失败时启动终止 |
| `inputPolicy`                     | 所有标签页的输入策略，包括启动时的标签页和弹出页；见[输入](input.md#新标签页的默认策略)                                                                                                                                                                                                                                                                     |
| `handleSignals`                   | 默认不接管宿主信号。设为 `true` 时，SIGINT 和 SIGTERM 会关闭所有以该选项启动的浏览器；之后重新发出信号，使宿主按默认方式终止，除非宿主自己处理该信号                                                                                                                                                                                                        |
| `detached`                        | 默认 `false`；`true` 允许 Windows/Unix 独立启动与 `release()`，仅支持 WebSocket；未设置 `supervised` 时丢弃 Chrome stderr                                                                                                                                                                                                                                   |
| `supervised`                      | 配合 `detached: true`：宿主在 `release()` 前死亡时由辅助进程结束 Chrome，并保留有界的 stderr 尾部，见[监管启动](lifecycle-ownership-design.md)                                                                                                                                                                                                              |
| `trace`                           | 与 `connect` 相同：布尔值或回调，见[协议与追踪](#协议与追踪)                                                                                                                                                                                                                                                                                                |

### Profile

未设置 `userDataDir` 时，每次启动都使用一个新的临时 profile，关闭时删除，除非浏览器通过 `release()` 移交。设置 `userDataDir` 时，profile 以及 Chrome 保存在其中的一切（Cookie、存储、设置、缓存）在多次启动之间保留。一个 profile 目录同一时间只能供一个浏览器使用：同时运行的浏览器需要使用不同的目录。

`prepareProfile` 在每次启动前运行，临时 profile 和持久 profile 都是如此，因此通过 `updateProfileSettings()` 写入的设置会在每次 Chrome 启动时检查并恢复。它的第二个参数包含启动的 `timeout` 与 `signal`、`temporary`（库为本次启动创建的 profile）和 `empty`：临时 profile 恒为 true；`userDataDir` 在目录原本不存在、或只含库的锁文件 `.nodriver.lock` 与 `.nodriver.lock.reclaim` 时为 true。`empty` 在锁内、库和 Chrome 写入其他内容之前读取，因此“有数据的目录必须已带应用标识”之类的检查无需依赖锁文件的名称。`updateProfileSettings(dir, { localState, preferences })` 把值合并进 `Local State` 和某个 profile 的 `Preferences`（未指定时为 `Default`），并逐个读回文件检查；它无法判断 Chrome 是否采用某个值。

在 Windows 上，Chrome 的密码管理器可能会以空密码尝试登录，以检查账户是否没有设置密码，失败的尝试会计入账户锁定策略。Chrome 把检查结果缓存在 `Local State` 中。固定的 `userDataDir` 会在多次启动之间保留这份缓存，从而减少检查次数，但不能杜绝检查：新的 profile、修改过的 Windows 密码或失效的缓存都会再次触发检查。按照 Chromium 源码（`password_manager_util_win.cc`），只有在缓存有效时，才会复用缓存的 `password_manager.os_password_blank` 值：`password_manager.os_password_last_changed` 大于零，且不早于 Windows 报告的该账户最近一次修改密码的时间。否则会再次检查，因此仅设置 `os_password_blank` 并不能阻止检查。本库不附带这类设置，也不声明哪些设置能在某个 Chrome 或 Edge 版本中避免这项检查。依赖某套配置之前，请在目标机器上验证，例如使用专门的测试账户并查看安全日志。

持久 profile 的锁文件记录 PID 与主机名，只有确认本机持有进程已退出时才回收陈旧锁；回收过程由独立的 `.nodriver.lock.reclaim` 文件互斥。若回收期间进程被强杀而留下该文件，会明确报错，确认记录的进程已退出后再手动删除。profile 中残留的 `DevToolsActivePort`（Chrome 未正常退出时留下，例如 MCP 宿主强制结束了服务进程）会被探测：记录的浏览器仍在该端口上应答时拒绝启动，否则删除该文件后继续。启动失败且 Chrome 已退出时，错误包含退出码与 stderr。

`Browser.connect({ endpoint, attach })` 连接已有浏览器：`'all'`（默认）附加全部标签页，`'created'` 只附加本客户端创建的标签页及其弹出页。启动参数对已连接的浏览器无效，`close()` 只断开连接，同时结束本连接用 `proxy` 创建的上下文（见[环境](environment.md#代理与-webrtc)）。

`browser.attachTarget(targetId)` 附加 `pageTargets` 中已有的页面。如果旧会话已解除附加、页面仍然打开，它会返回一个完成初始化的新 `Tab`；旧对象保持关闭，应使用返回的新对象。同一页面的并发调用共用一次附加。

确认同机 `.nodriver.lock` 持有进程仍存活、其他进程抢先回收了陈旧锁，或 `DevToolsActivePort` 仍由原浏览器提供服务时，抛出带 `profile` 路径的 `ProfileInUseError`。Windows 另探测 Chrome 原生 `lockfile` 的共享冲突（`EBUSY`），因此未开放调试端口的已运行 Chrome 也会得到该错误；未锁定的残留文件和权限错误都不算占用。Unix 不检查原生 `SingletonLock`/`SingletonSocket`，未开放调试端口时可能得到普通的启动退出错误。

`await using` 在正常退出和异常展开时关闭资源，也可使用 `try/finally` 与 `close()`。`close()` 幂等，失败后可再次调用。未设置 `detached` 启动的 Chrome 也会在宿主退出时结束，包括 `process.exit()` 和未捕获异常。宿主被强制终止或断电时，JavaScript 无法保证清理；这种情况下的遗留见[浏览器交接与事件](browser-handoff.md)。

`await browser.release()` 返回 WebSocket 端点并放弃进程所有权，之后 `owned` 为 `false`，`close()` 与异步析构只断开连接。自有浏览器必须以 `detached: true` 启动，且不能使用 `virtualDisplay`；pipe 会明确拒绝交接且不改变连接。交接保留 profile（临时 profile 也保留）与 `DevToolsActivePort`，移除记录宿主 PID 的 `.nodriver.lock`。`disconnect()` 不放弃所有权，pipe Chrome 在管道断开时会退出。未设置 `supervised` 时，交接前宿主崩溃可能遗留 Chrome。完整示例、清理责任和事件接口见[浏览器交接与事件](browser-handoff.md)。

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

`browser.tabScope()` 与 `context.tabScope()` 在与其他工作共享的浏览器中，把一个任务的页面归为一组。作用域拥有通过 `scope.newTab()` 打开的标签页、传给 `adopt()` 的标签页，以及它们（逐级）打开的弹出页。`borrow(tab)` 把一个比作用域存活更久的标签页借给作用域，例如每个任务都复用的启动页：它此后打开的弹出页归作用域所有并随作用域关闭，标签页本身保持打开。`keep(tab)` 把某个页面移出作用域，例如留给人工处理的页面；它之后打开的弹出页不归作用域所有。弹出页是否归作用域所有，在 Chrome 报告它时按其打开者当时的角色确定：标签页在通过 `adopt()` 或 `borrow()` 加入作用域之前打开的弹出页不归作用域所有；之后改变标签页的角色，也不会改变它已打开的弹出页（包括仍在附加中的）的归属。对同一标签页再次调用 `adopt`、`borrow` 或 `keep` 会把它改为相应角色。角色属于页面本身，因此通过 `attachTarget()` 重新附加的页面保持原有角色。`close()`（也可通过 `await using` 调用）先等待仍在通过作用域打开的标签页，包括 `newTab()` 调用停止等待之后 Chrome 才创建的标签页，再关闭所有归属页面，包括期间新打开的弹出页和尚未附加的弹出页，其他标签页保持打开。这些等待和关闭共用一个期限，即连接的命令超时：届时仍未关闭的页面以 `TimeoutError` 列入 `AggregateError`，并在后台继续关闭；此后关闭失败时，通过 `onError` 和 `browser.errors` 报告。未能通过 `scope.newTab()` 打开完成的标签页关闭失败时，同样如此报告，除非 `close()` 正在等待这次关闭；该标签页仍归作用域所有，`close()` 会再次尝试关闭。页面在 `scope.newTab(url)` 加载期间打开的弹出页也归作用域所有。在 `close()` 开始之后才完成的 `newTab()` 会关闭其标签页并拒绝；`close()` 要等该标签页关闭后才完成，并把它列入结果。结果列出作用域关闭的页面 ID（包括未能通过 `scope.newTab()` 打开完成的标签页），以及仍打开的已保留和借入标签页 ID；无法关闭的页面以 `AggregateError` 拒绝。用 `noopener` 打开的弹出页在 Chrome 中仍会报告其打开者；由已保留或无关标签页打开的弹出页永远不归作用域所有。

```ts
await using scope = browser.tabScope();
const tab = await scope.newTab('https://example.com');
// ... 任务打开的弹出页随作用域一起关闭
scope.borrow(startTab); // 保持打开；它的弹出页随作用域关闭
scope.keep(reviewTab); // 留给人工处理
```

## 虚拟显示

`Browser.launch({ virtualDisplay: true })` 让有界面的 Chrome 运行在专属的 Xvfb 服务器上，适用于没有显示器的 Linux 机器。需要安装 `Xvfb` 程序，在其他平台上或与 `headless: true` 同时使用时会报错。可传 `{ screen: '1920x1080x24', timeout, executable }` 进行配置。

服务器自行选择空闲的显示编号，并通过 `-displayfd` 报告，所以并发启动不会争抢编号。它不监听 TCP，并要求 MIT-MAGIC-COOKIE；cookie 写在临时目录里权限为 0600 的文件中，其他本地用户无法连接。Chrome 退出后服务器随之停止，相关文件也会删除。使用 `supervised: true` 时，两个进程都归 guardian 所有，宿主退出时一起结束。`XvfbSession.start(options)` 可以单独启动服务器：把 `session.env` 传给需要使用它的程序，用完调用 `session.stop()`。带 `virtualDisplay` 启动的浏览器不能 `release()`，因为交接出去的 Chrome 退出后，没有谁会结束服务器；需要交接时，请用这种方式启动服务器，再以 `env: session.env` 启动浏览器。

## 状态与存储

BrowserContext 之间的 Cookie 与存储相互隔离；这不等于独立的操作系统、GPU 或字体环境。

`storageState({ include, maxBytes, path })` 保存 Cookie，以及该上下文中任一 frame 访问过的 HTTP(S) 源的第一方 localStorage，包括 iframe 和已关闭标签页用过的源；空存储不导出。跨站 iframe 在其他顶层站点下的分区 localStorage 不在快照内。仍打开的主页面原地读取，其余源在一个临时标签页中读取。

结果带有 `version: 2`。`include: ['sessionStorage']` 会加入打开的标签页顶层文档的 sessionStorage，每个源一条，取自第一个显示该源的标签页。`include: ['indexedDB']` 会把各源的数据库加入对应条目：版本、对象仓库、索引和全部记录；Date、ArrayBuffer 与类型化数组、Blob 与 File、Map、Set、BigInt、undefined、NaN 和 ±Infinity 以带类型标签的 JSON 形式保存。数据库在拦截后的空白页上分批读取，页面同时写入时，导出内容可能混有写入前后的数据。无法表示的值（如循环引用，或 `CryptoKey` 这类存储的平台对象）会让导出失败。导出超过 `maxBytes`（默认 64 MiB）时抛出 `RangeError`。

`restoreStorage(state, { sessionStorageTab })` 先设置 Cookie，再替换列出的各源的 localStorage：该源仍打开的主页面原地写入，返回时即可读到；其余源在一个临时标签页中写入。临时标签页拦截文档请求、返回空白页并绕过 Service Worker，因此不访问站点、不跟随重定向、不运行站点脚本。同一源的其他已打开文档与浏览器中跨标签页写入一样，异步收到变更。

带 sessionStorage 的状态需要传 `sessionStorageTab`，即该上下文的一个标签页。它会在拦截后的空白页上依次访问各源、写入数据，最后停在 about:blank；之后导航到站点即可看到这些数据。列出的 IndexedDB 数据库会被删除，再按保存的版本用显式键重建；该源的其他数据库不受影响。上下文中有标签页显示这些源时，调用在改动任何内容之前报错，并列出这些标签页。如果 worker 或上下文之外的页面仍占着连接，调用以 `NodriverError` 失败，该数据库会在连接关闭后被删除。键生成器从恢复的最大数字键加一继续，即使原库曾分配过更大、后来被删除的键。早期版本保存的无 `version` 状态仍可恢复。

`encryptState(state, key)` 和 `decryptState(bytes, key)` 用 AES-256-GCM 加密状态。`key` 是 32 字节密钥，或由 scrypt 派生密钥的口令，派生参数写在文件头里。文件头与内容一起参与认证，因此密钥错误和文件被改动都报告 `Cannot decrypt the state`。

`clearSiteData({ domains, origins, types, openTabs })` 删除部分站点的数据，保留上下文中的其他数据，例如退出某个站点的登录，同时保持另一个站点的登录：

```ts
const result = await context.clearSiteData({ domains: ['platform.example'], openTabs: 'blank' });
// { cookies: [{ name, domain, path }], origins: [...], tabs: [...] }
```

- **匹配**：`domains` 覆盖每个域名及其子域名；`origins` 指定精确的 HTTP(S) 源，因此 `http://127.0.0.1:3000` 不会影响 `http://127.0.0.1:4000` 的页面和存储。Cookie 不区分端口和协议，按域名匹配：属于所列域名或其子域名、或恰好属于某个源的主机名的 Cookie 会被删除，分区在这些站点之下的 Cookie 也会被删除。父域名的 Cookie（例如 `platform.example` 的 `.example`）由同级站点共享，除非列出父域名，否则保留。
- **类型**：`types` 可选 `cookies`、`localStorage`、`sessionStorage`、`indexedDB`、`cacheStorage` 和 `serviceWorkers`，默认全部。存储的清理范围为：所列的每个源、每个所列域名的 `http://` 与 `https://`，以及该上下文已知的、位于所列域名下的每个源：由 frame 提交过、出现在打开的标签页的历史记录中，或由该上下文的页面显示。这些源在任何标签页发生变化之前收集，包括连接浏览器时已经打开的标签页的源。同一域名下的其他源（例如持久 profile 上一次运行留下的源）只有列入 `origins` 才会清理。
- **sessionStorage** 属于各个标签页；标签页离开某个源之后仍保留该源的 sessionStorage，直到返回该源或关闭。只有打开的标签页能清理它，因此选中 `sessionStorage` 时，显示过或曾经提交过匹配站点的标签页都算作该站点的打开标签页。`'blank'` 会在标签页中逐个加载这些源来清理：文档请求由本库以空页面应答，并绕过 Service Worker，因此不会联系站点，也不会运行站点脚本；`'close'` 则随标签页一并丢弃。本客户端未附加的页面只有在显示匹配站点时才会被发现；跨站 iframe 的分区 sessionStorage 不在处理范围内。
- **打开的标签页**：含有匹配站点 frame 的标签页可能把数据重新写回。`openTabs: 'fail'`（默认）在清理任何数据之前抛出错误并列出这些标签页；`'close'` 关闭它们；`'blank'` 将它们导航到 about:blank。该上下文中本客户端未附加的页面（例如使用 `connect({ attach: 'created' })` 时）也计算在内：`'fail'` 和 `'blank'` 拒绝处理，`'close'` 关闭它们。调用处理的是开始时该上下文中已打开的页面，无论是否已附加；调用期间新打开的页面不予处理。仍在附加中的页面会等待其附加完成。收集完源之后，每个页面按本客户端此时是否已附加它来处理：期间被附加的页面按标签页处理，期间被解除附加的页面按本客户端未附加的页面处理。
- **结果**：已删除的 Cookie（不含值）、已清理存储的源，以及被关闭或置空的标签页和页面的 target ID。删除后若仍存在匹配的 Cookie，调用抛出 `ClearSiteDataError`。
- **期限与失败**：`timeout` 与 `signal` 覆盖整个调用，从收集源到最后的 Cookie 检查。调用结束时（超时或中止之后也是如此），`'blank'` 在标签页上设置的请求拦截立即停止；随后在 Chrome 中关闭拦截、撤销 Service Worker 绕过，各有独立的 5 秒期限。调用已经失败时若撤销也失败，调用保留自身的错误，撤销失败通过 `onError` 和 `browser.errors` 报告。按 `openTabs` 拒绝标签页时，在任何改动之前抛出 `NodriverError`；其他失败、超时或中止抛出 `ClearSiteDataError`，`cause` 为原始错误，`result` 列出到此为止已删除的 Cookie、已清理的源和已处理的标签页。停止时仍在进行的步骤不会列出，且可能仍会生效。

Chrome 在 browser 会话上执行 `Storage.clearDataForOrigin` 会返回 `Internal error`，因此这些命令发往该上下文中某个已打开标签页的会话；没有打开的标签页时，使用一个临时空白标签页。这些命令不会改变该页面。临时标签页在调用的期限内关闭；期限已过时，它在调用返回之后关闭。此时或调用失败之后关闭它失败，通过 `onError` 和 `browser.errors` 报告。

`Frame.storage(kind = 'local', origin?)` 与 `Frame.setStorage(values, kind = 'local', clear = false, origin?)` 可指定预期源：读取、清空与写入和 `location.origin` 检查在同一段脚本中执行，不匹配时抛出 `EvaluationError`，页面存储保持不变。

Cookie 快照与状态文件包含凭证，存放位置由调用者负责。

## 协议与追踪

严格的命令参数元组与返回、事件类型来自固定版本的 `devtools-protocol`。事件按 session 路由：`session.on(method, listener)` 和 `session.onAny(listener)` 只接收该 session 的事件，先于全局 `connection.events` 执行；`connection.listenerCount` 汇总两者。

`launch()`、`connect()` 和 `Connection` 的 `trace` 选项接受 `true` 或函数：`true` 把每条命令的方法、session、耗时和错误码（或错误名）写到 stderr，函数则接收 `TraceEntry`。未设置该选项时，`NODRIVER_TRACE=1`（或 `true`）开启追踪；`trace: false` 始终关闭追踪。参数和结果从不记录。
