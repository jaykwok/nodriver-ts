# 差分浏览器审计

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

原始组是 WebSocket 对照；Pipe 没有“开启 TCP 端点但未连接”的等价阶段，不能伪装成相同 B/C。D 先启动空白页，再打开测试页并关闭空白页；原始组直接打开测试 URL，因此启动历史不同。记录焦点、visibility、屏幕/视口与窗口几何；OS 遮挡、GPU/调度和物理输入不在自动化控制范围内。背景标签页、真正遮挡与 headless 是不同条件。

## 共用探针与报告

所有组运行相同页面脚本，采集 navigator、低/高熵 Client Hints、navigator/window/chrome 描述符、全局名称、有限数量的 mutation/事件、预期输入/点击/滚动结果、visibility/焦点/生命周期与 interval/rAF 分布。预期 DOM 变化和额外副作用分开。每阶段重置采样窗口，`background-start` 将切换过渡和后续背景窗口分开；少量样本、缺少 rAF 回调或调度噪声都不是检测结论。

相同脚本创建 Dedicated/Shared Worker，注册、激活、claim 独立 scope 的 Service Worker，重载验证已有注册，最后 unregister 并关闭资源。各上下文报告自己的原生 navigator，并向同一个本地接收器发请求。Worker/注册、网络、MutationObserver、计时器、rAF、JSON 序列化都有成本，所有组都承担；不改原生 getter，不向其他 Worker 注入，Service Worker 不拦截请求。

Worker 在**每个操作阶段重新采样**，以响应 ID 排除前一阶段迟到的数据。HTTP 请求与 navigator 按 run、上下文、阶段和文档生命周期匹配，不复用初始数据。连接组提供 WebSocket 同一文档的初始化对照。

字段区分 `observed`、`unsupported`、`unavailable`、`not-observed`，不要求 Worker 拥有全部 Window API。loopback 属于安全上下文；JS Client Hints 可用性、高熵 Promise 和 HTTP hints 分开记录，后者受请求类型及 Accept-CH 协商影响。请求未携带某 hint 标为“未观测”，不等于 JS 不支持。请求头与各自 navigator 的比较保留这些边界。

域审计保留 session ID、实际 enable/disable 及会开启 DOM 结构事件的 `DOM.getDocument`。默认操作只发送 Page.enable 与 DOM.getDocument；其他 API 按需启用 CSS、Network 或 Accessibility。关闭本 run 所有的 session/进程完成清理，不盲目 disable 其他调用方使用中的域。主世界 objectId 校验与现代发现另外由 audit/compat 覆盖。

字体诊断只在独立的临时 target session 上启用 DOM/CSS，结束后 detach，因此调用方的 CSS 订阅仍能收到样式表事件。审计有单独的显式 fonts 阶段，与基本操作的域记录分开报告。

## 自动回归门槛

JSON schema version 2 包含 `validation.passed`、断言数、带 run/阶段/标准的失败记录，以及明确允许的例外。缺少原始/连接对照或操作样本、Worker 未成功上报、原生字段不一致、描述符/全局名称变化、额外 DOM 修改、上下文 HTTP UA 与自己的 navigator 不符、Service Worker 失去控制或清理失败时，命令返回非零退出码。同时检查 navigator 自有属性和原型描述符。

显式 UA/locale/timezone 覆盖仅允许 Worker 保留自己的原生对照值，或采用文档的覆盖值，不能掩盖无关字段变化或任意新值。时序、显示几何、焦点和可见性只作观测，不要求相等。`test/unit/audit-checks.test.ts` 主动破坏有效报告，确认缺采样、注入、错误请求头和清理失败等情况会被拦截。报告通过只说明这些探针未发现回归，不代表浏览器无法被检测。

## 结论

- **原生默认值保持一致。** 使用原生 UA 时，文档与各类 Worker 的可比较字段一致，每个上下文的 HTTP UA 与自己的 navigator 相符。相对匹配的原始对照组，库不引入 navigator/window/chrome 描述符或全局名称差异；连接到已加载页面也不改变任何采样字段。
- **`maskHeadless: true` 会造成跨上下文矛盾。** 页面与 Dedicated Worker（及其请求）报告 Chrome，Shared/Service Worker 及其请求仍为 HeadlessChrome。因此 `maskHeadless` 默认为 `false`，库也不对 Worker 打补丁。
- **显式 UA、locale 与时区覆盖无法到达所有 Worker。** Dedicated Worker 继承 UA 但保留原生语言；Shared/Service Worker 保留原生 UA、语言与 Client Hints。HTTP 请求头跟随各自上下文的 UA。
- **背景标签页会被限速。** 被其他标签页切到后台的标签页报告 hidden/失焦，没有 rAF 回调，1 秒 interval 约按 1 秒运行，与是否启用 `agent` 预设的后台参数无关。这描述的是标签页后台化，不是 OS 窗口遮挡。

## 人工基线采集

运行 `npm run bench:audit:manual` 并保留终端。它只启动本地服务、显示 URL，不启动浏览器、不建立 CDP、不产生输入。自行用新建的空白可丢弃 `--user-data-dir` 启动 Chrome 并打开 URL，不带调试参数、不使用扩展或个人 Profile。另行记录完整命令、浏览器/OS 版本、显示环境、窗口关系与焦点。

用物理键鼠填表、点击、滚动，以页面 Record 按钮重复采样；重载一次验证已有 Service Worker，再人工分开采集前台、后台和真实遮挡。仅实际使用物理设备时勾选声明，再点 Finish。采集器注销自己的 Worker 并写入 `test-results/audit-manual.json`；关闭这次 Chrome，只删除这次新建的 Profile。声明不会被独立核实，CDP 产生的 trusted 事件或脚本事件不算物理基线。

Linux push CI 运行缩减的 native/masked/显式环境矩阵，以这些断言和 JSON artifact 回归。Beta/Dev/Canary 工作流也运行同样的门槛及严格 objectId、生命周期套件。CI 不能替代空闲主机基准和物理人工采集。
