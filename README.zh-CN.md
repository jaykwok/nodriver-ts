# nodriver-ts

基于 [nodriver](https://github.com/ultrafunkamsterdam/nodriver) 重新设计的 TypeScript 实现。

[English](README.md)

nodriver-ts 通过 Chrome DevTools Protocol（CDP）直接驱动 Chrome、Chromium 和 Edge，不使用 WebDriver，也不发送 Runtime.enable。内置的 [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28) 服务让 agent 可以通过 Streamable HTTP、stdio 或本地 socket 使用同一内核。

- **默认保持安静。** 库从不发送 `Runtime.enable`、`Runtime.addBinding`、`Console.enable` 或 `Debugger.enable`，也不会退回到这些命令。它通过 frame 的 document 和 `DOM.resolveNode` 找到主世界，不注入 getter、初始化脚本或桥接脚本。Chrome 的 sandbox 和站点隔离保持开启。
- **Frame。** 跟踪同进程 iframe 和进程外 iframe（OOPIF），包括嵌套的 OOPIF。同进程 frame 共用一个 CDP session，OOPIF 有自己的 session。查询会穿透 open 和 closed shadow root。
- **输入。** 点击在派发前等待目标可见、稳定且未被遮挡，动作不会被重放。可选的带种子 "human" 策略提供指针轨迹、按键事件打字和滚轮滚动。
- **面向 agent 的 MCP。** 工具通过缩进的可访问性快照中简短稳定的元素引用（`e12`）操作元素。动作返回所发生事情的摘要：导航、新标签页、对话框。HTTP 客户端使用应用层租约，浏览器状态在多次请求和重连之间保留。默认使用 MCP **2026-07-28**；[可选的兼容模式](docs/zh-CN/agent-compatibility.md)支持 2025-11-25 / 2025-06-18 的 agent。
- **运行时。** 包运行在 Node.js 24.22.0 或更高版本上；MCP HTTP 服务使用 `node:http`。
- **原生环境。** 无界面 UA 伪装需显式启用（`maskHeadless: true`）；默认在 Worker 和请求中保留原生值。见[差分审计](docs/zh-CN/differential-audit.md)。

> 没有检测不到的自动化框架。nodriver-ts 去除常见的 CDP 和 WebDriver 痕迹，但不保证任何网站都会放行。[自动化痕迹审计](docs/zh-CN/automation-audit.md)列出了默认行为覆盖的内容和仍可观测的信号。

## 运行要求

- 使用包、开发和测试都需要 Node.js ≥ 24.22.0。Node 直接运行 TypeScript 源码。
- 本机安装的 Chrome、Chromium 或 Edge。在 Windows、macOS 和 Linux 上会自动探测，包括 `PATH`；否则请设置 `CHROME_PATH` 或 `executablePath`。
- Chrome 默认打开窗口（`headless: false`）。没有显示环境的服务器和 CI 应传入 `headless: true` / `--headless`。Linux 上应以普通用户运行并安装 Chrome 所需的共享库；库从不添加 `--no-sandbox`。WSL 上的有界面模式需要 WSLg 或其他显示服务。

支持的平台见 [docs/zh-CN/support.md](docs/zh-CN/support.md)。

## 安装

从 npm 安装：

```sh
npm install nodriver-ts
```

或从源码构建：

```sh
git clone https://github.com/jaykwok/nodriver-ts.git
cd nodriver-ts
npm ci
npm run build
```

## 库快速开始

```js
import { Browser } from 'nodriver-ts';

const browser = await Browser.launch({ transport: 'pipe' }); // 默认有界面
try {
  const tab = await browser.newTab('https://example.com');
  console.log(await (await tab.waitForSelector('h1')).text());
  await tab.screenshot({ path: 'page.png', fullPage: true });
} finally {
  await browser.close();
}
```

`await using browser = await Browser.launch(...)` 可以代替 `try/finally`；`close()` 幂等。包和仓库内的示例需要 Node.js 24.22.0+；包管理使用 npm。

- **主世界。** `evaluate` 默认在主世界运行（也可用 `{ world: 'isolated' }`）；函数会序列化到页面中。
- **Frame。** `tab.frames` 列出所有 frame，包括 OOPIF，查询不会悄悄跨 frame。
- **浏览器上下文。** `browser.newContext({ proxy })` 为每个上下文隔离 Cookie 和存储，并支持带认证的 HTTP(S) 与 SOCKS 上游代理。
- **网络。** `tab.network.route()` 拦截并替换请求，`authenticate()` 应答认证质询，`responses` 订阅响应。`Network.enable` 只在订阅响应、调用 `enable()` 或设置 headers/cache/offline 时发送。
- **输入策略。** `tab.setInputPolicy({ mode: 'human', seed })` 启用可复现的轨迹、US 布局字符的按键事件打字和滚轮滚动。其他文本（如中日韩文字或 emoji）通过 `insertText` 输入。
- **现有浏览器。** `Browser.connect({ endpoint, attach: 'created' })` 只附加本客户端打开的标签页及其弹出页（默认值 `'all'` 附加所有标签页）。`close()` 只断开连接。远程调试端点拥有浏览器的完全控制权，请限制对它的访问。
- **Raw session。** `attach: 'none'` 只发现 target，不创建 Tab。`attachSession()` 提供独立的 session，具备明确的生命周期、取消清理和发送时观察。见 [raw session](docs/zh-CN/raw-sessions.md)。
- **CDP 追踪。** 向 `launch` 或 `connect` 传入 `trace: (entry) => ...`，可收集方法、session、耗时和错误码。`trace: true` 或 `NODRIVER_TRACE=1` 写到 stderr；参数和结果从不记录。
- **生命周期诊断。** `browser.drain()` 等待晚到的响应和 attachment 清理，并区分断连与超时失败。可选的 `observe.onPerformance` 报告不含载荷的分阶段耗时，见 [raw session](docs/zh-CN/raw-sessions.md)。[启动诊断](docs/zh-CN/startup-diagnostics.md)提供失败阶段、耗时和可用的进程信息。
- **监管交接。** 在 detached WebSocket 启动时加上 `supervised: true`，可在 Windows/macOS/Linux 上获得进程监管、有界 stderr 和显式 release。见[监管启动](docs/zh-CN/lifecycle-ownership-design.md)。
- **脚本化测试。** `nodriver-ts/testing` 提供一个模拟 CDP 对端，能构建真实的 Browser/Tab/Session 对象、编写脚本化回复和事件，并记录带参数的命令。见[测试接口](docs/zh-CN/testing.md)。

另见 [docs/zh-CN/api.md](docs/zh-CN/api.md) 和[示例](examples/)。

要在 Node 宿主退出后保留 Chrome，请以 `detached: true` 和 WebSocket 启动，然后保存 `await browser.release()` 返回的 endpoint，之后使用 `Browser.connect({ endpoint })`。release 会移除控制器的 profile 锁并保留 profile，之后的 `close()` 和异步析构只断开连接。pipe 交接会被拒绝。未设置 `supervised` 时，detached 启动会丢弃 Chrome stderr，宿主在 release 前崩溃可能留下运行中的 Chrome。生命周期的限制见[交接与 CDP 事件用法](docs/zh-CN/browser-handoff.md)。

## MCP 服务

让 stdio MCP 客户端指向 CLI：

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/nodriver-ts/dist/mcp/cli.js"]
    }
  }
}
```

安装包后，可执行文件为 `nodriver-mcp`。作为常驻的本地 HTTP 服务运行：

```sh
export NODRIVER_MCP_TOKEN="$(openssl rand -hex 32)"   # 至少 32 个字符
nodriver-mcp --mcp-transport http --port 3100
# 客户端连接 http://127.0.0.1:3100/mcp，并带上 "Authorization: Bearer $NODRIVER_MCP_TOKEN"
```

- **HTTP 租约。** HTTP 只监听 loopback。省略 `Browser-Lease-Id` 的客户端使用该 token 的 `default` 租约。由字母、数字和 `. _ -` 组成的任意租约名称在首次使用时创建独立租约，让多个 agent 保持各自的浏览器状态。租约 ID 通过 `Browser-Lease-Id` 响应头返回。
- **客户端要求。** 默认入口要求 MCP 2026-07-28（`server/discover` 和每请求元数据）。使用官方 TypeScript 客户端 2.3.1 时，需要固定 `versionNegotiation: { mode: { pin: '2026-07-28' } }`。对于 2025-11-25 / 2025-06-18 的客户端，可在 stdio 参数中加入 `--mcp-compat`，或在 HTTP 服务上启用后连接 `/mcp/compat`。见[通用 Agent 兼容](docs/zh-CN/agent-compatibility.md)和 [Pi 1.3.0](docs/zh-CN/pi.md)。
- **浏览器启动。** Chrome 在首次 `browser_open` 时才启动，使用 `agent` 启动预设：关闭首次运行界面、搜索引擎选择页、崩溃恢复气泡和后台节流，并设置 `--password-store=basic`（在 Linux 上，已保存的密码和 Cookie 改用 Chrome 内置密钥而不是系统密钥环；见 [docs/zh-CN/mcp.md](docs/zh-CN/mcp.md)）。

运行 `nodriver-mcp --help` 查看所有参数。常用的有：

- `--headless`、`--user-data-dir`、`--endpoint http://127.0.0.1:9222`、`--proxy URL`
- `--lang`、`--window-size 1280x800`、`--user-agent`
- `--input-policy human`、`--read-only`、`--disable-tool NAME`
- `--upload-dir`、`--download-dir`、`--state-dir`：各自启用对应的文件工具，并限定在该目录内。

### 工具

默认的 26 个工具：

- **标签页与导航：** `browser_tabs`、`browser_open`、`browser_navigate`、`browser_history`、`browser_close_tab`、`browser_close`
- **观察：** `browser_snapshot`（带引用的缩进可访问性树，支持 `interactiveOnly`、`root` 和 `offset` 分页）、`browser_find`（CSS、XPath 或文本）、`browser_wait`、`browser_screenshot`（PNG/JPEG/WebP，元素或全页，缩放）、`browser_network`（需开启的响应日志）
- **动作：** `browser_click`、`browser_click_at`、`browser_hover`、`browser_drag`、`browser_fill`、`browser_type`、`browser_press_key`、`browser_select`、`browser_check`、`browser_scroll`、`browser_dialog`
- **其他：** `browser_evaluate`（在主世界或隔离世界运行 async 函数体）、`browser_input_policy`、`browser_environment`（诊断与显式对齐）、`browser_handoff`（通过 elicitation 请用户完成手动步骤）

另有三个可选工具，只在设置对应目录参数时出现：`browser_upload`、`browser_downloads` 和 `browser_storage_state`。

除 `browser_scroll` 和 `browser_dialog` 外，动作工具接受 `waitFor: "auto" | "load" | "none"` 和 `snapshot: true`。它们返回发生了什么（`navigated`、`newTabs`、`dialog`、`tabClosed`），因此 agent 不需要在每一步后再多查询一次。被 JS 对话框打断的动作立即返回 `pending: true`，用 `browser_dialog` 回答。

stdio、HTTP、socket 和内存入口共用同一套工具实现、租约管理器和浏览器池。详情见 [docs/zh-CN/mcp.md](docs/zh-CN/mcp.md)、[docs/zh-CN/mcp-http.md](docs/zh-CN/mcp-http.md) 和 [docs/zh-CN/mcp-socket.md](docs/zh-CN/mcp-socket.md)。

## 自动化痕迹

默认行为：

- 不自动启用 `Runtime`、`Console` 或 `Debugger` 域，不使用 binding，也不在主世界中注入初始化脚本。
- 关闭 Chromium 的 `AutomationControlled` 特性，因此 `navigator.webdriver` 原生为 `false`，不修补任何 getter。
- 无界面模式默认保留原生 UA。显式设置 `maskHeadless: true` 会去掉页面 UA/UA-CH 和 Dedicated Worker 中的 HeadlessChrome；Shared/Service Worker 及其请求可能保留原生值。见[差分审计](docs/zh-CN/differential-audit.md)。
- human 模式的输入发送符合 US 布局的成对 keyDown/keyUp，为指针按下提供真实的 `pressure`，指针从随机位置而不是 (0, 0) 开始，并且只在标签页不在最前面时才将其置前。

这些措施不是伪装。它们不伪造字体、WebGL、canvas、音频或硬件，也不解验证码。环境覆盖（时区、locale、UA-CH、视口、地理位置）需要显式启用；见 [docs/zh-CN/environment.md](docs/zh-CN/environment.md)。

## 开发

```sh
npm run check                # 严格类型检查（src 和测试）
npm test                     # 在 Node.js 上运行单元测试
npm run test:integration     # 真实 Chrome，覆盖两种 CDP 传输
npm run test:dist            # 构建后对包和 MCP HTTP 做冒烟测试
npm run format:check
```

## 文档

以下为简体中文译本；英文版位于 [docs/](docs/)，内容有出入时以英文版为准。

| 文档                                             | 内容                                                 |
| ------------------------------------------------ | ---------------------------------------------------- |
| [API](docs/zh-CN/api.md)                         | 对象、期限与取消、查询、求值、存储                   |
| [浏览器交接](docs/zh-CN/browser-handoff.md)      | 分离启动、交接与重连、CDP 事件订阅                   |
| [输入](docs/zh-CN/input.md)                      | human 输入策略、打字、指针检查、取消                 |
| [环境](docs/zh-CN/environment.md)                | 环境采样、诊断、显式对齐、WebRTC                     |
| [自动化痕迹审计](docs/zh-CN/automation-audit.md) | 默认协议行为、回归检查、仍可观测的信号               |
| [MCP](docs/zh-CN/mcp.md)                         | CLI、工具、引用、页面 JavaScript、嵌入               |
| [HTTP 接入](docs/zh-CN/mcp-http.md)              | 租约、认证、限额、资源、人工交互                     |
| [socket 接入](docs/zh-CN/mcp-socket.md)          | Unix socket / 命名管道服务与客户端                   |
| [支持范围](docs/zh-CN/support.md)                | 平台、能力、限制                                     |
| [性能](docs/zh-CN/performance.md)                | 基准方法与基线                                       |
| [长稳测试](docs/zh-CN/soak.md)                   | 长时间资源测试                                       |
| [脚本化测试](docs/zh-CN/testing.md)              | 用 `ScriptedChrome` 在不启动 Chrome 的情况下测试代码 |
| [上游映射](docs/zh-CN/upstream-api-map.md)       | nodriver 成员与 TypeScript 对应项                    |
| [API 测试映射](docs/zh-CN/test-map.md)           | 调用每个公开成员和 MCP 工具的测试（自动生成）        |

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

AGPL-3.0-or-later，见 [LICENSE](LICENSE)。
