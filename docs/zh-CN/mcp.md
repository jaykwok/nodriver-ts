# MCP 服务

[English](../mcp.md)
使用 initialize 的客户端见[通用 Agent 兼容](agent-compatibility.md)，包括 [Pi](pi.md)。

内置 MCP 服务有四种接入：长期运行的本地 Streamable HTTP、由客户端启动的 stdio、本地 socket（Unix socket / Windows 命名管道），以及进程内 InMemory。它们共用 `createBrowserMcpServer`、`BrowserSessionManager`、浏览器池与租约、工具 schema、元素引用、操作队列和同一套 CDP 内核。

- 默认 MCP **2026-07-28**（`server/discover` 与逐请求 `_meta` 版本元数据），默认入口拒绝旧版 initialize。显式启用 `--mcp-compat` 后，stdio 或独立 HTTP `/mcp/compat` 支持 **2025-11-25 / 2025-06-18**。官方 TypeScript client 2.3.1 的现代请求需显式设置 `versionNegotiation: { mode: { pin: '2026-07-28' } }`。`nodriver-ts/mcp` 导出 `MCP_PROTOCOL_VERSION`。
- 不自动发送 `Runtime.enable`。提供页面内 JavaScript 工具 `browser_evaluate`，不提供任意 CDP 或宿主代码执行工具。
- Chrome 在首次 `browser_open` 时懒启动，默认有界面；无桌面环境传 `--headless`，嵌入时用 `launch: { headless: true }`。`--headful` 与 `--headless` 不能同时使用，也不能与 `--endpoint` 合用；连接已有 Chrome 不改变其窗口模式。

## 启动

```sh
npm run build

# stdio：由客户端启动；省略 --mcp-transport 时即为 stdio
node dist/mcp/cli.js --browser-transport pipe
node dist/mcp/cli.js --endpoint http://127.0.0.1:9222

# HTTP：常驻本地服务，先设置随机 NODRIVER_MCP_TOKEN（至少 32 字符）
node dist/mcp/cli.js --mcp-transport http --port 3100
```

安装包提供 `nodriver-mcp` 命令，源码入口为 `npm run mcp`。stdout 专用于协议，日志和帮助写 stderr。服务在前台运行，不安装系统服务或开机自启，也不修改客户端配置。

stdio 客户端配置示例（mcpServers 格式）：

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

stdio 连接拥有一个私有租约，直到 EOF 或 close；之后关闭自有 Chrome 并删除临时 profile，持久 profile 保留，外部 Chrome 只断开连接。

HTTP 只监听 loopback，要求 Bearer 令牌。省略 `Browser-Lease-Id` 时使用该令牌的 `default` 租约；多个 agent 需要独立状态时各自发送不同的租约名称（首次使用即创建）。请求结束或客户端断开不会销毁租约、浏览器和引用。认证、Header、Origin/Host 和限额见 [HTTP 接入](mcp-http.md)，本地 IPC 见 [socket 接入](mcp-socket.md)。

## CLI 选项

运行 `nodriver-mcp --help` 查看全部参数。

| 参数                                                       | 作用                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `--mcp-transport stdio\|http\|socket`                      | MCP 传输，默认 stdio                                                  |
| `--port`、`--socket-path`、`--token-env NAME`              | HTTP 端口（默认 3100）、socket 路径、令牌所在的环境变量               |
| `--headful` / `--headless`                                 | 窗口模式，默认有界面                                                  |
| `--browser-transport pipe\|websocket`                      | CDP 传输，默认 pipe；`--transport` 是别名                             |
| `--executable`、`--user-data-dir`                          | Chrome 路径；持久 profile（单浏览器，不按租约分 context）             |
| `--endpoint URL`、`--expose-existing-tabs`                 | 连接已有 Chrome；默认只附加本服务打开的标签页                         |
| `--proxy URL`                                              | 上游代理；带凭证时需要按租约分 context，不能与 `--user-data-dir` 合用 |
| `--user-agent`、`--lang`、`--window-size WxH`              | 启动时设置                                                            |
| `--preset agent\|default`                                  | 默认 agent：关闭首次运行界面、搜索引擎选择、崩溃恢复气泡和后台节流    |
| `--input-policy instant\|human`                            | 新标签页的默认输入策略                                                |
| `--read-only`、`--disable-tool NAME[,NAME]`                | 只保留观察与导航工具；逐个关闭工具                                    |
| `--upload-dir`、`--download-dir`、`--state-dir`            | 启用对应的文件工具，路径限定在该目录内                                |
| `--allow-handoff`                                          | 未显式 `--headful` 时也允许 `browser_handoff`                         |
| `--max-browsers`、`--contexts-per-browser`、`--max-leases` | 资源上限                                                              |
| `--lease-idle-ms`、`--queue-limit`、`--operation-timeout`  | 租约闲置期限、队列长度、操作期限                                      |

## 工具

默认 26 个工具：

| 工具                   | 用途                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `browser_tabs`         | 查看连接状态、标签页、frame 和待处理的 JS 对话框；不启动浏览器                   |
| `browser_open`         | 懒启动或连接浏览器并打开新标签页，返回 tabId                                     |
| `browser_navigate`     | 导航已打开的标签页；waitUntil 支持 commit/domcontentloaded/load/networkidle      |
| `browser_history`      | 后退、前进或刷新；没有历史项时返回 moved:false                                   |
| `browser_close_tab`    | 关闭指定标签页                                                                   |
| `browser_snapshot`     | 缩进文本形式的可访问性树与 `[e12]` 引用；interactiveOnly、root 子树、offset 分页 |
| `browser_find`         | CSS/XPath/文本查询，返回引用、角色、名称、标签、文本摘要与可见性                 |
| `browser_wait`         | 等待所选 frame 出现（可选要求可见的）匹配元素，返回新引用及描述                  |
| `browser_click`        | 检查稳定性、可见性和遮挡后点击；支持 button、clickCount                          |
| `browser_click_at`     | 点击视口坐标（canvas、地图等），不做遮挡检查                                     |
| `browser_hover`        | 把指针移到元素上，不按下                                                         |
| `browser_drag`         | 从元素拖到另一个元素或视口坐标                                                   |
| `browser_fill`         | 替换输入内容，支持中文与 emoji                                                   |
| `browser_type`         | 在光标/选择区处输入；human 模式下 US 布局字符使用按键事件                        |
| `browser_press_key`    | 向焦点发送按键或组合键，如 Enter、Shift+Tab、Control+A（macOS 全选用 Meta+A）    |
| `browser_select`       | 修改 select 的选中值                                                             |
| `browser_check`        | 设置 checkbox/radio 的选中状态                                                   |
| `browser_scroll`       | 把元素滚动进视口（ref），或在指定坐标发送滚轮增量                                |
| `browser_dialog`       | 接受或取消当前 JS 对话框，支持 promptText                                        |
| `browser_screenshot`   | PNG/JPEG/WebP，视口、全页或元素（ref），可设 quality 与 scale                    |
| `browser_network`      | 按需记录最近的响应（URL、状态、类型、MIME），不含 header 和 body                 |
| `browser_evaluate`     | 在指定标签页/frame 执行异步 JS 函数体，JSON 参数与结果                           |
| `browser_input_policy` | 设置标签页的 instant/human 策略、seed、节奏、typing 与 scroll 方式               |
| `browser_environment`  | 结构化诊断或显式对齐；网络探针和 GeoIP resolver 由宿主配置                       |
| `browser_close`        | 关闭自有浏览器或断开外部浏览器；之后可再次 open                                  |
| `browser_handoff`      | 请用户在浏览器中完成手工操作并确认；需要可访问的 UI 和 elicitation.form          |

宿主配置目录后出现的可选工具：

- **`browser_upload`**（`--upload-dir`）：文件名必须解析到该目录内。
- **`browser_downloads`**（`--download-dir`）：列出或等待最近 100 条下载记录，文件以 GUID 命名保存在该目录。每条记录带递增的 `sequence`，list 返回 `latestSequence`。wait 不占用操作队列，可在触发下载的点击之前或之后调用；它等待序号大于 `after` 的第一条记录完成或取消，`after` 默认为该标签页上次 wait 返回的序号（初始为 0）。超时会报错且不推进游标，再次 wait 继续等待同一个下载。
- **`browser_storage_state`**（`--state-dir`）：按名称保存或加载 Cookie 与第一方 localStorage，范围是上下文中任一 frame 用过的 HTTP(S) origin（含已关闭标签页），空存储不导出，跨站 iframe 的分区 localStorage 不导出。读写在拦截文档请求的临时空白页中进行，不访问站点、不跟随重定向。状态文件拒绝已有的符号链接与硬链接，经临时文件原子替换保存，POSIX 权限 0600；内容不进入对话，只返回计数。

### 动作与等待

动作工具（click、click_at、hover、drag、fill、type、press_key、select、check）接受 `waitFor`：

- `auto`：click、click_at、press_key 的默认值。动作后观察 250 ms，若开始导航则等待加载结束或对话框出现。
- `load`：必须观察到导航完成，同文档导航与 BFCache 恢复也算。
- `none`：其余动作的默认值。

导航等待与动作共用 `timeout`；等待超时返回错误，已执行的动作不会回滚或重放。结果包含 tabId、url、navigated、loading、tabClosed、newTabs 和 dialog；`snapshot: true` 时附带一次 interactiveOnly 快照，省去一次往返。

推荐流程：

1. `browser_open({ url })`，获得 `tabId`。
2. `browser_snapshot({ tabId })` 观察页面并获得元素 `ref`；复杂的选择用 `browser_find`。
3. `browser_click({ tabId, ref: "e12" })` 或 `browser_fill({ tabId, ref, text })`；需要立即看到结果时加 `snapshot: true`。
4. 根据动作摘要（是否导航、新标签页、对话框）决定下一步，或等待预期元素出现。

### 快照与引用

标签页和 frame 都通过返回的 ID 显式指定，不依赖“当前标签页”这类隐式状态。`browser_snapshot` 默认读取主 frame，同进程和跨进程 iframe 用返回的 `frameId` 选择。快照读取 `Accessibility.getFullAXTree`，只包含浏览器渲染出的语义信息，不是完整的 DOM 导出；AX 中没有暴露的目标可用 `browser_find`。输出去掉无名称的 generic/none/presentation 包装层和与父节点重复的静态文本，以缩进表示层级，同时返回结构化 nodes（depth、role、name、states、value、url）。

引用是 `e1`、`e2` 这样的短 ID，保存在服务端，绑定实际元素、session 与文档代次，不向 DOM 写入标记；同一文档中的同一节点再次出现时复用原引用。导航、换进程、节点删除或标签页关闭后，旧引用会报错，不会被替换成相似的新元素。每个租约最多保留 2000 个引用，较旧的可能被淘汰，届时重新 snapshot 或 find。

快照默认 200 个节点、最多 500，名称截断到 300 字符；响应包含 `truncated`、`totalNodes` 和 `nextOffset`，用 `offset` 继续读取。这只是输出限制，底层仍读取完整 AX 树。

文本结果同时提供 `structuredContent` 和 JSON 文本。截图直接返回 image，上限 5 MiB，不接受写文件路径。快照返回输入控件的当前值，但密码字段一律以掩码代替，`browser_find` 的文本摘要同样不回显密码。页面文字和对话框消息是不可信数据，不应被当作 agent 指令。

### 输入策略与环境

默认策略为 instant；human 模式与取消后的 `partialInput` 见 [输入](input.md)。环境字段、覆盖核验和网络限制见 [环境](environment.md)；未配置外网探针时不会探测外网。诊断与对齐会创建临时资源或发送显式 Emulation 配置，因此 `browser_environment` 没有标为 readOnly。

## 页面 JavaScript

`browser_evaluate` 用于批量提取 DOM、读取业务状态、调用页面函数或显式修改 DOM。`script` 是 **async 函数体**：用 `return` 返回结果，可直接 `await`；JSON 参数在页面中名为 `arg`，省略时为 null。

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

- **结果**：`{ "type": "json", "value": ... }`；无 return 或返回 undefined 时为 `{ "type": "undefined" }`。对象遵循 `JSON.stringify` 语义（Date 变成字符串，嵌套 undefined 被省略，NaN 变成 null）；BigInt、循环引用、顶层 function/symbol 报错。DOM 节点须显式映射成所需字段，不返回远端句柄。
- **大小**：脚本与参数（JSON 序列化后）各最多 32,768 个字符，结果 JSON 最多 262,144 个字符；超限报错，不截断。
- **范围**：`frameId` 可选，省略为主 frame，必须属于当前租约的标签页，支持同进程 iframe 与 OOPIF。`world` 默认 main，可访问页面全局变量；isolated 与页面 JS 全局对象隔离，但共享 DOM，不是安全沙箱。脚本只在 Chrome 中运行，无法访问宿主的 Node、文件系统或进程；请求、Cookie、存储和同源限制遵循页面自身权限。该工具能读写页面敏感状态，因此标为可修改状态。
- **期限**：timeout 默认 10 秒、最大 60 秒，同时受操作期限（默认 30 秒）约束。CDP 执行期限限制初始同步计算，宿主等待期限与取消信号同时生效；**不能保证停止已安排的定时器、网络请求或异步续体，也不回滚副作用**。超时或取消后不重放，后续操作可能与遗留的页面任务交错；需要中止整页任务时关闭该标签页。
- **输入行为**：`element.click()`、直接赋值 value 或 `dispatchEvent()` 不经过输入策略，也不产生可信输入事件；需要真实输入时使用 `browser_click`、`browser_fill`、`browser_type`、`browser_scroll`。跨页面导航请用 `browser_navigate`，避免执行期间文档被销毁。

## 嵌入

普通 `nodriver-ts` 入口不加载 MCP；从子路径导入：

```ts
import { createBrowserMcpServer } from 'nodriver-ts/mcp';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const handle = serveStdio(() => createBrowserMcpServer({ launch: { transport: 'pipe' } }), {
  legacy: 'reject',
});
// 应用退出时：await handle.close();
```

`launch` 与 `connect: { endpoint }` 互斥。每次工厂调用创建独立的实例与引用注册表，不要让无关的 agent 共用一个实例。返回值是标准 `McpServer`，可以注册应用自己的工具。服务关闭、stdin EOF 和 SIGINT/SIGTERM 都会清理其拥有的 Chrome 与临时 profile，持久 profile 保留；控制器被强杀或断电时无法保证执行。

第二个参数 `BrowserMcpBinding` 可传入已有的 `BrowserSessionManager`、已验证的 principal 和 leaseId，此时 `server.close()` 只关闭适配器，租约由 manager 管理，见 [HTTP 接入](mcp-http.md)。

依赖固定版本的官方 SDK `@modelcontextprotocol/server` 2.3.1 与 Zod 4.6.7。默认 HTTP 与字节流入口使用 SDK 的 `legacy: 'reject'`，`server.connect(InMemory)` 同样走现代路由；这些默认入口拒绝 initialize、其他版本和缺少版本元数据的请求。显式启用的兼容入口采用独立协商配置，见[通用 Agent 兼容](agent-compatibility.md)。解析、envelope 校验、MRTR、订阅和取消由 SDK 处理。参见 [协议规范](https://modelcontextprotocol.io/specification/2026-07-28)。

## 并发、取消与边界

- **串行**：同一租约的浏览器操作串行执行，避免输入、导航和引用观察相互干扰。`browser_tabs`、`browser_dialog` 与 `browser_downloads` 不进入操作队列：前两者用于在动作被 JS 对话框阻塞时发现并关闭它，下载等待则可与触发它的点击并行。
- **取消**：取消信号传递到导航、等待、查询、快照和支持取消的动作。已发出的 CDP 命令和输入不能撤销；队列不会因为客户端停止等待就提前放行下一个写操作。
- **错误**：工具错误返回 `isError: true` 及错误名称与信息，不自动重放点击、提交或其他动作。输入 schema 拒绝多余字段；导航入口只接受 HTTP(S) 与 about:blank，这不是网络隔离，页面重定向、链接和浏览器自身请求仍按 Chrome 的行为进行。
- **范围**：不提供远程多租户、任意 CDP 或宿主脚本执行。文件工具只在宿主配置目录后出现并限定在目录内。工具描述与 annotations 供客户端展示，不是访问控制机制。
- **痕迹**：AX 快照不启用 Runtime。其他仍可观测的信号见 [自动化痕迹审计](automation-audit.md)。

## 测试

```sh
npm run test:mcp
npm run test:all
```

测试使用官方 MCP 客户端，以真实 stdio 子进程和两种 Chrome 传输运行，并验证默认入口拒绝旧协议；兼容测试另行验证两种受支持的 2025 协议协商、取消、会话隔离与能力检查。测试还覆盖四类 frame、closed shadow root、引用失效与跨标签页拒绝、中文输入、checkbox/select、截图、非法参数、取消、JS 对话框和下载等待。嵌入测试审计实际 CDP 命令，并验证关闭后清理自有 profile、保留外部 Chrome；EOF 测试只关闭 stdin 并等待服务自行退出，验证持久 profile 保留、锁与 `DevToolsActivePort` 已删除且调试端口已退出。
