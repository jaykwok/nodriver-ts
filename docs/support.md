# 支持范围

## 运行环境

- **运行时**：Bun ≥ 1.4.3 是主要运行时，完整测试在 Bun 下运行。Node.js ≥ 22 运行构建产物，以冒烟测试覆盖启动、查询、输入和 MCP HTTP。
- **浏览器**：本机 Chrome、Chromium 或 Edge。Windows、macOS、Linux 的常见安装位置与 `PATH` 自动探测，也可用 `CHROME_PATH` 或 `executablePath` 指定。
- **协议**：CDP 类型固定为 devtools-protocol 0.0.1718299；MCP 仅支持 2026-07-28。
- **Linux**：以普通用户运行，安装 Chrome 所需共享库（如 libnspr4、libnss3）。框架不添加 `--no-sandbox`，也不关闭站点隔离。WSL 的有界面模式需要 WSLg 或其他显示服务。
- **macOS**：Chrome 运行在 macOS 上时，按键事件附带 Chrome 的编辑命令，`Meta+A`、`Meta+C/X/V/Z`、`Shift+Meta+Z` 及 Alt/Meta 组合的方向键与删除键与物理键盘行为一致；跨平台脚本的全选应按平台使用 `Meta+A` 或 `Control+A`。GitHub 托管的 macOS 虚拟机无法解析 mDNS（`.local`）主机候选，本地 WebRTC 会停在 ICE `new`；平台矩阵在该环境中以 `--disable-features=WebRtcHideLocalIpsWithMdns` 启动 WebRTC 测试的浏览器，本项目不会自动添加此参数。
- **WebSocket**：使用固定版本 npm `ws` 8.22.0 的 JS 协议解析器，关闭 per-message compression。Bun 会替换裸 `ws` 导入，适配层显式解析 npm 包的公开入口，因此需要保留正常的 npm 文件布局；Bun 单文件编译打包未验证。

## 已验证组合

测试数为单元 / 集成 / 兼容矩阵（WebSocket 与 Pipe 两种传输），均为当前版本。

| 平台与浏览器                                                                   | 运行时          | 结果                                                          |
| ------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------- |
| Windows 11 x64，Chrome 155.0.8059.80（本机）                                   | Bun 1.4.3       | 53 / 84 通过；类型、格式检查与构建通过                        |
| Windows 11 x64，Chrome 155.0.8059.80（本机）                                   | Node.js 26.1.0  | 构建产物冒烟测试（WebSocket 与 Pipe）及 HTTP 断连回收测试通过 |
| WSL2 Ubuntu 26.04，Chrome for Testing 155.0.8059.79 与 154.0.8037.92（本机）   | Bun 1.4.3       | 53 / 84 / 8 + 8 通过，原生信号测试 4 项通过                   |
| GitHub Actions Windows x64 与 Ubuntu x64，Chrome 155.0.8059.40 / 155.0.8059.39 | Bun 1.4.3       | 单元与集成测试通过                                            |
| GitHub Actions Ubuntu x64，Chrome 155.0.8059.39                                | Node.js 22.23.3 | 构建产物冒烟测试通过                                          |
| GitHub Actions macOS ARM64，Chrome 155.0.8059.40                               | Bun 1.4.3       | 53 / 84 / 8 通过（WebRTC 测试见上文 macOS 说明）              |
| GitHub Actions Ubuntu ARM64，Chrome for Testing 155.0.8059.84                  | Bun 1.4.3       | 53 / 84 / 8 通过                                              |
| GitHub Actions Ubuntu x64，Chrome for Testing 154.0.8037.92                    | Bun 1.4.3       | 53 / 84 / 8 通过                                              |
| GitHub Actions Windows x64，Microsoft Edge 154.0.4258.62                       | Bun 1.4.3       | 53 / 84 / 8 通过                                              |

后四行来自按需触发的平台矩阵（`.github/workflows/platforms.yml`），每个套件只运行一次、不重试，均首次通过。推送 CI 的集成测试失败时会重试一次，首次失败记录在作业摘要与日志 artifact 中；当前版本的 Windows 作业曾有一次 Bun 1.4.3 运行单元测试时自身段错误退出（非断言失败），重跑通过。每个公开 API 由哪些测试直接调用，见 [测试映射](test-map.md)。

集成测试只使用本地 fixture：用 127.0.0.1 与 localhost 构造跨站 OOPIF，并以所属 session 确认真实进程外 frame；测试显式启用 `--site-per-process`，不关闭任何隔离。代理测试使用本地 HTTP/SOCKS fixture，包括故意分片的响应。

## 核心能力

| 能力     | 实现与覆盖                                                                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议     | 官方命令参数元组、返回值与事件类型；乱序响应、session 路由、超时、AbortSignal、迟到消息、断开拒绝和监听清理；Pipe 拆包/粘包、UTF-8、长度上限与 EOF                                     |
| 生命周期 | Chrome 路径探测、临时/持久 profile、loopback WebSocket、Pipe、外部连接；幂等关闭与启动失败清理；Windows 终止进程树，Linux 终止并等待独立进程组后再删除临时 profile；不删除外部 profile |
| 页面     | 新建/关闭、popup、历史、重定向、hash/SPA、DOMContentLoaded/load/commit/networkidle、BFCache（含嵌套 frame）、renderer 崩溃与 reload、窗口、内容、资源、PDF                             |
| frame    | 同进程 iframe、OOPIF、嵌套 OOPIF、递归附加、进程内外切换、所属 session/context、句柄按文档代次失效                                                                                     |
| DOM      | CSS、XPath、最小文本、open/closed shadow root、元素作用域；隔离世界 DOM 辅助与主世界用户脚本                                                                                           |
| 输入     | 滚动、稳定/可见/启用/命中检查、遮挡与父 iframe 命中、变换后的 quad、hover 投递确认；中文/emoji、焦点与选择区、物理按键、文件输入、select/checkbox、指针拖动；可选 human 策略           |
| 求值     | Promise、exceptionDetails、顶层特殊数值/BigInt/undefined、JSHandle、对象释放、导航与崩溃失效、不重放副作用                                                                             |
| 状态     | Cookie 保存与恢复、local/sessionStorage、Cookie + localStorage 快照（含 iframe 与已关闭标签页的 origin）、权限、20 个 BrowserContext 隔离与订阅回收                                    |
| 文件     | PNG/JPEG/WebP、全页与元素截图、PDF、GUID 命名下载及完成/取消、saveAs、上传                                                                                                             |
| 网络     | Fetch 拦截/替换/失败、认证、响应与响应体、headers/cache/offline；覆盖页面及递归 OOPIF session                                                                                          |
| 代理     | Chrome 直接代理、每个 context 独立代理、经 proxy-chain 转发的认证 HTTP(S)/SOCKS 上游                                                                                                   |
| 环境     | 显式视口/DPR、时区、locale、UA 与 Client Hints、地理位置；结构化诊断与显式对齐，见 [环境](environment.md)                                                                              |
| MCP      | stdio、本地 HTTP、socket、InMemory 共用 26 个默认工具与 3 个目录受限的可选文件工具；租约、受控浏览器池、状态资源与订阅、进度、取消和人工确认，见 [MCP](mcp.md)                         |

## 限制

- **浏览器版本**：只对上表的 Chrome 154/155 与 Edge 154 建立了证据，不宣称兼容所有版本。主世界发现依赖经严格校验的 V8 objectId 内部格式；不兼容时明确报错，不退回 `Runtime.enable`。
- **检测**：默认不发送 `Runtime.enable`，并以原生启动开关关闭 AutomationControlled。隔离世界仍共享 DOM，headless 的屏幕尺寸等特征仍可观察；没有任何外部挑战必过的承诺，见 [自动化痕迹审计](automation-audit.md)。
- **查询**：XPath 不穿越 shadow root，frame 查询不隐式跨 frame。识别 closed shadow root 需要全量 DOM，大页面上的高频轮询成本未做长期测量。
- **状态**：快照不含跨站 iframe 的分区 localStorage、sessionStorage、IndexedDB 和 Service Worker。第三方分区 Cookie 没有独立的端到端用例。
- **几何与截图**：覆盖嵌套、边框、滚动、scale/rotate、DPR 和父层遮挡；复杂 CSS 透视、pinch zoom、极端裁剪没有跨平台矩阵。元素截图适用于轴对齐元素。
- **句柄**：JSHandle/Element 在文档失效后抛错，不自动重新定位。取消用户脚本只停止等待，不回滚已执行的 JS；用户脚本死循环会占用 renderer，需要协议执行期限或关闭页面。
- **注入时机**：已经开始运行的页面和 popup 不保证首段脚本前注入。新 OOPIF 的暂停初始化有 watchdog，超时后恢复页面并报告初始化错误。
- **文件**：上传与下载路径位于浏览器主机；连接远程 CDP 时需要共享文件系统或调用者自行传输。
- **输入**：指针拖动不等于完整的 HTML5 DataTransfer 或跨应用拖放；`insertText` 不模拟 OS IME 候选窗或真实剪贴板。human 策略是可复现的程序化模型，不等同于物理输入。
- **网络**：Fetch 路由不覆盖浏览器自身流量和独立的 Service Worker target。HTTPS 代理证书、IPv6 与复杂 DNS 出口组合由 proxy-chain 处理，本项目没有覆盖全部组合。
- **范围外**：不内置 OpenCV、视频编码、验证码或挑战自动处理、屏幕布局探测；可通过 typed CDP、页面脚本或外部适配器扩展。
- **MCP**：HTTP 服务需显式启用且只绑定 loopback，HTTP/socket 强制预配令牌与应用租约；不提供远程不可信多租户、OAuth 或全部内核能力的工具映射。AX 快照限制输出大小，但底层仍读取完整 AX 树。
- **清理**：`await using`、finally 与可选信号处理不能保证宿主被强杀或断电后的即时清理。重连不自动重放操作。

## 待验证

- 原生 Linux 的其他发行版、Intel macOS 及更多相邻 Chrome 版本。
- 当前版本打包产物的独立消费者安装与声明检查。
- 完整 24 小时长稳运行，见 [长稳测试](soak.md)。
- 物理输入与真实 OS IME 对照，以及当前版本的在线检测页复测。

## 复验命令

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run test:integration
bun run test:node
bun run test:compat    # 用 CHROME_PATH 指定待验证的 Chrome
```
