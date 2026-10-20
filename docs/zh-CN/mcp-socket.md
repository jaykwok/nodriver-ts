# 本地 socket / Windows 命名管道

[English](../mcp-socket.md)

`--mcp-transport socket` 或 `nodriver-ts/mcp/socket` 提供常驻的本地 IPC 服务：Linux 使用 Unix domain socket，Windows 使用本机命名管道。它与其他接入共用 26 个默认工具、应用租约、浏览器池、资源和取消行为，仅支持 MCP 2026-07-28。这是需要配套客户端的自定义传输；普通 MCP 客户端请使用 stdio 或 HTTP。

服务使用官方 SDK 的 `serveStdio(factory, { transport, legacy: 'reject' })` 与 `StdioServerTransport`，复用其 UTF-8 NDJSON 分帧、协议发现、订阅和取消。分帧方式参见 [MCP 自定义传输](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)，路径格式参见 [Node IPC](https://nodejs.org/api/net.html#ipc-support)。

## 启动

先设置随机的 `NODRIVER_MCP_TOKEN`（至少 32 个字符）：

```sh
npm run build
node dist/mcp/cli.js --mcp-transport socket
```

服务在前台运行，实际路径写 stderr，stdout 不输出日志或认证信息。默认生成随机路径；`--socket-path PATH` 可指定 Linux 上已有私有目录中的绝对路径，或 Windows 本机的 `\\.\pipe\nodriver-NAME`。`--token-env` 修改令牌所在的环境变量名，Chrome 启动参数与 [MCP](mcp.md) 相同。

- **Linux**：父目录必须属于运行用户、没有组或其他用户权限且不是符号链接；socket 权限为 0600。默认临时目录为 0700，关闭后删除。路径最多 100 个 UTF-8 字节；已存在的文件或 socket 一律拒绝替换，崩溃残留需调用者核实后处理。
- **Windows**：只接受 `\\.\pipe\nodriver-` 前缀的本机路径，不接受远程管道。使用系统默认的管道 ACL 并额外强制令牌认证，不提供跨用户沙箱。

关闭是幂等的：listen 失败时不重复关闭未监听的端点，已销毁的 socket 不再次销毁。

## 客户端

```ts
import { Client } from '@modelcontextprotocol/client';
import {
  startBrowserMcpSocketServer,
  BrowserMcpSocketClientTransport,
} from 'nodriver-ts/mcp/socket';

const token = process.env.NODRIVER_MCP_TOKEN!;
const service = await startBrowserMcpSocketServer({ tokens: { [token]: 'local-operator' } });
const transport = new BrowserMcpSocketClientTransport({ path: service.path, token });
const client = new Client(
  { name: 'local-agent', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
try {
  await client.connect(transport);
  console.log((await client.listTools()).tools);
  const leaseId = transport.leaseId; // 保存后可显式重连，重连同样需要令牌
} finally {
  await client.close();
  await service.close();
}
```

完整示例见 `examples/mcp-socket.ts`。`leaseId` 绑定预配令牌映射的 principal，不信任 clientInfo，不同 principal 无法使用对方的租约。客户端关闭会取消该连接的在途请求，浏览器和引用保留到显式 `browser_close`、租约释放或闲置到期。重连必须重新认证并传入 `leaseId`；不会自动重连或重放动作。

可信宿主可以注入已有的 `BrowserSessionManager`，并调用 `manager.release(principal, leaseId)` 立即释放租约。服务关闭时也会关闭注入的 manager，共享 manager 的宿主应统一安排停机。租约、池以及自有和外部浏览器的生命周期规则见 [HTTP 接入](mcp-http.md)。

## 认证前导

连接的第一行是应用认证前导，不是 MCP 方法：

```json
{ "type": "nodriver-auth", "token": "预配的随机秘密", "leaseId": "可选的已有租约" }
```

成功后服务回复一行 `{"type":"nodriver-auth","leaseId":"..."}`，之后只传标准 NDJSON JSON-RPC。省略 `leaseId` 会创建懒租约，此时不启动 Chrome；认证失败直接关闭连接，不回显凭证。前导可以被拆包，也可以与第一条 MCP 消息粘包。令牌以明文在本机 IPC 内传输，不应用于远程连接或不可信租户。

## 限制

| 默认值           | 范围                          |
| ---------------- | ----------------------------- |
| 32               | 连接数，含未认证连接          |
| 4 KiB / 5 秒     | 认证前导大小与期限            |
| 16 / 4           | 每连接未完成请求数 / 订阅数   |
| 256 KiB / 128 条 | 输入消息缓冲 / 待分派消息     |
| 8 MiB / 60 秒    | 输出缓冲 / 写入期限           |
| 8 MiB            | 客户端响应接收上限            |
| 30 秒 / 30 分钟  | 浏览器操作期限 / 租约闲置回收 |

重复的在途请求 ID、超出容量、非法 NDJSON 和过慢的写入都会关闭连接。除协议通知外，不向流中写入任意 CDP 事件。

取消使用 `notifications/cancelled`，连接 EOF 会中断该连接的全部请求。已产生的副作用不能撤销，不同连接仍由同一浏览器写队列协调。资源更新由 SDK 的 `subscriptions/listen` 过滤，不支持旧的 `resources/subscribe`。通知与同批响应按接收顺序分派，确保 SDK 的异步进度回调在请求完成前处理。
