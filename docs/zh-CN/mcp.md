# MCP 服务

[English](../mcp.md)

内置 MCP 服务有四种接入：由客户端启动的 stdio、常驻的本地 Streamable HTTP 服务（[HTTP 接入](mcp-http.md)）、本地 socket 或 Windows 命名管道（[socket 接入](mcp-socket.md)），以及进程内 InMemory。它们共用 `createBrowserMcpServer`、`BrowserSessionManager`、浏览器池与租约、工具 schema、元素引用、操作队列和 CDP 内核。

- 默认协议为 MCP **2026-07-28**（`server/discover` 与逐请求 `_meta` 版本元数据），旧版 `initialize` 会被拒绝。`--mcp-compat` 在 stdio 或独立的 HTTP 路由 `/mcp/compat` 上增加 **2025-11-25 / 2025-06-18**，见[通用 Agent 兼容](agent-compatibility.md)，其中包括 [Pi](pi.md)。官方 TypeScript client 2.3.1 发送现代请求时须固定 `versionNegotiation: { mode: { pin: '2026-07-28' } }`。`nodriver-ts/mcp` 导出 `MCP_PROTOCOL_VERSION`。
- 不自动发送 `Runtime.enable`。`browser_evaluate` 在页面中运行 JavaScript；没有任何工具能执行任意 CDP 命令或宿主代码。
- Chrome 在首次 `browser_open` 时懒启动，默认有界面。无桌面环境时传 `--headless`，嵌入时用 `launch: { headless: true }`。连接已有 Chrome 不会改变其窗口模式。

## 启动

```sh
npm run build

# stdio（省略 --mcp-transport 时的默认值）：由客户端启动
node dist/mcp/cli.js --browser-transport pipe
node dist/mcp/cli.js --endpoint http://127.0.0.1:9222

# HTTP：常驻本地服务；先把 NODRIVER_MCP_TOKEN 设为至少 32 个字符的随机秘密
node dist/mcp/cli.js --mcp-transport http --port 3100
```

安装包提供 `nodriver-mcp` 命令，在源码中使用 `npm run mcp`。stdout 只传协议，日志和帮助写 stderr。服务在前台运行：不安装系统服务或开机自启，也不修改客户端配置。

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

stdio 连接拥有一个私有租约，直到 EOF 或 close。之后关闭自有 Chrome 并删除临时 profile；持久 profile 保留，外部 Chrome 只断开连接。

HTTP 与 socket 服务只接受本机连接，并要求 `NODRIVER_MCP_TOKEN`（或 `--token-env` 指定的变量）中的令牌。省略 `Browser-Lease-Id` 的 HTTP 请求使用该令牌的 `default` 租约；需要独立状态的多个 agent 各自发送不同的租约名称，首次使用时创建。请求结束或客户端断开不会销毁租约、浏览器和引用。

## CLI 选项

运行 `nodriver-mcp --help` 查看全部参数。

| 参数                                                       | 作用                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mcp-transport stdio\|http\|socket`                      | MCP 传输，默认 stdio                                                                                                                                                                                                                                    |
| `--mcp-compat`                                             | 在 stdio 或 HTTP `/mcp/compat` 上服务 2025 时代的客户端；`/mcp` 保持现代协议。不能用于 socket                                                                                                                                                           |
| `--port`、`--socket-path`、`--token-env NAME`              | HTTP 端口（默认 3100，仅 HTTP）、socket 路径（仅 socket）、存放令牌的环境变量（默认 `NODRIVER_MCP_TOKEN`）                                                                                                                                              |
| `--headful` / `--headless`                                 | 窗口模式，默认有界面；二者不能同时使用                                                                                                                                                                                                                  |
| `--virtual-display`                                        | 在没有显示器的 Linux 机器上，让有界面的 Chrome 运行在专属的 Xvfb 服务器上。需要安装 Xvfb，不能和 `--headless` 同时使用                                                                                                                                  |
| `--browser-transport pipe\|websocket`                      | CDP 传输，默认 pipe；`--transport` 是别名                                                                                                                                                                                                               |
| `--executable`、`--user-data-dir`                          | Chrome 路径；持久 profile（单浏览器，不按租约分上下文）                                                                                                                                                                                                 |
| `--endpoint URL`、`--expose-existing-tabs`                 | 连接已有 Chrome 而不是启动新的；默认只附加本服务打开的标签页。`--endpoint` 不能与启动参数（窗口模式、浏览器传输、可执行文件、profile、代理、UA、语言、窗口尺寸、预设）合用                                                                              |
| `--proxy URL`                                              | 上游代理；带凭证时需要按租约分上下文，因此不能与 `--user-data-dir` 合用                                                                                                                                                                                 |
| `--user-agent`、`--lang`、`--window-size WxH`              | 启动时设置                                                                                                                                                                                                                                              |
| `--preset agent\|default`                                  | 默认 agent：隐藏搜索引擎选择页和崩溃恢复气泡，关闭后台节流，并设置 `--password-store=basic`。在 Linux 上，Chrome 因此用内置密钥而不是系统密钥环加密已保存的密码和 cookie，不会弹出密钥环提示；而数据曾经通过密钥环加密的持久 profile 将无法读取这些数据 |
| `--input-policy instant\|human`                            | 新标签页的默认输入策略                                                                                                                                                                                                                                  |
| `--read-only`、`--disable-tool NAME[,NAME]`                | 只保留观察、导航和标签页生命周期工具（[见下](#只读模式)）；逐个关闭工具（可重复）                                                                                                                                                                       |
| `--upload-dir`、`--download-dir`、`--state-dir`            | 启用对应的文件工具，路径限定在该目录内                                                                                                                                                                                                                  |
| `--state-key-env`                                          | 存放口令的环境变量，用于加密 `--state-dir` 中的文件                                                                                                                                                                                                     |
| `--allow-handoff`                                          | 未显式 `--headful` 时也允许 `browser_handoff`                                                                                                                                                                                                           |
| `--remote-handoff`、`--remote-handoff-link-in-result`      | 允许用户通过回环地址上的查看链接操作标签页，详见 [HTTP 接入](mcp-http.md#远程人工接管)。仅限 HTTP 传输                                                                                                                                                  |
| `--max-browsers`、`--contexts-per-browser`、`--max-leases` | 资源上限                                                                                                                                                                                                                                                |
| `--lease-idle-ms`、`--queue-limit`、`--operation-timeout`  | 租约闲置期限、队列长度、操作期限                                                                                                                                                                                                                        |

## 工具

默认 26 个工具：

| 工具                   | 用途                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_tabs`         | 查看连接状态、标签页、frame 和待处理的 JS 对话框；不启动浏览器                                                                                                                                    |
| `browser_open`         | 懒启动或连接浏览器并打开新标签页，返回 tabId                                                                                                                                                      |
| `browser_navigate`     | 导航已打开的标签页；waitUntil 支持 commit/domcontentloaded/load/networkidle                                                                                                                       |
| `browser_history`      | 后退、前进或刷新；没有历史项时返回 moved:false                                                                                                                                                    |
| `browser_close_tab`    | 关闭指定标签页                                                                                                                                                                                    |
| `browser_snapshot`     | 缩进文本形式的可访问性树、`[e12]` 引用与布局框；interactiveOnly、viewportOnly、root 子树、offset 分页                                                                                             |
| `browser_find`         | CSS/XPath/文本查询，返回引用、角色、名称、标签、文本摘要与可见性                                                                                                                                  |
| `browser_wait`         | 在所选 frame 中等待匹配元素出现（可要求可见），返回新引用及描述                                                                                                                                   |
| `browser_click`        | 检查稳定性、可见性和遮挡后点击；支持 button、clickCount                                                                                                                                           |
| `browser_click_at`     | 点击视口坐标（canvas、地图等），不做遮挡检查                                                                                                                                                      |
| `browser_hover`        | 把指针移到元素上，不按下                                                                                                                                                                          |
| `browser_drag`         | 从元素拖到另一个元素（`to`）或视口坐标（`toX` 与 `toY`）                                                                                                                                          |
| `browser_fill`         | 替换输入内容，支持中文与 emoji                                                                                                                                                                    |
| `browser_type`         | 在光标/选区处输入；human 模式下 US 布局字符使用按键事件                                                                                                                                           |
| `browser_press_key`    | 向焦点元素发送按键或组合键，如 Enter、Shift+Tab、Control+A（macOS 全选用 Meta+A）                                                                                                                 |
| `browser_select`       | 修改 select 的选中值                                                                                                                                                                              |
| `browser_check`        | 设置 checkbox/radio 的选中状态                                                                                                                                                                    |
| `browser_scroll`       | 把元素滚动进视口（ref），或在指定坐标发送滚轮增量                                                                                                                                                 |
| `browser_dialog`       | 接受或取消当前 JS 对话框，支持 promptText                                                                                                                                                         |
| `browser_screenshot`   | 视口、整页或元素（ref）的 PNG/JPEG/WebP，可设 quality、scale，marks 在图上标注 ref                                                                                                                |
| `browser_network`      | 按需记录最近的响应（URL、状态、类型、MIME），不含响应头和响应体                                                                                                                                   |
| `browser_evaluate`     | 在指定标签页/frame 执行异步 JS 函数体，参数与结果均为 JSON                                                                                                                                        |
| `browser_input_policy` | 设置标签页的 instant/human 策略、种子、时间与步数范围、滚轮类型与 `wheelNotch`、`pointerGrid`、`lateMoves`、`targetInset`、打字与滚动方式，以及 `presentationRecovery`（见[参数](input.md#参数)） |
| `browser_environment`  | 结构化诊断或显式对齐；网络探针和 GeoIP 解析器由宿主配置                                                                                                                                           |
| `browser_close`        | 关闭自有浏览器或断开外部浏览器；之后可再次 open                                                                                                                                                   |
| `browser_handoff`      | 请用户在浏览器中完成手工操作并确认；需要可访问的 UI 和 elicitation.form                                                                                                                           |

宿主配置目录后出现的可选工具：

- **`browser_upload`**（`--upload-dir`）：文件名必须解析到该目录内。离开该目录的文件名在访问文件系统之前就被拒绝，解析后离开该目录的链接同样被拒绝。错误信息只提及调用者给出的文件名，不包含宿主路径。
- **`browser_downloads`**（`--download-dir`）：列出或等待最近 100 条下载记录，文件以 GUID 命名保存在该目录。每条记录带递增的 `sequence`，list 返回 `latestSequence`。wait 不占用操作队列，因此可在触发下载的点击之前或之后调用；它等待序号大于 `after` 的第一条记录完成或取消，`after` 默认为该标签页上次 wait 返回的序号（初始为 0）。超时会报错且不推进游标，再次 wait 继续等待同一个下载。
- **`browser_storage_state`**（`--state-dir`）：按名称保存或加载 Cookie 与第一方 localStorage，范围是该上下文中任一 frame 用过的 HTTP(S) 源，包括已关闭的标签页。空存储不导出，跨站 iframe 的分区 localStorage 也不导出。读写在拦截文档请求的临时空白页中进行，因此不会访问站点，也不跟随重定向。状态文件拒绝已有的符号链接与硬链接，经临时文件原子替换保存，POSIX 权限为 0600。文件内容不进入对话，只返回计数。文件位于 `<state-dir>/<principal>/<name>.json`，因此名称归已认证的主体私有。保存时用 `include` 可加入 `sessionStorage` 或 `indexedDB`，含义同 [`storageState`](api.md#状态与存储)；加载带 sessionStorage 的状态需要 `tabId`，该标签页最后停在 about:blank。使用 `--state-key-env NAME`（嵌入时为 `stateKey`：32 字节密钥或口令）后，文件用 AES-256-GCM 加密，并拒绝读取明文文件，因此把文件换成明文也无法降级。密钥只由主机配置，工具参数里没有密钥。认证主体符合 `[a-z0-9_-]{1,64}` 时目录名就是它本身，否则为 `p-` 加上认证主体的 SHA-256 十六进制值；未传 binding 的服务使用 `private`，CLI 的 HTTP 和 socket 服务使用 `local-operator`。认证主体目录位置上的链接会被拒绝。加载未知名称时报告 `No saved state named <name>`，与其他认证主体是否保存过该名称无关。

开启 `--remote-handoff`（仅限 HTTP）时还会出现 `browser_handoff_wait`，用于等待远程人工接管结束，或将其取消，见[远程人工接管](mcp-http.md#远程人工接管)。

### 只读模式

`--read-only`（嵌入时为 `readOnly`）注册 `browser_tabs`、`browser_open`、`browser_navigate`、`browser_history`、`browser_close_tab`、`browser_snapshot`、`browser_find`、`browser_wait`、`browser_screenshot`、`browser_network` 和 `browser_close`，不注册页面输入、脚本、输入策略、环境更改、上传、下载、存储状态、对话框和人工接管工具。浏览器并不会保持不变：导航会加载页面，两个关闭工具会结束该租约的标签页和浏览器（使用 `--expose-existing-tabs` 时也包括暴露的标签页；外部浏览器只断开连接）。保留它们是为了让 agent 能自行清理；如需一并移除，再加 `--disable-tool browser_close_tab,browser_close`。

### 动作与等待

动作工具（click、click_at、hover、drag、fill、type、press_key、select、check）接受 `waitFor`：

- `auto`：click、click_at、press_key 的默认值。动作后观察 250 ms，若开始导航则等待加载结束或对话框出现。
- `load`：必须观察到导航完成，同文档导航与 BFCache 恢复也算。
- `none`：其余动作的默认值。

导航等待与动作共用 `timeout`（默认 10 秒，最大为操作期限）。等待超时返回错误，已执行的动作不会回滚或重放；操作期限或取消结束等待时，错误信息同样以 `Action completed, but` 开头。结果包含 tabId、url、navigated、loading、tabClosed、newTabs 和 dialog。`snapshot: true` 时还附带一次 interactiveOnly 快照，省去一次往返；该快照失败时，结果照常成功，并以 `snapshotError` 代替快照。

标签页上打开 JS 对话框期间，Chrome 不会回复动作的输入命令。对话框打开时尚未结束的动作会立即返回：结果设置 `dialog` 并带 `pending: true`，不含完成时才报告的字段（如 `clicked`），也不附带快照。动作在该结果之后继续运行，最长到其 `timeout`：

- 租约的操作队列和其浏览器进程的队列一直被占用，直到动作结束。其他工具在后面等待，各自保有操作期限和取消能力；`browser_dialog`、`browser_tabs`、`browser_downloads` 与 `browser_handoff_wait` 不进入队列。
- `browser_dialog` 回答对话框后动作继续，下一个工具在动作结束后运行。
- 结果写入 `browser://events`（`action-completed`，或带 `error` 信息的 `action-failed`）和该标签页的 `lastInput`。
- 到达 `timeout` 时动作失败并释放队列，因此没有人回答对话框时可以用 `browser_close_tab` 或 `browser_close` 结束该标签页。此后该浏览器上的输入会等到对话框被回答或标签页关闭，各工具受自身期限约束。

推荐流程：

1. `browser_open({ url })`，获得 `tabId`。
2. `browser_snapshot({ tabId })` 观察页面并获得元素 `ref`；复杂的选择用 `browser_find`。
3. `browser_click({ tabId, ref: "e12" })` 或 `browser_fill({ tabId, ref, text })`；需要立即看到结果时加 `snapshot: true`。
4. 根据动作摘要（是否导航、新标签页、对话框）决定下一步，或等待预期元素出现。

### 快照与引用

标签页和 frame 都通过返回的 ID 指定，不存在隐式的“当前标签页”。`browser_snapshot` 默认读取主 frame，同进程和跨进程 iframe 用返回的 `frameId` 选择。快照读取 `Accessibility.getFullAXTree`，只包含浏览器渲染出的语义信息，不是完整的 DOM 导出；AX 树中没有暴露的目标用 `browser_find` 查找。输出去掉无名称的 generic/none/presentation 包装层和与父节点重复的静态文本，以缩进表示层级，同时返回结构化 nodes（depth、role、name、states、value、url、box）。

每个节点行带有布局框 `@x,y WxH`：左上角坐标和尺寸，单位是标签页视口的 CSS 像素，iframe 里的节点也换算到标签页视口，例如 `- button "提交" [e12] @412,300 96x32 disabled`。视口外的节点标 `offscreen`；没有布局的节点（如隐藏元素）没有框（`box: null`）。响应还包含 `viewport`，即视口的 CSS 像素尺寸。`viewportOnly: true` 只返回与视口有重叠的节点，此时分页和 `totalNodes` 只计这些节点。布局框来自该 frame 所在 session 的一次 `DOMSnapshot.captureSnapshot`，加上 `Page.getLayoutMetrics`，iframe 还要加上各级 `<iframe>` 元素的内容框，不在页面里执行脚本。布局框描述的是布局而不是绘制：被其他元素遮住、被滚动容器裁掉的元素仍有布局框。iframe 内不考虑双指缩放。Chrome 没有报告布局时，节点没有布局框，`viewport` 为 null，`viewportOnly` 会报错。

`browser_screenshot` 传 `marks: "interactive"`（只标控件，同 `interactiveOnly`）或 `marks: "all"`（标所有带 ref 的节点）时，截取视口 PNG，并在主 frame 的每个可见节点上画出边框和 ref 编号（`e12`），最多 500 个。结果还以文本和结构化形式附带图例 `legend`：`{ ref, role, name, box }`，其中 box 与快照一样使用 CSS 像素；可见节点超过上限时 `truncated` 为 true。marks 不能和 `ref`、`fullPage`、png 以外的 `format` 或 `quality` 同时使用，`scale` 可以。快照在截图前读取，两者之间页面若有移动，标注会偏移。标注时拒绝超过 16,777,216 像素（4096 × 4096）的截图。

引用是 `e1`、`e2` 这样的短 ID，保存在服务端，绑定实际元素、session 与文档代次，不向 DOM 写入标记。同一文档中的同一节点保持同一引用。导航、换进程、节点删除或标签页关闭后，旧引用会报错，不会被替换成相似的新元素。每个租约最多保留 2000 个引用，淘汰最久未使用的引用；遇到这种情况时重新快照或查找。

快照每页默认 200 个节点、最多 500 个，名称截断到 300 字符。响应包含 `truncated`、`totalNodes` 和 `nextOffset`，用 `offset` 继续读取。分页只限制输出，底层读取完整 AX 树。一次快照最多覆盖 20,000 个节点：超过后停止遍历，每一页的 `capped` 和 `truncated` 都为 true，`totalNodes` 止于该上限，最后一页没有 `nextOffset`。其余部分通过 `root` 或 `frameId` 读取。

文本结果同时提供 `structuredContent` 和 JSON 文本。截图直接以 image 返回，上限 5 MiB，不接受输出文件路径。快照返回输入控件的当前值，但密码字段一律以掩码代替，`browser_find` 的文本摘要同样不回显密码。页面文字和对话框消息是不可信数据，不是给 agent 的指令。

### 输入策略与环境

默认策略为 instant；human 模式见[输入](input.md)。输入动作提前结束时，工具错误带有 `partialInput`，即该动作的报告（`action`、`status`、`completedSegments`、`events`、`dispatched`、`sent`、`skippedMoves`、`lateReplies`、`presentationRecoveries`、`plannedMs`、`actualMs`、`phase`、`cleanup`、`cleanupErrors`、`trace`、`seed` 和 `randomState`，见[输入](input.md)）。由于不会重放任何动作，它用来表明输入进行到了哪一步。`browser_tabs` 以 `lastInput` 显示每个标签页的最后一个动作，只含 `action`、`status`、`events`、`completedSegments` 和 `cleanup`。

环境字段、覆盖核验和网络限制见[环境](environment.md)；宿主未配置探针时不会探测外网。诊断与对齐会创建临时资源或发送显式 Emulation 配置，因此 `browser_environment` 没有标为 readOnly。

## 页面 JavaScript

`browser_evaluate` 用于批量提取 DOM、读取业务状态、调用页面函数或显式修改 DOM。`script` 是 **async 函数体**：用 `return` 返回结果，可直接 `await`。JSON 参数在页面中名为 `arg`，省略时为 null。

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

- **结果**：`{ "type": "json", "value": ... }`；无 return 或返回 undefined 时为 `{ "type": "undefined" }`。对象遵循 `JSON.stringify` 语义（Date 变成字符串，嵌套 undefined 被省略，NaN 变成 null）；BigInt、循环引用、顶层 function/symbol 报错。DOM 节点须映射成所需字段，不返回远端句柄。
- **大小**：脚本与参数（JSON 序列化后）各最多 32,768 个字符，结果 JSON 最多 262,144 个字符。超限报错，不截断。
- **范围**：`frameId` 可选，省略时为主 frame。它必须属于当前租约的标签页，支持同进程 iframe 与 OOPIF。`world` 默认 main，可访问页面全局变量；isolated 与页面 JS 全局对象隔离，但共享 DOM，不是安全沙箱。脚本只在 Chrome 中运行，无法访问宿主的 Node、文件系统或进程；请求、Cookie、存储和同源限制遵循页面自身权限。该工具能读写页面敏感状态，因此标为会修改状态。
- **期限**：超时时间默认 10 秒，最大为操作期限（默认 30 秒）。CDP 执行期限限制初始同步计算，宿主等待期限与取消同时生效。已安排的定时器、网络请求或异步任务可能在到期后继续运行，已产生的副作用会保留。 超时或取消后不重放，后续操作可能与遗留的页面任务交错；要停止页面上的全部任务，请关闭该标签页。
- **输入行为**：`element.click()`、直接赋值 value 或 `dispatchEvent()` 不经过输入策略，也不产生可信输入事件。需要真实输入时使用 `browser_click`、`browser_fill`、`browser_type` 和 `browser_scroll`。跨页面导航请用 `browser_navigate`，以免执行期间文档被销毁。

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

`launch` 与 `connect: { endpoint }` 互斥。每次工厂调用创建独立的实例与引用注册表，不要让无关的 agent 共用一个实例。返回值是标准 `McpServer`，可以注册应用自己的工具。关闭服务或 stdin EOF 会清理其拥有的 Chrome 与临时 profile，并保留持久 profile；CLI 收到 SIGINT/SIGTERM 时同样如此。进程被强杀或断电可能留下浏览器进程或临时文件。

第二个参数 `BrowserMcpBinding` 传入已有的 `BrowserSessionManager`、已验证的主体和 leaseId。此时 `server.close()` 只关闭适配器，租约归管理器管理，见 [HTTP 接入](mcp-http.md#嵌入与所有权)。

服务依赖固定版本的官方 SDK `@modelcontextprotocol/server` 2.3.1 与 Zod 4.6.7。默认 HTTP 与字节流入口使用 SDK 的 `legacy: 'reject'`，`server.connect(InMemory)` 同样走现代路由，前面另有一层薄薄的检查，拒绝 initialize、其他版本和缺少版本元数据的请求。解析、envelope 校验、MRTR、订阅和取消由 SDK 处理。参见[协议规范](https://modelcontextprotocol.io/specification/2026-07-28)。

## 并发、取消与边界

- **串行**：同一租约的浏览器操作串行执行，输入、导航和引用观察互不干扰。`browser_tabs`、`browser_dialog`、`browser_downloads` 与 `browser_handoff_wait` 不进入操作队列：前两者用于发现并回答阻塞动作的 JS 对话框，下载等待可与触发它的点击同时进行，`browser_handoff_wait` 只等待远程人工接管，不操作页面。`browser_handoff` 的应答轮次同样不进入队列；其第一轮在队列中排队，以便移动焦点。
- **取消**：取消信号传递到导航、等待、查询、快照和支持取消的动作。已发出的 CDP 命令和输入不能撤销；队列不会因为客户端停止等待就提前放行下一个写操作。
- **错误**：工具错误返回 `isError: true` 及错误名称与信息，不自动重放点击、提交或其他动作。输入 schema 拒绝多余字段；对于参数本会被忽略的组合，工具以 `TypeError` 拒绝：`browser_environment` 的 inspect 模式搭配 `environment` 或 `geoip`；`browser_drag` 的 `to` 搭配 `toX` 或 `toY`（须给出 `to`，或同时给出两个坐标）；`browser_scroll` 的 `ref` 搭配非零增量或坐标；`browser_screenshot` 的 `ref` 搭配 `fullPage`，或 PNG 搭配 `quality`；`marks` 搭配 `ref`、`fullPage`、非 PNG 格式或 `quality`。导航只接受 HTTP(S) 与 about:blank；这不是网络隔离，页面重定向、链接和浏览器自身请求仍按 Chrome 的行为进行。
- **范围**：不提供远程多租户、任意 CDP 或宿主脚本执行。文件工具只在宿主配置目录后出现，并限定在该目录内。工具描述与 annotations 供客户端展示，不是访问控制。
- **痕迹**：AX 快照不启用 Runtime。`browser_network` 的 `start` 会在标签页剩余生命周期内启用 CDP Network 域；`stop` 只结束记录。其他可观测的信号见[浏览器行为](automation-audit.md)。

## 测试

```sh
npm run test:mcp
npm run test:all
```

测试用官方 MCP 客户端驱动真实 stdio 子进程，覆盖两种 Chrome 传输，并检查默认入口拒绝旧协议；兼容测试覆盖两个 2025 版本的协商、取消、会话隔离与能力检查。测试还覆盖四类 frame、closed shadow root、引用失效与跨标签页拒绝、中文输入、checkbox/select、截图、非法参数、取消、JS 对话框和下载等待。嵌入测试记录 CDP 命令，并检查关闭后清理自有 profile、保留外部 Chrome。EOF 测试只关闭 stdin 并等待服务自行退出，然后检查持久 profile 保留、锁与 `DevToolsActivePort` 已删除、调试端口已关闭。
