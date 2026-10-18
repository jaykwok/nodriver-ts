# 本地 socket / Windows 命名管道

新增的输入策略、type、scroll 与环境诊断/显式对齐同样通过共享工厂提供。宿主可在 browser 选项预配探针/resolver；socket 适配器不生成轨迹或实现第二套环境逻辑。

可用 `--mcp-transport socket` 或 `nodriver-ts/mcp/socket` 连接常驻本地服务。Linux 使用 Unix domain socket，Windows 使用本机命名管道；仅接受 2026-07-28，拒绝 initialize/其他版本/缺失版本元数据；共用已有的 26 个默认工具（含页面脚本 browser_evaluate）、应用租约、浏览器池、资源和取消行为。这是需要配套客户端的自定义传输，普通 MCP 客户端可继续使用 stdio 或 HTTP。

服务使用官方 SDK 的 `serveStdio(factory, {transport, legacy: 'reject'})` 与 `StdioServerTransport` 复用 UTF-8 NDJSON 分帧、现代协议发现、订阅和取消；旧版 initialize 明确拒绝。[MCP 自定义传输规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)建议可靠字节流复用这种分帧；[Node IPC 文档](https://nodejs.org/api/net.html#ipc-support)说明了 Unix socket 和 Windows 命名管道路径。

## 启动

先设置随机的 `NODRIVER_MCP_TOKEN`（至少 32 字符），再运行：

```sh
bun run build
bun dist/mcp/cli.js --mcp-transport socket
```

服务前台运行，实际路径写 stderr，stdout 不输出日志或认证信息；不会安装后台服务、修改客户端配置。默认生成随机路径。可通过 `--socket-path PATH` 指定已有私有目录中的 Linux 绝对路径，或 Windows 本地 `\\.\pipe\nodriver-NAME`。`--token-env` 可改令牌环境变量名；Chrome 启动参数与 [MCP 说明](mcp.md)一致。

Linux 父目录必须属于运行用户、没有组/其他用户权限且不是符号链接；服务将 socket 设置为 `0600`。默认临时目录为 `0700`，关闭后删除。路径最多 100 个 UTF-8 字节；已存在的文件或 socket 均拒绝替换，崩溃残留需调用者核实后处理。Windows 仅接受 `\\.\pipe\nodriver-` 前缀的本机路径，不接受远程管道；使用系统默认管道 ACL，并额外强制令牌认证，不声称修改了 Windows ACL 或提供了跨用户沙箱。

关闭采用幂等保护：失败的 listen 不重复关闭未监听端点，已销毁的 socket 不再次携带错误销毁。Windows 补测曾在旧关闭路径出现 Bun 原生崩溃，当前保护经过端点冲突、重复 close 的 100 轮回归；这只建立当前路径的验证证据，没有声称修复 Bun 的原生根因。

## 同进程服务和官方客户端

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
  const leaseId = transport.leaseId; // 保存后可显式重连，同样必须提供令牌。
} finally {
  await client.close();
  await service.close();
}
```

完整示例见 `examples/mcp-socket.ts`。`leaseId` 绑定预配令牌映射的 principal，不信任 clientInfo。不同 principal 无法使用对方租约。客户端关闭取消该连接的在途请求，浏览器和 ref 保留到显式 `browser_close`、租约释放或闲置到期；重连必须重新认证并传 `leaseId`，不会自动重连或重放动作。`browser_close` 释放浏览器分配，租约仍可重新 open。

可信宿主可注入已有 `BrowserSessionManager`，并调用 `manager.release(principal, leaseId)` 立即释放租约。服务关闭也关闭注入的 manager；共享 manager 的宿主应统一安排停机。租约/池/自有与外部浏览器的生命周期规则见 [HTTP 接入](mcp-http.md)。

## 认证前导与限制

第一行是应用认证前导，不是 MCP 方法：

```json
{ "type": "nodriver-auth", "token": "预配的随机秘密", "leaseId": "可选的已有租约" }
```

成功后服务回复一行 `{"type":"nodriver-auth","leaseId":"..."}`，之后只传标准 NDJSON JSON-RPC。省略 leaseId 创建懒租约，不启动 Chrome；认证失败直接关闭，不回显凭证。前导支持拆包及与第一条 MCP 消息粘包。令牌明文在本机 IPC 内传输，不应用于远程连接或不可信租户。

默认限制：32 个连接（含未认证连接）、认证前导 4 KiB / 5 秒、每连接 20 个未完成请求 / 4 个现代订阅、输入消息缓冲 256 KiB、待分派消息 128 条、输出缓冲 8 MiB、写入期限 60 秒。重复在途请求 ID、容量超限、非法 NDJSON、慢写入会关闭连接；客户端响应接收上限 8 MiB。浏览器操作沿用默认 30 秒总期限、有界队列和租约闲置 5 分钟回收。除协议通知外，不向标准流塞入任意 CDP 事件。

仅支持 2026-07-28；取消使用 notifications/cancelled，连接 EOF 同时中断该连接全部请求。动作已产生的副作用不能撤销，其他连接仍受同一浏览器写队列协调。资源更新由 SDK 的 subscriptions/listen 过滤，旧 resources/subscribe 不受支持。通知与同批响应按接收顺序分派，确保 SDK 异步进度回调在请求完成前处理。
