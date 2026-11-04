# Raw target sessions

[简体中文](zh-CN/raw-sessions.md)

Use `attach: 'none'` on `Browser.launch()` or `Browser.connect()` when your application owns page initialization, target tracking and CDP commands.

```ts
import { Browser } from 'nodriver-ts';

const browser = await Browser.launch({ attach: 'none', headless: true, detached: true });
try {
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
  const session = await browser.attachSession(targetId, { timeout: 5000 });
  const result = await session.send('Runtime.evaluate', { expression: '6 * 7' });
  console.log(result.result.value);
  await session.detach();
  const endpoint = await browser.release();
  // Persist endpoint for Browser.connect({ endpoint, attach: 'none' }).
} finally {
  await browser.close(); // After release, only disconnects.
}
```

## Attachment policies and readiness

| Policy          | Automatic page attachment                          | Explicit `newTab` / `attachTarget` |
| --------------- | -------------------------------------------------- | ---------------------------------- |
| `all` (default) | Existing pages, future pages and popups            | Allowed                            |
| `created`       | Pages created through this client and their popups | Allowed                            |
| `none`          | None; `tabs` stays empty                           | Rejected before sending CDP        |

`attachSession()` works with every policy and always creates a new, independent attachment; it does not deduplicate by target. In `none`, no page, popup or `Target.attachedToTarget` event ever creates a Tab or Frame.

In `none`, launch/connect is ready once the connection is open and `Browser.getVersion`, `Target.getBrowserContexts`, `Target.setDiscoverTargets({ discover: true })` and `Target.getTargets` have completed. It does not wait for a startup page and can return with no page targets. Track pages with `pageTargets` and root `Target.*` events, not `tabs`.

`none` skips the optional headless UA masking probe and overrides, and rejects an explicit `maskHeadless: true`; Chrome launch flags still apply. Each raw attach sends only `Target.attachToTarget({ targetId, flatten: true })`, never `Page.enable`, `Page.setLifecycleEventsEnabled`, `Target.setAutoAttach` or any `Runtime.*` command. Domain setup, screencast acknowledgements and teardown are up to you. The one exception is managed input: `inputScope()` runs and `keyboard.compose()` send `Page.enable` by default so that navigation interrupts input; `pageEvents: false` sends no `*.enable` command.

Launch/connect share one total initialization deadline (default 30 s) and the abort signal across endpoint discovery, version, contexts, target discovery/listing and automatic attachments. A failed launch closes its connection and cleans up its owned process; a failed connect only disconnects. Process cleanup has its own bounded termination waits and may outlast the deadline; a host hard crash still cannot run cleanup.

## Managed raw input

`browser.inputScope(session)` and `createInputScope(session)` share the connection's input queue with Tab input and standalone mouse/keyboard objects. Each `run()` manages held keys/buttons and explicit composition under one deadline/signal/guard, cleans up in reverse order and returns an `InputReport`. Scopes never activate the target. Direct `session.sendWith()` calls bypass this queue. See [input scopes, composition and cleanup](input.md) for the API and interruption contract.

## Bounded background presentation

`browser.presentationLease(session, options)` keeps a raw target observable for a short, bounded period through `Page.startScreencast` and `Page.stopScreencast`. The lease is independent of target focus, Runtime, input retry and unrelated connection work.

```ts
const lease = browser.presentationLease(session, {
  screencast: { format: 'jpeg', quality: 30, maxWidth: 320, maxHeight: 240 },
  maxDuration: 3000,
  maxFrames: 8,
  maxBytes: 2_000_000,
  maxInFlightAcks: 4,
});
try {
  await lease.start();
  // Perform background target work here.
} finally {
  const report = await lease.close();
  console.log(report.state, report.frames, report.acknowledgedFrames);
}
```

Defaults: 5 s duration, 16 frames offered for acknowledgement, 4 MiB of decoded frame bytes, 4 concurrent ACKs, a 2 s start deadline, a 1 s per-ACK deadline and a 2 s stop/ACK cleanup budget. Reaching a duration, frame, byte or ACK limit, or an ACK timing out, stops the lease and records the reason. `close()` is idempotent and waits for the stop command and the lease's own ACK work; other commands on the connection keep their own lifecycle. If the session disconnects, the report is `disconnected` and cleanup ends with the connection.

`screencast` passes `format`, `quality`, `maxWidth`, `maxHeight` and `everyNthFrame` to `Page.startScreencast`; Chrome's defaults apply to omitted fields. Durations and timeouts accept up to 2147483647 ms, the Node.js timer limit. Starting a lease on an ended session rejects with a `DisconnectedError` whose `cause` is the session's `closeReason`.

A session has at most one active presentation lease; a lease that is still idle can start after the current one closes. Frames that arrive while a lease is `starting` count against the same frame, byte and ACK limits as frames received while it is `active`. Do not call `Page.startScreencast` or `Page.stopScreencast` directly on a session while a lease is active.

The report keeps the lease outcome (`state`) separate from cleanup (`cleanup`). `state` is `active`, `stopped`, `timed-out` (a limit or ACK timeout ended the lease), `failed` or `disconnected`. `cleanup` is `pending`, `completed`, `timed-out` (ACK work remained when the cleanup budget ran out), `failed` or `disconnected`. `reason` records why the lease ended; when `Page.stopScreencast` fails, `reason` is kept, `state` becomes `failed` and the error is added to `cleanupErrors`. The report also counts offered, acknowledged and dropped frames, encoded bytes, ACK errors and cleanup errors, and `inFlightAcks` holds the ACKs still outstanding at close. After `close()` resolves, the report is a stable snapshot. Screencast ACKs are reported separately from input actions. Background throttling remains up to Chrome and the operating system.

## Session lifetime

`TargetSession` extends `Session` with `targetId`, `endReason`, `ended: Promise<EndReason>` and `detach({ signal?, timeout? })`. It inherits typed `send`, `sendWith`, `on`, `onAny`, `waitFor`, `id`, `closed` and `closeReason`.

The first terminal event wins, and `ended` resolves exactly once with one of these reasons:

| Reason             | Trigger                                                         |
| ------------------ | --------------------------------------------------------------- |
| `detach-requested` | This session's `detach()` was called                            |
| `detached`         | Chrome sent `Target.detachedFromTarget`                         |
| `target-destroyed` | Chrome sent `Target.targetDestroyed` first                      |
| `target-crashed`   | Chrome sent `Inspector.targetCrashed` or `Target.targetCrashed` |
| `disconnected`     | The CDP connection ended, including release/disconnect          |

When a session ends, its pending requests and `waitFor` calls reject immediately with `SessionEndedError`, a `DisconnectedError` subtype carrying `reason` and `targetId`. Its event subscriptions are removed; later sends and waits reject and new subscriptions throw. Sibling attachments stay usable unless they share the destroyed/crashed target or the connection ends. Closing a target can yield `detached` before `target-destroyed`, depending on Chrome's event order.

A crash ends the **library** lifetime even though Chrome would let the original CDP attachment reload and evaluate after a renderer crash: the raw session is closed and its attachment cleaned up. To recover, wait for the root `Target.targetCrashed` notification (the session-level one can arrive first), then attach again and send `Page.reload`. A target can crash again, so a new attachment does not guarantee recovery. High-level Tab crash/reload behavior is separate.

`detach()` ends the local lifetime synchronously, then awaits `Target.detachFromTarget`; repeated calls share one promise. A signal aborted before the call leaves the session open; aborting after the send does not reopen it and starts independent cleanup. If the session has already ended or Chrome no longer has the attachment, `detach()` succeeds without another command.

If a root `Target.attachedToTarget` listener calls `connection.session(id)` for an attachment that `attachSession()` is creating, it gets a plain `Session`. Once the attach completes, events go to the returned `TargetSession` and the plain `Session` ends: `closed` is true, `closeReason` says why, and its commands reject.

## Cancelled attaches and bounded cleanup

An aborted or timed-out attach rejects immediately without affecting other attachments. If a successful response arrives later, the connection sends `Target.detachFromTarget` for that session ID with an independent 5 s deadline.

If no attach response arrives within 5 s of cancellation, or the cleanup detach (including the one after a failed `detach()`) cannot be confirmed within its own 5 s, the library disconnects the CDP connection. A protocol response saying the session is already gone counts as success. This exceptional closure ends **all** sessions on the connection, so no untracked attachment survives, and reports the cleanup failure through `onError`. Treat it as `connection_lost`; ordinary cancellation affects only the cancelled caller. Disconnecting does not kill a WebSocket browser; Pipe Chrome exits when its transport closes.

## Observe sends, caller settlement and responses without recording payloads

```ts
const browser = await Browser.connect({
  endpoint,
  attach: 'none',
  observe: {
    onSend({ seq, method, sessionId, at }) {
      // Bind the application's current phase to this command here.
    },
    onSettle({ seq, durationMs, error }) {
      // The caller completed or failed; a cancelled command may still be running in Chrome.
    },
    onResponse({ seq, method, sessionId, at, durationMs, late, error }) {
      // A correlated response arrived, possibly after cancellation/timeout/session end.
    },
  },
});
```

`onSend` runs synchronously just before the transport's send method is called. `seq` is the connection's monotonically increasing CDP request ID (gaps are allowed), shared by all three callbacks. `at` is `performance.now()` in milliseconds. It records a send attempt, not that Chrome received or executed the command. Sends made from inside an observer are queued to preserve transport invocation order. Observer exceptions are isolated. Keep callbacks short; aborting from a callback cannot unsend the observed attempt.

`onSettle` runs once per sent request when the caller's promise settles, in completion order. It reports the time since the send attempt and, on failure, the protocol error code or error name. A late response does not settle the caller again.

`onResponse` runs synchronously when a correlated response is processed. `sessionId` is the request's session ID, including for browser-level errors about detached sessions. `at` is the receive time from `performance.now()` and `durationMs` the send-to-response time. `late` means the request was already retired by cancellation, timeout, session end or send failure before the response arrived, regardless of whether the `onSettle` microtask has run. `error`, if present, is the CDP error code as a string. Duplicate or unknown responses are ignored; a session mismatch disconnects instead of acknowledging the command. No observer receives parameters, results or protocol error text.

For an ordinary response, `onResponse` runs before the asynchronous `onSettle`. Internal response processing and scheduling of cancelled-attach cleanup happen before `onResponse`. If a transport responds synchronously during a send, that cleanup send can still be queued: `pendingCount` includes it before `unansweredCount` does. `trace` callbacks run on completion; their shape and stderr output are independent of observers.

### Unanswered commands and bounded waiting

`connection.pendingCount` counts caller requests awaiting settlement, including queued sends. `connection.unansweredCount` counts transport send attempts without a correlated response. After a sent command times out, for example, they can be `0` and `1`; the late response brings `unansweredCount` to zero without settling the caller again. The cleanup detach that a late reply to a cancelled attach triggers is counted too.

Cancellation, timeout and session end do **not** remove unanswered commands. Send errors keep the count as well, because an arbitrary transport may fail after partial delivery. Pre-aborted requests, serialization failures and queued requests cancelled before their send attempt add no debt. Entries hold only ID/method/session/timestamp metadata and remain until a response or connection closure, regardless of what history the application evicts. A peer that never replies can grow this metadata; stop issuing work, enforce your own cleanup deadline and disconnect if responses cannot be confirmed.

Connection closure clears the count without synthesizing responses, so always check `closed` or the disconnection event: zero after disconnect is not successful draining. Zero while open is an instantaneous count, not a barrier against concurrent sends, and a CDP reply does not prove that every browser-side effect has completed. Serialize operation and cleanup ownership in the application before releasing it.

### Native drain

`await browser.drain({ timeout: 11000, signal })` delegates to `connection.drain()`. Without polling, it waits for pending and queued requests, unanswered wire attempts, abandoned attaches and library attachment cleanup, including the continuation that retries a failed detach. Synchronous observers and their queued sends run before the idle check.

| Outcome                                            | Result                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| Open connection with all tracked work drained      | Resolves `void`                                                     |
| Already disconnected or disconnected while waiting | Rejects `DisconnectedError`, with the connection failure as `cause` |
| Deadline expires                                   | Rejects `TimeoutError`                                              |
| Signal aborts                                      | Rejects the signal's error reason                                   |

The timeout defaults to the connection's timeout. Each waiter has its own deadline and signal; timing out or cancelling a waiter does not cancel commands, retry input or disconnect, while library attachment cleanup keeps its own deadlines and can still disconnect on failure. Stop command producers first: drain is not a lock against later sends and does not await application promises, event waiters or all browser-side effects. A protocol error response settles the wire debt but does not turn the command's failure into success. A crashed target can leave commands that are never answered, so a drain deadline remains necessary.

```ts
// Stop/cancel the operation, then wait for its wire replies before detaching its session.
await browser.drain({ timeout: 11000 });
await session.detach({ timeout: 5000 });
await browser.drain({ timeout: 11000 });
```

### Optional performance observations

Set `observe.onPerformance(entry)` to receive payload-free measurements. This opt-in adds no JSON parse and stores no message body. `bytes` is the UTF-8 JSON message size, excluding WebSocket framing or pipe delimiters. All timestamps use `performance.now()`.

| Direction | Fields and measurement boundaries                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`    | `seq`, `method`, `sessionId`, `at`, `bytes`; `queueMs` from entering the request queue to serialization start; `serializationMs` for JSON serialization                                               |
| `receive` | `kind` (`response`, `event`, `invalid`), `at`, `bytes`, `parseMs`, `dispatchMs`; correlated responses also include `seq`, `method`, `sessionId`, and `responseWaitMs` when that send was instrumented |

`responseWaitMs` runs from transport invocation (after `onSend`) to receive callback entry. It includes transport, network and Chrome time and cannot isolate Chrome execution. `dispatchMs` covers synchronous protocol processing and event/response callbacks, excluding the performance callback itself, Promise continuations such as `onSettle`, and asynchronous listener work. The queue in `queueMs` is the connection's reentrant send queue, not an application or input queue. Instrumentation and observers add overhead; these phases are not an end-to-end input latency breakdown.

Late responses keep their original `seq`; unknown and duplicate responses have no correlation fields. Callback exceptions are isolated. A synchronous transport may emit receive metrics before send metrics, so correlate by `seq`, not callback order. Sends rejected before serialization produce no metric. No entry includes payloads or protocol error text.

## Test support

`ScriptedChrome` from `nodriver-ts/testing` drives the same real objects: `(await ScriptedChrome.start()).connect({ attach: 'none' })`. It models independent attachments, `detachSession(id)`, `crashTarget(id)` and `destroyTarget(id)`. `attachReplyDelayMs` delays the attach reply after the attachment and its event exist, for cancelled-late-reply tests. Every command, including detaches, is recorded in `commands`.
