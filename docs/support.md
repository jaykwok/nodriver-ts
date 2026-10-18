# 支持范围与验证证据

验证日期：2026-10-16（Asia/Singapore）。Bun 是首要且完整验证的运行时，最低版本 1.4.3；Node.js 22+ 自 2026-10-18 起受支持，以构建产物冒烟测试（启动、查询、输入、MCP HTTP）验证，完整集成测试仍只在 Bun 下运行。协议声明固定 devtools-protocol 0.0.1718299。

| 组合                                                                      | WebSocket                     | Pipe           | 同一功能回归                                                  |
| ------------------------------------------------------------------------- | ----------------------------- | -------------- | ------------------------------------------------------------- |
| Windows x64，Bun 1.4.3，Chrome 155.0.8059.80                              | 已通过                        | 已通过         | 109 项测试 / 1616 断言、严格类型检查                          |
| WSL2 Linux x64，Ubuntu 26.04，Bun 1.4.3，Chrome for Testing 155.0.8059.79 | 已通过                        | 已通过         | 109 项测试 / 1620 断言、严格类型检查                          |
| Windows / WSLg，Chrome for Testing 154.0.8037.92，Bun 1.4.3               | 已通过                        | 已通过         | 有界面/无界面专项兼容矩阵，各 8 项测试                        |
| 原生 Linux x64 的其他发行版/浏览器版本                                    | 共用 Linux 适配，尚未独立验证 | 同左           | 不外推 WSL 结果为所有 Linux 发行版保证                        |
| Windows x64，Node.js 26.1.0，Chrome 155.0.8059.80                         | 已通过（冒烟）                | 已通过（冒烟） | `test/node-smoke.mjs`；Node 22 只配置了 CI 作业，尚未实际运行 |
| macOS / ARM64 / Firefox                                                   | 未验证                        | 未验证         | 不在已验证支持范围                                            |

Linux 实测使用普通用户和默认 Chrome sandbox、站点隔离；没有传入 `--no-sandbox`。通过 `ldd` 安装了 libnspr4/libnss3。Chrome 可执行文件通过 `CHROME_PATH` 指定。Windows 受限工具环境会在 Chrome 启动前发生 Crashpad 命名管道错误；执行审批后的相同代码可以运行，不能把此失败归结为 Pipe 不兼容。

Chrome 154/155 在 Windows 桌面与 Linux WSLg 的有界面/无界面模式均完成双传输专项矩阵：每个版本/模式 8 项测试、874 断言，含每条传输 100 轮 frame/session/navigation churn。主页面、同进程 iframe、跨站及嵌套 OOPIF 的文档/Worker 对比字段本次无差异。有限轮次验证不等同于数日长稳；采样范围、复验参数和长探针边界见 [环境采样](environment.md)。

当前所有 MCP 入口仅支持 2026-07-28。截至 2026-10-16，Windows/WSL 官方客户端验证 HTTP JSON/SSE、stdio、InMemory 和 socket；旧版 initialize/版本/协议 session、缺失或非法现代元数据在浏览器动作前拒绝。两入口共享行为契约比较当时的 20 工具 schema，覆盖跨请求引用、四类 frame/closed shadow、输入、导航失效、截图和错误；订阅、MRTR、取消与回收通过。人工确认由测试客户端模拟，不是外部登录或真人接管测评。HTTP 是常驻本地服务，限定 loopback 与预配凭证，不外推远程多租户安全性。测试数量减少源于移除旧协议正向矩阵并替换为拒绝用例。

2026-10-18 新增页面脚本 browser_evaluate，所有入口现为 21 工具。Windows Chrome 155.0.8059.80 / Bun 1.4.3 的 MCP 回归通过 41 项 / 742 断言，执行上下文与 Runtime 专项通过 7 项 / 93 断言，类型、构建和格式检查通过。覆盖 HTTP/stdio 的四类 frame 主世界与隔离世界、socket 调用及 InMemory 两条 CDP 传输的 JSON/错误/期限/取消/跨租约拒绝；实际脚本命令审计禁止自动启用项为零。Runtime 专项中的正向对照单独显式启用 Runtime，用于证明检测有效。该新增接口尚未重跑 WSL/macOS/ARM 或公网检测，不用历史 109 项结果代表本次全量验收。

2026-10-18 重命名为 nodriver-ts 并完成审计改进（默认 26 工具、短引用、动作摘要、默认/命名租约、Node 支持、按需 Network、headless UA 掩码、按键/指针修正等，见 [CHANGELOG](../CHANGELOG.md)）。复核时基线为单元测试 42 项 / 619 断言、集成测试 77 项 / 1163 断言；此前记录的“单元测试 104 项 / 1767 断言”与当前命令不符，已更正。

同日复核修复后的 Windows Chrome 155.0.8059.80 / Bun 1.4.3 实测：`bun run test` 47 项 / 646 断言，`bun run test:integration` 81 项 / 1207 断言（双 CDP 传输，headless），均零失败；严格类型检查、格式检查、构建和 npm 打包预检通过。Node.js 26.1.0 的两项 HTTP 断连回收测试及浏览器/MCP HTTP 冒烟测试通过。新增覆盖包括动态 closed shadow 缓存、并发 Network 初始化及失败回收、陈旧 profile 锁竞争、动作导航等待、状态文件链接限制与原子保存，以及 MCP 快照分页/子树/密码遮蔽、JPEG 截图和状态恢复。对应测试位于 `test/unit/{network,mcp-actions,mcp-state,additions}.test.ts`、`test/integration/{query,mcp-additions}.test.ts` 和 `test/node-http.mjs`。Runtime 自动命令审计中的禁止命令为零；显式启用 Runtime 的正向对照单独运行。本轮未重跑 Node 22、WSL/macOS/ARM、有界面全量矩阵、公网检测页或长稳测试。

Windows 本机命名管道、WSL Unix socket 均通过现代协议、旧版拒绝、取消/EOF、重连引用、身份隔离、容量限制和订阅/进度，以及 100 轮端点冲突/幂等关闭；Linux 额外验证目录与 socket 权限、保留已有文件，因此比 Windows 多 4 个断言。自定义传输需要配套客户端，见 [socket 接入](mcp-socket.md)。独立基准覆盖两条 Chrome 传输、大页面 AX 及 1/5/20 context，见 [测量方法](performance.md)；该历史有限基线不等于当前协议改造的性能结论或长期资源上限保证。

WebSocket 使用固定 npm ws 8.22.0 的独立 JS 协议解析器，关闭 per-message compression，处理写入完成回调及负载上限。一次 Linux 原生 WebSocket 回归中出现无法 JSON 解析的消息，原生路径 8000 次异常响应压力探针未复现，根因尚未确证。没有吞掉错误或静默重放；改用独立解析器后双平台全套回归通过。Bun 1.4.3 会替换裸 `ws` 导入，所以适配显式解析 npm 包的公开 JS 入口；需要保留正常 npm 文件布局，尚未验证 Bun 单文件编译打包。

Linux 主进程被 SIGKILL 后，子进程可能继续存在并重建刚删除的 profile。关闭实现始终终止并等待其独立进程组，再删除临时 profile；用 /proc 区分仍可写文件的活进程和已被系统接管的 zombie。测试连续强杀三次，在关闭后立即及延迟复查目录。独立消费者项目已从本地 tarball 安装，在不加载 @types/bun、skipLibCheck:false 下通过声明检查，并运行 WebSocket/Pipe 的中文与 JSHandle 示例。

## 已实现的核心能力

| 能力     | 实现与证据                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议     | 官方命令参数元组、返回值/事件类型；乱序响应、session 路由、超时、AbortSignal、迟到消息、断开拒绝和监听清理；Pipe 字节拆包/粘包/UTF-8/上限/EOF                                                                       |
| 生命周期 | Chrome 路径探测、独立临时/持久 profile、loopback WS、Pipe、外部连接；幂等关闭、启动失败清理、Windows taskkill 进程树、Linux 独立进程组；不删除外部 profile                                                          |
| 页面     | 新建/关闭、popup、历史、redirect、hash/SPA、DOMContentLoaded/load/commit、BFCache（含嵌套 frame）、renderer crash/reload、窗口、内容、资源、打印 PDF                                                                |
| frame    | 同进程 iframe、真实 OOPIF、嵌套 OOPIF、递归 attach、进程内外转换、所属 session/context、句柄文档代次失效                                                                                                            |
| DOM      | CSS、XPath、最小文本、open/closed shadow、元素作用域；isolated DOM 辅助与 main-world 用户 JS                                                                                                                        |
| 输入     | 滚动、稳定/可见/启用/命中检查、遮挡与父 iframe 命中、变换 quad、真实 hover 投递确认；中文/emoji、焦点/选择、物理按键、文件输入、select/checkbox、指针拖动                                                           |
| 求值     | Promise、exceptionDetails、顶层特殊数值/BigInt/undefined、JSHandle、对象释放、导航/崩溃失效、不重放副作用                                                                                                           |
| 状态     | Cookie JSON 保存恢复、local/sessionStorage、Cookie+localStorage 快照、权限、20 BrowserContext 隔离及订阅回收                                                                                                        |
| 文件     | PNG/JPEG/WebP、全页截图、元素截图、PDF、GUID 下载与完成/取消、saveAs、上传                                                                                                                                          |
| 网络     | Fetch 请求拦截/替换/失败、认证、响应/响应体、headers/cache/offline；页面及递归 OOPIF session                                                                                                                        |
| 代理     | Chrome 直接代理、每 context 独立代理、proxy-chain 认证 HTTP(S)/SOCKS；本地 HTTP 认证/CONNECT 和分片 SOCKS5 用户密码回归                                                                                             |
| 环境     | 显式视口/DPR、时区、locale、UA+Client Hints、地理位置，权限单独配置                                                                                                                                                 |
| MCP      | stdio / 本地 HTTP / InMemory / socket，默认 26 工具（含页面 JS）及 3 个目录受限的可选文件工具、独立租约/受控池/权限/回收、状态资源/订阅、进度及人工确认；固定协议版本，见 [MCP](mcp.md) 与 [HTTP 接入](mcp-http.md) |

## 明确限制

- 已对上述 Chrome 154/155 版本建立证据，没有宣称所有 Chrome 版本兼容。154 的证据为专项矩阵，155 另有完整功能回归。主世界发现依赖经过严格校验的 V8 objectId 内部格式；不兼容时明确报错，不自动开启 Runtime 兜底。
- 默认不发送 `Runtime.enable`，并通过原生启动开关关闭 AutomationControlled。默认有界面 Chrome；无桌面环境需显式 `headless:true`。隔离世界仍共享 DOM，选择 headless 时其 UA 特征仍可观察；具体证据与残余信号见 [自动化痕迹审计](automation-audit.md)。没有外部挑战必过或性能改善百分比承诺。
- XPath 不穿越 shadow root；frame 查询不隐式跨 frame。全量 DOM 用于识别 shadow 根，大页面高频轮询成本尚未长期压测。
- Cookie/localStorage 快照不含 IndexedDB、Service Worker 和 sessionStorage。第三方分区 Cookie 未有独立端到端用例。
- 已覆盖嵌套、边框、滚动、scale/rotate、DPR 和父遮挡。复杂 CSS 透视、pinch zoom、极端裁剪及旋转元素截图未形成跨平台全面矩阵。元素截图适用于轴对齐元素；页面 screenshot/clip 可替代。
- JSHandle/Element 文档失效会抛错，不自动重新定位。用户脚本取消只停止等待，不能回滚已执行 JS。
- 已运行页面和 popup 的第一段脚本不保证先于注入。新 OOPIF 暂停初始化有 watchdog，超时会恢复页面并报告初始化错误。
- file upload 要求路径在浏览器主机可访问，远程 CDP 需要共享文件系统或调用方自行传输。下载路径同样属于浏览器主机。
- 指针 drag 不等于完整 HTML5 DataTransfer/跨应用拖放；insertText 不模拟 OS IME 候选窗或真实剪贴板。用户 JS 无限循环会占用 renderer，需要协议终止或关闭页面。
- Fetch 路由不覆盖浏览器自身流量和 Service Worker 独立 target。HTTPS 代理证书、IPv6 与复杂 DNS 出口组合由 proxy-chain 处理，但尚无本项目全部组合回归。
- 不内置 OpenCV、视频编码、验证码/挑战自动绕过或屏幕布局探测。可选 human 输入策略提供可复现的轨迹与节奏，不等同于物理输入。其他能力可通过 typed CDP、页面脚本或外部适配器扩展。
- MCP 的 HTTP 常驻服务显式启用且只绑定 loopback；stdio 是兼容启动模式，省略模式参数时仍采用 stdio。所有入口仅支持 2026-07-28。HTTP/socket 强制预配令牌与应用租约；Linux socket 使用私有目录/0600，Windows 使用本机命名管道。不提供远程不可信多租户、OAuth 或全部内核能力的工具映射。AX 快照限制输出大小，底层仍获取完整 AX 树；首次基线测量不能代替超大页面长期性能验证。
- `await using` / finally / 可选信号处理不能保证宿主被强制杀死或系统掉电后的即时清理。重连不自动重放操作。

## 复验

新增输入/诊断能力在共享层实施：seed、轨迹、按键/滚动节奏、字素提交、选择区、导航/取消清理，四类 frame/closed shadow、显式配置后的文档/Worker 差异、字体/WebGL、本地 HTTP/ICE、权限受控定位和 resolver 截止均有有限测试。所有接入现共用默认 26 工具（含页面脚本）；MCP 版本仍固定 2026-07-28。正常浏览器和 Python 对照、真实 IME、全媒体/所有代理网络矩阵、macOS/ARM 均未验证，不能据模型名称宣称不可检测。方法与替代决策见 [输入](input.md)、[环境](environment.md)。

新增 4 项原生信号测试覆盖实际渲染字体、四类 frame 的本地 HTTP 地址和 WebRTC 双 peer 数据通道，Windows/WSL 各 102 个断言。字体和授权公网出口的观测见 [环境采样](environment.md)，固定提交检测器与公网检测页结果见 [自动化痕迹审计](automation-audit.md)。公网检测页仍能观察到 headless 和环境差异，不能将本地回归通过解释为所有检测通过。

双平台 48 小时任务已按用户要求停止，自有浏览器、租约和临时 profile 清理通过，未完成 48 小时，不重启；记录见 [长稳测试](soak.md)。当前 MCP 调整另行运行有限短回归。OOPIF 来回切换测试改为等待对应文档加载完成，双平台各连续 30 次通过；该同步只在测试中，不添加生产动作重试。

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run test:integration
bun run build
```

测试只使用本地 fixture。不同站点用 127.0.0.1 与 localhost，断言所属 session 确认真实 OOPIF；测试显式加强 `--site-per-process`，没有关闭隔离。外部连接用同机第二条连接验证进程归属。代理使用本地 HTTP/SOCKS fixture，包括故意分片响应。测试覆盖 renderer crash 和 20 context 并发，不代表数日长稳或所有资源故障组合已验收。
