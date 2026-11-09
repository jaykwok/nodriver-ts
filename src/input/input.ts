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
import { motionPlan, keyInterval, scrollPlan } from './human.ts';
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
export class Mouse {
  private held?: { button: Protocol.Input.MouseButton; release: InputRelease };
  private x = 0;
  private y = 0;
  private buttons = 0;
  private placed = false;
  readonly session: Session;
  readonly behavior: InputBehavior;
  private readonly scope?: InputAction;
  constructor(
    session: Session,
    behavior: InputBehavior = standalone(session),
    scope?: InputAction,
  ) {
    this.session = session;
    this.behavior = behavior;
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
  get position() {
    return { x: this.x, y: this.y, buttons: this.buttons };
  }
  /** Human mode starts from a random viewport point rather than the (0,0) corner. */
  private async place(action: InputAction): Promise<void> {
    if (this.placed || this.behavior.policy.mode !== 'human') return;
    this.placed = true;
    const metrics = await action.send(this.session, 'Page.getLayoutMetrics');
    const v = metrics?.cssVisualViewport;
    if (!v?.clientWidth || !v.clientHeight) return;
    this.x = v.clientWidth * (0.15 + 0.7 * this.behavior.random());
    this.y = v.clientHeight * (0.15 + 0.7 * this.behavior.random());
  }
  private async dispatch(x: number, y: number, action: InputAction) {
    await action.check();
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new RangeError('Invalid pointer coordinates');
    await action.send(this.session, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      buttons: this.buttons,
      modifiers: this.behavior.modifiers,
      // A pressure-less mouse reports 0.5 while any button is held (Pointer Events spec).
      ...(this.buttons ? { force: 0.5 } : {}),
    });
    this.x = x;
    this.y = y;
    this.placed = true;
    action.record('move', { x, y });
  }
  private async path(x: number, y: number, action: InputAction, width?: number) {
    if (this.behavior.policy.mode === 'instant') return this.dispatch(x, y, action);
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new RangeError('Invalid pointer coordinates');
    await this.place(action);
    for (const point of motionPlan(this.position, { x, y }, () => this.behavior.random(), {
      width,
      duration:
        this.behavior.policy.moveDuration !== undefined
          ? this.behavior.range('moveDuration')
          : undefined,
      steps:
        this.behavior.policy.moveSteps !== undefined ? this.behavior.range('moveSteps') : undefined,
      // An explicit duration or sample count is kept exactly, with no correction after it.
      overshoot:
        !this.buttons &&
        this.behavior.policy.moveSteps === undefined &&
        this.behavior.policy.moveDuration === undefined,
    })) {
      await action.wait(point.delay);
      await this.dispatch(point.x, point.y, action);
    }
    await action.wait(this.behavior.range('pause'));
  }
  move(x: number, y: number, options: InputOptions = {}): Promise<InputReport> {
    return this.action('move', options, (a) => this.path(x, y, a));
  }
  down(
    button: Protocol.Input.MouseButton = 'left',
    options: InputOptions = {},
  ): Promise<InputReport> {
    return this.action('mouseDown', options, async (action) => {
      await action.check();
      if (this.buttons) throw new Error('Mouse button is already held');
      const bits = { none: 0, left: 1, right: 2, middle: 4, back: 8, forward: 16 };
      if (!bits[button]) throw new TypeError('A mouse button is required');
      const release = action.release(
        async () => {
          this.buttons = 0;
          this.held = undefined;
          await action.sendCleanup(this.session, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: this.x,
            y: this.y,
            button,
            buttons: 0,
            clickCount: 1,
            modifiers: this.behavior.modifiers,
          });
          action.record('up', this.position);
        },
        { session: this.session },
      );
      this.buttons = bits[button];
      this.held = { button, release };
      await action.send(this.session, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: this.x,
        y: this.y,
        button,
        buttons: this.buttons,
        clickCount: 1,
        force: 0.5,
        modifiers: this.behavior.modifiers,
      });
      action.record('down', this.position);
      if (!this.scope) action.retain(release);
    });
  }
  up(options: InputOptions = {}): Promise<InputReport> {
    return this.action('mouseUp', options, async (action) => {
      await action.check();
      if (!this.held) return;
      if (this.scope) await this.held.release.run();
      else {
        const button = this.held.button;
        const release = action.release(
          async () => {
            this.buttons = 0;
            this.held = undefined;
            await action.sendCleanup(this.session, 'Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: this.x,
              y: this.y,
              button,
              buttons: 0,
              clickCount: 1,
              modifiers: this.behavior.modifiers,
            });
            action.record('up', this.position);
          },
          { session: this.session },
        );
        await release.run();
      }
    });
  }
  async click(
    x: number,
    y: number,
    options: InputOptions & {
      button?: Protocol.Input.MouseButton;
      clickCount?: number;
      beforePress?: () => Promise<void>;
      /** @internal Root viewport target width for motion planning. */
      targetWidth?: number;
      /** @internal Confirm that a small held-pointer move remains on the target. */
      beforeSlip?: (x: number, y: number) => Promise<boolean>;
    } = {},
  ): Promise<InputReport> {
    return this.action('click', options, async (action) => {
      if (this.buttons) throw new Error('Cannot click while a mouse button is held');
      await this.path(x, y, action, options.targetWidth);
      if (options.beforePress) await action.waitFor(options.beforePress());
      await action.check();
      const params = {
        x,
        y,
        button: options.button ?? 'left',
        clickCount: options.clickCount ?? 1,
      };
      const release = action.release(
        async () => {
          this.buttons = 0;
          await action.sendCleanup(this.session, 'Input.dispatchMouseEvent', {
            ...params,
            x: this.x,
            y: this.y,
            type: 'mouseReleased',
            buttons: 0,
            modifiers: this.behavior.modifiers,
          });
          action.record('up', { x: this.x, y: this.y });
        },
        { session: this.session },
      );
      const bits = { none: 0, left: 1, right: 2, middle: 4, back: 8, forward: 16 };
      this.buttons = bits[params.button];
      try {
        await action.send(this.session, 'Input.dispatchMouseEvent', {
          ...params,
          type: 'mousePressed',
          buttons: this.buttons,
          force: 0.5,
          modifiers: this.behavior.modifiers,
        });
        action.record('down', { x, y });
        if (this.behavior.policy.mode === 'human') {
          const hold = this.behavior.range('pressDelay');
          await action.wait(hold / 2);
          if (this.behavior.random() < 0.18) {
            const angle = this.behavior.random() * Math.PI * 2;
            const sx = x + Math.cos(angle),
              sy = y + Math.sin(angle);
            // The press has been delivered: a slip that fails is skipped, and a stopped action
            // still ends at the next wait.
            if (!options.beforeSlip || (await action.waitFor(options.beforeSlip(sx, sy))))
              await this.dispatch(sx, sy, action).catch(() => {});
          }
          await action.wait(hold / 2);
        }
      } finally {
        await release.run();
      }
    });
  }
  wheel(deltaX: number, deltaY: number, options: InputOptions = {}): Promise<InputReport> {
    return this.action('scroll', options, async (action) => {
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY))
        throw new RangeError('Invalid scroll delta');
      await this.place(action);
      const human = this.behavior.policy.mode === 'human';
      const profile = this.behavior.policy.wheelProfile;
      const steps = !human
        ? 1
        : this.behavior.policy.scrollSteps !== undefined
          ? this.behavior.range('scrollSteps')
          : Math.max(
              1,
              Math.min(
                120,
                Math.ceil(Math.hypot(deltaX, deltaY) / (profile === 'wheel' ? 100 : 18)),
              ),
            );
      for (const packet of scrollPlan(deltaX, deltaY, steps, profile)) {
        await action.check();
        await action.send(this.session, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: this.x,
          y: this.y,
          deltaX: packet.deltaX,
          deltaY: packet.deltaY,
          buttons: this.buttons,
          modifiers: this.behavior.modifiers,
        });
        action.record('wheel', { x: this.x, y: this.y });
        if (human) await action.wait(packet.delay + this.behavior.range('pause'));
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
      if (this.buttons) throw new Error('Cannot drag while a mouse button is held');
      await this.path(from.x, from.y, action);
      const release = action.release(
        async () => {
          this.buttons = 0;
          await action.sendCleanup(this.session, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: this.x,
            y: this.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
            modifiers: this.behavior.modifiers,
          });
          action.record('up', this.position);
        },
        { session: this.session },
      );
      this.buttons = 1;
      try {
        await action.send(this.session, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: from.x,
          y: from.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
          force: 0.5,
          modifiers: this.behavior.modifiers,
        });
        action.record('down', from);
        for (let i = 1; i <= steps; i++) {
          await this.dispatch(
            from.x + ((to.x - from.x) * i) / steps,
            from.y + ((to.y - from.y) * i) / steps,
            action,
          );
          if (this.behavior.policy.mode === 'human')
            await action.wait(this.behavior.range('pause') + 10);
        }
      } finally {
        await release.run();
      }
    });
  }
}
interface KeyDefinition {
  code: string;
  keyCode: number;
  key: string;
  shiftKey?: string;
  text?: string;
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
  Control: { code: 'ControlLeft', keyCode: 17, key: 'Control' },
  Shift: { code: 'ShiftLeft', keyCode: 16, key: 'Shift' },
  Alt: { code: 'AltLeft', keyCode: 18, key: 'Alt' },
  Meta: { code: 'MetaLeft', keyCode: 91, key: 'Meta' },
  Space: { code: 'Space', keyCode: 32, key: ' ', text: ' ' },
};
for (let n = 1; n <= 12; n++) named[`F${n}`] = { code: `F${n}`, keyCode: 111 + n, key: `F${n}` };
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
const modifierBits: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
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
  /** Held key name -> dispatched DOM key value, so keyUp mirrors keyDown. */
  private pressed = new Map<string, string>();
  readonly session: Session;
  readonly behavior: InputBehavior;
  readonly mac: boolean;
  private readonly scope?: InputAction;
  private readonly releases = new Map<string, InputRelease>();
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
    return [...this.pressed.keys()];
  }
  private get modifiers(): number {
    let result = 0;
    for (const key of this.pressed.keys())
      result |= Object.hasOwn(modifierBits, key) ? modifierBits[key]! : 0;
    return result;
  }
  private shortcut(code: string): string {
    const held = ['Shift', 'Control', 'Alt', 'Meta'].filter((key) => this.pressed.has(key));
    return [...held, code].join('+');
  }
  private async insertRaw(text: string, action: InputAction): Promise<void> {
    await action.check();
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
      const release = await this.downRaw(key, action);
      action.record('keyDown');
      if (!this.scope) action.retain(release);
    });
  }
  private async downRaw(key: string, action: InputAction): Promise<InputRelease> {
    await action.check();
    const definition = keyDefinition(key);
    const character = characters.has(key);
    // A held Shift yields the shifted character, as on a physical US keyboard.
    const shifted = !!(this.modifiers & 8) && !!definition.shiftKey;
    const value = shifted ? definition.shiftKey! : character ? key : definition.key;
    const text = definition.text === undefined ? undefined : character ? value : definition.text;
    const autoRepeat = this.pressed.has(key);
    const release =
      (this.scope && this.releases.get(key)) ||
      action.release(
        async () => {
          this.releases.delete(key);
          await this.upRaw(key, action, true);
          action.record('keyUp');
        },
        { session: this.session },
      );
    this.releases.set(key, release);
    this.pressed.set(key, value);
    this.behavior.modifiers = this.modifiers;
    const plain = !(this.modifiers & ~8);
    const shortcut = this.shortcut(definition.code);
    const commands =
      this.mac && Object.hasOwn(macCommands, shortcut) ? macCommands[shortcut] : undefined;
    try {
      await action.send(this.session, 'Input.dispatchKeyEvent', {
        ...(commands && { commands }),
        type: text !== undefined && plain ? 'keyDown' : 'rawKeyDown',
        key: value,
        code: definition.code,
        windowsVirtualKeyCode: definition.keyCode,
        modifiers: this.modifiers,
        autoRepeat,
        text: plain ? text : undefined,
        unmodifiedText: plain ? text : undefined,
      });
      return release;
    } catch (e) {
      await release.run();
      throw e;
    }
  }
  async up(key: string, options: InputOptions = {}): Promise<void> {
    await this.action('keyUp', options, async (action) => {
      const release = this.releases.get(key);
      if (this.scope && release) await release.run();
      else {
        await action.check();
        keyDefinition(key);
        await action
          .release(
            async () => {
              this.releases.delete(key);
              await this.upRaw(key, action, true);
              action.record('keyUp');
            },
            { session: this.session },
          )
          .run();
      }
    });
  }
  private async upRaw(key: string, action: InputAction, cleanup = false): Promise<void> {
    const definition = keyDefinition(key);
    const value = this.pressed.get(key) ?? (characters.has(key) ? key : definition.key);
    this.pressed.delete(key);
    this.behavior.modifiers = this.modifiers;
    const send = cleanup ? action.sendCleanup.bind(action) : action.send.bind(action);
    await send(this.session, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: value,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      modifiers: this.modifiers,
    });
  }
  press(chord: string, options: InputOptions = {}): Promise<InputReport> {
    return this.action('key', options, async (action) => {
      const items = parseChord(chord);
      for (const key of items) keyDefinition(key);
      const down: InputRelease[] = [];
      try {
        for (const key of items) {
          await action.check();
          if (this.pressed.has(key)) throw new Error(`Key ${key} is already held`);
          down.push(await this.downRaw(key, action));
          action.record('keyDown');
          if (this.behavior.policy.mode === 'human')
            await action.wait(this.behavior.range('pressDelay'));
        }
      } finally {
        for (const release of down.reverse()) await release.run();
      }
    });
  }
  /** Presses one US-layout character with physical key events, adding Shift when needed. */
  private async typeKey(char: string, action: InputAction): Promise<void> {
    if (this.pressed.has(char)) throw new Error('Cannot type a key that is already held');
    const needShift = characters.get(char)!.shift && !this.pressed.has('Shift');
    let shift: InputRelease | undefined;
    if (needShift) {
      shift = await this.downRaw('Shift', action);
      action.record('keyDown');
    }
    try {
      if (needShift && this.behavior.policy.mode === 'human')
        await action.wait(this.behavior.range('pressDelay') / 2);
      const release = await this.downRaw(char, action);
      action.record('keyDown');
      try {
        if (this.behavior.policy.mode === 'human')
          await action.wait(this.behavior.range('pressDelay'));
      } finally {
        await release.run();
      }
    } finally {
      await shift?.run();
    }
  }
  private get typesKeys(): boolean {
    const { typing, mode } = this.behavior.policy;
    return typing === 'keys' || (typing === 'auto' && mode === 'human');
  }
  /**
   * Types whole graphemes or explicit commit segments. With physical-key typing (the human-mode
   * default) US-layout characters use keyDown/keyUp; anything else, including line breaks and
   * tabs, uses Input.insertText. Neither path is native IME composition.
   */
  type(text: string | string[], options: InputOptions = {}): Promise<InputReport> {
    if ((typeof text === 'string' ? text.length : text.reduce((n, s) => n + s.length, 0)) > 100000)
      throw new RangeError('Text input exceeds 100000 UTF-16 units');
    const segments =
      typeof text === 'string'
        ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
            (s) => s.segment,
          )
        : text;
    return this.action('type', options, async (action) => {
      const keys = this.typesKeys && !(this.modifiers & ~8);
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]!;
        await action.check();
        const character = characters.get(segment);
        const next = segments[i + 1];
        // Overlap only distinct lowercase letter keys without caller-held modifiers or keys.
        // Every downRaw registers its release before dispatch, including a failed second press.
        if (
          keys &&
          this.behavior.policy.mode === 'human' &&
          this.pressed.size === 0 &&
          segment.length === 1 &&
          next?.length === 1 &&
          ['th', 'he', 'in', 'er'].includes(segment + next) &&
          this.behavior.random() < 0.15
        ) {
          const first = await this.downRaw(segment, action);
          action.record('keyDown');
          let second: InputRelease | undefined;
          try {
            await action.wait(this.behavior.range('pressDelay'));
            second = await this.downRaw(next, action);
            action.record('keyDown');
            await action.wait(5 + this.behavior.random() * 7);
            await first.run();
            action.report.completedSegments++;
            await action.wait(this.behavior.range('pressDelay'));
          } finally {
            await second?.run();
            await first.run();
          }
          action.report.completedSegments++;
          i++;
          await action.wait(
            keyInterval(
              () => this.behavior.random(),
              this.behavior.policy.keyDelay,
              next,
              segments[i + 1] ?? '',
            ),
          );
          continue;
        }
        // A held Shift would turn a character typed without Shift into its shifted one.
        if (keys && character && (character.shift || !(this.modifiers & 8)))
          await this.typeKey(segment, action);
        else {
          await this.insertRaw(segment, action);
          action.record('insertText');
        }
        action.report.completedSegments++;
        if (this.behavior.policy.mode === 'human')
          await action.wait(
            keyInterval(
              () => this.behavior.random(),
              this.behavior.policy.keyDelay,
              segment,
              next ?? '',
            ),
          );
      }
    });
  }
}
