# 浏览器交接与 CDP 事件

[English](../browser-handoff.md)

包与示例统一需要 Node.js 24.22.0+。可使用 `await using` 或 `try/finally` 与 `close()`，先关闭子资源，再关闭所属 Browser。

`nodriver-ts` 可以直接作为进程内的库使用。浏览器交接不经过 MCP，也不改变 MCP 协议版本。

## 启动、交接与重连

```ts
import { writeFile, readFile } from 'node:fs/promises';
import { Browser } from 'nodriver-ts';

// 第一次运行：成功后保留浏览器；失败时仍由 await using 清理。
{
  await using browser = await Browser.launch({
    detached: true,
    transport: 'websocket',
    userDataDir: './exam-profile',
  });
  const tab = browser.tabs[0]!;
  // 执行应用自己的工作。
  // 先保存地址，避免 release 成功后写文件失败，失去重连信息。
  await writeFile('./browser-endpoint.json', JSON.stringify(browser.endpoint));
  const endpoint = await browser.release();
  console.log(endpoint);
}

// 下次运行：connect 不取得 Chrome 进程的所有权，close 只断开。
{
  const endpoint = JSON.parse(await readFile('./browser-endpoint.json', 'utf8')) as string;
  await using browser = await Browser.connect({ endpoint });
  console.log(browser.tabs.map((tab) => ({ id: tab.id, url: tab.url })));
}
```

`detached` 默认为 `false`，既有启动/关闭行为不变。设为 `true` 后，所有平台都以分离模式 spawn Chrome，stdin/stdout/stderr 都不绑定宿主管道；Chrome 的 stderr 不再进入启动诊断。CDP 仍使用 WebSocket，调试端口须在浏览器存活期间保持可用。

`release()` 幂等，返回浏览器的 WebSocket endpoint。它不发送 `Browser.close`、不终止进程、不关闭标签页或删除 profile，而是解除信号清理、取消子进程对 Node 事件循环的引用并断开 CDP。之后 `browser.owned === false`，`browser.closed === true`（指本连接），`close()`、`Symbol.asyncDispose` 和原 `browser.process.close()` 都不会终止 Chrome。旧 Tab/Session 不可继续使用，重连后获取新对象。已开始的 `close()` 会使后续 `release()` 拒绝；已开始的 `release()` 则使并发 `close()` 等待交接后仅断开。

自有浏览器只有显式以 `detached: true` 启动才能交接。`Browser.connect()` 得到的实例也可调用 `release()`，仅断开并返回 endpoint。普通 `disconnect()` 保留自有进程的所有权，之后 `close()` 仍清理它；满足独立启动条件时，可在断开后再 `release()`。

Pipe 模式不能交接：Chrome 的 CDP 管道断开会导致其退出。`release()` 在断开前拒绝 pipe 实例，`detached: true` 与 `transport: 'pipe'` 的组合在启动前拒绝。依赖本进程 `ProxyForwarder` 的 context 也会使交接拒绝；先关闭该 context，或使用可独立存活的外部 `proxyServer`。

## Profile 与进程责任

- `.nodriver.lock` 表示 nodriver 控制器对持久 profile 的所有权，内容是宿主 PID 与主机名。交接时关闭锁句柄并删除此文件，不把它伪装成 Chrome 的锁。
- `DevToolsActivePort` 保留。新的 `launch({ userDataDir })` 会探测它；同一浏览器仍提供服务时拒绝启动并提示使用 `connect()`。Chrome 自身的 profile 锁仍由 Chrome 管理。
- 临时 profile 也会保留，路径可在交接前通过 `browser.process!.profile` 保存。交接将清理责任移交给调用方；只有确认 Chrome 完全退出后才可删除临时 profile。持久 profile 不自动删除。
- `Browser.connect().close()` 不终止 Chrome。需要最终退出时，由用户关闭浏览器，或由调用方显式发送 `browser.cdp.send('Browser.close')`；断开时可能收到连接关闭错误。
- endpoint 只在这一次 Chrome 生命周期内有效。浏览器退出后需重新启动并保存新 endpoint。

本实现不提供 Job Object、看门狗或原生辅助进程。普通启动失败或取消仍尝试终止 Chrome 并清理资源，但宿主从 spawn 到交接之间被强制终止或崩溃，可能留下独立 Chrome，包括尚未就绪的实例。需要“就绪前随宿主退出，就绪后独立存活”的严格保证时，须由上层提供平台进程监管。

分离启动也不保证抵抗外部进程树终止。例如 Windows 上，上层仍可能通过 `taskkill /T /F` 连带终止已交接 Chrome。因此交接不能修复 MCP 宿主的进程树强杀策略。

## 录屏与 target 事件

`tab.cdp` 和 `browser.cdp` 是有类型的 `Session`，支持 `send`、`sendWith`、`on`、`onAny` 和 `waitFor`。`on` 返回取消订阅函数。事件等待须在触发命令前注册。

```ts
const stopFrames = tab.cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
  try {
    // data 是 base64 编码的图像帧；在此交给应用自己的录制队列。
    console.log('frame bytes (base64):', data.length);
  } finally {
    await tab.cdp.send('Page.screencastFrameAck', { sessionId });
  }
});
await tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80 });
// 录制期间保持订阅；每帧均须 ack。
await tab.cdp.send('Page.stopScreencast');
stopFrames();
```

浏览器初始化已启用 target discovery，可直接订阅：

```ts
const offCreated = browser.cdp.on('Target.targetCreated', ({ targetInfo }) => {
  console.log('created', targetInfo);
});
const offChanged = browser.cdp.on('Target.targetInfoChanged', ({ targetInfo }) => {
  console.log('changed', targetInfo);
});
const offDestroyed = browser.cdp.on('Target.targetDestroyed', ({ targetId }) => {
  console.log('destroyed', targetId);
});
// 用完后调用 offCreated()、offChanged()、offDestroyed()。
```

`browser.tabCreated.on(...)` 在 Tab 附加与初始化完成后通知；原始 `Target.targetCreated` 更早，可能尚无可用的 Tab。`pageTargets` 包括 attach 策略未自动附加的页面，可用 `attachTarget(id)` 主动附加。

## 焦点边界

当前库没有“用户切换活动标签页”的高层事件，target 信息变化也不等价于焦点变化。`browser.frontTab` 只缓存本客户端最近置前的 Tab，不是操作系统或 Chrome UI 的权威焦点状态。

`tab.bringToFront()` 主动置前；`tab.activate()` 根据上述缓存决定是否置前。需要检查用户切换后的当前状态，可用 `tab.evaluate('document.hasFocus()')` 并按需读取 `document.visibilityState`。需要保留连续的焦点事件时，应由应用在文档中监听 `focus`、`blur`、`visibilitychange` 并记录队列，再读取队列；每次导航需重新安装监听。此方案有采样、导航及页面事件语义的限制，不能直接替换 OS 级 focus watcher。

上述 target 与 screencast 订阅不要求 `Runtime.enable`。主世界仍通过 Document 与 `DOM.resolveNode` 获取；没有默认启用的 Runtime 事件可供等待。
