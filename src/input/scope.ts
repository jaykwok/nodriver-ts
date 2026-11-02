import type { Session } from '../protocol/connection.ts';
import { StaleElementError } from '../errors.ts';
import {
  InputBehavior,
  inputCoordinator,
  type InputOptions,
  type InputPolicy,
  type InputReport,
} from './behavior.ts';
import { Keyboard, Mouse } from './input.ts';
import { Composition, type CompositionOptions } from './composition.ts';
export interface InputScopeOptions {
  policy?: InputPolicy;
  mac?: boolean;
  /**
   * false never sends Page.enable. Navigation then stops a run only through your signal;
   * compositions still check focus and document before every step. Defaults to true.
   */
  pageEvents?: boolean;
}
export interface InputScopeRunOptions extends InputOptions, CompositionOptions {}
export interface ScopedInput {
  readonly mouse: Mouse;
  readonly keyboard: Keyboard;
  readonly composition: Composition;
  wait(ms: number): Promise<void>;
}
/** Raw input on the same connection queue as Tab input. Never activates a target. */
export class InputScope {
  readonly session: Session;
  readonly behavior: InputBehavior;
  private readonly mac: boolean;
  private readonly pageEvents: boolean;
  constructor(session: Session, options: InputScopeOptions = {}) {
    if (!session.id) throw new TypeError('Input scope requires a target session');
    this.session = session;
    this.mac = options.mac ?? false;
    this.pageEvents = options.pageEvents ?? true;
    const coordinator = inputCoordinator(session.connection);
    this.behavior = new InputBehavior(
      (task) => coordinator.run(task),
      () => {
        if (session.closed)
          throw new StaleElementError('Input target closed', { cause: session.closeReason });
      },
    );
    this.behavior.coordinator = coordinator;
    if (options.policy) this.behavior.configure(options.policy);
  }
  /**
   * Acknowledge that you inspected/restored this page after failed composition cleanup.
   * Await the failed action's cleanup and verify the page before calling. Sends no commands
   * and does not cancel composition itself. Clears only a page-level composition block,
   * across all its attachments/frames; connection-wide failures remain blocked.
   * Returns false if the page has no block. Uses the connection's input queue.
   */
  recoverComposition(): Promise<boolean> {
    return inputCoordinator(this.session.connection).recoverComposition(this.session);
  }
  run(
    task: (input: ScopedInput) => Promise<void>,
    options: InputScopeRunOptions = {},
  ): Promise<InputReport> {
    return this.behavior.action('scope', options, async (action) => {
      action.watch(this.session);
      if (this.pageEvents) await action.send(this.session, 'Page.enable');
      const input: ScopedInput = {
        mouse: new Mouse(this.session, this.behavior, action),
        keyboard: new Keyboard(this.session, this.behavior, this.mac, action),
        composition: new Composition(this.session, action, options),
        wait: async (ms) => {
          await action.perform({}, (a) => a.wait(ms));
        },
      };
      await action.waitFor(task(input));
    });
  }
}
export function createInputScope(session: Session, options: InputScopeOptions = {}): InputScope {
  return new InputScope(session, options);
}
