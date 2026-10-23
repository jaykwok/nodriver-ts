# Raw target sessions

[简体中文](zh-CN/raw-sessions.md)

Use `attach: 'none'` when your application owns page initialization, target tracking and CDP
commands. Available in 0.3.0 on both `Browser.launch()` and `Browser.connect()`.

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
Callers choose all domain setup, screencast acknowledgements and teardown themselves.

Launch/connect use one total initialization deadline (default 30 s), including endpoint
discovery, version, contexts, target discovery/listing and automatic attachments. The abort signal
covers these phases too. Failed launches close their connection and clean their owned process;
failed connects disconnect only. Process cleanup has separate bounded termination waits and may
outlast the initialization deadline; a host hard crash still cannot run cleanup.

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
session open; aborting after send does not reopen it and triggers independent cleanup.

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

`onSettle` retains its existing meaning: once per sent request when the caller's promise settles,
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
Existing `trace` callbacks still run on completion with their existing shape and stderr behavior.

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
application and wait for both counts to reach zero within its budget before releasing that
ownership. The library does not introduce a new drain method or change cancellation behavior.

## Test support

`ScriptedChrome.connect({ attach: 'none' })` uses the same real objects. The fixture models
independent attachments, `detachSession(id)`, `crashTarget(id)`, and `destroyTarget(id)`.
`attachReplyDelayMs` delays the reply after the attachment and its event exist, enabling
cancelled-late-reply tests. Detach commands are recorded in `commands`.

Unit tests cover these lifetimes, cancellation, cleanup failure, startup budgets and send order.
Real-browser tests cover raw evaluation, crash/recovery, target close, release/reconnect and
closing the last window while Chrome stays alive. The latter uses
`--no-startup-window --keep-alive-for-test`: it is a controlled background-process test,
not a test of a particular installed extension's background policy. Windows runs it headful;
Linux without a display uses headless Chrome. Node.js 24 runs the source suite and
built-package acceptance; CI also checks the minimum supported release, Node.js 24.22.0.
