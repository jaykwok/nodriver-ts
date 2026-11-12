# Input policy, events and cancellation

[简体中文](zh-CN/input.md)

The default `instant` policy performs fast, deterministic actions. `tab.setInputPolicy({ mode: 'human', seed: 42 })` turns on continuous pointer trajectories with acceleration and deceleration, pauses, press/release intervals, segmented scrolling and per-character typing rhythm. The policy controls CDP input timing and paths; it does not generate operating-system keyboard or mouse events.

```ts
tab.setInputPolicy({
  mode: 'human',
  seed: 42,
  pause: [0, 15],
  pressDelay: [25, 70],
  keyDelay: [35, 110],
  wheelProfile: 'trackpad', // trackpad | wheel
  targetInset: 0.2,
  typing: 'auto', // auto | keys | insertText; auto uses key events in human mode
  scroll: 'auto', // auto | wheel | dom; auto first wheels the element close to the viewport in human mode
  presentationRecovery: 250, // ms an input command may stall before a frame is requested; false turns it off
  lateMoves: 'send', // send | skip; skip drops pointer samples whose time has passed
});
const input = await tab.waitForSelector('input');
await input.fill('replace all');
await input.type('中文👨‍👩‍👧‍👦é'); // types at the current caret/selection; does not select all or submit
await input.type(['an explicit committed segment', '😀']);
await tab.keyboard.press('Control+A'); // select all is Meta+A on macOS
await tab.mouse.wheel(0, 420);
console.log(tab.inputBehavior.lastReport);
```

## Defaults for new tabs

`inputPolicy` in `Browser.launch()` / `Browser.connect()` options applies to every tab of the browser, including the startup tab and tabs attached while connecting. `browser.setDefaultInputPolicy(policy)` sets it for tabs that open later, and `newContext({ inputPolicy })` or `context.setDefaultInputPolicy(policy)` overrides it for one context. Popups open in their opener's context, so they take the context's default, not the opener tab's own policy. Open tabs keep their policy, and `tab.setInputPolicy()` overrides the default for one tab. `undefined` removes a default. A default without a seed gives each tab its own random stream; with a seed, every new tab starts the same stream.

```ts
await using browser = await Browser.launch({ inputPolicy: { mode: 'human' } });
const page = await browser.newTab(); // human
const popup = await page.waitForPopup(); // human
```

## Parameters

Times are in milliseconds and each range is a minimum/maximum: step counts 1–120, times 0–3000, and `targetInset` (the fraction of the visible target excluded at each edge) 0–0.45. `presentationRecovery` is 10–60000 ms or `false`; see [pages that draw no frames](#pages-that-draw-no-frames). `wheelNotch` (1–1000 px) and `pointerGrid` have no default and are described [below](#human-motion-planning): `wheelNotch` requires `wheelProfile: 'wheel'` and cannot be combined with `scrollSteps`, and `pointerGrid.scale` is 0.25–20. Omitted policy fields, and fields set to `undefined`, reset to their defaults, except the seed. When no seed is given, one is generated with Node crypto when the Tab's input behavior is created, and it is kept across actions, mode switches and configure calls that omit it. An explicit seed, even the current one, restarts that behavior's random stream; other tabs are unaffected. The policy cannot be changed while an action is running, and it never introduces typos, extra submits or random business actions.

Omitting `moveDuration`, `moveSteps` or `scrollSteps` means automatic planning, described [below](#human-motion-planning); an explicit range replaces it. The MCP tool `browser_input_policy` takes the same fields.

The same seed, starting point, layout, configuration and call sequence reproduce the same planned trajectory and delays; actual scheduling, frame rate and event timestamps can still differ by milliseconds. The seed alone reproduces an action only together with the random draws before it; `randomState` restarts the PRNG at an action boundary. Reproducing an entire action also requires the same policy, layout, pointer/keyboard state and arguments. Without an explicit seed, separate runs use different random sequences.

## Human motion planning

Human input is planned in Node; nothing runs in the page to produce it.

- **Paths**: cubic Bézier curves with minimum-jerk progress and 8–12 Hz motion noise that fades in and out. A path that starts and ends inside the viewport does not cross its top or left edge.
- **Duration**: `70 + 90 * log2(1 + distance / targetWidth)` ms, at most 1800 ms, planned at about 120 points per second. `click()` uses the smaller side of the element's box as `targetWidth`; `hover()`, `mouse.move()` and the approach of `drag()` use 24 px. An explicit `moveDuration` or `moveSteps` replaces the planned duration or point count. With the button held, `drag()` moves in its `steps` equal straight steps and waits `pause` plus 10 ms after each.
- **Overshoot**: a move over 350 px overshoots by 4–12 px in a quarter of cases and adds 3–5 correction points, which can take it past 1800 ms. There is no overshoot while a button is held, or with an explicit `moveDuration` or `moveSteps`.
- **Timing**: each point is due its planned delay after the previous point was sent, the first after the path starts, and the time Chrome takes to answer counts toward that delay. Pauses, press holds, key intervals and the intervals between wheel events count the same way, so a reply only adds time when it takes longer than the delay. The host's timer resolution can stretch short waits; on Windows it is often about 16 ms, which lowers the actual rate.
- **Late samples**: when replies are slower than the samples, as in a background window, a path still sends every sample by default and takes longer than planned. With `lateMoves: 'skip'`, a sample is dropped once the next sample is due as well, so the pointer keeps to the planned timeline. The last point of a path is always sent, and so are moves with a button held, such as those of `drag()`, presses, keys and wheel events. `report.skippedMoves` counts the dropped samples.
- **Pointer grid**: a physical mouse reports positions in whole device pixels. `pointerGrid: { scale, phase }` places every pointer coordinate on that grid: a multiple of `1 / scale` CSS pixels, offset by `phase` (`{ x, y }`, in CSS pixels, default 0). `scale` is the device pixels per CSS pixel, which is `devicePixelRatio` including page zoom; the phase depends on where the viewport lies on the screen. Both depend on the machine and window, so there is no default. Moves, presses, releases and wheel events use the snapped position, guards receive it, and a planned sample that would not move the pointer is not sent.
- **Landing points**: truncated Gaussian sampling within `targetInset` over the part of the element inside the viewport, centred horizontally and slightly above centre vertically.
- **Presses**: some presses include a 1 px held-pointer move halfway through `pressDelay`. Element clicks hit-test it first and skip it when the check fails, and it never happens inside out-of-process frames. The release uses the final position.
- **Scrolling**: `wheelProfile: 'trackpad'` (default) sends accelerating then decaying wheel events, one per 18 px of distance and about 8 ms apart; `'wheel'` sends equal events, one per 100 px and 45 ms apart. Both send 1–120 events, add `pause` to each interval and keep the signed, fractional total. An explicit `scrollSteps` sets the number of events. With `wheelNotch`, the size of one notch of the target platform's wheel, `'wheel'` instead sends one event per notch, each along one axis and 45 ms apart, and rounds the distance to whole notches: `wheel(0, 250)` with a 100 px notch scrolls three notches. Instant mode sends one event with the exact distance. Scrolling an element into view in human mode uses the wheel for up to 3 s, and Chrome scrolls the rest.
- **Typing**: delays are log-normal, bounded by `keyDelay` and weighted by QWERTY distance and hand alternation. Lowercase `th`, `he`, `in` and `er` can overlap for a planned 5–12 ms; modified keys, repeated keys and non-ASCII segments do not. Cancellation releases both keys.

## Text and keys

- **`fill()`**: replaces the whole value using focus, the selection and a single `Input.insertText`.
- **`type()`**: commits text at the current selection one grapheme at a time (Intl.Segmenter), and also accepts an array of string segments. `type(text, { replace: true })` first selects the whole value, as `fill()` does, and then types over it; with an empty text it deletes the value with Backspace. Emoji surrogate pairs, ZWJ sequences and combining characters are never split. At most 100000 UTF-16 code units per call.
- **Key events**: with `typing: 'keys'`, or the default `auto` in human mode, typeable US-layout characters (letters, digits, common symbols, space) are sent one at a time as key presses, with Shift held for capitals and shifted symbols. A key that produces a character is sent as `rawKeyDown` and then `char`, so a keydown handler that prevents the default suppresses the character, as with a physical key; with Control, Alt or Meta held, only `rawKeyDown` is sent. keyUp carries the same `key`, `code`, key code and location as keydown. While Shift is held with `keyboard.down('Shift')`, characters that need no Shift are inserted with `insertText` so that the held key does not shift them. CJK, emoji, newlines and tabs use `insertText`, and `typing: 'insertText'` uses it for everything.
- **`press()`**: supports named keys (Enter, Tab, Escape, arrow keys, Home/End, PageUp/PageDown, F1–F12, Space and more), modifier combinations and US-layout characters, for example `Shift+Tab` or `Control++`. While Shift is held, the shifted character is sent. `keyDefinition()` and `parseChord()` are exported.
- **Left, right and numpad keys**: `Shift`, `Control`, `Alt` and `Meta` are the left keys; `ShiftLeft`, `ShiftRight`, `ControlLeft`, `ControlRight`, `AltLeft`, `AltRight`, `MetaLeft` and `MetaRight` choose a side. `Numpad0`–`Numpad9`, `NumpadAdd`, `NumpadSubtract`, `NumpadMultiply`, `NumpadDivide`, `NumpadDecimal` and `NumpadEnter` type as with Num Lock on. Their events set `KeyboardEvent.location` to 1 (left), 2 (right) or 3 (numpad), on keydown, keypress and keyup alike, and `keyDefinition()` reports the same `location`. A key is held by its physical key: `up('ControlLeft')` releases a key pressed with `down('Control')`, and `pressedKeys` lists keys by the name they were pressed with.
- **macOS editing shortcuts**: when the browser runs on macOS, key events carry AppKit editing commands (CDP `commands`), so `Meta+A` selects all, `Meta+Z` undoes, `Alt+ArrowLeft` moves by word, `Control+A` moves to the start of the paragraph, and so on, as on a Mac keyboard. A launched browser uses the host platform, so a `userAgent` launch option does not change it; a connected browser uses the user agent that `Browser.getVersion` reports.
- **`select()`**: changes the option through the DOM and dispatches synthetic input/change events; isTrusted is not rewritten. When pointer or key interaction is needed, the caller performs it explicitly.

`keyboard.type()`, `element.type()` and `locator.type()` accept `onSegment(segment, index)`, a synchronous or async completion callback. It runs once per grapheme (string input) or array entry (explicit segments), after Chrome acknowledges the segment and its character key is released. The zero-based index belongs to this `type()` call; `completedSegments` is incremented before the callback. Typing waits for the callback before sending the next segment, and disables overlapping presses so a readback sees that boundary. Use the callback to read the resulting value, since a page event handler can suppress or transform the text. Callback time counts against the action's deadline and signal. A throw, rejection, timeout or cancellation stops further typing and releases managed keys; completed text is never replayed. No completion callback runs for an interrupted segment, including one acknowledged only during cleanup. Cancellation stops waiting for a callback but cannot stop arbitrary user code already running inside it. `KeyboardTypeOptions` is exported; the element/locator `TypeOptions` extends it with `replace`.

With physical-key typing, consecutive capitals or shifted symbols in one `type()` call share a single Shift press, also across `onSegment` waits. For example, `['A', 'B', '!']` holds Shift through the first two callbacks and releases it before the last. Before an unshifted or inserted-text segment, at the end of the call, or on failure, the Shift acquired by typing is released. A caller-held Shift is preserved. Multi-character array entries still use a single `insertText`; separate `type()` calls do not share an automatically held Shift.

```ts
tab.setInputPolicy({ typing: 'keys' });
const field = await tab.waitForSelector('#code');
await field.type(['A', 'B', 'C'], {
  replace: true,
  onSegment: async (segment, index) => {
    const value = await field.evaluate((el) => (el as HTMLInputElement).value);
    console.log({ segment, index, value }); // A, AB, ABC
  },
});
```

Ordinary `type()` does not generate a composition lifecycle; explicit CDP composition is available through `keyboard.compose()` and input scopes. Neither simulates OS input-method candidate windows or non-US keyboard layouts.

## Pointer and clicks

A click first scrolls the element into the viewport, checks that it is visible, enabled and not obscured, and samples its position twice, 32 ms apart, to confirm it is stable. After the trajectory ends, the target coordinates and the parent frame's hit testing are checked again. If the position changed or the target is obscured, the press is refused; the click is never repositioned or replayed.

`setChecked(checked)` is one input action: its timeout, signal and guard cover reading the state, the click and up to 1 s of waiting for the requested state. It clicks the checkbox or radio itself, or its first rendered `<label>` when a click at the control's center would not reach it, for example a native control hidden behind a styled label. It resolves to `{ changed, clicked }`, where `clicked` is `'control'` or `'label'`. A radio cannot be unchecked by clicking, so `setChecked(false)` on a checked radio is refused before any input; `setChecked(true)` checks an unchecked one. A disabled control, including one inside a disabled `<fieldset>`, is waited for until it is enabled, within the same deadline; neither it nor its label is clicked while it is disabled. A click that does not reach the requested state is reported, not repeated. Plain `click()` never redirects to another element.

Pointer pressure is 0.5 while a button is pressed, including moves with a button held. In human mode the first pointer position is random within 15–85% of the viewport. Hovering inside an OOPIF confirms that the event was delivered; only when the pointer already rests at the same coordinates is an extra probe move sent, 0.25 px aside or one step of the pointer grid, which itself produces observable events.

## Guards

`InputOptions.guard` is called with an `InputCheckpoint` at each checkpoint of an action. When it throws or rejects, the action stops with `InputActionError` and that error as `cause`, and the keys and buttons the action holds are released. `checkpoint.type` is:

- `step`: at the start and end of each step and around pauses.
- `move` and `wheel`, with `x` and `y`: before each pointer move or wheel event.
- `mouseDown`, with `button`, `x` and `y`: before a button press. `mousePressed`, with the same fields: after Chrome acknowledged the press and before anything else is sent while the button is held. The release follows even when the guard throws, so a click whose target is still under the pointer completes.
- `keyDown`, with `key` (the name it was pressed with) and `code`: before a key goes down. `char`, with the same fields: the key is down, and its character, keypress and text input are next. A guard that throws at `char` sends no character, and the key is released. Keys without a character, and keys pressed while Control, Alt or Meta is held, have no `char` checkpoint.
- `text`: before `Input.insertText`. `composition`: before a composition update or commit.

The guard counts against the action's deadline and stops with its signal. Element actions add checks of their own: `type()` checks that the element has focus at `keyDown`, `char` and `text`, and `click()` hit-tests the target at `mouseDown`.

```ts
const field = await tab.waitForSelector('#code');
await field.focus();
await tab.keyboard.type('1234', {
  // Each character goes in only while the field has focus.
  guard: async (checkpoint) => {
    if (checkpoint.type !== 'char' && checkpoint.type !== 'text') return;
    if (!(await field.evaluate((el) => el === document.activeElement)))
      throw new Error('Focus moved');
  },
});
```

## Serialization and cancellation

Tab input, standalone `new Mouse(session)` / `new Keyboard(session)` and raw input scopes share one reentrant queue per `Connection`, with at most 128 waiting or running calls. Separate connections do not share a queue, and direct `Session.send()` / `sendWith()` calls bypass it. Before an action, Tab input calls `Page.bringToFront` when another tab may be in front. A successful standalone `down()` keeps its key or button held until `up()`; use a scope when several calls must retain ownership together. A scope releases its held inputs automatically, in reverse acquisition order.

`InputOptions.timeout` is one budget for the input stage, 10000 ms by default, starting when the action is called and including queue time and preparation; element `click`, `hover`, `fill`, `type` and `setChecked` include their preparation in it. Each input command receives the remaining time and the combined cancellation signal through `sendWith()`. A nested scope operation may shorten the budget or add a signal/guard; it cannot extend the scope deadline or replace its guard.

Cancellation and deadlines reject promptly with `InputActionError`, preserving the cause. `error.report` captures the action when it stops; `error.cleanup` resolves to `{ status, report }` after cleanup, with status `completed`, `failed` or `disconnected`. Reports include:

- `phase` (`queued`, `running`, `cleaning`, `done`), `cleanup` and cleanup errors.
- `events` and `completedSegments`: acknowledged events and text segments.
- `sent`: the input commands the action sent, by kind, counted when sent rather than when answered: `moves`, `wheels`, `presses`, `keys` (key downs), `characters` (the `char` after a key down), `releases` (button and key releases, including those sent during cleanup), `text` (`Input.insertText`, including composition commits) and `composition` (updates and cancels). `dispatched` is the sum of the kinds that can change the page, every kind except moves and wheel events; a hover can still change a page, so only `sent` shows that no input was sent at all. Raw input commands that a scope callback sends during its run are counted too.
- `skippedMoves`: pointer samples dropped under `lateMoves: 'skip'`.
- `lateReplies`: replies to the action's own requests that arrived after their caller had stopped waiting, such as a command in flight when the action timed out, which cleanup then waited for.
- `presentationRecoveries`: see [pages that draw no frames](#pages-that-draw-no-frames).
- `plannedMs` and `actualMs`: the milliseconds of planned delays (pointer motion, pauses, press and key intervals, and scope `wait()` calls), and the time from acquiring input until the input ended, before cleanup. In instant mode only scope waits are planned.
- The seed, the action-start `randomState` and a trace of up to 2000 entries. Input text is not stored.

Commands whose callers stopped waiting remain visible through the cleanup result and the connection lifecycle.

`cleanupTimeout`, 5000 ms by default and independent of the input timeout and an aborted signal, bounds releases and late-response draining. The next managed input waits until cleanup completes; after a failed cleanup, later managed input is rejected with `InputBlockedError` as the cause. Input actions keep their original command results and never resend commands. Cleanup waits only for the action's own late replies: its input commands, element preparation and raw commands issued from its callback on any connection, including those whose callers stopped waiting, plus the detach the library sends for an attach of the action that answers late. Other pending commands, such as another tab's evaluation, neither delay nor fail cleanup.

While a JavaScript dialog is open on a page the action used, the cleanup budget pauses, because Chrome holds the replies to input that page was handling until the dialog closes. The budget restarts when the dialog closes, and the trace records `dialogWait`. A page that closes takes its input state with it: requests it leaves unanswered and steps that fail because its session ended are not cleanup failures, and the trace records `pageClosed`. Other failures on a closed page are still reported but block no input.

When only composition cancellation is unconfirmed, all other cleanup and outstanding replies have completed, and no managed key or mouse button remains held anywhere on the connection, the block covers only that composition's top-level page target: every attachment and cross-origin child frame of that page. Other known pages keep using the same connection and input queue. A held key or button counts as released after a managed release through any attachment of its page, or once that page closes. Closing the page clears its block after `Target.targetDestroyed`; detaching or reattaching a session, navigation, a renderer crash or destroying a child frame does not. The original action still reports failed cleanup; the composition may still be active, and text Chrome committed on blur stays in the document.

If page ownership cannot be established from target metadata and attachment ancestry, a composition cleanup failure still blocks the whole connection. While a page is blocked, managed input on a session of unknown ownership is refused too, so a new raw frame attachment cannot bypass the block. Unreleased keys/buttons, other release failures, drain timeouts and disconnection also block the whole connection: restore the target state and establish a new connection before continuing. Direct raw CDP input bypasses both managed hold tracking and these blocks.

To clear a page-level composition block without closing the target, await the failed action's `error.cleanup`, inspect and restore the page (including its child frames), then call `await browser.inputScope(session).recoverComposition()` or `createInputScope(session).recoverComposition()`. The call is your acknowledgement that the page is ready: it sends no CDP commands, cancels no composition and performs no DOM verification. If a composition may remain, cancel it with raw CDP and verify the resulting document first. Send an empty `Input.imeSetComposition` only while the focused editor has a collapsed selection, because without a composition Chrome deletes the selected text instead. Recovery uses the same input queue and returns `true` when it clears the page's block across all attachments/frames, or `false` if there is no block; other pages' blocks and the original failed cleanup report are unchanged. It refuses unknown or closed sessions, connection-wide blocks, managed keys/buttons held on that page, and a failure newer than the one present when it was called; holds and outstanding replies on other pages do not prevent it. A call made before cleanup ends cannot acknowledge the failure that cleanup records later.

```ts
import { InputActionError } from 'nodriver-ts';

try {
  await tab.keyboard.type('中文', { timeout: 1500, signal, cleanupTimeout: 5000 });
} catch (error) {
  if (!(error instanceof InputActionError)) throw error;
  console.log(error.cause, error.report); // input has stopped; cleanup can still be pending
  const cleanup = await error.cleanup;
  console.log(cleanup.status, cleanup.report); // final snapshot
}
```

The cleanup result describes managed releases and protocol replies. The application owns the final document state, and delivered input cannot be reversed. User callbacks should observe the supplied cancellation signal. Controllers retained after a scope ends reject further input.

## Pages that draw no frames

Chrome delivers pointer and key input to a page as the page draws frames, and answers an input command once the page has handled it. A page that draws no frames, such as one in a minimized window, holds input back, and the command stalls. When an input command of an action stays unanswered for `presentationRecovery` milliseconds (250 by default), the action sends one `Page.captureScreenshot`, which makes Chrome draw a frame. Chrome captures only top-level targets, so the request goes through a session attached to the command's top-level page: input to an out-of-process frame recovers through its page. A raw command that a scope callback sends on another connection recovers, and waits for dialogs, through the pages known on that connection. Each command gets at most one such request, and input is never sent again. Commands whose callers stopped waiting, because the action timed out or was cancelled, are recovered the same way, so that cleanup can drain them, and cleanup also waits for the screenshot. Nothing is requested while a JavaScript dialog is open on the page. `report.presentationRecoveries` counts the requests, and the trace records `presentationRecovery` for each. `presentationRecovery: false` turns this off.

## Explicit composition

Focus an editor before calling `keyboard.compose()`. Its callback receives one composition controller: `update(text, selection?, options?)` starts or updates the composition, `commit(text?, options?)` attempts one commit, and `cancel(options?)` cancels it. Selection offsets count UTF-16 code units within the update text and default to its end. Text must contain 1–100000 UTF-16 units; use `cancel()` for an empty composition.

```ts
await input.focus();
await tab.keyboard.compose(
  async (composition) => {
    await composition.update('中文');
    await composition.update('中文😀', { selectionStart: 2, selectionEnd: 4 });
    await composition.commit(); // commits the latest update text, at most once
  },
  { timeout: 2000, signal, cleanupTimeout: 5000 },
);
```

Updates use `Input.imeSetComposition` and commit uses `Input.insertText`. A callback that returns without commit or cancellation leaves cleanup to cancel the composition. Repeated `cancel()` is harmless; a second commit is rejected, even after an uncertain first commit.

Before each update and commit, the controller checks that the original element still has focus, through open and closed shadow roots and accessible iframe ancestors, and stops when the document changes. By default, cancellation also requires the original editor to keep focus. If focus leaves the editor or the document changes during a composition, cleanup sends no cancel, reports `failed`, and blocks later managed input as described above, on the composition's top-level page or on the whole connection. Chrome can commit text into the old editor on blur, or move the active composition to the new editor when focus moves during `compositionstart`. A composition can also end by itself while the editor keeps or regains focus, for example when focus leaves and comes back; the controller watches for this with listeners in its probe world, except for focus in a cross-origin frame. Because an empty update without a composition deletes the selected text, the cancel is then sent only over a collapsed selection; over a range selection no cancel is sent and cleanup reports `failed`.

Pass `{ forceCancel: true }` to `keyboard.compose()` or scope `run()` to send an empty `Input.imeSetComposition` at the session's current focus during explicit `cancel()` and automatic cleanup, even if focus or the document changed. This cancels a composition that followed focus into another editor, and may also cancel that editor's own composition. Once focus has left the original editor, the cancel is sent only if the current focus is an editor the probes can inspect and its selection is collapsed: without a composition, Chrome deletes the selected text on an empty update, and a composition interrupted by a later focus move has already been finished into the original editor. Otherwise no cancel is sent and cleanup fails as without `forceCancel`; this includes a range selection set by the last `update()` and focus in a cross-origin frame. Updates and commits still require the original focus and document, and a failed commit remains an interrupted action even when forced cleanup succeeds. An acknowledged cancel with otherwise successful cleanup leaves the page usable; a failed or unacknowledged cancel still blocks input and is not retried. No cancel is sent if the first update failed its focus checks before dispatch.

Focus checks and CDP input are separate operations, so callers should verify the resulting document. Runtime is not enabled and browser methods are not patched. Focus probes run in an isolated world that the library creates with `Page.createIsolatedWorld` and reuses while the document lives, so page scripts cannot replace the JavaScript primitives they use; focus and DOM effects remain observable. Pass `executionContextId` to `compose()` or `run()` to use your own context instead; pass an ID of the current document. The controller resolves that context's global object once, before the first update, and probes through that handle, so a newer document that reuses the numeric ID is never probed. The DOM domain is never enabled: closed shadow roots are inspected with `DOM.describeNode` and `DOM.resolveNode`, which do not enable it.

The first `update()` fails before any composition command unless the focus can take text: a text `input` (`text`, `search`, `url`, `tel`, `email`, `password` or `number`) or a `textarea` that is neither read-only nor disabled (including through a disabled fieldset), or contenteditable content, including `designMode` documents. The failure is an `InputActionError` whose `cause` is an `ActionabilityError`. The controller follows focus into open and closed shadow roots and same-origin frames, and checks contenteditable content by its editing host, because Chrome moves focus from a focusable descendant to the editing host when composition starts. Focus inside a cross-origin frame cannot be inspected from the parent session: its editability is unknown, composition proceeds, the report trace records `compositionFocusUnknown`, and focus changes inside that frame are not detected. Compose through the frame's own target session to get the full checks. Timeouts, disconnects and document changes still stop the action.

## Raw input scopes

`scope.position` returns a frozen, read-only `{ x, y }` snapshot of the last acknowledged move, in viewport CSS pixels. It includes moves acknowledged during cancellation cleanup: after an interrupted run, await `error.cleanup`, then read `scope.position`. Failed or unacknowledged moves do not update it. Before the first acknowledged move it returns the supplied `pointer`, or `(0, 0)` if omitted; a random starting point chosen for human motion is not an acknowledged position. It tracks only this scope's managed mouse moves, without querying Chrome, and old snapshots do not change. The same state supplies the next run's starting point.

The `sent` counters include raw input commands issued from the scope callback, including on another connection; they count transport dispatch, not merely a queued call.

`browser.inputScope(session)` or the exported `createInputScope(session, { policy?, mac?, pageEvents?, pointer? })` creates a reusable scope factory for a target session. Each `run()` supplies fresh mouse, keyboard and composition controllers, one deadline, the original guard and one final report. The pointer carries over: each run's mouse starts where Chrome last acknowledged the previous run's pointer, so a run sends no move just to put the pointer back. `pointer` gives the position for the first run, such as `tab.mouse.position` when the scope drives a tab's page; without it the first run starts as a new `Mouse` does, at (0, 0) or at a random viewport point in human mode. Sibling controller calls serialize, and held keys, buttons and compositions are cleaned up in reverse order before the connection queue changes owner. Explicit `up()` or `cancel()` releases a resource early. A click or drag cannot replace a button that is already held.

```ts
const session = await browser.attachSession(tab.id);
const scope = browser.inputScope(session);
await scope.run(
  async (input) => {
    await input.keyboard.down('Shift');
    await input.mouse.move(100, 100);
    await input.mouse.down();
    await input.mouse.move(220, 100);
    await input.wait(20);
    // mouse button, then Shift, are released automatically
  },
  { timeout: 1000, signal, cleanupTimeout: 5000 },
);
console.log(scope.position); // { x: 220, y: 100 }
```

By default raw scopes and `keyboard.compose()` send `Page.enable` so that navigation interrupts input; they never change target focus. Managed input is the only place where the library enables a domain on a raw session. The domain stays enabled on the caller's session after the run, and scope-owned listeners are removed. With `pageEvents: false` (an option of `inputScope()`, `createInputScope()` and `compose()`) no `*.enable` command is sent. Navigation then interrupts a run only if the Page domain is enabled on the session by other means; otherwise the run ends at its deadline, through your `signal` or when the session ends, and compositions still check focus and document before every step. Dialog events likewise arrive only through sessions with the Page domain enabled; without one, cleanup cannot wait for a dialog to close. `browser.inputScope()` selects macOS editing commands as Tab input does; `createInputScope()` defaults `mac` to false. Inside a scope, use `input.composition` rather than nesting `keyboard.compose()`.

The outer `run()` owns `cleanupTimeout`; child operations inherit it. A failed child operation ends the run, even if the callback catches its rejection. Mouse events within a scope carry the modifiers held by its keyboard.

## MCP

`browser_input_policy` sets a tab's policy, and actions such as `browser_click`, `browser_fill`, `browser_type`, `browser_press_key` and `browser_scroll` use the same input layer. Trajectories and rhythm change only if the caller enables human mode explicitly. `browser_handoff`, which asks a person to take over and confirm, is unrelated to the input policy.
