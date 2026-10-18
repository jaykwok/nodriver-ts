# 本地 Streamable HTTP 与浏览器租约

默认 26 个工具（宿主配置目录后另有上传、下载、状态 3 个可选工具）共用浏览器核心，含页面脚本 browser_evaluate，接口与边界见 [MCP](mcp.md)。宿主可在 browser 配置 inputPolicy、environmentDiagnostics（显式 httpProbe/stunServers）和 geoIPResolver；诊断默认不访问外网。browser_input_policy/type/scroll/environment 与库 API 的输入状态、取消报告和验证语义相同，见 [输入](input.md)、[环境](environment.md)。

Streamable HTTP 是长期运行的本地服务主入口，stdio 是兼容启动/传输入口；两者共用工具工厂、BrowserSessionManager/池/租约和 CDP 内核。服务在 Bun 下使用 Bun.serve、在 Node.js 22+ 下使用 node:http 适配（同一 fetch 处理器，流式 SSE 带背压），官方 SDK 2.3.1，仅支持 **2026-07-28**。应用级 Browser-Lease-Id 保持跨请求浏览器状态；不提供旧 MCP session 或远程不可信多租户部署。

## 启动

```sh
bun run build
# 在当前终端设置 NODRIVER_MCP_TOKEN 为随机秘密（至少 32 个字符）
bun dist/mcp/cli.js --mcp-transport http --port 3100 --browser-transport pipe
```

默认只监听 127.0.0.1，前台运行，日志写 stderr，秘密从环境读取且不会打印。可用 `--token-env NAME` 指定其他环境变量。`--transport pipe|websocket` 保留为 Chrome 传输的旧别名；MCP 传输只由 `--mcp-transport http|stdio|socket` 选择。默认有界面 Chrome；无桌面服务环境加 `--headless`，嵌入时设 `browser: { launch: { headless: true } }`。保留 `--headful`、持久 profile、可执行文件及外部 endpoint 参数。服务由当前前台进程持有，不安装 OS 服务/自启动、不重命名项目或修改客户端配置。

## 建立与使用租约

最简单的接法只配置 Authorization：省略 `Browser-Lease-Id` 时，请求使用该凭证（principal）的 `default` 租约，首次 POST 时创建。需要多个独立浏览器状态时，在 Header 中发送任意租约名称（1–64 个字母、数字、`.`、`_`、`-`），同一 principal 下同名即同一租约，首次 POST 时创建；名称只在该 principal 内有效，不能借此访问他人租约。非法名称返回 400，达到租约上限返回 429，未知或过期的随机 ID 返回 404；GET/DELETE 等非 POST 请求只查找、不创建。每个 /mcp 响应都带 `Browser-Lease-Id` 响应头，值为实际租约 ID。嵌入时设 `requireLeaseHeader: true` 可恢复强制 Header 的旧行为。

也可以先用同一 Bearer 凭证显式创建随机 ID 租约：

```http
POST /leases
Authorization: Bearer <secret>
Content-Type: application/json

{}
```

201 响应包含随机 `id`、已验证的 principal、创建及最后使用时间。此接口接受空对象，不能由请求指定 profile、身份或浏览器启动参数。管理接口为 `GET /leases`（只列出该身份租约）和 `DELETE /leases/{id}`（释放整个租约）。这些是应用 API，不是 MCP 标准方法。

使用随机 ID 时，将以下 header 配给客户端的 `/mcp` HTTP 连接：

```text
Authorization: Bearer <secret>
Browser-Lease-Id: <id from POST /leases>
```

每次请求均重新验证凭证与租约归属，clientInfo/name、tabId、租约名称和随机租约 ID 本身都不能充当身份。两个 agent 需要独立状态时使用不同的租约名称或分别创建租约。只接受 POST /mcp；initialize、旧协议版本和 Mcp-Session-Id 明确拒绝，GET /mcp 与 DELETE /mcp 为 405（携带未知或越权租约时先返回 404）。Browser-Lease-Id 是应用租约，独立于单次请求与连接；断连后以同一凭证和租约建立新客户端，可继续使用仍有效的引用。

官方客户端示例（依赖 `@modelcontextprotocol/client` 2.3.1）：

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client(
  { name: 'local-agent', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3100/mcp'), {
    // 省略 Browser-Lease-Id 即使用 default 租约；'Browser-Lease-Id': 'agent-a' 选择命名租约
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
await client.listTools(); // 取得 schema 和 Header 镜像声明
const opened = await client.callTool({
  name: 'browser_open',
  arguments: { url: 'https://example.com' },
});
// 后续 snapshot/find/click 使用同一租约；每个 HTTP 请求结束不会销毁浏览器/ref。
await client.close();
// 任务结束时用 DELETE /leases/{id} 释放租约（id 见响应头 Browser-Lease-Id 或 GET /leases）。
```

现代客户端必须发送协议版本、方法、名称等标准 Header。tabId 声明 `x-mcp-header: Tab-Id`，对应 `Mcp-Param-Tab-Id`；官方 SDK 负责解码及 Header/Body 对比，服务随后仍校验 Tab/ref 的租约归属。Header 与逐请求 _meta 里的版本必须一致；仅接受 2026-07-28，不降级。入口验证精确 Host/端口和 Origin；允许缺省 Origin（本机非浏览器客户端），存在时默认必须等于服务 origin。嵌入可显式配置 `allowedOrigins`，但不因此免除认证，也未启用通用 CORS 或 OAuth 服务。

## 嵌入与所有权

```ts
import { startBrowserMcpHttpServer } from 'nodriver-ts/mcp/http';

const service = await startBrowserMcpHttpServer({
  tokens: { [secretA]: 'operator-a', [secretB]: 'operator-b' },
  port: 3100,
  browser: { maxLeases: 16, maxBrowsers: 2, contextsPerBrowser: 4 },
});
// 退出时：await service.close();
```

token→principal 映射由宿主可信配置提供，不接受客户端指定。`createBrowserMcpHttpService()` 提供同样的 fetch/close 接口，供本地宿主挂载；宿主必须保持 loopback 及精确 authority 约束。注入 manager 时，service.close() 也会关闭该 manager，应由一个应用服务拥有。

`BrowserSessionManager` 从 `nodriver-ts/mcp` 导出，可用于 stdio 或 InMemory：

```ts
const manager = new BrowserSessionManager();
const lease = manager.create('verified-local-identity');
const server = createBrowserMcpServer(
  {},
  {
    manager,
    principal: lease.principal,
    leaseId: lease.id,
  },
);
// 将 server 与官方 InMemoryTransport 链接，完整示例见 examples/mcp-inmemory.ts。
// server.close() 只关闭适配器；manager.release(principal, id) 才释放租约。
```

不传 binding 的 createBrowserMcpServer(options) 使用同一管理器实现创建私有 manager/租约；连接保留其私有租约至 EOF/close，然后清理自有 Chrome，外部 Chrome 只断连。InMemory 省去传输编解码，但 MCP 图片仍是 base64；需要 Buffer 可使用普通 TypeScript screenshot API。

普通 HTTP 租约懒分配独立 BrowserContext，可共用一个受控 Chrome 进程。同一浏览器进程的完整操作仍串行，跨租约也不并发抢焦点；tabs/dialog 保留响应阻塞对话框的旁路。BrowserContext 隔离 Cookie/storage，不是敌对租户的安全沙箱。进程到达配置容量后拒绝分配，不无限创建或等待。

持久 `userDataDir` 和外部 `connect` 使用排他进程分配：同一管理器至多一个活跃分配，不同时启动多个 Chrome 打开同一 profile。持久目录关闭后保留；外部连接只断开，保留其页面。释放普通租约时关闭所属 context；空闲进程可短暂复用，到期或服务退出后关闭并清理临时 profile。`browser_close` 释放当前分配和 refs，保留应用租约，可再次 open。租约 DELETE 则永久结束该租约。崩溃后的旧引用失效，需要 close 后再 open，不重放动作。

## 限额、取消与关闭

| 默认值                                   | 范围                                              |
| ---------------------------------------- | ------------------------------------------------- |
| 16 租约 / 2 Chrome / 每 Chrome 4 context | 管理器总上限                                      |
| 32 等待操作                              | 每租约及每共享进程队列，满时明确失败              |
| 30000ms                                  | 包括排队的操作期限                                |
| 1800000ms / 30000ms                      | 租约无活动到期 / 空闲进程关闭                     |
| 256 KiB                                  | HTTP 请求体上限，含实际流式读入；读体也有期限     |
| 16 请求 / 4 订阅                         | 每租约上限                                        |
| ≥35000ms / ≥60000ms                      | 请求建流期限 / 响应流最长寿命（随操作期限上调）   |
| 64 KiB / 8 MiB                           | 订阅输出缓冲 / 一般响应输出缓冲；过慢客户端被断开 |

CLI 也提供 `--max-browsers`、`--contexts-per-browser`、`--lease-idle-ms`、`--queue-limit`、`--operation-timeout`。更详细限额通过嵌入 options 设置。活跃请求和执行中的操作保护租约不被闲置扫描回收；HTTP 空闲租约仍按期限回收。长订阅受响应流寿命限制，客户端应显式重订阅并读取最新资源。

SSE 断流取消对应请求；取消不释放整个租约，不影响其他请求和有效状态。JSON 模式只返回最终结果；要即时断流取消/进度应使用 SSE。已投递点击、输入不能回滚；取消排队工作会移除它，执行中工作仍持有写锁直到收尾。服务退出停止接纳、取消并等待已有工作，然后释放租约和进程。MRTR 或网络恢复均不自动重放页面动作；不支持 Last-Event-ID 恢复。

## 资源、进度与人工交互

两个标准资源 `browser://state`、`browser://events` 只包含当前租约的信息。state 包含 tabs/frames/dialog、所属 context、队列及引用数。events 保留最近 64 条有序状态事件（导航、tab、dialog等），不声称是完整 DOM/网络事件总线。使用 subscriptions/listen 的 resourceSubscriptions 选择 URI；旧 resources/subscribe 和 GET SSE 接入不受支持。每个租约独立通知总线，状态变化合并后通知，断开后读取最新资源；不保证补齐已淘汰事件。

工具携带 progressToken 时发送 Queued/Running/Completed 三个阶段。auto 模式需要通知时升级 SSE；强制 json 模式按 SDK 语义省略中间通知。进度只表示阶段，不能推导 Chrome 操作完成百分比或响应时延。

`browser_handoff({tabId})` 请求用户在已经可访问的浏览器 UI 完成手工任务，再确认已完成。它不收集密码，不提供远程桌面，也不自动执行登录或恢复之前的点击。仍需显式 `--headful` / `launch.headless:false`，或宿主确认 UI 可访问后设置 `humanInteraction:true`，并且客户端声明 `elicitation.form`。默认有窗口不代表远程调用者能访问它，因此仅修改启动默认值不会自动放开人工接管。无能力时返回明确错误。

使用 2026-07-28 InputRequiredResult/MRTR；不启用 SDK 的 legacy elicitation shim。requestState 是有期限的随机标识，服务器保存其 Tab/租约和阶段；篡改、跨租约或未知状态被拒绝，已完成状态不会再执行前置步骤。完成只返回当前页面状态，调用者应重新 snapshot。秘密应由用户直接填入浏览器。

## 验证边界

测试覆盖 2026-07-28 JSON/SSE 和旧协议明确拒绝、跨请求/连接复用、认证与 Header、tab/ref 权限、取消/超时/配额、订阅过滤、人工交互、profile 归属及真实 CDP 禁止命令。具体平台及完整断言数量见 [支持矩阵](support.md)。内核的 Chrome 154/155、headful/headless 和环境采样证据继续保留。没有零拷贝截图、微秒响应或吞吐倍数结论。本地 socket 已提供；文件与状态工具需宿主配置目录后启用。OAuth、远程多租户、全量网络/DOM 订阅仍未实现。

当前版本通过双平台现代发现、跨请求/断连重连、元数据/旧协议拒绝、MRTR、订阅、取消与所有权有限回归；共享契约对 HTTP 与真实 stdio 子进程使用同一行为断言。具体数量见支持矩阵，旧三版本兼容记录仅作为开发历史保留，不代表当前支持范围。
