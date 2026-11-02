# Supervised launch and explicit release

[简体中文](zh-CN/lifecycle-ownership-design.md)

`Browser.launch({ detached: true, supervised: true })` opts into independent process supervision
and bounded stderr on Windows, macOS and Linux. Requires WebSocket. Without `supervised`,
host exit before release can leave detached Chrome running.

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

Readiness does not transfer ownership. Before release commits, host control-channel EOF,
including hard host exit, triggers helper-owned termination. Normal close/cancel/failure waits
for cleanup before handling the profile. Chrome never inherits the host control handles.

| Platform      | Supervision                                                                                                          | Helper hard death before release                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Windows 10+   | Create Chrome inside a kill-on-close Job Object using PROC_THREAD_ATTRIBUTE_JOB_LIST; descendants inherit membership | Closing the last job handle terminates the job    |
| macOS / Linux | Independent Node helper creates a new session/process group; host EOF triggers group SIGKILL                         | Not guaranteed; SIGKILL cannot run helper cleanup |

POSIX supervision covers members remaining in the owned group, not deliberately escaped
descendants. No mode protects against external whole-tree termination, Windows parent jobs,
containers/cgroups or login-session cleanup.

Windows system PowerShell compiles the bundled C# source to a private temporary executable
before Chrome is created. Compilation is cancellable within the initialization budget.
The environment must permit Add-Type and .NET Framework execution. Compilation or supervision
failure rejects launch. The running helper is
independent of PowerShell. See [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[process attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
and [Node detached spawning](https://nodejs.org/api/child_process.html#optionsdetached).

`browser.process.pid` is Chrome's PID. In supervised mode `browser.process.child` is
the helper's ChildProcess: its PID and stdio belong to the helper. Prefer the Browser lifecycle
methods, `pid`, `diagnostics` and `waitForExit()`.

## Release and uncertain outcomes

Windows commits release by disabling kill-on-close; POSIX commits by changing the helper's
ownership state. Only then does the helper acknowledge. The host removes its profile lock
before requesting commit and releases its control streams after acknowledgement.
Repeated release shares a promise; concurrent close waits for release.

If the helper refuses the request or the request never reaches it, release rejects with that
error and ownership stays: `owned` remains true and `close()` still ends the browser. The CDP
connection closes in either case.

If acknowledgement is lost, release rejects with `ReleaseUncertainError`. The helper may have
committed: the original host never sends a kill or retries the operation. Closing the control
channel kills an uncommitted browser; a committed browser survives. Local ownership is
relinquished even on uncertainty (`owned` is false). Inspect/reconnect using the saved
`browser.endpoint`. Confirm OS process exit separately if the endpoint is unreachable.

## Bounded logging and resources

The helper retains at most the last 16,384 **bytes** of stderr in memory and sends bounded
snapshots. No logfile grows with browser output. Supervised detached startup diagnostics
report `stderrStatus: 'captured'`, including handshake failures.

At release the helper clears retained logs, then drains/discards stderr for the browser's
remaining lifetime. An independent helper remains, but no original-host stderr pipe or
control connection is required.

Normal owned close cleans temporary profiles and the Windows helper executable. Release
retains profiles and, on Windows, the running helper's `nodriver-guardian-*` directory in the
system temp directory. A later supervised launch on Windows removes such directories once their
helper has exited and they are more than an hour old, including those a hard host exit leaves.
Hard host exit can also leave temporary profiles and stale controller locks. Persistent locks are
reclaimed after checking that their owner has exited. Confirm exit before removing leftovers.
