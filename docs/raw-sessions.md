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

Crash is a terminal **library** lifetime even though Chrome 155 on Windows allowed the original
CDP attachment to reload and evaluate after a renderer crash. The raw session is closed and
its attachment is cleaned up. Observe the root `Target.targetCrashed` notification before
reattaching for recovery: the session-level crash notification can arrive first. The caller
may then attach again and send `Page.reload`. Existing high-level Tab crash/reload behavior is
unchanged. A target can crash again; a new attachment is not a recovery guarantee.

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

## Observe sending without recording payloads

```ts
const browser = await Browser.connect({
  endpoint,
  attach: 'none',
  observe: {
    onSend({ seq, method, sessionId, at }) {
      // Bind the application's current phase to this command here.
    },
    onSettle({ seq, durationMs, error }) {
      // Correlate completion with its send sequence.
    },
  },
});
```

`onSend` runs synchronously immediately before calling the transport's send method. `seq` is the
connection's monotonically increasing command ID; gaps are allowed. `at` is `performance.now()`
in milliseconds. It records a send attempt, not confirmation Chrome received or executed it.
Reentrant observer sends are queued to preserve transport invocation order. Observer exceptions
are isolated. Keep callbacks short; aborting from a callback cannot unsend the observed attempt.

`onSettle` follows completion order and reports elapsed time from the send attempt, with the
protocol error code or error name on failure. Neither observer receives parameters or results.
Existing `trace` callbacks still run on completion with their existing shape and stderr behavior.

## Test support and evidence

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
