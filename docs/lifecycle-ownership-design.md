# Supervised launch and explicit release

[简体中文](zh-CN/lifecycle-ownership-design.md)

`Browser.launch({ detached: true, supervised: true })` opts into independent process supervision and bounded stderr on Windows, macOS and Linux, and requires WebSocket. Without `supervised`, a host that exits before release can leave detached Chrome running.

```ts
const browser = await Browser.launch({ headless: true, detached: true, supervised: true });
try {
  await browser.drain({ timeout: 11000 });
  const endpoint = await browser.release();
  // Persist endpoint for another process to connect after this host exits.
} finally {
  await browser.close();
}
```

## Ownership and platform boundaries

Readiness does not transfer ownership. Until release commits, EOF on the host control channel, including a hard host exit, makes the helper terminate Chrome. A normal close, cancellation or failure waits for that cleanup before handling the profile. Chrome never inherits the host control handles.

| Platform      | Supervision                                                                                                          | Helper hard death before release                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Windows 10+   | Create Chrome inside a kill-on-close Job Object using PROC_THREAD_ATTRIBUTE_JOB_LIST; descendants inherit membership | Closing the last job handle terminates the job    |
| macOS / Linux | Independent Node helper creates a new session/process group; host EOF triggers group SIGKILL                         | Not guaranteed; SIGKILL cannot run helper cleanup |

POSIX supervision covers processes that remain in the owned group, not descendants that deliberately escape it. No mode protects against external whole-tree termination, Windows parent jobs, containers/cgroups or login-session cleanup.

On Windows, system PowerShell compiles the bundled C# source to a private temporary executable before Chrome is created. Compilation is cancellable and bounded by the initialization budget, at most 15 s. The environment must permit Add-Type and .NET Framework execution; a compilation or supervision failure rejects the launch. The running helper does not depend on PowerShell. See [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [process attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) and [Node detached spawning](https://nodejs.org/api/child_process.html#optionsdetached).

`browser.process.pid` is Chrome's PID. In supervised mode, `browser.process.child` is the helper's ChildProcess, so its PID and stdio belong to the helper. Prefer the Browser lifecycle methods, `pid`, `diagnostics` and `waitForExit()`.

## Release and uncertain outcomes

Windows commits a release by turning off kill-on-close; POSIX commits by switching the helper's ownership state. Only then does the helper acknowledge. After the acknowledgement, the host closes its control streams and removes its profile lock. Repeated `release()` calls share one promise, and a concurrent `close()` waits for the release.

If the helper refuses the request or the request never reaches it, `release()` rejects with that error and ownership stays: `owned` remains true and `close()` still ends the browser. The CDP connection closes either way. A helper that reports Chrome's exit instead of an acknowledgement counts as refusing, since it reports an exit only while it still owns Chrome.

If the acknowledgement is lost or does not arrive within 5 s, `release()` rejects with `ReleaseUncertainError`. The helper may have committed, so the original host never sends a kill or retries; it closes the control channel instead, which kills an uncommitted browser and leaves a committed one running. Local ownership is relinquished even then (`owned` is false) and the profile lock is removed. Inspect or reconnect through the saved `browser.endpoint`; if the endpoint is unreachable, confirm separately whether the OS process has exited.

## Bounded logging and resources

The helper keeps at most the last 16,384 **bytes** of stderr in memory and sends bounded snapshots; no logfile grows with browser output. Supervised detached startup diagnostics report `stderrStatus: 'captured'`, including for handshake failures.

At release the helper clears the retained log, then drains and discards stderr for the rest of the browser's lifetime. The independent helper keeps running, but it needs no original-host stderr pipe or control connection.

A normal owned close removes temporary profiles and the Windows helper executable. A release keeps profiles and, on Windows, the running helper's `nodriver-guardian-*` directory in the system temp directory. A later supervised launch on Windows removes such directories once their helper has exited and they are more than an hour old, including those a hard host exit leaves. A hard host exit can also leave temporary profiles and stale controller locks; a persistent profile's lock is reclaimed once its recorded owner on the same host has exited. Confirm that Chrome has exited before removing leftovers.
