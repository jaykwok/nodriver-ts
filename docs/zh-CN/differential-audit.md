# 差分浏览器审计

[English](../differential-audit.md)

`npm run bench:audit` 将 JSON 写到 stdout、进度写到 stderr，需要 Node.js 24.22.0+ 和本机 Chrome。解读时序数据时请在空闲主机上运行；普通 CI 只验证功能并保存观测，不设时间阈值，也不使用检测网站评分。`AUDIT_REPEATS` 默认为 2。`AUDIT_TRANSPORTS`（默认 `websocket,pipe`）和 `AUDIT_VARIANTS`（从 `default-native`、`default-masked`、`explicit-environment`、`agent`、`occluded-flag`、`renderer-flag` 中以逗号分隔选择，默认全部）选择库的测试矩阵。`AUDIT_HEADFUL=1` 用于显式选择在空闲图形桌面上运行有界面测试：审计会创建自己的窗口和标签页，可能影响焦点。它从不接入个人浏览资料。

## 分组与归因

每次运行都使用独立的空白可丢弃 Profile，不加载扩展，不继承权限、缓存或 Worker 注册，请求相同的视口并使用相同的本地探针。Profile 绝不在运行之间复制或共享；运行内唯一有意的复用，是受控重载时保留的 Service Worker 注册。记录浏览器进程参数、可执行文件、库实际使用的浏览器版本、OS/运行时、传输、重复序号、操作序列、环境覆盖以及全部 CDP 请求。原始组使用同一可执行文件，通过页面的 UA/高熵信息记录版本，而不是用 CDP 查询。

| 阶段          | 配置与采集方式                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-native      | 启动 Chrome 时不带调试参数，也不带库的自动化特性参数，由页面自行上报，不存在 CDP 客户端。默认设置下这是原生 **headless**，不是物理人工/有界面基线。 |
| A-matched     | 在 A 的基础上增加 `--disable-blink-features=AutomationControlled`，把这个启动参数与调试端点的影响分开。                                             |
| B-endpoint    | 使用匹配的参数并开启回环调试端点，但没有客户端连接。                                                                                                |
| C-raw         | 与 B 相同，再打开一个浏览器 WebSocket，但不发送任何 CDP 命令。C 与作为对照的 B 使用相同的采样延迟。                                                 |
| D-attached    | 先采样已加载的页面，再初始化 `Browser.connect`，对同一文档再次采样，断开后再采样一次；三次观测之间不导航、不输入。                                  |
| D-initialized | 完整的 `Browser.launch`，而不只是建立连接。在打开测试页前记录初始化；显式启用伪装时，还包括其临时 `chrome://version` 探测和覆盖。                   |
| E-operations  | 分别执行 DOM 读取、完整 AX 读取、字体诊断、填表/点击、滚轮、后台标签页和导航阶段，每次操作后由页面自有探针采样。                                    |

原始组都是 WebSocket 对照：Pipe 没有“开启 TCP 端点但未连接”的等价状态，因此不把它当作相同的 B/C 对照。D 会打开一个新标签页，关闭 Chrome 初始的空白标签页，再把新标签页导航到 fixture；原始组的 Chrome 则直接从该 URL 启动，因此启动历史不同。报告记录焦点/可见性、屏幕/视口和窗口几何；OS 遮挡、GPU/OS 调度和物理输入不在自动化矩阵的控制范围内。把审计自己的某个标签页切到后台，与 OS 遮挡和 headless 模式都不是同一种条件。

## 共用探针与报告

所有组运行完全相同的页面脚本，采集 navigator 字段、低/高熵 Client Hints、navigator/window/chrome 描述符、全局名称、有上限的变更/事件日志、显式的填表/点击/滚动结果、可见性/焦点/生命周期事件，以及 定时器/rAF 采样分布。预期的 DOM 变化与额外的变更、描述符/全局名称差异分开记录。每个阶段后重置采样窗口，`background-start` 把标签页切换的过渡期与之后的后台窗口分开。样本少、没有 rAF 回调和调度噪声都只是观测，不是检测结论。

同一脚本会创建 Dedicated 和 Shared Worker，注册、激活并 claim 一个独立作用域的 Service Worker，在保留该注册的情况下重载，最后注销它并关闭 Worker 资源。每个上下文报告自己的原生 navigator，并向同一个回环接收器发送请求。Worker 创建、注册、本地请求、MutationObserver、计时器、rAF 和 JSON 序列化都有开销，每个组都同样承担。不修补任何原生 getter，不向无关的 Worker 注入代码，Service Worker 也不拦截请求。

Worker 在**每次**操作后都会重新采样，并用响应 ID 排除前一阶段迟到的响应。HTTP 记录与 navigator 的比较按 run、上下文、阶段和文档生命周期匹配，而不是复用初始样本。连接组提供同一文档上的 WebSocket 初始化对照。

字段值区分 `observed`、`unsupported`、`unavailable` 和 `not-observed`。不要求 Worker 中缺少的 API 与 Window 一致。回环源属于安全上下文；JavaScript Client Hints 的可用性和高熵 Promise 与 HTTP hints 分开记录，后者取决于请求类型和 Accept-CH 协商。请求中缺少某个 hint 记为 `not-observed`，不代表对应的 JS 字段不受支持。请求汇总以及请求与 navigator 的比较都保留这些区分。

域记录包含 session ID 和实际发送的 enable/disable 命令，以及会开启 DOM 结构事件的 `DOM.getDocument`。默认操作只发送 Page.enable 和 DOM.getDocument；其他 API 按需使用 CSS、Network 或 Accessibility。关闭本次运行自有的 session/进程即完成清理；工具绝不盲目 disable 其他调用方正在使用的域。现代发现机制和主世界 objectId 校验另由 审计/兼容套件覆盖。

字体诊断只在独立的临时 target session 上启用 DOM/CSS，结束后分离，因此调用方自己的 CSS 订阅仍能收到样式表事件。fonts 阶段与基本操作的域记录分开报告。

## 自动回归门槛

JSON schema version 2 包含 `validation.passed`、检查数、带 run/阶段/判据的失败记录，以及明确允许的例外。缺少必需的原始/连接对照或操作样本、Worker 未能上报、原生字段不一致、描述符/全局名称变化、出现意外的 DOM 变更、某个上下文的 HTTP UA 与其自身 navigator 不符、Service Worker 失去控制，或作用域内的清理失败时，命令以非零码退出。除原型描述符外，也检查 navigator 的自有属性。

显式启用的 UA/locale/时区 差异有明确边界：Worker 的值必须等于其原生对照值或显式覆盖后的文档值，这一例外不能掩盖无关字段的变化或任意的新值。时序、显示几何、焦点和可见性仍只作观测，不要求相等。`test/unit/audit-checks.test.ts` 会故意破坏有效报告，确认缺少样本、注入、错误请求头和清理失败等情况都会被拦截。报告通过只说明这些探针没有发现回归，不代表浏览器无法被检测。

## 结论

- **原生默认值保持一致。** 使用原生 UA 时，文档与各类 Worker 的可比较字段一致，每个上下文的 HTTP UA 都与其自身 navigator 相符。相对于匹配的原始对照组，库不引入 navigator/window/chrome 描述符或全局名称差异；连接到已加载的页面也不改变任何采样字段。
- **`maskHeadless: true` 会造成跨上下文矛盾。** 页面与 Dedicated Worker（及其请求）报告 Chrome，而 Shared/Service Worker 及其请求仍为 HeadlessChrome。因此 `maskHeadless` 默认为 `false`，库也不对 Worker 打补丁。
- **显式的 UA、locale 与时区覆盖无法到达所有 Worker。** Dedicated Worker 继承 UA，但保留原生语言值；Shared/Service Worker 保留原生的 UA、语言和 Client Hints。HTTP 请求头跟随各上下文自己的 UA。
- **后台标签页会被限流。** 被另一个标签页切到后台的标签页报告 hidden/失焦，收不到 rAF 回调，1 秒的定时器大约按 1 秒运行，无论是否使用 `agent` 预设的后台相关参数。这描述的是标签页后台化，不是 OS 窗口遮挡。

## 人工基线采集

运行 `npm run bench:audit:manual` 并保持采集器终端打开。它只启动本地服务并输出一个 URL，从不创建浏览器、CDP 连接或输入。请自行用新建的空白可丢弃 `--user-data-dir` 启动 Chrome 并打开该 URL，**不带任何调试参数**，不使用扩展或个人 Profile。将完整命令、Chrome/OS 版本、显示环境、窗口排列和焦点与 JSON 一同记录。

用物理键盘/鼠标填表、点击和滚动，并用页面上的 Record 按钮重复采样。重载一次以进入已有 Service Worker 阶段，然后手动比较前台、后台和真正被遮挡的窗口，并把这些条件分开记录。只有确实使用了物理设备时才勾选声明，然后点击 Finish。采集器会注销自己的 Worker 并写入 `test-results/audit-manual.json`；之后关闭这个 Chrome，只删除它使用的可丢弃 Profile。声明不会被独立核实，CDP 生成的事件或脚本事件都不算物理基线。

在 Linux 上，回归工作流会运行缩减的 原生/伪装/显式环境审计，执行这些回归断言并将 JSON 保存为产物。Beta/Dev/Canary 工作流也运行同样的门槛，并同时运行严格的 objectId 和生命周期套件。CI 不能替代空闲主机上的基准测试和物理人工采集。
