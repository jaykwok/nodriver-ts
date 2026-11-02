# 监管启动与显式 release

[English](../lifecycle-ownership-design.md)

`Browser.launch({ detached: true, supervised: true })` 在 Windows、macOS、Linux
启用独立 helper 监管与有界 stderr，仅支持 WebSocket。
未启用 `supervised` 时，宿主在交接前退出可能留下 detached Chrome。

```ts
const browser = await Browser.launch({ headless: true, detached: true, supervised: true });
try {
  await browser.drain({ timeout: 11000 });
  const endpoint = await browser.release();
  // 保存 endpoint，供宿主退出后的其他进程 connect。
} finally {
  await browser.close();
}
```

## 监管与平台边界

初始化成功不会自动交接。release 提交前，宿主控制通道关闭（含宿主被强杀）触发 helper 终止浏览器。
正常取消、失败和 close 等待进程清理后再处理 profile。Chrome 不继承宿主控制通道句柄。

| 平台          | 监管机制                                                                                      | release 前 helper 自身被强杀           |
| ------------- | --------------------------------------------------------------------------------------------- | -------------------------------------- |
| Windows 10+   | 创建 Chrome 时通过 PROC_THREAD_ATTRIBUTE_JOB_LIST 加入 kill-on-close Job Object，后代继承 job | OS 关闭最后一个 job 句柄，终止受管进程 |
| macOS / Linux | 独立 Node helper 创建新 session/进程组；宿主 EOF 后对组发送 SIGKILL                           | 不保证，SIGKILL 无法执行用户态清理     |

POSIX 只覆盖留在受管进程组内的进程，不覆盖主动脱离的后代。
三平台都不能抵抗外层整树终止、Windows 父 job、容器/cgroup 或登录会话清理策略。

Windows 用系统 PowerShell 将随库附带的 C# 源码编译到独占临时目录，再运行独立可执行 helper。
编译可取消，受初始化期限约束。环境须允许 Add-Type 和 .NET Framework 执行；
编译或监管失败时启动报错。运行中的 helper 不依赖 PowerShell 持续托管。
机制见 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、
[进程创建属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)、
[Node detached spawning](https://nodejs.org/api/child_process.html#optionsdetached)。

`browser.process.pid` 是 Chrome PID；监管模式的 `browser.process.child` 是 helper 的 ChildProcess，
其 PID/stdio 属于 helper。优先使用 Browser 生命周期接口、pid、diagnostics、waitForExit()。

## 交接与结果不确定

Windows 以关闭 job 的 kill-on-close 标志为提交点，POSIX 以 helper 内的所有权状态切换为提交点，
提交后才回复确认。宿主先移除 profile 控制锁再请求提交，确认后关闭控制流。
重复 release 共用一个 Promise，并发 close 等待交接。

helper 拒绝请求或请求未送达时，release 以该错误拒绝，所有权不变：`owned` 仍为 true，`close()` 仍会结束浏览器。
两种情况下 CDP 连接都会关闭。

确认丢失时抛 `ReleaseUncertainError`。helper 可能已提交，因此原宿主不会再终止浏览器或重试操作。
控制通道关闭使未提交的浏览器退出；已提交的浏览器继续存活。
即使结果不确定，本地也已放弃终止权（owned 为 false）。
用保存的 `browser.endpoint` 检查/重连；endpoint 不可达时，需另行确认 OS 进程是否已退出。

## 有界日志与资源归属

helper 在内存最多保留 stderr 尾部 16,384 **字节**，发送有界快照，不创建持续增长的日志文件。
监管 detached 的启动诊断返回 `stderrStatus: 'captured'`，包括握手失败时的日志。

release 清空日志后，helper 继续排走并丢弃 stderr，直到浏览器生命周期结束。
交接后仍有独立 helper，但不再依赖原宿主 stderr 管道或控制连接。

正常 owned close 清理临时 profile 和 Windows helper 可执行文件；release 保留 profile，
在 Windows 上还保留运行中 helper 位于系统临时目录的 `nodriver-guardian-*` 目录。
之后在 Windows 上的监管启动会删除 helper 已退出且超过一小时的此类目录，包括宿主硬退出留下的目录。
宿主硬退出还可能留下临时 profile 和陈旧控制锁。
持久 profile 陈旧锁在确认所有者已退出后回收。确认进程退出后再删除遗留目录。
