# 自动化痕迹审计

2026-10-16：将“不自动发送 Runtime.enable”落实为默认架构与回归要求。避免这条命令减少一类检测面，不等同于隐藏全部浏览器自动化行为。

## 已实现的约束

| 检查项              | 当前行为                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime.enable      | 主页面、popup、同进程 iframe、嵌套 OOPIF、重连均不自动发送，也不先 enable 再 disable                                                                   |
| 主世界定位          | Page.createIsolatedWorld 获取精确 frame；隔离世界 Document → DOM.describeNode → DOM.resolveNode（省略 executionContextId）得到该 Document 的主世界对象 |
| objectId 适配       | 严格检查 V8 格式、上下文范围、隔离世界官方 ID、isolate 一致性，以及主世界 Document 的 backendNodeId；不兼容抛 UnsupportedError，绝不兜底启用 Runtime   |
| 生命周期            | 缓存绑定 frame/session/文档代次；导航、BFCache、进程切换、崩溃、setContent 失效。上下文消失的协议错误使下一次调用重新发现，当前用户脚本不自动重放      |
| 对象释放            | 发现上下文产生的临时对象用 objectGroup 在 finally 中释放；用户取消后仍尝试清理                                                                         |
| 主世界注入          | 无自动 Runtime.addBinding、postMessage 通信、插入 script 或框架全局对象；没有固定 sourceURL 标签。用户显式 evaluate/addInitScript 保留其自身语义       |
| DOM 辅助            | 查询、动作检查等在随机命名的隔离世界执行；不申请跨源通用访问权限                                                                                       |
| navigator.webdriver | 默认通过 Chromium AutomationControlled 启动开关关闭，getter 仍是原生实现，不在 navigator 实例上增加属性                                                |
| 浏览器机制          | 保留 sandbox、站点隔离和 CSP；无默认 Console.enable/Debugger.enable。Pipe 不监听调试 TCP 端口，WS 仍支持本地与远程连接                                 |

Chromium 在未指定上下文时将 DOM 节点包装到所属 frame 的主世界，见 [ResolveNode 源码](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/inspector/resolve_node.cc)。[V8 的 objectId 格式](https://github.com/v8/v8/blob/main/src/inspector/remote-object-id.cc) 是内部实现，CDP 没有保证；目前支持证据限定已实测的 Chrome 154/155 版本。没有冒用标准协议稳定性承诺。

## 可重复验证

```sh
bun run test:audit
bun run test:all
```

`test/integration/runtime.test.ts` 在浏览器启动前截取 Transport.send 的真实消息，覆盖双传输、四个 frame（含嵌套 OOPIF）、中文输入、closed shadow、JSHandle、导航、BFCache、popup 与 WS 重连。断言禁用域/绑定/自动 init script 命令为零，并用独立浏览器显式启用 Runtime 作阳性对照，验证采集器能看到命令及 executionContextCreated/consoleAPICalled 事件。

历史 Runtime/MCP/HTTP/socket 阶段的回归数量保留在开发计划。当前协议统一为 2026-07-28，移除旧版正向矩阵并补齐拒绝测试后，两平台各 109 项，Windows 1616、WSL 1620 断言，严格类型检查通过。HTTP JSON/SSE、socket、嵌入和共享行为契约继续审计真实 CDP 命令，禁止自动发送的命令为零；最早审计的命令条数不作为固定断言。此轮未更改 CDP 控制内核或恢复 Runtime。

页面自有探针比较操作前后的主世界全局属性、元素属性、DOM 结构/属性变更、console 函数及 webdriver getter。已执行的查询和输入没有新增这些痕迹，所有四个 frame 的 webdriver 为 false、getter 保持原生。此测试不声称页面观察不到鼠标事件、表单值或滚动。

Chrome 155 的 Error.stack getter 在启用 Runtime 的阳性对照中仍为零；Error.name 在 console 调用本身会被读取。本项目比较操作前后的计数，并以协议和事件为主要证据，**不把老式 stack 探针的绿色结果当成消除了 CDP 检测**。

上下文单元测试覆盖不兼容格式、错误世界/文档、临时句柄清理、发现时导航、执行上下文消失后恢复，以及不重放用户脚本。普通回归另覆盖 renderer crash、跨进程来回切换和资源回收。

## 第三方检测复测（开发计划 7.2）

2026-10-16，Windows Chrome 155.0.8059.80 与 WSLg Chrome for Testing 155.0.8059.79，Bun 1.4.3，各运行 headed/headless × Pipe/WebSocket 四格；未打开 DevTools，没有修改默认 UA、字体、时区或网络出口。固定源码与 PDF 按 Git blob SHA1 校验，不修改检测逻辑：

- [rebrowser-bot-detector e1a25b1](https://github.com/rebrowser/rebrowser-bot-detector/tree/e1a25b1ff264cc9a5b5ea7fe8a6dfc26e3b1c718)：本地托管原脚本，明确允许 Chrome 官方版本接口。本轮 Windows 四格没有正向命中；WSL 四格的 UA 检查均提示 CfT 的品牌集合缺少 Google Chrome。exposeFunction 未使用，仍属不适用；runtimeEnableLeak 受前述阳性对照限制。
- [Brotector 98b3309](https://github.com/ttlns/brotector/tree/98b330999e9928a226ca0c8254dddf909d1583bd)：原脚本与 PDF 本地托管，CSP 允许所需同源及 Blob Worker。本轮每格分别执行 crash 探针关闭与开启，等待初始化完成；均无检测回调，开启时未崩溃。该结果替代早期仅 Windows/headless/关闭 crash 且 Worker 可能受 CSP 阻止的有限记录。

经用户明确授权，另在双平台 headed/headless 的 Pipe 浏览器访问 CreepJS、BrowserScan 及 Pixelscan 的实际 fingerprint-check 页面。只允许所授权的第一方站点及其子域；非许可广告、分析和图标请求被拦截并记录，可能影响页面，因此结果仅属于该配置与采样时间：

| 检测页                                        | Windows                                                        | WSLg Linux                                    |
| --------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------- |
| CreepJS（like headless / headless / stealth） | headless 25% / 67% / 0%；headed 19% / 0% / 0%                  | headless 50% / 67% / 0%；headed 44% / 0% / 0% |
| BrowserScan                                   | headless：Robot；headed：Normal                                | headless：Robot；headed：Normal               |
| Pixelscan fingerprint-check                   | 两模式均报告指纹不一致；headless 报告自动化行为，headed 未报告 | 同左                                          |

Pixelscan 还显示 Timezone spoofed、Proxy detected。它们是站点标签；原生 JS 时区为 Asia/Singapore，与 HTTP 出口地理位置不一致，不证明项目实际伪造时区。另经授权的 HTTP/STUN 探针也观察到出口地址不同，见 [环境采样](environment.md)。未尝试修补或绕过检测，不以这些结果声称不可检测或挑战必过。

第三方源码、回归脚本、原始文本/JSON/截图和出口地址保存在维护者本地，不进入仓库或安装包。没有进行普通物理浏览器操作或 Python 同机对照，也没有外部业务登录或长期对抗测试。

## 当前安装包在线复验（2026-10-17）

2026-10-17 10:09–10:12（Asia/Singapore），使用 behavior 安装包的独立消费者，在 Windows Chrome 155.0.8059.80 / Bun 1.4.3 / Pipe 下访问以上三个在线检测页。每格新临时 profile，本轮不拦截站点请求，不覆盖 UA/环境，不配置代理或 WebRTC 限制，不打开 DevTools。

| 检测项                                      | 默认有界面 instant | headless instant | 有界面 human(seed=42) |
| ------------------------------------------- | ------------------ | ---------------- | --------------------- |
| CreepJS：like-headless / headless / stealth | 19% / 0% / 0%      | 25% / 67% / 0%   | 19% / 0% / 0%         |
| BrowserScan                                 | Normal             | Robot            | Normal                |
| Pixelscan：Bot check                        | 未报告自动化行为   | 报告自动化行为   | 未报告自动化行为      |
| Pixelscan：指纹一致性                       | inconsistent       | inconsistent     | inconsistent          |

Pixelscan 三格另显示 Timezone spoofed、Proxy detected、No masking detected。原生 JS 时区与站点给出的出口时区不同；标签不证明库伪造环境。三格各记录一次站内 HTTP 500，另有分析请求中止，结果仅指可见结果卡，不能证明每个子检测均无故障。

每格执行相同两次移动和两次滚动：instant 为 1/1/1/1 个事件，human 为 9/8/7/4，前后判定未变。此次没有点击/打字检测或物理输入对照，页面可能缓存首次判定；不能据此认定类人策略有效或无效。CreepJS 分数不是检测概率。九格实际协议禁止命令均为零，webdriver 均为 false，临时 profile 全部清理。

这一轮为 Windows/Pipe 单次矩阵，没有重复其他平台或重启长稳。原始正文/截图及精确结果卡提取保存在维护者本地；与前次过滤子请求的样本条件不同。公开结果不包含原始地址和设备标识。

## 仍可观察的特征与使用方式

1. **Headless**：此前 headless 样本的 UA 含 HeadlessChrome，screen 为 800×600，Windows 该次 viewport 为 764×485。2026-10-16 按用户要求将默认改为有界面（`headless:false`），保留显式 `headless:true` / CLI `--headless`。2026-10-18 起 headless 默认去掉 UA 与 UA-CH 中的 HeadlessChrome（`maskHeadless`，见下节），但 screen 尺寸等其他 headless 信号不变，上述 headless 检测记录不能视为已修复；有界面模式也不保证全部隐藏。无图形桌面时需显式选择 headless，不自动降级。
2. **用户脚本的执行世界**：`evaluate()` 默认 main，以保留页面业务对象访问。页面可 hook 自己的方法；通用 DOM 读取可用 `query()` 或 `evaluate(fn, arg, { world: 'isolated' })`。隔离世界也共享 DOM。
3. **环境一致性**：UA、Client Hints、语言、时区、screen、字体、GPU、Worker 信息、代理出口需分别测量。有界面模式保留浏览器原始值；headless 只把 HeadlessChrome 替换为 Chrome（UA-CH 从同一浏览器的 WebUI 页面读取原值后改写），不套用另一系统 UA；仅改一个字段会产生不一致。`setEnvironment()` 是显式覆盖接口，尚不负责完整 Worker/设备配置一致性。
4. **输入行为**：点击/文字使用 CDP Input；页面仍能观察时序、轨迹与事件。select 等 DOM 改值会派发合成事件，不能宣称全操作均像物理设备输入。没有加入通用“拟人”或消除坐标差异的承诺。
5. **外部调试与网络**：连接前已有 DevTools/其他 CDP 客户端的行为、调用方手动启用域、TLS/IP 信誉、代理及 WebRTC 出口均不由本次修复覆盖。Pipe 只减少本机调试端口暴露，不改变其他 CDP 行为。

现已补充 Chrome 154/155、Windows/WSLg、有界面/无界面、双传输矩阵，以及 UA-CH/Worker/屏幕/WebGL、字体与 IP/WebRTC 原生信号，见 [环境采样与兼容性复验](environment.md)。Windows 有界面观测到普通 Chrome UA、DPR 1.75；headless 原生 UA 含 HeadlessChrome，screen 为 800×600（UA 现由 maskHeadless 改写，screen 未改）。物理输入对照尚未开展；双平台 48 小时 [长稳测试](soak.md) 已按用户要求停止，未完成全时长，不重启。

## 2026-10-18 调整与本地探针

以下改动只针对已知的协议副作用与输入一致性，没有重跑上文的在线检测页，不改变上文结论：

- **headless UA**：`maskHeadless`（headless 默认开启、显式 `userAgent` 时不生效）在所有目标上以 `Emulation.setUserAgentOverride` 去掉 HeadlessChrome，同时提供从 `chrome://version` 读取的原生 UA-CH，避免只改 UA 导致 Client Hints 消失。本地探针确认文档、HTTP 请求头与专用 Worker 一致；Shared/Service Worker 是独立目标，可能保留原值。诊断类测试显式关闭该选项以观察原生值。
- **按键**：human 模式下 US 布局字符使用 keyDown/keyUp（大写和符号自动按 Shift），keyUp 与 keyDown 的 key 一致（修复 Space 与 Shift+字母的不对称）；修饰键与无文本键使用 rawKeyDown；中日韩、emoji 与换行继续使用 insertText，不模拟 IME。
- **指针**：按下与按住移动时 pressure 为 0.5（Pointer Events 对无压感鼠标的规定值，此前为 0）；human 模式首次指针位置在视口 15–85% 随机，不再从 (0,0) 出发。本地探针中 `screenX - clientX` 与窗口位置和边框一致（有界面/无界面均成立）。
- **前台切换**：只在其他标签页可能在前台时才调用 `Page.bringToFront`，减少重复的焦点/可见性事件。
- **滚动**：human 模式对主 frame 元素先用滚轮滚动到视口附近，再用 `DOM.scrollIntoViewIfNeeded` 收尾。
- **协议面**：`Network.enable` 改为按需启用；查询在 isolated world 完成，不调用会隐式开启 DOM 事件的 `DOM.getDocument`（存在 closed shadow root 时除外）。init script 使用每个标签页随机的 world 名称。
- **启动参数**：agent 预设只关闭首次运行、搜索引擎选择、崩溃恢复气泡和后台节流，不关闭 sandbox 或站点隔离。

测试 `test/integration/stealth.test.ts` 固化了 UA/UA-CH、pressure 与按键序列；所有集成测试继续断言自动发送 Runtime/Console/Debugger 启用命令的次数为零。快照使用 Accessibility 域，页面无法直接观察，但会让渲染进程构建可访问性树，带来轻微的时序与内存变化，未做专项测量。
