# Raw target sessions

[简体中文](zh-CN/raw-sessions.md)

Use `attach: 'none'` when your application owns page initialization, target tracking and CDP
commands. It is available on both `Browser.launch()` and `Browser.connect()`.

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

`attachSession()` is available with every policy and always creates an independent attachment.
It does not deduplicate by target. In `none`, initial pages, later pages, popups and
`Target.attachedToTarget` never create a Tab or Frame.

Readiness in `none` means the connection and these commands have completed:
`Browser.getVersion`, `Target.getBrowserContexts`, `Target.setDiscoverTargets({ discover: true })`,
and `Target.getTargets`. It does not wait for a startup page, and may return with no page targets.
Use `pageTargets` and root `Target.*` events, not `tabs`, to track pages.

`none` skips any optional headless UA masking probe and overrides; explicit `maskHeadless: true`
is rejected. Chrome launch flags still apply. Each raw attach sends only
`Target.attachToTarget({ targetId, flatten: true })`. It does not send `Page.enable`,
`Page.setLifecycleEventsEnabled`, `Target.setAutoAttach`, or any `Runtime.*` command.
Callers choose all domain setup, screencast acknowledgements and teardown themselves. Managed input
is the one exception: `inputScope()` runs and `keyboard.compose()` send `Page.enable` by default so
that navigation interrupts input; pass `pageEvents: false` to keep all domain setup to yourself.

Launch/connect use one total initialization deadline (default 30 s), including endpoint
discovery, version, contexts, target discovery/listing and automatic attachments. The abort signal
covers these phases too. Failed launches close their connection and clean their owned process;
failed connects disconnect only. Process cleanup has separate bounded termination waits and may
outlast the initialization deadline; a host hard crash still cannot run cleanup.

## Managed raw input

`browser.inputScope(session)` and `createInputScope(session)` share the connection queue with Tab input and standalone mouse/keyboard objects. Each `run()` manages held keys/buttons and explicit composition, one deadline/signal/guard, reverse-order cleanup, and an `InputReport`. Raw scopes enable Page events for navigation tracking without activating the target; `pageEvents: false` sends no `*.enable` command. Direct `session.sendWith()` remains independent of this queue. See [input scopes, composition and cleanup](input.md) for the API and interruption contract.

## Bounded background presentation

`browser.presentationLease(session, options)` keeps a raw target observable for a short,
bounded period through `Page.startScreencast` and `Page.stopScreencast`. The lease is independent
of target focus, Runtime, input retry and unrelated connection work.

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

The defaults are bounded: 5 seconds, 16 frames offered for acknowledgement, 4 MiB of decoded frame bytes,
four concurrent ACKs, a 2 second start deadline, a 1 second per-ACK deadline and a 2 second
stop/ACK cleanup budget. Reaching a duration, frame, byte or ACK limit stops the lease and records
the reason. `close()` is idempotent and waits for the stop command plus the lease's own ACK work;
other commands on the connection keep their own lifecycle. If the session disconnects, the final
report is `disconnected` and cleanup ends with the connection.

`screencast` passes `format`, `quality`, `maxWidth`, `maxHeight` and `everyNthFrame` to
`Page.startScreencast`; Chrome's defaults apply to omitted fields. Durations and timeouts accept
up to 2147483647 ms, the Node.js timer limit. Starting a lease on an ended session rejects with a
`DisconnectedError` whose `cause` is the session's `closeReason`.

Only one presentation lease can be active for a session at a time. A lease that is still idle can
be started after the current lease closes. Frames received while a lease is `starting` are handled
under the same frame, byte and ACK limits as frames received while it is `active`.
This coordination covers managed presentation leases; do not mix direct `Page.startScreencast` or
`Page.stopScreencast` calls on the same session while a lease is active.

The report separates the lease lifecycle (`state`) from cleanup (`cleanup`). `state` describes
whether the lease is active, stopped, timed out, failed or disconnected. `cleanup` is `pending`,
`completed`, `timed-out`, `failed` or `disconnected`; `timed-out` means the lease ended while ACK
work remained. `reason` records why the lease ended; when `Page.stopScreencast` fails, `reason`
keeps that cause, `state` is `failed` and the error is added to `cleanupErrors`.
`inFlightAcks` is the number of ACKs still outstanding when the report was closed,
and the report is a stable snapshot after `close()` resolves. The report also includes frames
offered for acknowledgement, acknowledged frames, dropped frames, encoded bytes, ACK errors and
cleanup errors. Screencast ACKs are reported separately from input actions. Background throttling
remains dependent on Chrome and the operating system.

## Session lifetime

`TargetSession` extends `Session`, adding `targetId`, `endReason`, `ended: Promise<EndReason>`,
and `detach({ signal?, timeout? })`. It inherits typed `send`, `sendWith`, `on`, `onAny`,
`waitFor`, `id`, and `closed`.

The first terminal event wins. `ended` resolves exactly once; `endReason` is one of:

| Reason             | Trigger                                                         |
| ------------------ | --------------------------------------------------------------- |
| `detach-requested` | This session's `detach()` was called                            |
| `detached`         | Chrome sent `Target.detachedFromTarget`                         |
| `target-destroyed` | Chrome sent `Target.targetDestroyed` first                      |
| `target-crashed`   | Chrome sent `Inspector.targetCrashed` or `Target.targetCrashed` |
| `disconnected`     | The CDP connection ended, including release/disconnect          |

Ending a session immediately rejects its pending requests and `waitFor` calls with
`SessionEndedError`, a `DisconnectedError` subtype with `reason` and `targetId`. Event
subscriptions are removed. Future sends/waits reject; new event subscriptions throw.
Sibling attachments remain usable unless they share the destroyed/crashed target or the connection
ends. A close-target operation can yield `detached` before `target-destroyed`, depending on Chrome's
event order.

Crash is a terminal **library** lifetime even though Chrome itself lets the original
CDP attachment to reload and evaluate after a renderer crash. The raw session is closed and
its attachment is cleaned up. Observe the root `Target.targetCrashed` notification before
reattaching for recovery: the session-level crash notification can arrive first. The caller
may then attach again and send `Page.reload`. High-level Tab crash/reload
behavior is separate. A target can crash again; a new attachment is not a recovery guarantee.

`detach()` closes the local lifetime synchronously, then awaits `Target.detachFromTarget`.
Repeated calls share the same promise. A signal already aborted before the call leaves the
session open; aborting after send does not reopen it and triggers independent cleanup. If Chrome
no longer has the attachment, `detach()` succeeds without another command.

A root `Target.attachedToTarget` listener that calls `connection.session(id)` for an attachment
that `attachSession()` is creating gets a plain `Session`. Once the attach completes, events go
to the `TargetSession` that `attachSession()` returns, and the plain `Session` ends: `closed`
is true, `closeReason` says why, and its commands reject.

## Cancelled attaches and bounded cleanup

An aborted or timed-out attach rejects immediately. Other attachments are independent.
If a successful response arrives later, the connection sends `Target.detachFromTarget` for
its session ID with an independent 5 s deadline.

If the attach response never arrives within 5 s after cancellation, or the cleanup detach cannot
be confirmed within its own 5 s deadline, the library disconnects the CDP connection. The same
fallback applies to failed detach cleanup. A protocol response saying the session is already
gone counts as success. This exceptional connection closure ends **all** its sessions, prevents
untracked attachments from surviving on the connection, and reports the cleanup failure through
`onError`. Applications should classify it as `connection_lost`; ordinary cancellation affects
only the cancelled caller. This does not kill a connected WebSocket browser; Pipe Chrome exits
when its transport closes.

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

`onSend` runs synchronously immediately before calling the transport's send method. `seq` is the
connection's monotonically increasing command ID; gaps are allowed. `at` is `performance.now()`
in milliseconds. It records a send attempt, not confirmation Chrome received or executed it.
Reentrant observer sends are queued to preserve transport invocation order. Observer exceptions
are isolated. Keep callbacks short; aborting from a callback cannot unsend the observed attempt.

`onSettle` runs once per sent request when the caller's promise settles,
in completion order, with elapsed time from the send attempt and the protocol error code or
error name on failure. A late response does not produce a second settlement.

`onResponse` runs synchronously when a correlated response is processed. `seq` is the same CDP
request ID used by `onSend` and `onSettle`, scoped to one connection. `sessionId` is the request's
session ID, including browser-level errors for detached sessions. `at` is the receive time from
`performance.now()`; `durationMs` measures send-to-response time. `late` means the request was
already retired by cancellation, timeout, session end or send failure before receipt; it does
not depend on whether the `onSettle` microtask has run. `error`, if present, is the CDP error code
as a string. Duplicate/unknown responses are ignored; a session mismatch disconnects instead
of acknowledging the command. No observer receives parameters, results or protocol error text.
For an ordinary response, `onResponse` runs before the asynchronous `onSettle` notification.
Internal response processing and scheduling of cancelled-attach cleanup happen before `onResponse`.
If a transport responds synchronously during a send, the cleanup send can still be queued;
`pendingCount` includes it even before `unansweredCount` does.
`trace` callbacks run on completion; their shape and stderr output are independent of observers.

### Unanswered commands and bounded waiting

`connection.pendingCount` counts caller requests awaiting settlement (including queued sends).
`connection.unansweredCount` counts transport send attempts without a correlated response.
For example, after a sent command times out, these can be `0` and `1` respectively; the late
response makes `unansweredCount` zero without settling the caller again. Cancelled attaches
can enqueue a cleanup detach when the late reply arrives; that new command is also counted.

Cancellation, timeout and session end do **not** remove unanswered commands. Send errors also
retain the count because an arbitrary transport may fail after partial delivery. Pre-aborted
requests, serialization failures and queued requests cancelled before their send attempt add
no debt. Entries store only ID/method/session/timestamp metadata and remain until a response or
connection closure, regardless of how much history an application evicts. A peer that never
replies can grow this metadata; callers should stop issuing work and enforce their own cleanup
deadline, disconnecting if they cannot confirm responses.

Connection closure clears the count without synthesizing responses. Always check `closed` or
the disconnection event: zero after disconnect is not successful draining. Zero while open is
only an instantaneous count, not a barrier against concurrent sends, and a CDP reply does not
prove every browser-side effect has completed. Serialize operation/cleanup ownership in the
application before releasing that ownership.

### Native drain

`await browser.drain({ timeout: 11000, signal })` delegates to `connection.drain()`.
It waits without polling for pending/queued requests, unanswered wire attempts, abandoned
attaches, and library attachment cleanup (including the continuation that retries a failed
detach). Synchronous observers and their queued sends run before the idle check.

| Outcome                                            | Result                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| Open connection with all tracked work drained      | Resolves `void`                                                     |
| Already disconnected or disconnected while waiting | Rejects `DisconnectedError`, with the connection failure as `cause` |
| Deadline expires                                   | Rejects `TimeoutError`                                              |
| Signal aborts                                      | Rejects the signal's error reason                                   |

The timeout defaults to the connection's timeout. Each waiter has its own deadline and signal;
timing out or cancelling a waiter does not cancel commands, retry input or disconnect. Library
attachment cleanup retains its independent deadlines and can still disconnect on failure.
Stop command producers first: drain is not a lock against later sends, and does not await
arbitrary application promises, event waiters, or all browser-side effects. A protocol error
response pays the wire debt; drain does not turn the command's failure into success. A crashed
target can leave unanswerable commands, so a drain deadline remains necessary.

```ts
// Stop/cancel the operation, then wait for its wire replies before detaching its session.
await browser.drain({ timeout: 11000 });
await session.detach({ timeout: 5000 });
await browser.drain({ timeout: 11000 });
```

### Optional performance observations

Set `observe.onPerformance(entry)` to receive payload-free measurements. This opt-in adds no
JSON parse and stores no message body. `bytes` is the UTF-8 JSON message size, excluding WebSocket
framing or pipe delimiters. All timestamps use `performance.now()`.

| Direction | Fields and measurement boundaries                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`    | `seq`, `method`, `sessionId`, `at`, `bytes`; `queueMs` from entering the request queue to serialization start; `serializationMs` for JSON serialization                                               |
| `receive` | `kind` (`response`, `event`, `invalid`), `at`, `bytes`, `parseMs`, `dispatchMs`; correlated responses also include `seq`, `method`, `sessionId`, and `responseWaitMs` when that send was instrumented |

`responseWaitMs` runs from transport invocation (after `onSend`) to receive callback entry.
It includes transport/network and Chrome time; it cannot isolate Chrome execution. `dispatchMs`
covers synchronous protocol processing and event/response callbacks, excluding the performance
callback itself, Promise continuations such as `onSettle`, and asynchronous listener work.
The queue is the connection's reentrant send queue, not an application/input queue. Instrumentation
and observer work have overhead; these phases are not an end-to-end input latency breakdown.

Late responses retain their original `seq`. Unknown/duplicate responses have no correlation
fields. Callback exceptions are isolated. A synchronous transport may emit receive metrics before
send metrics; correlate by `seq`, not callback order. Rejected sends before serialization produce
no message metric. No payload or protocol error text is included.

## Test support

`ScriptedChrome.connect({ attach: 'none' })` uses the same real objects. The fixture models
independent attachments, `detachSession(id)`, `crashTarget(id)`, and `destroyTarget(id)`.
`attachReplyDelayMs` delays the reply after the attachment and its event exist, enabling
cancelled-late-reply tests. Detach commands are recorded in `commands`.
