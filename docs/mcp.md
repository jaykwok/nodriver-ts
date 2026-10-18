# MCP：常驻 HTTP 与 stdio 兼容接入

Streamable HTTP 是长期运行的本地服务模式，stdio 是由客户端启动的兼容接入模式。两者与 socket、InMemory 共用 createBrowserMcpServer、BrowserSessionManager/池/租约、工具 schema、引用、队列和同一套 CDP 内核，不分别实现导航、查询、输入或截图。仅支持 **2026-07-28**；stdio 的兼容指传输方式，2025 年旧协议不受支持。默认不自动发送 Runtime.enable；提供页面内 JavaScript 工具 browser_evaluate，不提供任意 CDP 或宿主代码执行工具。

所有接入默认启动有界面 Chrome，沿用核心的 `headless: false`。无桌面环境显式传 `--headless`，嵌入时使用 `launch: { headless: true }`；保留 `--headful` 作为显式有界面选项。两个窗口模式标志不能混用，也不能与 `--endpoint` 混用；连接已有 Chrome 不改变其窗口模式。HTTP 常驻与是否显示浏览器窗口是独立选项，不会因 HTTP 模式自动启用 headless。

## HTTP 常驻服务

```sh
bun run build
# 在当前终端设置随机 NODRIVER_MCP_TOKEN（至少 32 字符）
bun dist/mcp/cli.js --mcp-transport http --port 3100 --browser-transport pipe
```

服务保持前台运行、仅监听 loopback；Chrome 在首次 browser_open 时懒启动。客户端只需配置 /mcp 与 Authorization；省略 Browser-Lease-Id 时使用该凭证的 `default` 租约，多个 agent 需要独立状态时各自发送不同的租约名称（首次使用即创建），也可先 POST /leases 取得随机 ID。请求结束或客户端断连保留有效租约、浏览器与引用；任务结束显式释放租约，服务退出清理自有资源。完整接线和认证、Header/Body、Origin/Host、限额见 [HTTP 接入](mcp-http.md)。这不安装 OS 服务或开机自启，也不修改客户端配置。

## stdio 兼容模式

```sh
bun dist/mcp/cli.js --mcp-transport stdio --browser-transport pipe
bun dist/mcp/cli.js --mcp-transport stdio --browser-transport websocket --headless
bun dist/mcp/cli.js --mcp-transport stdio --endpoint http://127.0.0.1:9222
```

MCP 传输通过 --mcp-transport 选择；Chrome Pipe/WebSocket 通过 --browser-transport 选择，--transport 保留为后者的别名。省略 MCP 模式仍使用 stdio，便于兼容现有启动配置；所有模式的协议版本边界相同。stdout 专用于协议，日志及帮助写 stderr。私有 stdio 使用独立 manager 和租约，连接拥有该租约直至 EOF/close，之后关闭自有 Chrome、删除临时 profile；持久 profile 保留，外部 Chrome 只断连。

采用 mcpServers 格式的客户端示例：

```json
{
  "mcpServers": {
    "nodriver": {
      "command": "node",
      "args": ["/path/to/nodriver-ts/dist/mcp/cli.js"]
    }
  }
}
```

客户端必须支持 2026-07-28 的 server/discover 与逐请求元数据。官方 client 2.3.1 应显式配置 versionNegotiation.mode.pin 为 2026-07-28；其默认旧版 initialize 会被拒绝。支持版本从 nodriver-ts/mcp 导出的 MCP_PROTOCOL_VERSION 查询，不随 SDK 内部版本列表自动扩大。安装包提供 nodriver-mcp；源码入口为 bun run mcp。保留的本地 IPC 见 [socket 接入](mcp-socket.md)。

## CLI 选项

`nodriver-mcp --help` 列出全部参数。默认启动预设为 `agent`（`--preset default` 关闭），包含 `--disable-search-engine-choice-screen`、`--password-store=basic`、`--hide-crash-restore-bubble` 和关闭后台/遮挡窗口节流的参数；导出为 `AGENT_ARGS`。

| 参数                                                   | 作用                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `--headful` / `--headless`                             | 窗口模式，默认有界面                                                  |
| `--executable`、`--user-data-dir`                      | Chrome 路径、持久 profile（单浏览器，不分租约 context）               |
| `--endpoint URL`、`--expose-existing-tabs`             | 连接已有 Chrome；默认只附加本服务打开的标签页                         |
| `--proxy URL`                                          | 上游代理；带凭证时需要按租约 context（不能与 `--user-data-dir` 合用） |
| `--user-agent`、`--lang`、`--window-size WxH`          | 启动时设置                                                            |
| `--input-policy instant                                | human`                                                                | 新标签页的默认输入策略 |
| `--read-only`、`--disable-tool NAME[,NAME]`            | 收窄工具面                                                            |
| `--upload-dir`、`--download-dir`、`--state-dir`        | 启用对应文件工具，路径限定在目录内                                    |
| `--allow-handoff`                                      | 未显式 `--headful` 时也允许 browser_handoff                           |
| `--max-browsers`、`--max-leases`、`--lease-idle-ms` 等 | 资源限额                                                              |
| `--version`、`--help`                                  | 版本与帮助                                                            |

客户端最低要求：支持 MCP 2026-07-28（server/discover 与逐请求 `_meta` 版本元数据）。官方 TypeScript SDK 需 2.3.1 或更新并 pin 该版本；仍只发送旧版 initialize 的客户端会被明确拒绝，不降级。

## 工具与调用流程

默认 26 个工具：

| 工具                   | 用途                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `browser_tabs`         | 查看连接状态、标签页、frame 和待处理 JS dialog；不启动浏览器                     |
| `browser_open`         | 延迟启动/连接浏览器并打开新标签页，返回 tabId                                    |
| `browser_navigate`     | 导航已打开标签页；waitUntil 支持 commit/domcontentloaded/load/networkidle        |
| `browser_history`      | 后退、前进或刷新；无历史项时返回 moved:false                                     |
| `browser_close_tab`    | 关闭指定标签页                                                                   |
| `browser_snapshot`     | 缩进文本形式的可访问性树与 `[e12]` 引用；interactiveOnly、root 子树、offset 分页 |
| `browser_find`         | CSS/XPath/文本查询，返回引用、角色、名称、标签、文本摘要与可见性                 |
| `browser_wait`         | 等待所选 frame 内出现（可选可见的）匹配元素，返回新引用及描述                    |
| `browser_click`        | 检查稳定性/可见性/遮挡后点击；支持 button、clickCount                            |
| `browser_click_at`     | 点击视口坐标（canvas/地图），不做遮挡检查                                        |
| `browser_hover`        | 将指针移到元素上，不按下                                                         |
| `browser_drag`         | 从元素拖到另一个元素或视口坐标                                                   |
| `browser_fill`         | 替换输入内容，支持中文与 emoji                                                   |
| `browser_type`         | 在 caret/selection 处键入；human 模式下 US 布局字符使用按键事件                  |
| `browser_press_key`    | 向焦点发送按键/组合键，如 Enter、Shift+Tab、Control+A                            |
| `browser_select`       | 修改 select 的选中值                                                             |
| `browser_check`        | 设置 checkbox/radio 的 checked 状态                                              |
| `browser_scroll`       | 滚动元素进入视口（ref），或在指定坐标发送滚轮增量                                |
| `browser_dialog`       | 接受/取消当前 JS dialog，支持 promptText                                         |
| `browser_screenshot`   | PNG/JPEG/WebP，视口、全页或元素（ref），可设 quality 与 scale                    |
| `browser_network`      | 按需记录最近响应（URL、状态、类型、MIME），不含 header/body                      |
| `browser_evaluate`     | 在指定 tab/frame 执行异步 JS 函数体，支持 JSON 参数和结果                        |
| `browser_input_policy` | 设置 tab 的 instant/human 策略、seed、节奏、typing 与 scroll 方式                |
| `browser_environment`  | 结构化诊断或显式对齐；网络探针/GeoIP resolver 由宿主配置                         |
| `browser_close`        | 关闭自有浏览器或断开外部浏览器；后续可重新 open                                  |
| `browser_handoff`      | 请求用户完成手工浏览器操作并确认，要求可访问 UI 与 elicitation.form              |

宿主配置目录后才出现的可选工具：`browser_upload`（`--upload-dir`，文件名须解析到该目录内）、`browser_downloads`（`--download-dir`，列出或等待下载）、`browser_storage_state`（`--state-dir`，按名称保存/加载 Cookie 与 localStorage，拒绝已有符号链接与硬链接，通过临时文件原子替换保存，POSIX 文件权限 0600，内容不进入对话，只返回计数）。`--read-only` 只保留观察与导航工具，`--disable-tool` 可逐个关闭工具。

动作工具（click/click_at/hover/drag/fill/type/press_key/select/check）接受 `waitFor`：`auto`（默认用于 click/click_at/press_key，动作后给 250ms 观察是否开始导航，若开始则等待加载结束或对话框出现）、`load`（必须观察到导航完成，同文档导航与 BFCache 恢复也计入）、`none`（其余动作默认）。导航等待与动作共用 timeout；等待超时返回错误，已经执行的动作不会回滚或重放。结果包含 tabId、url、navigated、loading、tabClosed、newTabs 和 dialog；`snapshot: true` 时附带一次 interactiveOnly 快照，省去额外往返。

新增工具在所有接入共用同一实现。默认策略为 instant，显式启用示例和取消后的 partialInput 见 [输入策略](input.md)。环境字段、实际覆盖验证和网络限制见 [环境诊断](environment.md)；没有配置外网探针时不会探测外网。诊断/对齐会创建临时诊断资源或发送显式 Emulation 配置，因此该工具未标为纯 readOnly。

推荐流程：

1. `browser_open({url: "https://example.com"})`，获得 `tabId`。
2. `browser_snapshot({tabId})`，观察页面，获得元素 `ref`；复杂选择可用 `browser_find`。
3. `browser_click({tabId, ref: "e12"})` 或 `browser_fill({tabId, ref, text})`；需要立即看到结果时加 `snapshot: true`。
4. 根据返回的动作摘要（是否导航、新标签页、对话框）决定下一步，或等待预期元素。

标签页和 frame ID 由返回值获取，不靠“当前标签页”隐式状态。`browser_snapshot` 默认选主 frame；同进程和跨进程 iframe 均用返回的 `frameId` 显式选择。snapshot 读取 `Accessibility.getFullAXTree`，不需要先启用 Runtime；只有真实浏览器渲染出的语义信息，并非完整 DOM 导出。输出去掉无名称的 generic/none/presentation 包装层和与父节点重复的静态文本，以缩进表示层级；同时返回结构化 nodes（depth、role、name、states、value、url）。AX 中未暴露的目标可用 find。

引用是 `e1`、`e2` 这样的短 ID，保存在 MCP 服务内，绑定实际 Element、session 与文档代次，不向 DOM 写入标记；同一文档中的同一节点再次出现时复用原引用。导航、换进程、节点删除或标签页关闭后，旧引用报错；不自动选择一个相似的新元素来替代。每租约最多保留 2000 个引用，较旧引用可能被淘汰，届时重新 snapshot/find。当前快照节点数默认 200、最多 500，名称截断到 300 字符；响应包含 `truncated`、`totalNodes` 和 `nextOffset`，用 `offset` 继续读取。这是输出限制，底层当前仍读取完整 AX 树。

文本结果同时提供 `structuredContent` 和 JSON 文本。截图直接返回 image，限制 5 MiB，不接受任意写文件路径。快照返回输入控件的当前 value，但密码字段一律以掩码代替；browser_find 的文本摘要同样不回显密码。页面文字和对话框消息应作为不可信数据处理，不赋予其 agent 指令权限。

## 页面 JavaScript

Agent 可调用 `browser_evaluate` 批量提取 DOM、读取业务状态、调用页面函数或进行显式 DOM 操作。`script` 是 **async 函数体**，通过 `return` 返回结果，可以直接使用 `await`；JSON 参数在页面中叫 `arg`，省略为 null。

```json
{
  "name": "browser_evaluate",
  "arguments": {
    "tabId": "browser_open 返回的 tabId",
    "script": "return [...document.querySelectorAll(arg.selector)].map(a => ({ text: a.textContent.trim(), href: a.href }));",
    "arg": { "selector": "a[href]" },
    "world": "isolated",
    "timeout": 10000
  }
}
```

返回 `{ "type": "json", "value": [...] }`；无 return 或返回 undefined 时为 `{ "type": "undefined" }`。对象遵循 `JSON.stringify` 语义（如 Date 为字符串，嵌套 undefined 被省略，NaN 为 null）；BigInt、循环引用、顶层 function/symbol 报错。DOM 节点请显式映射成需要的字段，不返回远端句柄。脚本与参数分别最多 32,768 个字符（参数按 JSON 序列化后计算），结果 JSON 最多 262,144 个字符，按 JS 字符串长度计；超限报错，不截断后伪装完整结果。

`frameId` 可选，省略为主 frame；必须使用当前租约的 tab 和其中的 frame，支持同进程和 OOPIF。`world` 默认 main，可访问页面定义的全局变量；isolated 的 JS 全局对象与页面隔离，但共享 DOM，不是不可观察的安全沙箱。脚本只在 Chrome 中执行，没有 MCP 宿主的 Bun、Node、文件系统或进程对象；浏览器请求、Cookie/存储可见性和同源限制遵循页面权限。脚本能读写页面敏感状态，因此该工具标为可修改状态，不是 readOnly。返回数据始终是不可信页面内容。

timeout 默认 10 秒、最大 60 秒，同时受 manager 默认 30 秒操作期限约束。复用核心 evaluate 的 CDP 执行期限来限制初始同步计算，并设宿主等待期限、传递取消信号；**不能保证停止已安排的定时器、网络请求、异步续体或回滚副作用**。取消/超时后不自动重放，后续操作可能与遗留页面任务交错；需要中止整页任务时显式关闭该 tab。不要把这个接口当成运行不可信脚本的硬资源沙箱。

底层复用 Frame.evaluate 和已验证的上下文发现，没有 Runtime.enable、addBinding、调试器或自动 init script。`element.click()`、直接赋 value 或 `dispatchEvent()` 不会自动使用 human 输入策略，也不保证产生可信输入事件；需要输入行为时使用 browser_click/fill/type/scroll。跨页面导航用 browser_navigate，避免脚本执行期间文档销毁导致结果失效。四种 MCP 接入使用同一工具实现。

## 嵌入现有应用

安装后从独立子路径导入；普通 `nodriver-ts` 入口不会主动加载 MCP Server：

```ts
import { createBrowserMcpServer } from 'nodriver-ts/mcp';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const handle = serveStdio(
  () =>
    createBrowserMcpServer({
      launch: { transport: 'pipe' },
    }),
  { legacy: 'reject' },
);
// 应用退出时：await handle.close();
```

也可传 `connect: { endpoint }`；它与 `launch` 互斥。每次工厂调用创建独立实例与引用注册表；不要给无关 agent 复用同一实例。返回标准 `McpServer`，可以注册应用自己的工具。服务关闭会清理其拥有的 Chrome 与临时 profile，持久 profile 保留；stdin EOF 和 SIGINT/SIGTERM 也会走清理。强杀控制器/断电仍无法由 JS 保证执行 finally。

使用固定版本官方 SDK @modelcontextprotocol/server 2.3.1、Zod 4.6.7；client 2.3.1 显式 pin 2026-07-28。HTTP 与字节流入口使用 SDK 正式 legacy:reject 配置；直接 server.connect(InMemory) 同样通过 SDK 现代路由。额外薄边界拒绝 initialize、其他版本和缺少版本元数据的请求，解析、envelope 校验、MRTR、订阅及取消由 SDK 执行。参见 [正式规范](https://modelcontextprotocol.io/specification/2026-07-28)。

## 并发、取消与边界

同一 MCP 实例的浏览器操作串行执行，避免并发输入、导航和引用观察互相冲突。`browser_tabs` 和 `browser_dialog` 可在操作阻塞时响应，便于发现和关闭阻塞 JS 对话框。取消信号传递到导航、等待、快照和支持取消的动作；已发送的 CDP 命令和输入副作用不能撤销，部分底层步骤只受协议超时约束。队列不会因为客户端停止等待就提前放行下一次写操作。

工具错误返回 `isError: true`，包括错误名称与信息；不会自动重放点击、提交或用户动作。输入 schema 拒绝多余字段，导航入口限 HTTP(S) 与 about:blank；这不是网络隔离机制，页面重定向/链接及浏览器自身请求仍遵循 Chrome 的行为。

HTTP 常驻服务提供独立应用租约、身份校验和标准状态资源订阅；stdio 通过相同管理器创建私有租约。`createBrowserMcpServer(options, binding?)` 的显式 manager/principal/leaseId binding 可使适配器独立于浏览器寿命；未传 binding 时 close/EOF 保持清理私有资源。仍不提供远程多租户、任意 CDP 或宿主脚本执行；文件上传、下载与状态保存只在宿主配置目录后出现，并限定在该目录内；页面 JS 可访问页面自身权限允许的数据。MCP 工具描述/annotations 用于客户端呈现，不是访问控制机制。详见 [HTTP 与嵌入说明](mcp-http.md)。

默认无 Runtime.enable 的约束保持不变。AX 快照是新增的浏览器观察路径，本次协议测试证明没有自动开启 Runtime，未宣称所有辅助观察行为都不可检测。其余浏览器痕迹边界见 [自动化痕迹审计](automation-audit.md)。

## 验证

```sh
bun run test:mcp
bun run test:all
```

使用官方 MCP 客户端的真实 stdio 子进程测试 2026-07-28 及两种 Chrome 传输，并拒绝旧协议，覆盖四个 frame、closed shadow、引用失效/跨标签页拒绝、中文输入、checkbox/select、截图 image、非法参数、取消及 JS dialog。嵌入测试审计实际 CDP 命令，并验证关闭后清理自有 profile、保留外部 Chrome。额外 EOF 测试验证持久 profile 保留、锁释放且调试端口已退出。

2026-10-16 MCP 首版曾通过 48 项/395 断言，环境与生命周期阶段为 59 项/820 断言；新增 HTTP 重构的最新结果与版本见 [支持矩阵](support.md)。历史记录不代替当前代码回归。
