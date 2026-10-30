# Input policy, events and cancellation

[简体中文](zh-CN/input.md)

The default `instant` policy performs fast, deterministic actions. An explicit `tab.setInputPolicy({ mode: 'human', seed: 42 })` turns on continuous pointer trajectories, acceleration and deceleration, pauses, press/release intervals, scrolling in segments and per-character typing rhythm. This is a configurable, programmatic behaviour model. It is not equivalent to physical input and does not promise to pass detection.

```ts
tab.setInputPolicy({
  mode: 'human',
  seed: 42,
  moveDuration: [90, 220],
  moveSteps: [8, 18],
  pause: [0, 15],
  pressDelay: [25, 70],
  keyDelay: [35, 110],
  scrollSteps: [3, 8],
  targetInset: 0.2,
  typing: 'auto', // auto | keys | insertText; auto uses key events in human mode
  scroll: 'auto', // auto | wheel | dom; auto first wheels the element close to the viewport in human mode
});
const input = await tab.waitForSelector('input');
await input.fill('replace all');
await input.type('中文👨‍👩‍👧‍👦é'); // types at the current caret/selection; does not select all or submit
await input.type(['an explicit committed segment', '😀']);
await tab.keyboard.press('Control+A'); // select all is Meta+A on macOS
await tab.mouse.wheel(0, 420);
console.log(tab.inputBehavior.lastReport);
```

## Parameters

Times are in milliseconds, and each range is a minimum/maximum: step counts 1–120, times 0–3000, `targetInset` (the fraction of the visible target's edge to exclude) 0–0.45. An omitted seed is generated once, using Node crypto, when the Tab's input behavior is created. It is retained when human mode is first enabled, across actions, mode switches and configure calls that omit seed. Other omitted policy fields still reset to their defaults. An explicit seed (including the current seed) resets only that behavior's stream. The seed determines each tab's random sequence. The same starting point, layout, configuration and call sequence reproduce the same planned trajectory and delays, but actual scheduling, frame rate and event timestamps are not guaranteed to match to the millisecond. The policy never introduces typos, extra submits or random business actions, and the policy cannot be changed while an action is running.

`randomState` permits restarting the PRNG at an action boundary; seed alone requires the preceding random draws/action history. Reproducing an entire action also requires the same policy, layout, pointer/keyboard state and arguments. Without an explicit seed, separate runs use different random sequences.

## Text and keys

- **`fill()`**: replaces the whole value using focus, the selection and a single `Input.insertText`.
- **`type()`**: commits text at the current selection one grapheme at a time (Intl.Segmenter), and also accepts an array of string segments. Emoji surrogate pairs, ZWJ sequences and combining characters are never split. At most 100000 UTF-16 code units per call.
- **Key events**: with `typing: 'keys'`, or the default `auto` in human mode, typeable US-layout characters (letters, digits, common symbols, space) are sent one at a time as keyDown/keyUp, with Shift held for capitals and shifted symbols; keyUp carries the same key as keyDown. CJK, emoji, newlines and tabs use `insertText`. `typing: 'insertText'` uses `insertText` for everything.
- **`press()`**: supports named keys (Enter, Tab, Escape, arrow keys, Home/End, PageUp/PageDown, F1–F12, Space and more), modifier combinations and US-layout characters, for example `Shift+Tab` or `Control++`. While Shift is held, the shifted character is sent. `keyDefinition()` and `parseChord()` are exported.
- **macOS editing shortcuts**: when the browser runs on macOS, key events carry AppKit editing commands (CDP `commands`), so `Meta+A` selects all, `Meta+Z` undoes, `Alt+ArrowLeft` moves by word, `Control+A` moves to the start of the paragraph, and so on, as on a Mac keyboard. The platform is determined from the browser's own UA and is not affected by UA overrides.
- **`select()`**: changes the option through the DOM and dispatches synthetic input/change events; isTrusted is not rewritten. When pointer or key interaction is needed, the caller performs it explicitly.

Ordinary `type()` does not generate a composition lifecycle. Explicit CDP composition is available through `keyboard.compose()` and input scopes. Neither API simulates OS input-method candidate windows or non-US keyboard layouts.

## Pointer and clicks

A click first scrolls the element into the viewport, checks that it is visible, enabled and not obscured, and samples its position twice (32 ms apart) to confirm it is stable. After the trajectory ends, the target coordinates and the parent frame's hit-testing are checked again. If the position changed or the target is obscured, the press is refused; the click is never automatically repositioned or replayed.

In human mode the first pointer position is random within 15–85% of the viewport, and pressure is 0.5 while pressed and while moving with a button held. Hovering inside an OOPIF confirms that the event was actually delivered. Only when the pointer is already resting at the same coordinates is an extra 0.25px probe sent, and that probe itself produces observable events.

## Serialization and cancellation

Tab input, standalone `new Mouse(session)` / `new Keyboard(session)` and raw input scopes share one reentrant queue per `Connection`, with at most 128 waiting or running calls. Separate connections do not share a queue. Direct `Session.send()` / `sendWith()` calls bypass this input queue. Successful standalone `down()` calls keep their key or button held until `up()`; use a scope when several calls must retain ownership together. A scope automatically releases its held inputs in reverse acquisition order.

`InputOptions.timeout` is one input-stage budget, starting when the action is called, including queue time and preparation. It defaults to 10000 ms. Each input command receives the remaining time and combined cancellation signal through `sendWith()`. Element `click`, `hover`, `fill` and `type` include their preparation in the same budget. A nested scope operation may shorten that budget or add a signal/guard; it cannot extend the scope deadline or replace its guard.

Cancellation and deadlines reject promptly with `InputActionError`, preserving the cause. `error.report` captures the action when it stops; `error.cleanup` resolves to `{ status, report }` after cleanup, with status `completed`, `failed` or `disconnected`. Reports include `phase` (`queued`, `running`, `cleaning`, `done`), `cleanup`, acknowledged event/segment counts, seed, action-start `randomState`, a trace of up to 2000 entries, and cleanup errors. Input text is not stored. Commands whose callers stop waiting remain visible through the cleanup result and connection lifecycle.

`cleanupTimeout` defaults to 5000 ms and is independent of the input timeout and aborted signal. It bounds releases and late-response draining. The next managed input waits until cleanup completes. A failed release, cleanup timeout or disconnected connection blocks subsequent managed input on that connection with `InputBlockedError` as the cause; restore the target's state and establish a new connection before continuing. Input actions keep their original command results and do not resend commands. When draining is needed, it covers the whole connection, including unrelated pending raw commands.

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

## Explicit composition

Focus an editor before calling `keyboard.compose()`. Its callback receives one composition controller: `update(text, selection?, options?)` starts or updates composition, `commit(text?, options?)` attempts one commit, and `cancel(options?)` cancels it. Selection offsets count UTF-16 code units within the update text, defaulting to its end. Text must contain 1–100000 UTF-16 units; use `cancel()` for an empty composition.

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

Updates use `Input.imeSetComposition`; commit uses `Input.insertText`. Returning without commit or cancellation attempts cancellation during cleanup. Repeated `cancel()` is harmless; a second commit is rejected, including after an uncertain first commit. Normal `type()` retains its grapheme/key/insertText behavior.

Before each update and commit, the controller checks the original focused element, including open shadow roots and accessible iframe ancestors, and stops when the document changes. It sends commit and cancel commands only after the original editor is confirmed; cross-origin ancestors that cannot be inspected are left untouched. Focus checks and CDP input are separate operations, so callers can verify the resulting document. Runtime is not enabled and browser methods are not patched.

## Raw input scopes

`browser.inputScope(session)` or exported `createInputScope(session, { policy?, mac? })` creates a reusable scope factory for a target session. Each `run()` supplies fresh mouse, keyboard and composition controllers, one deadline, the original guard, and one final report. Sibling controller calls serialize, and held keys/buttons/composition are cleaned up in reverse order before the connection queue changes owner. Explicit `up()` or `cancel()` releases a resource early. A click/drag cannot replace an already held button.

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
```

Raw scopes enable Page events for navigation tracking without changing target focus. Domain enablement stays on the caller's session after the run, and scope-owned listeners are removed. `browser.inputScope()` derives macOS editing commands from the browser UA; `createInputScope()` defaults `mac` to false and accepts an explicit override. Use `input.composition` inside a scope rather than nesting `keyboard.compose()`.

The outer `run()` owns `cleanupTimeout`; child operations inherit it. A failed child operation ends the run, even if the callback catches that operation's rejection. Mouse events within a scope carry the modifiers held by its keyboard.

## MCP

`browser_input_policy` sets the policy of a tab, and actions such as `browser_click`, `browser_fill`, `browser_type`, `browser_press_key` and `browser_scroll` use the same input layer. Trajectories and rhythm change only if the caller enables human mode explicitly. `browser_handoff` asks a person to take over and confirm; it is unrelated to the input policy.
