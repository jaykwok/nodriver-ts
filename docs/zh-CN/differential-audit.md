# 本地分阶段差分审计

[English](../differential-audit.md)

`npm run bench:audit` 将 JSON 写到 stdout、进度写到 stderr，需要 Node.js 24.22.0+ 与本机 Chrome。解释时序数据时请让主机空闲；普通 CI 只验证功能并保存观测，不用精确时间阈值或检测网站评分验收。`AUDIT_REPEATS` 默认 2；`AUDIT_TRANSPORTS=websocket,pipe` 和 `AUDIT_VARIANTS` 选择矩阵。`AUDIT_HEADFUL=1` 显式选择空闲图形桌面上的有界面测试，会创建独立窗口并影响焦点，不接入个人浏览资料。

## 分组与归因

每次使用独立、空白、可丢弃 Profile，不复制/共享个人 Profile；关闭扩展，不继承权限、缓存或 Worker 注册。仅同一 run 的受控重载保留它自己的 Service Worker。记录准确启动参数、执行文件、浏览器/OS/运行时、传输、重复号、操作、环境覆盖及完整 CDP 请求。原始组由页面 UA/高熵信息记录版本，不为取版本建立 CDP。

| 阶段          | 含义                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| A-native      | 无调试参数、无库的 AutomationControlled 参数，页面自行提交。默认运行是原生 headless，不冒充人工/headful 基线。 |
| A-matched     | 仅增加 `--disable-blink-features=AutomationControlled`，分离启动参数影响。                                     |
| B-endpoint    | 匹配参数并开启 loopback 调试端点，但不连接。                                                                   |
| C-raw         | 与 B 相同，再打开浏览器 WebSocket，不发送 CDP 命令；B/C 使用相同采样延迟。                                     |
| D-attached    | 先采集已经加载的页面，再初始化 `Browser.connect`，对同一文档再次采样，断开后再采样；三次之间不导航、不输入。   |
| D-initialized | 完整 `Browser.launch`，不是“仅连接”；记录初始化，显式覆盖还包括 `chrome://version` 临时探测与覆盖。            |
| E-operations  | 分别执行 DOM 读取、完整 AX、填表/点击、滚动、背景标签页与导航，每阶段由页面取样。                              |

原始组是 WebSocket 对照；Pipe 没有“开启 TCP 端点但未连接”的等价阶段，不能伪装成相同 B/C。D 先启动空白页，再打开测试页并关闭空白页；原始组直接打开测试 URL，这段启动历史不同，报告明确保留限制。记录焦点、visibility、屏幕/视口与窗口几何；OS 遮挡、GPU/调度和物理输入不在自动化控制范围内。背景标签页、真正遮挡与 headless 是不同条件。

## 共用探针与报告

所有组运行相同页面脚本，采集 navigator、低/高熵 Client Hints、navigator/window/chrome 描述符、全局名称、有限数量的 mutation/事件、预期输入/点击/滚动结果、visibility/焦点/生命周期与 interval/rAF 分布。预期 DOM 变化和额外副作用分开。每阶段重置采样窗口，`background-start` 将切换过渡和后续背景窗口分开；少量样本、缺少 rAF 回调或调度噪声都不是检测结论。

相同脚本创建 Dedicated/Shared Worker，注册、激活、claim 独立 scope 的 Service Worker，重载验证已有注册，最后 unregister 并关闭资源。各上下文报告自己的原生 navigator，并向同一个本地接收器发请求。Worker/注册、网络、MutationObserver、计时器、rAF、JSON 序列化都有成本，所有组都承担；不改原生 getter，不向其他 Worker 注入，Service Worker 不拦截请求。

Worker 在**每个操作阶段重新采样**，以响应 ID 排除前一阶段迟到的数据。HTTP 请求与 navigator 按 run、上下文、阶段和文档生命周期匹配，不复用初始数据。新增连接组提供 WebSocket 同一文档的初始化对照；独立启动的 D/E 矩阵仍保留上述启动历史与 Pipe 对照限制。

字段区分 `observed`、`unsupported`、`unavailable`、`not-observed`，不要求 Worker 拥有全部 Window API。loopback 属于安全上下文；JS Client Hints 可用性、高熵 Promise 和 HTTP hints 分开记录，后者受请求类型及 Accept-CH 协商影响。请求未携带某 hint 标为“未观测”，不等于 JS 不支持。请求头与各自 navigator 的比较保留这些边界。

域审计保留 session ID、实际 enable/disable 及会开启 DOM 结构事件的 `DOM.getDocument`。本次默认操作仅出现 Page.enable、DOM.getDocument，不需要 CSS/Network/Accessibility.enable；其他 API 可按需启用。关闭本 run 所有的 session/进程完成清理，不盲目 disable 其他调用方使用中的域。主世界 objectId 校验与现代发现另外由 audit/compat 覆盖。

字体诊断现仅在独立临时 target session 上启用 DOM/CSS，结束后 detach 自己的 session。四种 frame 的回归验证字体输出，也验证调用方 CSS 订阅仍收到样式表事件。审计另增显式 fonts 阶段，相关命令与上述基本操作的域观测分开记录。

## 自动回归门槛

JSON schema version 2 包含 `validation.passed`、断言数、带 run/阶段/标准的失败记录，以及明确允许的例外。缺少原始/连接对照或操作样本、Worker 未成功上报、原生字段不一致、描述符/全局名称变化、额外 DOM 修改、上下文 HTTP UA 与自己的 navigator 不符、Service Worker 失去控制或清理失败时，命令返回非零退出码。同时检查 navigator 自有属性和原型描述符。

显式 UA/locale/timezone 覆盖仅允许 Worker 保留自己的原生对照值，或采用文档的覆盖值，不能掩盖无关字段变化或任意新值。时序、显示几何、焦点和可见性只作观测，不要求相等。`test/unit/audit-checks.test.ts` 主动破坏有效样本，验证缺采样、注入、错误请求头和清理失败等情况确实被拦截。通过只说明这些探针下未出现回归，不证明无法被检测。

## 已测量的结果与决定

2026-10-21，Windows x64 / Chrome 155.0.8059.85 / Node.js 24.22.0：两次重复、两种库传输、六种变体及四个原始组，共 32 次独立启动、248 份页面报告、536 条本地请求。所有 Worker 类型均被观测；初次注册为空，受控重载找到自己的已激活注册和已受控页面，全部 unregister 成功，默认禁止命令为 0。在这些探针下，相对匹配组未发现 navigator/window/chrome 描述符或全局名称集合差异；这不能证明不存在其他信号。

| 配置                               | 实际环境差异                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生 UA（含 default/agent/单参数） | 可比较的已支持字段未发现页面与 Worker 差异。                                                                                                |
| `maskHeadless: true`               | 页面、Dedicated Worker 及其请求使用 Chrome；Shared/Service Worker 与请求仍使用 HeadlessChrome，两种传输、两次重复、新建/受控页面均复现。    |
| 显式 UA + locale + UTC             | Dedicated Worker 继承 UA，但保留原生语言；Shared/Service Worker 保留原生 UA/语言/Client Hints。各自请求与各自 UA 一致，不代表跨上下文一致。 |

覆盖能隐藏一个 headless 标记，却引入直接的跨上下文矛盾。因此 **`maskHeadless` 改为默认 false**，需要原行为的调用方显式传 true；不新增 Worker 补丁。这个选择优先保留原生一致性，网站观测结果可能改变，不能推导检测率下降。

default、agent 与两个相关单参数配置在其他审计标签页置前后均为 hidden/失焦。短期 headless timer/rAF 样本不能证明 OS 遮挡效应，也不足以删除可靠性参数；保留显式 agent 及其原语义。本次未验证原生 headful、物理人工输入或其他平台/版本。AX 成本/内存分别见[性能分阶段结果](performance-phases.md)与[长稳](soak.md)，不能据此推导页面可稳定观察的信号。

随后在同一空闲主机独立运行 Pipe，两次重复，并在标签切换后重置采样窗口：16 次启动、120 份报告、264 条请求，含新增显式字体阶段及实际不传 mask 的默认配置。约 2 秒的背景窗口中，各配置均 hidden/失焦、rAF 回调为 0。interval 中位数（两次重复，ms）为 default 1003.0 / 993.5、agent 991.6 / 1002.4、occluded 参数 990.7 / 988.3、renderer 参数 1003.8 / 991.2；这些窗口的 p95 在 1000.5–1004.0 ms。这只描述背景标签页限速，不代表物理遮挡或稳定的计时器策略。新的原生默认未出现可比较的 Worker 差异，字体阶段只在自己的临时 session 上启用 DOM/CSS。此前与功能测试重叠的运行仅用于功能检查，不用于这些时序结论。

在相同 Windows/Chrome/Node 版本上，新回归门槛已通过 **17 次 headless 运行 / 153 份样本 / 612 条请求 / 13,878 项断言**（一次重复、两种传输、全部六种变体），以及 **11 次 headful 运行 / 87 份样本 / 348 条请求 / 7,768 项断言**（一次重复、库使用 Pipe、全部六种变体）。两者都包含 WebSocket 同页连接对照；初始化未改变所测环境字段、描述符和全局名称，断开后的检查也通过。headless 和 headful 分别记录 240、100 项字段级显式覆盖例外，并非失败。两次分开运行；这些功能结果不代表计时等价、物理输入或 OS 遮挡行为。完整报告生成在 `test-results/audit-gated-headless.json` 和 `test-results/audit-gated-headful.json`，作为被忽略的本地产物保留。

## 人工基线采集

运行 `npm run bench:audit:manual` 并保留终端。它只启动本地服务、显示 URL，不启动浏览器、不建立 CDP、不产生输入。自行用新建的空白可丢弃 `--user-data-dir` 启动 Chrome 并打开 URL，不带调试参数、不使用扩展或个人 Profile。另行记录完整命令、浏览器/OS 版本、显示环境、窗口关系与焦点。

用物理键鼠填表、点击、滚动，以页面 Record 按钮重复采样；重载一次验证已有 Service Worker，再人工分开采集前台、后台和真实遮挡。仅实际使用物理设备时勾选声明，再点 Finish。采集器注销自己的 Worker 并写入 `test-results/audit-manual.json`；关闭这次 Chrome，只删除这次新建的 Profile。声明不是独立鉴证，CDP 产生的 trusted 事件或脚本事件不算物理输入。本次实施没有采集物理人工样本。

Linux push CI 运行缩减的 native/masked/显式环境矩阵，以这些断言和 JSON artifact 回归。独立 Beta/Dev/Canary 工作流也运行同样的门槛及严格 objectId、生命周期套件，支持每周、手动以及修改相关工作流/核心/审计文件的 PR 触发。预览版失败保持可见，不纳入稳定版发布要求。CI 不能替代空闲主机基准和物理人工采集。
