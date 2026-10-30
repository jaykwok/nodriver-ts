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
import { Composition } from './composition.ts';
export interface InputScopeOptions {
  policy?: InputPolicy;
  mac?: boolean;
}
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
  constructor(session: Session, options: InputScopeOptions = {}) {
    if (!session.id) throw new TypeError('Input scope requires a target session');
    this.session = session;
    this.mac = options.mac ?? false;
    const coordinator = inputCoordinator(session.connection);
    this.behavior = new InputBehavior(
      (task) => coordinator.run(task),
      () => {
        if (session.closed) throw new StaleElementError('Input target closed');
      },
    );
    this.behavior.coordinator = coordinator;
    if (options.policy) this.behavior.configure(options.policy);
  }
  run(
    task: (input: ScopedInput) => Promise<void>,
    options: InputOptions = {},
  ): Promise<InputReport> {
    return this.behavior.action('scope', options, async (action) => {
      action.watch(this.session);
      await action.send(this.session, 'Page.enable');
      const input: ScopedInput = {
        mouse: new Mouse(this.session, this.behavior, action),
        keyboard: new Keyboard(this.session, this.behavior, this.mac, action),
        composition: new Composition(this.session, action),
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
