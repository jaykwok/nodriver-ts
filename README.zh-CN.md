# nodriver-ts

基于 [nodriver](https://github.com/ultrafunkamsterdam/nodriver) 重新设计的 TypeScript 实现。

[English](README.md)

直接使用 Chrome DevTools Protocol 驱动 Chrome/Chromium/Edge。默认不发送 `Runtime.enable`，保留 Chrome sandbox 和站点隔离，支持 WebSocket 与 Pipe。内置 MCP 服务（Streamable HTTP、stdio、本地 socket），供 agent 使用同一内核。

## 运行

安装：`npm install nodriver-ts`。源码开发与测试使用下列命令。

包需要 Node.js 22+；从源码构建和测试需要 Node.js 24+（直接运行 TypeScript 源码）。另需本机 Chrome/Chromium/Edge（Windows、macOS、Linux 常见路径与 `PATH` 自动探测，也可用 `CHROME_PATH` 或 `executablePath` 指定）。已验证的系统和版本见 [支持范围](docs/support.md)。

```sh
npm ci
npm run check
npm test
npm run test:integration
npm run test:dist   # 构建后对包与 MCP HTTP 做冒烟测试
```

默认打开有界面 Chrome（`headless: false`）；没有图形桌面的服务器或 CI 请显式设置 `headless: true`。Linux 应使用普通用户运行并安装 Chrome 所需共享库；框架不会自动添加 `--no-sandbox`。WSL 的默认有界面模式需要 WSLg 或其他可用显示服务。

```ts
import { Browser } from 'nodriver-ts';

await using browser = await Browser.launch({ transport: 'websocket' });
await using context = await browser.newContext();
const tab = await context.newTab('https://example.com');
console.log(await (await tab.waitForSelector('h1')).text());
```

`await using` 在正常退出和异常展开时关闭资源。也可使用 `try/finally` 调用幂等 `close()`。库默认不接管宿主信号；`handleSignals: true` 可启用拥有进程的 SIGINT/SIGTERM 清理。强制终止控制器或机器断电无法由 JavaScript 保证清理。

`launch()` 和 `connect()` 均接受 `trace: (entry) => ...`，可记录 CDP 方法、会话、耗时和错误，不含参数或结果。`nodriver-ts/testing` 提供能完成启动握手的 `ScriptedChrome`，可使用真实 Browser/Tab/Session 编写脚本化回复、事件和故障测试，详见[测试接口](docs/testing.md)。

需要宿主退出后保留 Chrome 时，使用 `Browser.launch({ detached: true, transport: 'websocket' })`，保存 `await browser.release()` 返回的 endpoint，下次用 `Browser.connect({ endpoint })` 重连。交接后 `close()` 和异步析构只断开连接，profile 保留，宿主锁移除；pipe 交接明确报错。独立启动会丢弃 Chrome stderr，宿主在交接前崩溃可能留下 Chrome。详见[浏览器交接与事件](docs/browser-handoff.md)。

启动选项还包括 `lang`、`windowSize`、`userAgent`、`preset: 'agent'`（关闭首次运行/搜索引擎选择界面与后台节流）。持久 `userDataDir` 使用带 PID/主机名的锁文件，仅在确认本机持有进程已退出时回收陈旧锁；Chrome 未正常退出留下的 `DevToolsActivePort` 在其端口无响应时自动清理。

## 页面、元素与 frame

```ts
const tab = await browser.newTab('https://your-app.example');
await (await tab.waitForSelector('#name')).fill('中文与 emoji 😀');
await Promise.all([
  tab.waitForNavigation({ waitUntil: 'networkidle' }),
  (await tab.waitForSelector('button[type=submit]')).click(),
]);
const text = await tab.query({ text: '提交成功', exact: true });
const xpath = await tab.query({ xpath: '//main/h1' });
await tab.screenshot({ path: 'page.png', fullPage: true });
```

CSS 和文本查询默认进入 open/closed shadow root；`pierce: false` 可关闭。查询在 isolated world 中执行；识别 closed shadow root 所需的 DOM 扫描会缓存，无 closed shadow root 的结果最多复用 1 秒。XPath 遵循标准语义，不穿越 shadow root。文本会折叠空白，默认只选可见且不包含同样匹配子元素的最小元素。查询只针对所选 frame。

```ts
for (const frame of tab.frames) {
  console.log(frame.id, frame.url, frame.session.id);
  const button = await frame.query('#inside-frame');
  if (button) await button.click();
}
```

OOPIF 在自己的 session 中查询和求值，点击坐标转换到顶层视口，并检查父层遮挡。frame 换进程、导航、renderer 崩溃会使旧元素与 JS 句柄失效。点击在派发前等待可见、启用、位置稳定和命中；不自动重放已经派发的操作。另有 `element.hover()`、`element.scrollIntoView()`、`mouse.drag()`。参考 [frame 示例](examples/frames.ts)。

## 求值与协议

```ts
console.log(await tab.evaluate('window.appState')); // 默认 main world
console.log(await tab.evaluate('typeof appState', undefined, { world: 'isolated' }));
const result = await tab.evaluate(({ a, b }) => a + b, { a: 1, b: 2 });
await using handle = await tab.evaluateHandle('document.body');
console.log(await tab.cdp.send('Page.getLayoutMetrics'));
const off = tab.cdp.on('Page.javascriptDialogOpening', async () => {
  await tab.handleDialog(false);
});
off();
```

函数在浏览器中执行，不能捕获宿主闭包；参数通过单个可序列化值传递。用户 JS 异常抛出 `EvaluationError`。严格命令参数元组来自固定版本 `devtools-protocol`；`sendWith(method, { timeout, signal }, ...params)` 设置期限与取消。

框架不会自动启用 Runtime、Console 或 Debugger，也不使用 binding/主世界桥接脚本。主世界通过目标 frame 的 Document 和 `DOM.resolveNode` 按需发现，校验后缓存；内部格式不兼容时明确报错，不退回 `Runtime.enable`。事件按 session 路由，监听数量随 session 而非全局增长。设置 `NODRIVER_TRACE=1` 可把每条 CDP 命令（方法、session、耗时、错误码）写到 stderr，不记录参数或结果；也可传 `trace` 回调。

## 自动化痕迹

- 启动默认关闭 Chromium 的 `AutomationControlled` 特性，原生 `navigator.webdriver` 为 `false`；不注入 getter 补丁。
- 无界面模式默认（`maskHeadless`）通过逐目标覆盖去掉 UA 字符串与 UA-CH 中的 HeadlessChrome；专用 Worker 继承该覆盖，Shared/Service Worker 可能保留原值。仍推荐有界面模式。
- human 输入策略对 US 布局字符发送成对 keyDown/keyUp（含 Shift），其他文本（中日韩、emoji、换行）使用 insertText；按下时指针 pressure 为 0.5；首次指针位置随机，不从 (0,0) 起步；只在需要时把标签页置前。
- 不伪造字体、WebGL、canvas、音频或硬件，也不解验证码。时区、locale、UA/Client Hints、视口和地理位置只能通过 `tab.setEnvironment()` 显式设置。

更多边界、复现方法与已知信号见 [自动化痕迹审计](docs/automation-audit.md)。

## 状态、网络与文件

```ts
await context.setCookies([{ name: 'session', value: 'value', url: 'https://your-app.example' }]);
const state = await context.storageState('state.json');

const unroute = await tab.network.route(/\/api\/item$/, (route) =>
  route.fulfill({ headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }),
);
await unroute();
await tab.network.authenticate({ username: 'user', password: 'pass' });
tab.network.responses.on(({ event }) => console.log(event.response.status, event.response.url));

await context.setDownloadDirectory('./downloads');
const pending = tab.waitForDownload();
await (await tab.waitForSelector('a.download')).click();
await (await pending).saveAs('./downloaded.bin');
```

`Network.enable` 只在订阅 `responses`、调用 `network.enable()` 或设置 headers/cache/offline 时发送；路由与认证基于 Fetch，不需要它。下载先以 GUID 写入配置目录，`saveAs()` 后复制，不信任服务端文件名。Cookie 快照与状态文件包含凭证，存放位置由调用者决定。

```ts
await using proxied = await browser.newContext({
  proxy: 'socks5://user:password@proxy.example:1080',
});
```

`proxy` 使用本机转发器支持认证 HTTP(S)/SOCKS 上游；`proxyServer` 直接传给 Chrome。环境观测与诊断见 [环境采样](docs/environment.md)。

## 连接现有浏览器

```ts
await using external = await Browser.connect({ endpoint: 'http://127.0.0.1:9222' });
```

外部连接的 `close()` 只断开连接，不关闭 Chrome。`attach: 'created'` 只附加本客户端打开的标签页及其弹出页，不触碰用户已有标签页；默认 `'all'`。远程调试端点拥有浏览器控制权限，应由部署方限制访问。

## MCP / agent 调用

```sh
npm run build
# stdio（客户端启动）
node dist/mcp/cli.js
# 常驻本地 HTTP：先设置随机 NODRIVER_MCP_TOKEN（至少 32 字符）
node dist/mcp/cli.js --mcp-transport http --port 3100
```

安装包提供 `nodriver-mcp`，嵌入导出 `nodriver-ts/mcp`、`nodriver-ts/mcp/http`、`nodriver-ts/mcp/socket`。所有入口共用同一工具工厂、manager/池/租约与 CDP 内核，默认 26 个工具；设置 `--upload-dir`、`--download-dir`、`--state-dir` 后分别增加限定目录的上传、下载和状态工具。仅支持 MCP **2026-07-28**，旧协议在浏览器动作前拒绝；官方 client 2.3.1 需显式 pin 该版本。

- `browser_snapshot` 返回带 `[e12]` 短引用的缩进可访问性树，支持 `interactiveOnly`、`root`、`offset` 分页；密码字段值不会回显。
- 动作工具支持 `waitFor: auto|load|none` 与 `snapshot: true`，返回是否导航、新标签页、对话框等摘要。
- HTTP 仅监听 loopback；省略 `Browser-Lease-Id` 使用该 token 的 `default` 租约，任意合法名称（字母、数字、`. _ -`）首次使用即创建独立租约。
- `--read-only`、`--disable-tool` 限制工具面；`--proxy`、`--lang`、`--window-size`、`--input-policy human` 等见 `nodriver-mcp --help`。

## 文档

| 文档                                       | 内容                                          |
| ------------------------------------------ | --------------------------------------------- |
| [API](docs/api.md)                         | 对象、期限与取消、查询、求值、存储            |
| [输入](docs/input.md)                      | human 输入策略、文本与按键、点击检查、取消    |
| [环境](docs/environment.md)                | 环境采样、诊断、显式对齐、代理与 WebRTC       |
| [自动化痕迹审计](docs/automation-audit.md) | 默认协议行为、回归证据、检测结果              |
| [MCP](docs/mcp.md)                         | CLI、工具、引用、页面 JavaScript、嵌入        |
| [HTTP 接入](docs/mcp-http.md)              | 租约、认证、限额、资源、人工交互              |
| [socket 接入](docs/mcp-socket.md)          | Unix socket / 命名管道服务与客户端            |
| [支持范围](docs/support.md)                | 已验证平台、能力、限制                        |
| [性能](docs/performance.md)                | 基准方法与基线                                |
| [长稳测试](docs/soak.md)                   | 长时间资源回收测试                            |
| [上游映射](docs/upstream-api-map.md)       | nodriver 成员与 TypeScript 对应项             |
| [API 测试映射](docs/test-map.md)           | 每个公开成员与 MCP 工具对应的测试（自动生成） |

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

AGPL-3.0-or-later，见 [LICENSE](LICENSE)。
