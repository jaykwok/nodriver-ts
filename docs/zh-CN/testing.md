# 库测试用的脚本化 Chrome

[English](../testing.md)

从 **`nodriver-ts/testing`** 导入 `ScriptedChrome`，即可用真实的 `Browser`、`Tab`、`Frame` 和 `Session` 实例测试代码，不必启动 Chrome，也不必把手写 mock 强转成带私有字段的类。

该 fixture 监听一个临时的 loopback WebSocket 端口，应答库的浏览器与页面启动握手，创建 target 和 context，并连同参数记录收到的命令。它没有渲染器、DOM 或 JavaScript 引擎：应用层命令必须事先编写回复。缺少预期回复时明确失败，不会静默返回 `{}`。

```ts
import assert from 'node:assert/strict';
import { ScriptedChrome } from 'nodriver-ts/testing';

await using chrome = await ScriptedChrome.start();
await using browser = await chrome.connect();
const tab = browser.tabs[0]!;

chrome.replyOnce('Runtime.callFunctionOn', {
  result: { type: 'object', value: { completed: 3 } },
});
const result = await tab.cdp.send('Runtime.callFunctionOn', {
  functionDeclaration: 'function () { return { completed: 3 }; }',
  objectId: 'fixture-document',
  returnByValue: true,
});
assert.deepEqual(result.result.value, { completed: 3 });
assert.equal(chrome.commands.at(-1)!.sessionId, tab.cdp.id);
chrome.assertDone();
```

不支持 `await using` 语法的运行时请使用 `try/finally` 与 `close()`。先释放 Browser，再释放 fixture。`chrome.close()` 也会终止仍连着的客户端，并且是幂等的。

raw 客户端使用 `chrome.connect({ attach: 'none' })` 和 `browser.attachSession(targetId)`。`chrome.detachSession(sessionId)` 结束一个模拟 attachment；`attachReplyDelayMs` 在 attachment 建立后延迟回应。详见 [raw-session 测试与生命周期](raw-sessions.md)。

## 回复与命令记录

- `replyOnce(method, resultOrHandler)` 为某个方法排队一个结果或处理函数。排队的回复按到达顺序跨所有 session 消费，优先于持久处理函数和内置默认值。
- `handle(method, handler)` 安装持久处理函数并返回取消函数。两种处理函数都接收带类型的 `(params, command)` 参数；用 `command.sessionId` 区分页面。异步处理函数可以乱序完成，与真实 CDP 命令一样。
- `commands` 包含全部线上请求（含启动阶段），字段为 `id`、`method`、`params` 和可选的 `sessionId`。处理函数修改参数不会改变已记录的请求。这些记录可能含敏感值，fixture 数据应使用合成数据。
- 内置握手/生命周期集合以外、未被处理的命令会收到错误码为 `-32601` 的 `ProtocolError`，并记录在 `unexpectedCommands` 中。
- 有未使用的排队回复或收到过意外命令时，`assertDone()` 抛错。持久处理函数不要求被用到。如果拆卸过程本身也需要编写回复，请在拆卸前调用它。

```ts
import { ProtocolError } from 'nodriver-ts';
import { NO_REPLY } from 'nodriver-ts/testing';

const off = chrome.handle('Runtime.evaluate', (params, command) => {
  if (params.expression === 'stall') return NO_REPLY;
  if (params.expression === 'fail')
    throw new ProtocolError('Runtime.evaluate', -32000, 'fixture failure');
  return { result: { type: 'string', value: command.sessionId } };
});
// 运行应用代码，然后移除持久处理函数。
off();
```

返回 `NO_REPLY` 会让 Connection 上的真实请求保持挂起，用于超时、中止或断连测试。抛出 `ProtocolError` 时，其错误码和 data 原样写到线上；其他错误使用错误码 `-32000`。处理函数没有自动取消：原 socket 关闭后迟到的返回结果被丢弃，也不会发给重新连接的客户端。

`tab.evaluate()` 仍会执行库的执行上下文发现 CDP 命令。测试这条路径时同样需要为它们编写回复；fixture 不会凭空构造 DOM，也不会对表达式求值。例如隔离世界求值：

```ts
chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 8 }));
chrome.replyOnce('Runtime.evaluate', { result: { type: 'number', value: 42 } });
assert.equal(await tab.evaluate('answer', undefined, { world: 'isolated' }), 42);
```

## Target、事件与故障

`start()` 默认有一个 `about:blank` 页面。传 `{ pages: [] }` 表示没有页面，或用 `{ pages: [{ url: 'https://fixture.test/', title: 'Fixture' }] }` 设置初始元数据。`browser.newTab()`（不导航）和 `browser.newContext()` 使用内置回复即可工作。导航、截图、输入及其他应用操作需要编写回复。

```ts
const ready = browser.waitForTab();
const targetId = chrome.addPage({ url: 'https://fixture.test/' });
const page = await ready;

const load = page.cdp.waitFor('Page.loadEventFired');
chrome.emit('Page.loadEventFired', { timestamp: 1 }, page.cdp.id);
await load;

const crash = page.cdp.waitFor('Inspector.targetCrashed');
chrome.crashTarget(targetId);
await crash;
assert.equal(page.crashed, true);

const destroyed = browser.cdp.waitFor('Target.targetDestroyed');
chrome.destroyTarget(targetId);
await destroyed;
```

`emit(method, params, sessionId?)` 发送带类型的原始 CDP 事件；省略 `sessionId` 即为浏览器级事件。原始事件**不会**更新 fixture 的 target/frame 模型，相应的建模行为请使用 `addPage`、`destroyTarget` 和 `crashTarget`。崩溃使真实 Tab 的 frame 句柄失效，但不销毁 target。fixture 不模拟渲染，不自动创建 Worker/OOPIF，也没有导航引擎。

`chrome.disconnect()` 突然终止客户端 socket，拒绝真实的挂起请求和事件等待。fixture 保留页面和 context，之后仍可再次 `connect()`。同一时间只允许一个控制端连接；重连前请等待 `browser.close()` 完成。需要直接控制连接参数时，使用 `Browser.connect({ endpoint: chrome.endpoint, ...options })`。

## 追踪真实启动的浏览器

`Browser.launch()` 与 `Browser.connect()` 都接受 `trace: boolean | ((entry) => void)`。回调收到 `{ method, sessionId?, durationMs, error? }`，包括启动命令、协议错误、超时和取消；参数和结果有意不记录。即使设置了 `NODRIVER_TRACE`，`trace: false` 也会关闭追踪；`trace: true` 以现有的紧凑格式写到 stderr。回调优先于该环境变量。

```ts
const entries: import('nodriver-ts').TraceEntry[] = [];
await using browser = await Browser.launch({ trace: (entry) => entries.push(entry) });
```
