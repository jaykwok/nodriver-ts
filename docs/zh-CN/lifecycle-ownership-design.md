# 监管启动与显式 release

[English](../lifecycle-ownership-design.md)

`Browser.launch({ detached: true, supervised: true })` 在 Windows、macOS 和 Linux 上启用独立的进程监管与有界 stderr，仅支持 WebSocket。未启用 `supervised` 时，宿主在 release 之前退出，可能留下仍在运行的 detached Chrome。

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

初始化完成不会转移所有权。在 release 提交之前，宿主控制通道出现 EOF（包括宿主硬退出）时，辅助进程会终止 Chrome。正常关闭、取消或失败时，都会等这一清理完成后再处理 profile。Chrome 从不继承宿主的控制通道句柄。

| 平台          | 监管机制                                                                                      | release 前辅助进程自身被强杀           |
| ------------- | --------------------------------------------------------------------------------------------- | -------------------------------------- |
| Windows 10+   | 创建 Chrome 时通过 PROC_THREAD_ATTRIBUTE_JOB_LIST 加入 kill-on-close Job Object，后代继承 job | 最后一个 job 句柄关闭时终止整个 job    |
| macOS / Linux | 独立 Node 辅助进程创建新的 session/进程组；宿主 EOF 后对整个组发送 SIGKILL                    | 不保证；SIGKILL 无法执行辅助进程的清理 |

POSIX 监管只覆盖仍留在受管进程组中的进程，不覆盖主动脱离该组的后代。任何模式都无法抵御外部的整树终止、Windows 父 job、容器/cgroup 或登录会话清理。

在 Windows 上，系统 PowerShell 会在创建 Chrome 之前，把随包附带的 C# 源码编译成独占临时目录中的可执行文件。编译可以取消，受初始化预算约束，最长 15 秒。环境须允许 Add-Type 和 .NET Framework 执行；编译或监管失败时启动会被拒绝。运行中的辅助进程不依赖 PowerShell。参见 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[进程创建属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) 和 [Node detached spawning](https://nodejs.org/api/child_process.html#optionsdetached)。

`browser.process.pid` 是 Chrome 的 PID。监管模式下，`browser.process.child` 是辅助进程的 ChildProcess，其 PID 和 stdio 都属于辅助进程。请优先使用 Browser 的生命周期方法、`pid`、`diagnostics` 和 `waitForExit()`。

## 交接与结果不确定

Windows 以关闭 kill-on-close 作为 release 的提交点，POSIX 以切换辅助进程内的所有权状态作为提交点，提交之后辅助进程才回复确认。收到确认后，宿主关闭控制流并移除 profile 锁。重复调用 `release()` 共用同一个 Promise，并发的 `close()` 会等待 release 完成。

如果辅助进程拒绝请求，或请求没有送达，`release()` 以该错误拒绝，所有权保持不变：`owned` 仍为 true，`close()` 仍会结束浏览器。两种情况下 CDP 连接都会关闭。辅助进程没有回复确认、而是报告 Chrome 已退出时，同样视为拒绝，因为辅助进程只在仍持有 Chrome 时才报告退出。

如果确认丢失，或 5 秒内没有收到确认，`release()` 以 `ReleaseUncertainError` 拒绝。辅助进程可能已经提交，因此原宿主不会发送终止命令，也不会重试，而是关闭控制通道：未提交的浏览器会因此退出，已提交的浏览器继续运行。即便如此，本地也已放弃所有权（`owned` 为 false），并移除 profile 锁。请通过保存的 `browser.endpoint` 检查或重连；端点不可达时，需另行确认操作系统进程是否已退出。

## 有界日志与资源归属

辅助进程在内存中最多保留 stderr 末尾的 16,384 **字节**，并发送有界快照，不会生成随浏览器输出增长的日志文件。监管 detached 模式的启动诊断返回 `stderrStatus: 'captured'`，握手失败时也是如此。

release 时，辅助进程清空已保留的日志，之后在浏览器剩余的生命周期内持续读取并丢弃 stderr。独立的辅助进程会继续运行，但不再需要原宿主的 stderr 管道或控制连接。

正常的 owned close 会删除临时 profile 和 Windows 辅助程序可执行文件。release 会保留 profile，在 Windows 上还会保留系统临时目录中运行中辅助进程的 `nodriver-guardian-*` 目录。之后在 Windows 上的监管启动会删除辅助进程已退出且超过一小时的此类目录，包括宿主硬退出留下的目录。宿主硬退出还可能留下临时 profile 和陈旧的控制器锁；持久 profile 的锁会在同一主机上记录的所有者退出后被回收。删除遗留文件之前，请先确认 Chrome 已退出。
