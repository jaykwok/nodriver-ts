# Raw target session

[English](../raw-sessions.md)

0.3.0 起，`Browser.launch()` 和 `Browser.connect()` 支持 `attach: 'none'`，供应用自行管理页面初始化、target 和 CDP 命令。

```ts
import { Browser } from 'nodriver-ts';

const browser = await Browser.launch({ attach: 'none', headless: true, detached: true });
try {
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
  const session = await browser.attachSession(targetId, { timeout: 5000 });
  console.log((await session.send('Runtime.evaluate', { expression: '6 * 7' })).result.value);
  await session.detach();
  const endpoint = await browser.release();
  // 保存 endpoint，之后 Browser.connect({ endpoint, attach: 'none' })。
} finally {
  await browser.close(); // release 后只断开连接。
}
```

## 策略与就绪

| attach 策略   | 自动接管页面                 | 显式 newTab / attachTarget |
| ------------- | ---------------------------- | -------------------------- |
| `all`（默认） | 现有页面、后续页面及 popup   | 允许                       |
| `created`     | 本客户端创建的页面及其 popup | 允许                       |
| `none`        | 不接管；`tabs` 始终为空      | 发送 CDP 前拒绝            |

所有策略下都可调用 `attachSession()`，每次获得独立 attachment，不按 target 去重。
none 下初始页面、后续页面、popup 和 `Target.attachedToTarget` 都不创建 Tab/Frame。

none 的 ready 条件是连接建立及 `Browser.getVersion`、`Target.getBrowserContexts`、
`Target.setDiscoverTargets({ discover: true })`、`Target.getTargets` 完成，不等待启动页；
可以在零页面时就绪。用 `pageTargets` 和根 session 的 `Target.*` 事件追踪页面。

none 跳过可选 headless UA 探针和覆盖；显式 `maskHeadless: true` 会报错。Chrome 启动参数仍然生效。
每次 raw attach 只发送 `Target.attachToTarget({ targetId, flatten: true })`，
不发送 `Page.enable`、`Page.setLifecycleEventsEnabled`、`Target.setAutoAttach` 或任何 `Runtime.*`。
域初始化、录屏帧 ack 和停止录屏由调用方负责。

launch/connect 使用一个总初始化 deadline（默认 30 秒），覆盖端点发现、版本、contexts、
target discovery/listing 及自动 attach。signal 贯穿上述阶段。
launch 失败会断开连接并清理自有进程，connect 失败只断开连接。
进程清理使用独立且有界的终止等待，可能超过初始化 deadline；宿主硬崩溃仍无法执行清理。

## 生命周期

`TargetSession extends Session`，新增 `targetId`、`endReason`、`ended: Promise<EndReason>` 和
`detach({ signal?, timeout? })`；继承 `send`、`sendWith`、`on`、`onAny`、`waitFor`、`id`、`closed`。

首个终止原因生效，`ended` 只 resolve 一次：

| 原因               | 触发条件                                             |
| ------------------ | ---------------------------------------------------- |
| `detach-requested` | 本地调用 detach                                      |
| `detached`         | 收到 Target.detachedFromTarget                       |
| `target-destroyed` | 先收到 Target.targetDestroyed                        |
| `target-crashed`   | 收到 Inspector.targetCrashed 或 Target.targetCrashed |
| `disconnected`     | 连接断开，包括 release/disconnect                    |

结束时 pending 请求和 waitFor 立即以 `SessionEndedError` 拒绝，监听器被清理。
该错误继承 `DisconnectedError`，携带 `reason` 和 `targetId`。之后的 send/waitFor 拒绝，
新增事件订阅抛错。其他 attachment 保持可用，除非共享已崩溃/销毁的 target 或整个连接结束。
关闭 target 时 Chrome 可能先发 detached，所以最终原因取决于事件顺序。

crash 是库的逻辑生命周期终点。Windows Chrome 155 实测原 CDP attachment 在 crash 后仍可
reload/evaluate，但 raw API 会关闭旧 session 并清理 attachment，恢复必须重新 attach。
先观察根 `Target.targetCrashed`，再重新 attach 和发送 `Page.reload`：
session 级 crash 通知可能更早到达。高层 Tab 的 crash/reload 行为不变。
新 attachment 也可能遇到再次 crash，重新 attach 不保证恢复成功。

`detach()` 同步结束本地生命周期，再等待 `Target.detachFromTarget` 回应，重复调用共享同一个 Promise。
调用前 signal 已中止则 session 保持打开；发送后取消不会重新打开 session，并会启动独立清理。

## 取消与迟到响应

attach 超时或 signal 中止立即 reject，普通取消不影响其他 attachment。
迟到的成功响应到达后，用独立的 5 秒 deadline 发送 `Target.detachFromTarget`。

如果取消后 5 秒内没有 attach 响应，或者 detach 清理在其独立的 5 秒内仍无法确认成功，
库会断开整个 CDP 连接；显式 detach 失败后的清理也适用。协议确认 session 已不存在视为清理成功。
这项异常兜底会结束该连接的所有 session，通过 `onError` 报告清理失败，并避免 attachment
在不可追踪的连接上残留。应用应按 `connection_lost` 处理，不能把它视为普通取消。
断开 WebSocket 不终止外部 Chrome；Pipe Chrome 会随管道关闭退出。

## 发送时观察

launch/connect 都接受 `observe: { onSend, onSettle }`。

- `onSend({ seq, method, sessionId?, at })` 在调用 transport.send 前同步执行。
  seq 是连接内单调递增的请求 ID，允许空隙；at 是 `performance.now()` 的毫秒值。
  记录的是发送尝试，不代表 Chrome 已收到或执行。回调重入的发送排队以保持顺序。
  回调异常被隔离，应保持简短；回调中取消不能撤回已观察的发送尝试。
- `onSettle({ seq, durationMs, error? })` 按完成顺序触发，以 seq 关联发送；
  durationMs 从发送尝试开始计算，error 为协议错误码或错误名。
- 两者都不接收参数或结果。生产 trace 的回调形状和 stderr 行为保持不变，仍按完成顺序触发。

## 测试

`ScriptedChrome.connect({ attach: 'none' })` 构造真实 Browser/TargetSession。
fixture 支持独立 attachment、`detachSession(id)`、`crashTarget(id)`、`destroyTarget(id)`；
`attachReplyDelayMs` 在 attachment 已建立并发出事件后延迟响应，用于取消后迟到响应测试。
`commands` 记录 detachFromTarget 等命令及参数。

单元测试覆盖生命周期、取消、清理失败、总 deadline 和发送顺序。
真实 Chrome 覆盖 raw evaluate、crash/recovery、关闭 target、release/reconnect 和后台进程最后窗口关闭。
最后一项用 `--no-startup-window --keep-alive-for-test` 控制后台存活，Windows 使用真实窗口，
无显示环境的 Linux 使用 headless；它不验证特定扩展的后台策略。
Node 22.19 跑构建产物验收，Node 24 跑源码测试。
