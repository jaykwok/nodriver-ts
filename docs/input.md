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

OS input-method candidate windows, the composition lifecycle and non-US keyboard layouts are not simulated.

## Pointer and clicks

A click first scrolls the element into the viewport, checks that it is visible, enabled and not obscured, and samples its position twice (32 ms apart) to confirm it is stable. After the trajectory ends, the target coordinates and the parent frame's hit-testing are checked again. If the position changed or the target is obscured, the press is refused; the click is never automatically repositioned or replayed.

In human mode the first pointer position is random within 15–85% of the viewport, and pressure is 0.5 while pressed and while moving with a button held. Hovering inside an OOPIF confirms that the event was actually delivered. Only when the pointer is already resting at the same coordinates is an extra 0.25px probe sent, and that probe itself produces observable events.

## Serialization and cancellation

Within one browser, high-level input and the public mouse/keyboard methods share one reentrant serial channel (at most 128 waiting or running calls), so input from different tabs or leases never fights over focus. The low-level `down`/`up` can be combined into custom actions; scheduling between two independent calls is the caller's responsibility. The high-level `press`/`click`/`drag` release the keys or buttons they pressed in `finally`. Do not hold a modifier key down during long waits.

Mouse and keyboard actions return an `InputReport`: the event count, the number of committed segments, the seed and action-start `randomState`, a planned trace of up to 2000 entries and cleanup errors. Input text is not recorded. Cancellation, a deadline, navigation, document invalidation or loss of focus stops step-by-step input, and `InputActionError.report` describes what was completed (MCP returns `partialInput`). Clicks, input or scrolling already delivered to the browser are neither rolled back nor replayed. `finally` tries to release the buttons and keys held by the current action; if the connection is already gone, remote release cannot be guaranteed, and `cleanupErrors` records this. Cancellation does not let the next write operation start while the current one is still finishing.

## MCP

`browser_input_policy` sets the policy of a tab, and actions such as `browser_click`, `browser_fill`, `browser_type`, `browser_press_key` and `browser_scroll` use the same input layer. Trajectories and rhythm change only if the caller enables human mode explicitly. `browser_handoff` asks a person to take over and confirm; it is unrelated to the input policy.
