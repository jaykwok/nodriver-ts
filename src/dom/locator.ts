import type { Frame } from '../page/frames.ts';
import type { Element, SetCheckedResult, TypeOptions } from './element.ts';
import type { QueryOptions, Selector } from './query.ts';
import { InputActionError, type InputOptions, type InputReport } from '../input/behavior.ts';
import { EvaluationError, ProtocolError, StaleElementError } from '../errors.ts';
import { budget, type WaitOptions } from '../utils.ts';
/** The element was replaced or removed, as when a single-page app re-renders. */
function replaced(error: unknown): boolean {
  return (
    error instanceof StaleElementError ||
    ((error instanceof EvaluationError || error instanceof ProtocolError) &&
      /Node is detached|No node (with given id )?found|Could not find node/i.test(error.message))
  );
}
/** Whether an action may run again on a new match: it failed on a replaced element before any input. */
function retryable(error: unknown): boolean {
  if (error instanceof InputActionError)
    return error.report.dispatched === 0 && replaced(error.cause);
  return replaced(error);
}
/**
 * A query that runs again before each action, so the action reaches the current element after a
 * re-render. An action whose element is replaced before it sends a press, key or text runs again
 * on a new match within the same timeout; once such input was sent, its failure is reported and
 * the action is never repeated.
 */
export class Locator {
  private readonly root: () => Frame;
  readonly selector: Selector;
  readonly options: Omit<QueryOptions, 'timeout' | 'signal' | 'limit'>;
  constructor(
    root: () => Frame,
    selector: Selector,
    options: Omit<QueryOptions, 'timeout' | 'signal' | 'limit'> = {},
  ) {
    this.root = root;
    this.selector = selector;
    this.options = options;
  }
  /** Waits for the first match. The element itself goes stale if it is replaced. */
  element(options: WaitOptions = {}): Promise<Element> {
    return this.root().waitForSelector(this.selector, { ...this.options, ...options });
  }
  /** The number of current matches, without waiting. */
  async count(options: WaitOptions = {}): Promise<number> {
    return (await this.root().queryAll(this.selector, { ...this.options, ...options })).length;
  }
  private async act<T, O extends WaitOptions>(
    label: string,
    options: O,
    action: (element: Element, options: O) => Promise<T>,
  ): Promise<T> {
    const step = budget({ ...options, timeout: options.timeout ?? 10_000 }, label);
    for (;;) {
      const element = await this.element(step());
      try {
        return await action(element, { ...options, ...step() });
      } catch (error) {
        if (!retryable(error)) throw error;
      }
    }
  }
  click(options: Parameters<Element['click']>[0] = {}): Promise<void> {
    return this.act('click', options, (element, o) => element.click(o));
  }
  hover(options: InputOptions = {}): ReturnType<Element['hover']> {
    return this.act('hover', options, (element, o) => element.hover(o));
  }
  fill(text: string, options: InputOptions = {}): Promise<void> {
    return this.act('fill', options, (element, o) => element.fill(text, o));
  }
  type(text: string | string[], options: TypeOptions = {}): Promise<InputReport> {
    return this.act('type', options, (element, o) => element.type(text, o));
  }
  setChecked(checked: boolean, options: InputOptions = {}): Promise<SetCheckedResult> {
    return this.act('setChecked', options, (element, o) => element.setChecked(checked, o));
  }
  text(options: WaitOptions = {}): Promise<string> {
    return this.act('text', options, (element) => element.text());
  }
  attribute(name: string, options: WaitOptions = {}): Promise<string | null> {
    return this.act('attribute', options, (element) => element.attribute(name));
  }
}
