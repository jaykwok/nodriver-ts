# Startup diagnostics

[简体中文](zh-CN/startup-diagnostics.md)

Launch and connect failures carry a snapshot retrievable through `getStartupDiagnostics(error)`.
The original error class is preserved, including `TimeoutError` and `ProfileInUseError`.
Caller-owned abort reasons retain their identity and message, even when frozen. Other error
messages include the stage, elapsed time and available process details.

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

The snapshot contains `stage`, `elapsedMs`, `stageElapsedMs`, and optional `process`.
Times use a monotonic clock and are captured before owned-process failure cleanup, so they
exclude termination waits. `process` is absent before a child exists and for `Browser.connect()`.
It contains `pid`, `exited`, `exitCode`, `signal`, `stderr` and `stderrStatus`.
Null exit code/signal means no such exit status was observed, not successful execution.
The snapshot is frozen and does not change when cleanup later terminates Chrome.

| Stage                       | Work                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| `process-launch`            | Executable lookup and OS process spawn                                   |
| `profile-preparation`       | Profile creation, locking and launch configuration                       |
| `port-file`                 | Waiting for a valid `DevToolsActivePort` (WebSocket launch only)         |
| `endpoint-discovery`        | HTTP `/json/version` discovery (connect only)                            |
| `websocket-connect`         | Opening the WebSocket transport                                          |
| `protocol-handshake`        | `Browser.getVersion`                                                     |
| `target-initialization`     | Context/target discovery, automatic attachment and startup Tab readiness |
| `environment-configuration` | Optional headless UA configuration                                       |

One total initialization deadline covers all stages; failure cleanup has
independent termination bounds. Invalid timeout arguments are rejected before initialization.
The stage identifies the startup operation that failed or timed out.

For ordinary launches, stderr retains at most its last 16,384 characters. It can contain
browser-generated URLs or other sensitive text; choose where to record it. Plain detached launches
report `stderrStatus: 'discarded'`. With `detached: true, supervised: true`, an independent helper
retains the last 16,384 bytes and reports `captured`, including protocol/target startup failures.
The helper transfers to an independent drain-and-discard role at release; no growing logfile
or original-host stderr pipe remains.

See [supervised ownership](lifecycle-ownership-design.md) for platform and helper-lifetime limits.
