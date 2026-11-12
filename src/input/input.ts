import type { Session } from '../protocol/connection.ts';
import type { Protocol } from 'devtools-protocol';
import {
  InputBehavior,
  inputCoordinator,
  type InputAction,
  type InputOptions,
  type InputReport,
} from './behavior.ts';
import { StaleElementError } from '../errors.ts';
import type { InputRelease } from './action.ts';
import { Composition, type CompositionOptions } from './composition.ts';
import { motionPlan, keyInterval, notchPlan, scrollPlan } from './human.ts';
export interface KeyboardTypeOptions extends InputOptions {
  /**
   * Awaited after each grapheme or explicit segment is acknowledged and its character key is
   * released, before the next segment is sent. `index` is zero-based within this type() call.
   * Disables overlapping presses; Shift may stay held for the next shifted character. Counts
   * against the action's deadline and signal. Throwing stops typing without replaying the segment.
   */
  onSegment?: (segment: string, index: number) => void | Promise<void>;
}
export interface ComposeOptions extends InputOptions, CompositionOptions {
  /**
   * false never sends Page.enable. Navigation then stops the action only if the Page domain is
   * enabled on the session by other means; otherwise it ends at its deadline, through your signal
   * or with the session. The composition still checks focus and document before every step.
   * Defaults to true.
   */
  pageEvents?: boolean;
}
function standalone(session: Session) {
  const coordinator = inputCoordinator(session.connection);
  const behavior = new InputBehavior(
    (task) => coordinator.run(task),
    () => {
      if (session.closed)
        throw new StaleElementError('Input target closed', { cause: session.closeReason });
    },
    undefined,
    async (action) => {
      action.watch(session);
    },
  );
  behavior.coordinator = coordinator;
  return behavior;
}
const buttonBits = new Map<Protocol.Input.MouseButton, number>([
  ['left', 1],
  ['right', 2],
  ['middle', 4],
  ['back', 8],
  ['forward', 16],
]);
/** A pressed button; its release repeats the press's click count. */
interface ButtonHold {
  button: Protocol.Input.MouseButton;
  clickCount: number;
}
/**
 * @internal Where Chrome last acknowledged the pointer. Mice that share one continue each other's
 * paths; `placed` is false until the position is known or chosen.
 */
export interface PointerState {
  x: number;
  y: number;
  placed: boolean;
}
export class Mouse {
  private hold?: ButtonHold;
  private readonly pointer: PointerState;
  private readonly sharedPointer: PointerState;
  readonly session: Session;
  readonly behavior: InputBehavior;
  private readonly scope?: InputAction;
  constructor(
    session: Session,
    behavior: InputBehavior = standalone(session),
    scope?: InputAction,
    pointer: PointerState = { x: 0, y: 0, placed: false },
  ) {
    this.session = session;
    this.behavior = behavior;
    this.scope = scope;
    this.pointer = { ...pointer };
    this.sharedPointer = pointer;
    behavior.coordinator ??= inputCoordinator(session.connection);
  }
  private action(
    name: string,
    options: InputOptions,
    task: (a: InputAction) => Promise<void>,
  ): Promise<InputReport> {
    return this.scope
      ? this.scope.perform(options, task)
      : this.behavior.action(name, options, task);
  }
  private get buttons(): number {
    return this.hold ? buttonBits.get(this.hold.button)! : 0;
  }
  get position() {
    return { x: this.pointer.x, y: this.pointer.y, buttons: this.buttons };
  }
  /** The point a move to (x, y) reports: on the pointer grid when the policy sets one. */
  private snap(x: number, y: number): { x: number; y: number } {
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new RangeError('Invalid pointer coordinates');
    const grid = this.behavior.policy.pointerGrid;
    if (!grid) return { x, y };
    const on = (value: number, phase = 0) =>
      phase + Math.round((value - phase) * grid.scale) / grid.scale;
    return { x: on(x, grid.phase?.x), y: on(y, grid.phase?.y) };
  }
  /** Whether the pointer rests at the point. */
  private at(point: { x: number; y: number }): boolean {
    return Math.hypot(point.x - this.pointer.x, point.y - this.pointer.y) < 0.01;
  }
  /** Human mode starts from a random viewport point rather than the (0,0) corner. */
  private async place(action: InputAction): Promise<void> {
    if (this.pointer.placed || this.behavior.policy.mode !== 'human') return;
    this.pointer.placed = true;
    const metrics = await action.send(this.session, 'Page.getLayoutMetrics');
    const v = metrics?.cssVisualViewport;
    if (!v?.clientWidth || !v.clientHeight) return;
    const start = this.snap(
      v.clientWidth * (0.15 + 0.7 * this.behavior.random()),
      v.clientHeight * (0.15 + 0.7 * this.behavior.random()),
    );
    this.pointer.x = start.x;
    this.pointer.y = start.y;
  }
  private async dispatch(x: number, y: number, action: InputAction) {
    const point = this.snap(x, y);
    await action.check({ type: 'move', ...point });
    await this.moveRaw(point, action);
  }
  /**
   * Moves to a planned sample. On a pointer grid, a sample that leaves the pointer where it is
   * sends nothing, as a device reports only motion.
   */
  private async sample(x: number, y: number, action: InputAction) {
    if (this.behavior.policy.pointerGrid && this.at(this.snap(x, y))) return;
    await this.dispatch(x, y, action);
  }
  /** Sends a move to a snapped point without checking; dispatch() checks first. */
  private async moveRaw(point: { x: number; y: number }, action: InputAction) {
    await action.sendAcknowledged(
      this.session,
      'Input.dispatchMouseEvent',
      () => {
        this.pointer.x = point.x;
        this.pointer.y = point.y;
        this.pointer.placed = true;
        Object.assign(this.sharedPointer, this.pointer);
      },
      {
        type: 'mouseMoved',
        ...point,
        buttons: this.buttons,
        modifiers: this.behavior.modifiers,
        // A pressure-less mouse reports 0.5 while any button is held (Pointer Events spec).
        ...(this.buttons ? { force: 0.5 } : {}),
      },
    );
    action.record('move', point);
  }
  /**
   * Moves along a planned path. Each sample is due at its planned time, and time spent waiting for
   * replies counts toward it. With `lateMoves: 'skip'`, a sample is dropped once the next one is
   * due as well; the last sample, and samples with a button held, are always sent.
   */
  private async path(x: number, y: number, action: InputAction, width?: number) {
    if (this.behavior.policy.mode === 'instant') return this.dispatch(x, y, action);
    // Rejects invalid coordinates before any input.
    this.snap(x, y);
    await this.place(action);
    const { policy } = this.behavior;
    const points = motionPlan(this.position, { x, y }, () => this.behavior.random(), {
      width,
      duration: policy.moveDuration !== undefined ? this.behavior.range('moveDuration') : undefined,
      steps: policy.moveSteps !== undefined ? this.behavior.range('moveSteps') : undefined,
      // An explicit duration or sample count is kept exactly, with no correction after it.
      overshoot:
        !this.buttons && policy.moveSteps === undefined && policy.moveDuration === undefined,
    });
    const skip = policy.lateMoves === 'skip' && !this.buttons;
    action.startPlan();
    for (const [i, point] of points.entries()) {
      await action.pace(point.delay);
      const next = points[i + 1];
      if (skip && next && action.overdue(next.delay)) action.report.skippedMoves++;
      else await this.sample(point.x, point.y, action);
    }
    await action.pace(this.behavior.range('pause'));
  }
  /**
   * Presses a button at the pointer. The release is registered first, so a failed press or a
   * guard that rejects the `mousePressed` checkpoint still releases the button.
   */
  private async press(
    action: InputAction,
    button: Protocol.Input.MouseButton,
    clickCount = 1,
  ): Promise<InputRelease> {
    if (!buttonBits.has(button)) throw new TypeError('A mouse button is required');
    const point = this.snap(this.pointer.x, this.pointer.y);
    await action.check({ type: 'mouseDown', button, ...point });
    if (this.hold) throw new Error('Mouse button is already held');
    this.hold = { button, clickCount };
    const release = this.release(action);
    try {
      await action.send(this.session, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...point,
        button,
        buttons: this.buttons,
        clickCount,
        force: 0.5,
        modifiers: this.behavior.modifiers,
      });
      action.record('down', point);
      await action.check({ type: 'mousePressed', button, ...point });
      return release;
    } catch (error) {
      await release.run();
      throw error;
    }
  }
  /** Releases the button held now, at the pointer; once that hold has ended, it does nothing. */
  private release(action: InputAction): InputRelease {
    const hold = this.hold;
    return action.release(
      async () => {
        if (!hold || this.hold !== hold) return;
        this.hold = undefined;
        const point = this.snap(this.pointer.x, this.pointer.y);
        await action.sendCleanup(this.session, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...point,
          button: hold.button,
          buttons: 0,
          clickCount: hold.clickCount,
          modifiers: this.behavior.modifiers,
        });
        action.record('up', point);
      },
      { session: this.session },
    );
  }
  move(x: number, y: number, options: InputOptions = {}): Promise<InputReport> {
    return this.action('move', options, (a) => this.path(x, y, a));
  }
  /**
   * @internal Moves the pointer to (x, y) so that the page sees it arrive there: a pointer already
   * resting at that point first moves aside by the smallest step it can make.
   */
  reach(x: number, y: number, options: InputOptions = {}): Promise<InputReport> {
    return this.action('move', options, async (action) => {
      if (this.at(this.snap(x, y))) {
        const grid = this.behavior.policy.pointerGrid;
        await this.path(x + (grid ? 1 / grid.scale : 0.25), y, action);
      }
      await this.path(x, y, action);
    });
  }
  down(
    button: Protocol.Input.MouseButton = 'left',
    options: InputOptions = {},
  ): Promise<InputReport> {
    return this.action('mouseDown', options, async (action) => {
      const release = await this.press(action, button);
      if (!this.scope) action.retain(release);
    });
  }
  up(options: InputOptions = {}): Promise<InputReport> {
    return this.action('mouseUp', options, (action) => this.release(action).run());
  }
  async click(
    x: number,
    y: number,
    options: InputOptions & {
      button?: Protocol.Input.MouseButton;
      clickCount?: number;
      /** @internal Root viewport target width for motion planning. */
      targetWidth?: number;
      /** @internal Confirm that a small held-pointer move remains on the target. */
      beforeSlip?: (x: number, y: number) => Promise<boolean>;
    } = {},
  ): Promise<InputReport> {
    return this.action('click', options, async (action) => {
      if (this.hold) throw new Error('Cannot click while a mouse button is held');
      await this.path(x, y, action, options.targetWidth);
      const release = await this.press(action, options.button ?? 'left', options.clickCount ?? 1);
      try {
        if (this.behavior.policy.mode === 'human') {
          const hold = this.behavior.range('pressDelay');
          await action.pace(hold / 2);
          if (this.behavior.random() < 0.18) {
            const angle = this.behavior.random() * Math.PI * 2;
            const slip = this.snap(
              this.pointer.x + Math.cos(angle),
              this.pointer.y + Math.sin(angle),
            );
            if (
              !this.at(slip) &&
              (!options.beforeSlip || (await action.waitFor(options.beforeSlip(slip.x, slip.y))))
            ) {
              // A guard that refuses the slip stops the action like any other checkpoint.
              await action.check({ type: 'move', ...slip });
              // The press has been delivered: a slip that fails to send is skipped, and a
              // stopped action still ends at the next wait.
              await this.moveRaw(slip, action).catch(() => {});
            }
          }
          await action.pace(hold / 2);
        }
      } finally {
        await release.run();
      }
    });
  }
  wheel(
    deltaX: number,
    deltaY: number,
    options: InputOptions & {
      /** @internal No packet is sent after this performance.now() time; the caller scrolls on. */
      until?: number;
    } = {},
  ): Promise<InputReport> {
    return this.action('scroll', options, async (action) => {
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY))
        throw new RangeError('Invalid scroll delta');
      await this.place(action);
      const human = this.behavior.policy.mode === 'human';
      const { wheelProfile: profile, wheelNotch: notch, scrollSteps } = this.behavior.policy;
      const packets = !human
        ? [{ deltaX, deltaY, delay: 0 }]
        : notch !== undefined
          ? notchPlan(deltaX, deltaY, notch)
          : scrollPlan(
              deltaX,
              deltaY,
              scrollSteps !== undefined
                ? this.behavior.range('scrollSteps')
                : Math.max(
                    1,
                    Math.min(
                      120,
                      Math.ceil(Math.hypot(deltaX, deltaY) / (profile === 'wheel' ? 100 : 18)),
                    ),
                  ),
              profile,
            );
      const { until = Infinity } = options;
      for (const packet of packets) {
        if (performance.now() >= until) break;
        const point = this.snap(this.pointer.x, this.pointer.y);
        await action.check({ type: 'wheel', ...point });
        // An async guard can outlast the limit.
        if (performance.now() >= until) break;
        await action.send(this.session, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          ...point,
          deltaX: packet.deltaX,
          deltaY: packet.deltaY,
          buttons: this.buttons,
          modifiers: this.behavior.modifiers,
        });
        action.record('wheel', point);
        if (human) await action.pace(packet.delay + this.behavior.range('pause'), until);
      }
    });
  }
  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 10,
    options: InputOptions = {},
  ): Promise<InputReport> {
    if (!Number.isInteger(steps) || steps < 1)
      throw new RangeError('steps must be a positive integer');
    return this.action('drag', options, async (action) => {
      if (this.hold) throw new Error('Cannot drag while a mouse button is held');
      await this.path(from.x, from.y, action);
      const release = await this.press(action, 'left');
      try {
        for (let i = 1; i <= steps; i++) {
          await this.sample(
            from.x + ((to.x - from.x) * i) / steps,
            from.y + ((to.y - from.y) * i) / steps,
            action,
          );
          if (this.behavior.policy.mode === 'human')
            await action.pace(this.behavior.range('pause') + 10);
        }
      } finally {
        await release.run();
      }
    });
  }
}
/** A physical key of a US keyboard, as its key events describe it. */
export interface KeyDefinition {
  code: string;
  /** windowsVirtualKeyCode, which becomes KeyboardEvent.keyCode. */
  keyCode: number;
  key: string;
  /** The key value while Shift is held. */
  shiftKey?: string;
  text?: string;
  /** KeyboardEvent.location: 1 for left, 2 for right and 3 for numpad keys; absent otherwise. */
  location?: 1 | 2 | 3;
}
const named: Record<string, KeyDefinition> = {
  Enter: { code: 'Enter', keyCode: 13, key: 'Enter', text: '\r' },
  Tab: { code: 'Tab', keyCode: 9, key: 'Tab' },
  Escape: { code: 'Escape', keyCode: 27, key: 'Escape' },
  Backspace: { code: 'Backspace', keyCode: 8, key: 'Backspace' },
  Delete: { code: 'Delete', keyCode: 46, key: 'Delete' },
  Insert: { code: 'Insert', keyCode: 45, key: 'Insert' },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37, key: 'ArrowLeft' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38, key: 'ArrowUp' },
  ArrowRight: { code: 'ArrowRight', keyCode: 39, key: 'ArrowRight' },
  ArrowDown: { code: 'ArrowDown', keyCode: 40, key: 'ArrowDown' },
  Home: { code: 'Home', keyCode: 36, key: 'Home' },
  End: { code: 'End', keyCode: 35, key: 'End' },
  PageUp: { code: 'PageUp', keyCode: 33, key: 'PageUp' },
  PageDown: { code: 'PageDown', keyCode: 34, key: 'PageDown' },
  Space: { code: 'Space', keyCode: 32, key: ' ', text: ' ' },
  NumpadEnter: { code: 'NumpadEnter', keyCode: 13, key: 'Enter', text: '\r', location: 3 },
};
for (const [modifier, left, right] of [
  ['Shift', 16, 16],
  ['Control', 17, 17],
  ['Alt', 18, 18],
  ['Meta', 91, 92],
] as const) {
  named[`${modifier}Left`] = { code: `${modifier}Left`, keyCode: left, key: modifier, location: 1 };
  named[`${modifier}Right`] = {
    code: `${modifier}Right`,
    keyCode: right,
    key: modifier,
    location: 2,
  };
  // A modifier named without a side is the left one.
  named[modifier] = named[`${modifier}Left`]!;
}
for (let n = 1; n <= 12; n++) named[`F${n}`] = { code: `F${n}`, keyCode: 111 + n, key: `F${n}` };
// Numpad keys type as with Num Lock on.
for (let n = 0; n <= 9; n++)
  named[`Numpad${n}`] = {
    code: `Numpad${n}`,
    keyCode: 96 + n,
    key: `${n}`,
    text: `${n}`,
    location: 3,
  };
for (const [code, keyCode, key] of [
  ['NumpadMultiply', 106, '*'],
  ['NumpadAdd', 107, '+'],
  ['NumpadSubtract', 109, '-'],
  ['NumpadDecimal', 110, '.'],
  ['NumpadDivide', 111, '/'],
] as const)
  named[code] = { code, keyCode, key, text: key, location: 3 };
/** US-QWERTY printable keys as [code, keyCode, unshifted, shifted]. */
const printable: Array<[string, number, string, string]> = [
  ['Backquote', 192, '`', '~'],
  ['Minus', 189, '-', '_'],
  ['Equal', 187, '=', '+'],
  ['BracketLeft', 219, '[', '{'],
  ['BracketRight', 221, ']', '}'],
  ['Backslash', 220, '\\', '|'],
  ['Semicolon', 186, ';', ':'],
  ['Quote', 222, "'", '"'],
  ['Comma', 188, ',', '<'],
  ['Period', 190, '.', '>'],
  ['Slash', 191, '/', '?'],
];
for (let i = 0; i < 10; i++) printable.push([`Digit${i}`, 48 + i, `${i}`, ')!@#$%^&*('[i]!]);
for (const c of 'abcdefghijklmnopqrstuvwxyz') {
  const upper = c.toUpperCase();
  printable.push([`Key${upper}`, upper.charCodeAt(0), c, upper]);
}
const characters = new Map<string, { definition: KeyDefinition; shift: boolean }>();
for (const [code, keyCode, key, shiftKey] of printable) {
  const definition = { code, keyCode, key, shiftKey, text: key };
  characters.set(key, { definition, shift: false });
  characters.set(shiftKey, { definition, shift: true });
}
characters.set(' ', { definition: named.Space!, shift: false });
/** CDP modifier bits by the key value of a modifier key, in the order shortcuts name them. */
const modifierBits = new Map([
  ['Shift', 8],
  ['Control', 2],
  ['Alt', 1],
  ['Meta', 4],
]);
/**
 * Chrome on macOS runs editing shortcuts through AppKit key bindings, which synthetic key events
 * skip; CDP carries them as `commands`. Keys are modifiers (Shift, Control, Alt, Meta order) plus
 * the key code. Insert commands are omitted because the key event itself inserts text.
 */
const macCommands: Record<string, string[]> = {};
for (const [shortcuts, commands] of [
  ['Backspace Shift+Backspace Control+KeyH', 'deleteBackward'],
  ['Delete Shift+Delete Control+KeyD', 'deleteForward'],
  ['Alt+Backspace', 'deleteWordBackward'],
  ['Alt+Delete', 'deleteWordForward'],
  ['Meta+Backspace', 'deleteToBeginningOfLine'],
  ['Control+KeyK', 'deleteToEndOfParagraph'],
  ['Escape', 'cancelOperation'],
  ['ArrowUp Control+KeyP', 'moveUp'],
  ['ArrowDown Control+KeyN', 'moveDown'],
  ['ArrowLeft Control+KeyB', 'moveLeft'],
  ['ArrowRight Control+KeyF', 'moveRight'],
  ['Shift+ArrowUp Shift+Control+KeyP', 'moveUpAndModifySelection'],
  ['Shift+ArrowDown Shift+Control+KeyN', 'moveDownAndModifySelection'],
  ['Shift+ArrowLeft Shift+Control+KeyB', 'moveLeftAndModifySelection'],
  ['Shift+ArrowRight Shift+Control+KeyF', 'moveRightAndModifySelection'],
  ['Alt+ArrowLeft', 'moveWordLeft'],
  ['Alt+ArrowRight', 'moveWordRight'],
  ['Shift+Alt+ArrowLeft', 'moveWordLeftAndModifySelection'],
  ['Shift+Alt+ArrowRight', 'moveWordRightAndModifySelection'],
  ['Alt+ArrowUp', 'moveBackward moveToBeginningOfParagraph'],
  ['Alt+ArrowDown', 'moveForward moveToEndOfParagraph'],
  ['Shift+Alt+ArrowUp', 'moveParagraphBackwardAndModifySelection'],
  ['Shift+Alt+ArrowDown', 'moveParagraphForwardAndModifySelection'],
  ['Control+KeyA', 'moveToBeginningOfParagraph'],
  ['Control+KeyE', 'moveToEndOfParagraph'],
  ['Shift+Control+KeyA', 'moveToBeginningOfParagraphAndModifySelection'],
  ['Shift+Control+KeyE', 'moveToEndOfParagraphAndModifySelection'],
  ['Meta+ArrowLeft Control+ArrowLeft', 'moveToLeftEndOfLine'],
  ['Meta+ArrowRight Control+ArrowRight', 'moveToRightEndOfLine'],
  ['Shift+Meta+ArrowLeft Shift+Control+ArrowLeft', 'moveToLeftEndOfLineAndModifySelection'],
  ['Shift+Meta+ArrowRight Shift+Control+ArrowRight', 'moveToRightEndOfLineAndModifySelection'],
  ['Meta+ArrowUp', 'moveToBeginningOfDocument'],
  ['Meta+ArrowDown', 'moveToEndOfDocument'],
  ['Shift+Meta+ArrowUp Shift+Home', 'moveToBeginningOfDocumentAndModifySelection'],
  ['Shift+Meta+ArrowDown Shift+End', 'moveToEndOfDocumentAndModifySelection'],
  ['Home', 'scrollToBeginningOfDocument'],
  ['End', 'scrollToEndOfDocument'],
  ['PageUp Control+ArrowUp', 'scrollPageUp'],
  ['PageDown Control+ArrowDown', 'scrollPageDown'],
  ['Shift+PageUp', 'pageUpAndModifySelection'],
  ['Shift+PageDown', 'pageDownAndModifySelection'],
  ['Control+KeyT', 'transpose'],
  ['Control+KeyY', 'yank'],
  ['Meta+KeyA', 'selectAll'],
  ['Meta+KeyC', 'copy'],
  ['Meta+KeyX', 'cut'],
  ['Meta+KeyV', 'paste'],
  ['Meta+KeyZ', 'undo'],
  ['Shift+Meta+KeyZ', 'redo'],
] as const)
  for (const shortcut of shortcuts.split(' ')) macCommands[shortcut] = commands.split(' ');
/** Lowercase digraphs whose presses human typing can overlap. */
const ROLLOVER = new Set(['th', 'he', 'in', 'er']);
/** Resolves a named key or a US-layout character to its CDP key definition. */
export function keyDefinition(key: string): KeyDefinition {
  // Own keys only: "toString" or "__proto__" must not resolve through Object.prototype.
  const definition =
    (Object.hasOwn(named, key) ? named[key] : undefined) ?? characters.get(key)?.definition;
  if (!definition)
    throw new TypeError(`Unsupported physical key ${key}; use insertText() for Unicode`);
  return definition;
}
/** Splits "Control+Shift+a" style chords; a trailing "+" key is written as "Shift++". */
export function parseChord(chord: string): string[] {
  if (chord === '+') return ['+'];
  if (chord.endsWith('++')) return [...chord.slice(0, -2).split('+'), '+'];
  return chord.split('+');
}
/** A key held down, as its keydown described it; its keyup repeats the description. */
interface KeyHold {
  /** The name the key was pressed with. */
  name: string;
  definition: KeyDefinition;
  /** The DOM key value. */
  key: string;
}
export class Keyboard {
  compose(
    task: (composition: Composition) => Promise<void>,
    options: ComposeOptions = {},
  ): Promise<InputReport> {
    if (this.scope) throw new Error('Use the scope composition controller inside an input scope');
    return this.behavior.action('composition', options, async (action) => {
      if (options.pageEvents !== false) await action.send(this.session, 'Page.enable');
      await action.waitFor(task(new Composition(this.session, action, options)));
    });
  }
  /** Held keys by physical code. */
  private held = new Map<string, KeyHold>();
  readonly session: Session;
  readonly behavior: InputBehavior;
  readonly mac: boolean;
  private readonly scope?: InputAction;
  /** `mac` attaches macOS editing commands to key events; Tab sets it from the browser's platform. */
  constructor(
    session: Session,
    behavior: InputBehavior = standalone(session),
    mac = false,
    scope?: InputAction,
  ) {
    this.session = session;
    this.behavior = behavior;
    this.mac = mac;
    this.scope = scope;
    behavior.coordinator ??= inputCoordinator(session.connection);
  }
  private action(
    name: string,
    options: InputOptions,
    task: (a: InputAction) => Promise<void>,
  ): Promise<InputReport> {
    return this.scope
      ? this.scope.perform(options, task)
      : this.behavior.action(name, options, task);
  }
  get pressedKeys(): string[] {
    return [...this.held.values()].map((hold) => hold.name);
  }
  private get modifiers(): number {
    let result = 0;
    for (const { definition } of this.held.values())
      result |= modifierBits.get(definition.key) ?? 0;
    return result;
  }
  /** A key event for the key; keydown, char and keyup describe it alike. */
  private event(
    type: 'rawKeyDown' | 'char' | 'keyUp',
    hold: Pick<KeyHold, 'definition' | 'key'>,
  ): Protocol.Input.DispatchKeyEventRequest {
    const { code, keyCode, location } = hold.definition;
    return {
      type,
      key: hold.key,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers: this.modifiers,
      // Chrome takes a numpad location from isKeypad, and left or right from location.
      ...(location === 3 ? { isKeypad: true } : location && { location }),
    };
  }
  private async insertRaw(text: string, action: InputAction): Promise<void> {
    await action.check({ type: 'text' });
    await action.send(this.session, 'Input.insertText', { text });
  }
  insertText(text: string, options: InputOptions = {}): Promise<InputReport> {
    return this.action('insertText', options, async (action) => {
      await this.insertRaw(text, action);
      action.report.completedSegments++;
      action.record('insertText');
    });
  }
  async down(key: string, options: InputOptions = {}): Promise<void> {
    await this.action('keyDown', options, async (action) => {
      const release = await this.keyDown(key, action);
      if (!this.scope) action.retain(release);
    });
  }
  /**
   * Presses a key: rawKeyDown, then its character unless a modifier other than Shift is held. The
   * release is registered first, so a failed send or a guard that rejects the `char` checkpoint
   * still releases the key. A key that is already held repeats.
   */
  private async keyDown(name: string, action: InputAction): Promise<InputRelease> {
    const definition = keyDefinition(name);
    await action.check({ type: 'keyDown', key: name, code: definition.code });
    const repeat = this.held.get(definition.code);
    const character = characters.has(name);
    // A repeat keeps the hold, and with it the release, but describes the key as the modifiers
    // held now do.
    const hold = repeat ?? { name, definition, key: '' };
    // A held Shift yields the shifted character, as on a physical US keyboard.
    hold.key =
      this.modifiers & 8 && definition.shiftKey !== undefined
        ? definition.shiftKey
        : character
          ? name
          : definition.key;
    this.held.set(definition.code, hold);
    this.behavior.modifiers = this.modifiers;
    const release = this.release(name, action);
    const text =
      !(this.modifiers & ~8) && definition.text !== undefined
        ? character
          ? hold.key
          : definition.text
        : undefined;
    const shortcut = [...modifierBits]
      .filter(([, bit]) => this.modifiers & bit)
      .map(([modifier]) => modifier)
      .concat(definition.code)
      .join('+');
    const commands =
      this.mac && Object.hasOwn(macCommands, shortcut) ? macCommands[shortcut] : undefined;
    try {
      await action.send(this.session, 'Input.dispatchKeyEvent', {
        ...this.event('rawKeyDown', hold),
        autoRepeat: !!repeat,
        ...(commands && { commands }),
      });
      action.record('keyDown');
      if (text !== undefined) {
        await action.check({ type: 'char', key: name, code: definition.code });
        await action.send(this.session, 'Input.dispatchKeyEvent', {
          ...this.event('char', hold),
          autoRepeat: !!repeat,
          text,
          unmodifiedText: text,
        });
      }
      return release;
    } catch (error) {
      await release.run();
      throw error;
    }
  }
  /**
   * Releases the key held now under the name's code; once that hold has ended, it does nothing. A
   * key this keyboard does not hold is released as well, such as one held through another
   * attachment of the page.
   */
  private release(name: string, action: InputAction): InputRelease {
    const definition = keyDefinition(name);
    const hold = this.held.get(definition.code);
    return action.release(
      async () => {
        if (this.held.get(definition.code) !== hold) return;
        this.held.delete(definition.code);
        this.behavior.modifiers = this.modifiers;
        await action.sendCleanup(
          this.session,
          'Input.dispatchKeyEvent',
          this.event(
            'keyUp',
            hold ?? { definition, key: characters.has(name) ? name : definition.key },
          ),
        );
        action.record('keyUp');
      },
      { session: this.session },
    );
  }
  async up(key: string, options: InputOptions = {}): Promise<void> {
    await this.action('keyUp', options, (action) => this.release(key, action).run());
  }
  press(chord: string, options: InputOptions = {}): Promise<InputReport> {
    return this.action('key', options, async (action) => {
      const items = parseChord(chord);
      for (const key of items) keyDefinition(key);
      const down: InputRelease[] = [];
      try {
        for (const key of items) {
          if (this.held.has(keyDefinition(key).code)) throw new Error(`Key ${key} is already held`);
          down.push(await this.keyDown(key, action));
          if (this.behavior.policy.mode === 'human')
            await action.pace(this.behavior.range('pressDelay'));
        }
      } finally {
        for (const release of down.reverse()) await release.run();
      }
    });
  }
  /** Presses one US-layout character; type() owns any Shift shared with adjacent segments. */
  private async typeKey(char: string, action: InputAction): Promise<void> {
    const { definition } = characters.get(char)!;
    if (this.held.has(definition.code)) throw new Error('Cannot type a key that is already held');
    const release = await this.keyDown(char, action);
    try {
      if (this.behavior.policy.mode === 'human')
        await action.pace(this.behavior.range('pressDelay'));
    } finally {
      await release.run();
    }
  }
  /** Types two letters with overlapping presses: the second goes down before the first comes up. */
  private async rollover(first: string, second: string, action: InputAction): Promise<void> {
    const firstRelease = await this.keyDown(first, action);
    let secondRelease: InputRelease | undefined;
    try {
      await action.pace(this.behavior.range('pressDelay'));
      secondRelease = await this.keyDown(second, action);
      await action.pace(5 + this.behavior.random() * 7);
      await firstRelease.run();
      action.report.completedSegments++;
      await action.pace(this.behavior.range('pressDelay'));
    } finally {
      await secondRelease?.run();
      await firstRelease.run();
    }
    action.report.completedSegments++;
  }
  private get typesKeys(): boolean {
    const { typing, mode } = this.behavior.policy;
    return typing === 'keys' || (typing === 'auto' && mode === 'human');
  }
  /**
   * Types whole graphemes or explicit commit segments. With physical-key typing (the human-mode
   * default) US-layout characters use key events; anything else, including line breaks and
   * tabs, uses Input.insertText. Consecutive shifted characters share Shift, including across
   * awaited onSegment callbacks. Neither path is native IME composition.
   */
  type(text: string | string[], options: KeyboardTypeOptions = {}): Promise<InputReport> {
    if ((typeof text === 'string' ? text.length : text.reduce((n, s) => n + s.length, 0)) > 100000)
      throw new RangeError('Text input exceeds 100000 UTF-16 units');
    const segments =
      typeof text === 'string'
        ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
            (s) => s.segment,
          )
        : [...text];
    const { onSegment } = options;
    return this.action('type', options, async (action) => {
      const human = this.behavior.policy.mode === 'human';
      let shiftRelease: InputRelease | undefined;
      const pause = async (previous: string, next: string) => {
        if (human)
          await action.pace(
            keyInterval(
              () => this.behavior.random(),
              this.behavior.policy.keyDelay,
              previous,
              next,
            ),
          );
      };
      try {
        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i]!;
          const next = segments[i + 1];
          const keys = this.typesKeys && !(this.modifiers & ~8);
          // A segment callback must read this segment before any of the next one's input.
          if (
            !onSegment &&
            keys &&
            human &&
            this.held.size === 0 &&
            segment.length === 1 &&
            next?.length === 1 &&
            ROLLOVER.has(segment + next) &&
            this.behavior.random() < 0.15
          ) {
            await this.rollover(segment, next, action);
            i++;
            await pause(next, segments[i + 1] ?? '');
            continue;
          }
          const character = characters.get(segment);
          // A caller-held Shift would change an unshifted character; preserve the requested text.
          if (keys && character && (character.shift || !(this.modifiers & 8))) {
            if (character.shift && !(this.modifiers & 8)) {
              if (this.held.has(character.definition.code))
                throw new Error('Cannot type a key that is already held');
              shiftRelease = await this.keyDown('Shift', action);
              if (human) await action.pace(this.behavior.range('pressDelay') / 2);
            }
            await this.typeKey(segment, action);
          } else {
            await this.insertRaw(segment, action);
            action.record('insertText');
          }
          // Release only the Shift this call owns, before an unshifted segment or the last callback.
          if (shiftRelease && !characters.get(next ?? '')?.shift) {
            await shiftRelease.run();
            shiftRelease = undefined;
          }
          action.report.completedSegments++;
          if (onSegment)
            await action.waitFor(
              Promise.resolve().then(() => {
                action.step();
                return onSegment(segment, i);
              }),
            );
          await pause(segment, next ?? '');
        }
      } finally {
        await shiftRelease?.run();
      }
    });
  }
}
