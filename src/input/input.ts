import type { Session } from '../protocol/connection.js';
import type { Protocol } from 'devtools-protocol';
import {
  InputBehavior,
  type InputAction,
  type InputOptions,
  type InputReport,
} from './behavior.js';
import { StaleElementError } from '../errors.js';
function standalone(session: Session) {
  return new InputBehavior(
    (task) => task(),
    () => {
      if (session.closed) throw new StaleElementError('Input target closed');
    },
  );
}
export class Mouse {
  private x = 0;
  private y = 0;
  private buttons = 0;
  private placed = false;
  constructor(
    readonly session: Session,
    readonly behavior = standalone(session),
  ) {}
  get position() {
    return { x: this.x, y: this.y, buttons: this.buttons };
  }
  /** Human mode starts from a random viewport point rather than the (0,0) corner. */
  private async place(): Promise<void> {
    if (this.placed || this.behavior.policy.mode !== 'human') return;
    this.placed = true;
    const metrics = await this.session.send('Page.getLayoutMetrics').catch(() => undefined);
    const v = metrics?.cssVisualViewport;
    if (!v?.clientWidth || !v.clientHeight) return;
    this.x = v.clientWidth * (0.15 + 0.7 * this.behavior.random());
    this.y = v.clientHeight * (0.15 + 0.7 * this.behavior.random());
  }
  private async dispatch(x: number, y: number, action: InputAction) {
    await action.check();
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new RangeError('Invalid pointer coordinates');
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      buttons: this.buttons,
      // A pressure-less mouse reports 0.5 while any button is held (Pointer Events spec).
      ...(this.buttons ? { force: 0.5 } : {}),
    });
    this.x = x;
    this.y = y;
    this.placed = true;
    action.record('move', { x, y });
  }
  private async path(x: number, y: number, action: InputAction) {
    if (this.behavior.policy.mode === 'instant') return this.dispatch(x, y, action);
    await this.place();
    const from = this.position,
      dx = x - from.x,
      dy = y - from.y;
    const bend = (this.behavior.random() - 0.5) * Math.min(100, Math.hypot(dx, dy) * 0.25);
    const length = Math.hypot(dx, dy) || 1,
      nx = (-dy / length) * bend,
      ny = (dx / length) * bend;
    const steps = this.behavior.range('moveSteps'),
      duration = this.behavior.range('moveDuration');
    for (let i = 1; i <= steps; i++) {
      const t = i / steps,
        u = t * t * (3 - 2 * t),
        curve = 4 * u * (1 - u);
      await this.dispatch(from.x + dx * u + nx * curve, from.y + dy * u + ny * curve, action);
      await action.wait(duration / steps);
    }
    await action.wait(this.behavior.range('pause'));
  }
  move(x: number, y: number, options: InputOptions = {}): Promise<InputReport> {
    return this.behavior.action('move', options, (a) => this.path(x, y, a));
  }
  async click(
    x: number,
    y: number,
    options: InputOptions & {
      button?: Protocol.Input.MouseButton;
      clickCount?: number;
      beforePress?: () => Promise<void>;
    } = {},
  ): Promise<InputReport> {
    return this.behavior.action('click', options, async (action) => {
      await this.path(x, y, action);
      await options.beforePress?.();
      await action.check();
      const params = {
        x,
        y,
        button: options.button ?? 'left',
        clickCount: options.clickCount ?? 1,
      };
      this.buttons = params.button === 'right' ? 2 : params.button === 'middle' ? 4 : 1;
      try {
        await this.session.send('Input.dispatchMouseEvent', {
          ...params,
          type: 'mousePressed',
          buttons: this.buttons,
          force: 0.5,
        });
        action.record('down', { x, y });
        if (this.behavior.policy.mode === 'human')
          await action.wait(this.behavior.range('pressDelay'));
      } finally {
        this.buttons = 0;
        try {
          await this.session.send('Input.dispatchMouseEvent', {
            ...params,
            type: 'mouseReleased',
            buttons: 0,
          });
          action.record('up', { x, y });
        } catch (error) {
          action.report.cleanupErrors.push(String(error));
          throw error;
        }
      }
    });
  }
  wheel(deltaX: number, deltaY: number, options: InputOptions = {}): Promise<InputReport> {
    return this.behavior.action('scroll', options, async (action) => {
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY))
        throw new RangeError('Invalid scroll delta');
      await this.place();
      const steps = this.behavior.policy.mode === 'human' ? this.behavior.range('scrollSteps') : 1;
      for (let i = 0; i < steps; i++) {
        await action.check();
        await this.session.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: this.x,
          y: this.y,
          deltaX: deltaX / steps,
          deltaY: deltaY / steps,
        });
        action.record('wheel', { x: this.x, y: this.y });
        if (this.behavior.policy.mode === 'human')
          await action.wait(this.behavior.range('pause') + 10);
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
    return this.behavior.action('drag', options, async (action) => {
      await this.path(from.x, from.y, action);
      this.buttons = 1;
      try {
        await this.session.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: from.x,
          y: from.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
          force: 0.5,
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
        this.buttons = 0;
        try {
          await this.session.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: this.x,
            y: this.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
          });
          action.record('up', this.position);
        } catch (error) {
          action.report.cleanupErrors.push(String(error));
          throw error;
        }
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
/** Resolves a named key or a US-layout character to its CDP key definition. */
export function keyDefinition(key: string): KeyDefinition {
  const definition = named[key] ?? characters.get(key)?.definition;
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
  /** Held key name -> dispatched DOM key value, so keyUp mirrors keyDown. */
  private pressed = new Map<string, string>();
  constructor(
    readonly session: Session,
    readonly behavior = standalone(session),
  ) {}
  get pressedKeys(): string[] {
    return [...this.pressed.keys()];
  }
  private get modifiers(): number {
    let result = 0;
    for (const key of this.pressed.keys()) result |= modifierBits[key] ?? 0;
    return result;
  }
  private async insertRaw(text: string): Promise<void> {
    await this.session.send('Input.insertText', { text });
  }
  insertText(text: string, options: InputOptions = {}): Promise<InputReport> {
    return this.behavior.action('insertText', options, async (action) => {
      await this.insertRaw(text);
      action.report.completedSegments = 1;
      action.record('insertText');
    });
  }
  down(key: string): Promise<void> {
    return this.behavior.run(async () => {
      this.behavior.guard();
      await this.behavior.prepare();
      await this.downRaw(key);
    });
  }
  private async downRaw(key: string): Promise<void> {
    const definition = keyDefinition(key);
    const character = characters.has(key);
    // A held Shift yields the shifted character, as on a physical US keyboard.
    const shifted = !!(this.modifiers & 8) && !!definition.shiftKey;
    const value = shifted ? definition.shiftKey! : character ? key : definition.key;
    const text = definition.text === undefined ? undefined : character ? value : definition.text;
    const autoRepeat = this.pressed.has(key);
    this.pressed.set(key, value);
    const plain = !(this.modifiers & ~8);
    try {
      await this.session.send('Input.dispatchKeyEvent', {
        type: text !== undefined && plain ? 'keyDown' : 'rawKeyDown',
        key: value,
        code: definition.code,
        windowsVirtualKeyCode: definition.keyCode,
        modifiers: this.modifiers,
        autoRepeat,
        text: plain ? text : undefined,
        unmodifiedText: plain ? text : undefined,
      });
    } catch (e) {
      await this.upRaw(key).catch(() => {});
      throw e;
    }
  }
  up(key: string): Promise<void> {
    return this.behavior.run(() => this.upRaw(key));
  }
  private async upRaw(key: string): Promise<void> {
    const definition = keyDefinition(key);
    const value = this.pressed.get(key) ?? (characters.has(key) ? key : definition.key);
    this.pressed.delete(key);
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: value,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      modifiers: this.modifiers,
    });
  }
  press(chord: string, options: InputOptions = {}): Promise<InputReport> {
    return this.behavior.action('key', options, async (action) => {
      const items = parseChord(chord);
      for (const key of items) keyDefinition(key);
      const down: string[] = [];
      try {
        for (const key of items) {
          await action.check();
          if (this.pressed.has(key)) throw new Error(`Key ${key} is already held`);
          await this.downRaw(key);
          down.push(key);
          action.record('keyDown');
          if (this.behavior.policy.mode === 'human')
            await action.wait(this.behavior.range('pressDelay'));
        }
      } finally {
        for (const key of down.reverse()) {
          try {
            await this.upRaw(key);
            action.record('keyUp');
          } catch (error) {
            action.report.cleanupErrors.push(String(error));
          }
        }
        if (action.report.cleanupErrors.length) throw new Error('Key release failed');
      }
    });
  }
  /** Presses one US-layout character with physical key events, adding Shift when needed. */
  private async typeKey(char: string, action: InputAction): Promise<void> {
    const needShift = characters.get(char)!.shift && !this.pressed.has('Shift');
    if (needShift) {
      await this.downRaw('Shift');
      action.record('keyDown');
    }
    try {
      if (needShift) await action.wait(this.behavior.range('pressDelay') / 2);
      await this.downRaw(char);
      action.record('keyDown');
      try {
        if (this.behavior.policy.mode === 'human')
          await action.wait(this.behavior.range('pressDelay'));
      } finally {
        await this.upRaw(char);
        action.record('keyUp');
      }
    } finally {
      if (needShift) {
        await this.upRaw('Shift');
        action.record('keyUp');
      }
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
    return this.behavior.action('type', options, async (action) => {
      const keys = this.typesKeys && !(this.modifiers & ~8);
      for (const segment of segments) {
        await action.check();
        if (keys && characters.has(segment)) await this.typeKey(segment, action);
        else {
          await this.insertRaw(segment);
          action.record('insertText');
        }
        action.report.completedSegments++;
        if (this.behavior.policy.mode === 'human')
          await action.wait(this.behavior.range('keyDelay'));
      }
    });
  }
}
