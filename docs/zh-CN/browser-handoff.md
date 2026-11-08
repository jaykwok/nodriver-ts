# 浏览器交接与 CDP 事件

[English](../browser-handoff.md)

包和示例都需要 Node.js 24.22.0+。请使用 `await using`，或 `try/finally` 配合 `close()`，先关闭子资源，再关闭所属的 Browser。

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

`detached` 默认为 `false`：宿主退出时 Chrome 随之结束，无论是正常退出、调用 `process.exit()` 还是未捕获异常。SIGINT 和 SIGTERM 终止宿主时不经过这条退出路径，因此只有设置 `handleSignals: true` 才会关闭 Chrome。宿主被直接杀死时，pipe Chrome 会在管道断开时退出，Windows 也会随宿主结束 Chrome，但 macOS 或 Linux 上的 WebSocket Chrome 会继续运行。

设置 `detached: true` 且未启用 `supervised` 时，所有平台都以分离方式启动 Chrome，其 stdin/stdout/stderr 不绑定宿主管道，因此 stderr 不会进入启动诊断。监管模式则通过独立辅助进程采集有界的 stderr。CDP 使用 WebSocket，调试端口须在浏览器存活期间保持可用。

`release()` 幂等，返回浏览器的 WebSocket 端点。它不发送 `Browser.close`、不终止进程、不关闭标签页，也不删除 profile；它会解除信号清理，取消子进程对 Node 事件循环的引用，并断开 CDP。之后 `browser.owned === false`、`browser.closed === true`（指本连接），`close()`、`Symbol.asyncDispose` 和原来的 `browser.process.close()` 都不会再终止 Chrome。旧的 Tab/Session 对象不能继续使用，重连后获取新对象。

一旦调用过 `close()`，即使它失败了，`release()` 也会拒绝。Chrome 已退出时同样拒绝，因为已没有可交接的进程；`close()` 仍会确认其退出。在 `release()` 进行期间调用的 `close()` 会等待交接完成，然后只断开连接。

自有浏览器只有显式以 `detached: true` 启动才能交接。`Browser.connect()` 得到的浏览器也可以调用 `release()`，它只断开连接并返回端点。普通的 `disconnect()` 保留对自有进程的所有权，之后的 `close()` 仍会清理它；分离启动的浏览器在断开后仍可调用 `release()`。

Pipe 模式无法交接，因为 Chrome 会在 CDP 管道关闭时退出：`release()` 会在断开前拒绝 pipe 实例，`detached: true` 与 `transport: 'pipe'` 的组合会在启动前被拒绝。用 `newContext({ proxy })` 创建的上下文依赖本进程的 `ProxyForwarder`，并随创建它的连接一起结束，因此也会使交接被拒绝。请先关闭该上下文，或改用能在本进程退出后继续存在的外部 `proxyServer`。带 `virtualDisplay` 的启动同样无法交接，因为 Chrome 退出后没有谁会结束它的 Xvfb 服务器；见[虚拟显示](api.md#虚拟显示)。

## Profile 与进程责任

- `.nodriver.lock` 记录 nodriver 控制器对持久 profile 的所有权，内容是宿主 PID 和主机名。交接时会关闭锁句柄并删除该文件，而不是把它当作 Chrome 的锁交出去。
- `DevToolsActivePort` 会保留。新的 `launch({ userDataDir })` 会探测它；如果同一个浏览器仍在提供服务，启动会被拒绝，并提示改用 `connect()`。Chrome 自己的 profile 锁仍由 Chrome 管理。
- 临时 profile 同样保留；请在交接前通过 `browser.process!.profile` 保存其路径。清理它从此由调用方负责，并且只能在确认 Chrome 完全退出之后进行。持久 profile 从不自动删除。
- `Browser.connect().close()` 不会终止 Chrome。需要结束 Chrome 时，由用户关闭浏览器，或由调用方显式发送 `browser.cdp.send('Browser.close')`；断开时可能收到连接已关闭的错误。
- 端点只在这一次 Chrome 生命周期内有效。浏览器退出后，需要重新启动并保存新的端点。

普通 detached 模式不提供进程监管：宿主在 release 之前死亡，可能留下 Chrome。加上 `supervised: true` 即可使用 Windows Job Object 或 macOS/Linux 进程组辅助进程，并采集有界的启动 stderr。仅仅初始化完成不会交出所有权，只有显式 release 才会。平台限制与 release 的错误处理见[监管所有权](lifecycle-ownership-design.md)。

分离启动同样无法抵御外部的进程树终止。例如在 Windows 上，上层仍可能用 `taskkill /T /F` 连带杀死已交接的 Chrome，因此交接无法绕开会强杀进程树的 MCP 宿主。

## 录屏与 target 事件

`tab.cdp` 和 `browser.cdp` 是有类型的 `Session`，支持 `send`、`sendWith`、`on`、`onAny` 和 `waitFor`。`on` 返回取消订阅函数。事件等待须在发送触发它的命令之前注册。

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

浏览器初始化时已启用 target discovery，可以直接订阅：

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

`browser.tabCreated.on(...)` 在 Tab 完成附加和初始化后触发；原始的 `Target.targetCreated` 更早触发，此时可能还没有可用的 Tab。`pageTargets` 包括附加策略没有自动附加的页面，可用 `attachTarget(id)` 附加它们。

## 焦点边界

库没有“用户切换了活动标签页”这样的高层事件，target 信息变化也不等于焦点变化。`browser.frontTab` 只缓存本客户端最近置前的 Tab，并非来自操作系统或 Chrome 界面的权威焦点状态。

`tab.bringToFront()` 会把标签页置前；`tab.activate()` 只在该缓存指向其他标签页时才置前。要检查用户切换后的当前状态，可调用 `tab.evaluate('document.hasFocus()')`，并按需读取 `document.visibilityState`。如需连续记录，应由应用在文档中监听 `focus`、`blur` 和 `visibilitychange`，写入队列后再读取，并在每次导航后重新安装监听器。这种做法受采样、导航和页面事件语义的限制，不能替代操作系统级的焦点监视。

上述 target 与 screencast 订阅都不需要 `Runtime.enable`。主世界通过 Document 和 `DOM.resolveNode` 获取，默认也没有启用任何可供等待的 Runtime 事件。
