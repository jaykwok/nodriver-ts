# Startup diagnostics

[简体中文](zh-CN/startup-diagnostics.md)

Launch and connect failures carry a snapshot that `getStartupDiagnostics(error)` returns, even for frozen errors. The original error class is preserved, including `TimeoutError` and `ProfileInUseError`. Abort reasons from the caller's signal keep their identity and message; other error messages gain the stage, elapsed time, available process details and retained stderr.

```ts
import { Browser, getStartupDiagnostics } from 'nodriver-ts';

try {
  await Browser.launch({ headless: true, timeout: 30000 });
} catch (error) {
  const startup = getStartupDiagnostics(error);
  console.error(startup?.stage, startup?.elapsedMs, startup?.process);
  throw error;
}
```

The snapshot contains `stage`, `elapsedMs`, `stageElapsedMs` and an optional `process`. Times use a monotonic clock and are taken before failure cleanup of an owned process, so they exclude termination waits. `process` is absent before a child exists and for `Browser.connect()`; otherwise it contains `pid`, `exited`, `exitCode`, `signal`, `stderr` and `stderrStatus`. A null exit code or signal means that exit status was not observed; `exited` records whether the process had exited at sampling time. The snapshot is frozen and does not change when cleanup later terminates Chrome.

| Stage                       | Work                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process-launch`            | Option checks, executable lookup and OS process spawn, including the supervision helper                                                                                         |
| `profile-preparation`       | Profile creation, locking and launch configuration                                                                                                                              |
| `port-file`                 | Waiting for a valid `DevToolsActivePort` (WebSocket launch only)                                                                                                                |
| `endpoint-discovery`        | HTTP `/json/version` discovery (connect only)                                                                                                                                   |
| `websocket-connect`         | Opening the WebSocket transport                                                                                                                                                 |
| `protocol-handshake`        | `Browser.getVersion`                                                                                                                                                            |
| `target-initialization`     | Context/target discovery, automatic attachment and startup Tab readiness                                                                                                        |
| `environment-configuration` | The [native environment](native-environment.md) lookup and host checks before profile preparation; after target initialization, `maskHeadless` and the native environment check |

One total initialization deadline covers all stages, and the stage names the operation that failed or timed out. Failure cleanup has its own termination bounds. Invalid timeout arguments are rejected before initialization.

For ordinary launches, `stderr` keeps at most its last 16,384 characters. It can contain browser-generated URLs or other sensitive text, so choose where to record it. Plain detached launches report `stderrStatus: 'discarded'`. With `detached: true, supervised: true`, an independent helper keeps the last 16,384 bytes and reports `captured`, including for protocol/target startup failures; after release it discards stderr. See [supervised ownership](lifecycle-ownership-design.md) for platform and helper-lifetime limits.
