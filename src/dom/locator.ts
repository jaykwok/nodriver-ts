import type { Frame } from '../page/frames.ts';
import {
  batchEvaluateIsolatedChunks,
  batchProbeFilterChunks,
  isElementVisible,
  type Element,
  type SetCheckedResult,
  type TypeOptions,
} from './element.ts';
import type { QueryOptions, Selector } from './query.ts';
import { InputActionError, type InputOptions, type InputReport } from '../input/behavior.ts';
import { EvaluationError, StaleElementError } from '../errors.ts';
import { isContextGone, isNodeGone } from '../protocol/errors.ts';
import { budget, normalizeText, poll, type WaitOptions } from '../utils.ts';

export type LocatorQueryOptions = Omit<QueryOptions, 'timeout' | 'signal' | 'limit'>;

export interface LocatorFilter {
  hasText?: string | RegExp;
  has?: Selector;
  /** Filter matches by visibility (`isElementVisible()`). */
  visible?: boolean;
  /** Filter matches by enabled state (`isElementEnabled()`). */
  enabled?: boolean;
}

export type LocatorWaitState = 'visible' | 'hidden' | 'attached' | 'detached';

export interface LocatorWaitOptions extends WaitOptions {
  /** Target state to wait for. Defaults to `'visible'`. */
  state?: LocatorWaitState;
}

type LocatorStep =
  | { kind: 'query'; selector: Selector; options: LocatorQueryOptions }
  | { kind: 'filter'; filter: LocatorFilter }
  | { kind: 'nth'; index: number };

const WAIT_STATES = new Set<LocatorWaitState>(['visible', 'hidden', 'attached', 'detached']);

function matchesText(text: string, expected: string | RegExp): boolean {
  const normalized = normalizeText(text);
  if (typeof expected === 'string') return normalized.includes(normalizeText(expected));
  const flags = expected.flags.replace(/[gy]/g, '');
  return new RegExp(expected.source, flags).test(normalized);
}

/** The element was replaced or removed, as when a single-page app re-renders. */
function replaced(error: unknown): boolean {
  return (
    error instanceof StaleElementError ||
    isNodeGone(error) ||
    (error instanceof EvaluationError && /Node is detached/i.test(error.message))
  );
}

/** Whether an action may run again on a new match: it failed on a replaced element/context before any input. */
function retryable(error: unknown): boolean {
  if (error instanceof InputActionError)
    return error.report.dispatched === 0 && (replaced(error.cause) || isContextGone(error.cause));
  return replaced(error) || isContextGone(error);
}

/**
 * A query that runs again before each action, so the action reaches the current element after a
 * re-render. Supports chaining via `locator()`, filtering via `filter()`, indexing via `first()` /
 * `nth()`, and state waits via `waitFor()`. An action whose element is replaced before it sends a
 * press, key or text runs again on a new match within the same timeout; once such input was sent,
 * its failure is reported and the action is never repeated.
 */
export class Locator {
  private readonly root: () => Frame;
  private readonly steps: readonly LocatorStep[];
  readonly selector: Selector;
  readonly options: LocatorQueryOptions;
  constructor(
    root: () => Frame,
    selector: Selector,
    options: LocatorQueryOptions = {},
    steps?: readonly LocatorStep[],
  ) {
    this.root = root;
    this.selector = selector;
    this.options = options;
    this.steps = steps ?? [{ kind: 'query', selector, options }];
  }
  /** Chains a descendant query scoped to each element matched by this locator. */
  locator(selector: Selector, options: LocatorQueryOptions = {}): Locator {
    return new Locator(this.root, selector, options, [
      ...this.steps,
      { kind: 'query', selector, options },
    ]);
  }
  /** Narrows matches by text (`hasText`), descendant (`has`), visibility (`visible`), and/or enabled state (`enabled`). */
  filter(filter: LocatorFilter): Locator {
    if (
      filter.hasText !== undefined &&
      typeof filter.hasText !== 'string' &&
      !(filter.hasText instanceof RegExp)
    )
      throw new TypeError('filter.hasText must be a string or RegExp');
    if (filter.visible !== undefined && typeof filter.visible !== 'boolean')
      throw new TypeError('filter.visible must be a boolean');
    if (filter.enabled !== undefined && typeof filter.enabled !== 'boolean')
      throw new TypeError('filter.enabled must be a boolean');
    return new Locator(this.root, this.selector, this.options, [
      ...this.steps,
      { kind: 'filter', filter: { ...filter } },
    ]);
  }
  /** Narrows this locator to its first match (`nth(0)`). */
  first(): Locator {
    return this.nth(0);
  }
  /** Narrows this locator to its zero-based `index`-th match. */
  nth(index: number): Locator {
    if (!Number.isInteger(index) || index < 0)
      throw new RangeError('nth index must be a non-negative integer');
    return new Locator(this.root, this.selector, this.options, [
      ...this.steps,
      { kind: 'nth', index },
    ]);
  }
  private pending(frame: Frame, error: unknown): boolean {
    return (replaced(error) || isContextGone(error)) && !frame.detached;
  }
  private async resolveMatches(
    step: () => WaitOptions,
    mode: { single?: boolean; forceAttached?: boolean } = {},
  ): Promise<Element[]> {
    const frame = this.root();
    const { single = false, forceAttached = false } = mode;
    let elements: Element[] = [];
    for (let i = 0; i < this.steps.length; i++) {
      const current = this.steps[i]!;
      const isLast = i === this.steps.length - 1;
      const next = this.steps[i + 1];
      const nextIsLastNth = i === this.steps.length - 2 && next?.kind === 'nth';
      if (current.kind === 'query') {
        const queryOptions: QueryOptions = {
          ...current.options,
          ...(forceAttached && current.options.visible === undefined ? { visible: false } : {}),
          ...step(),
        };
        if (i === 0) {
          if (isLast && single) queryOptions.limit = 1;
          else if (nextIsLastNth) queryOptions.limit = next.index + 1;
          elements = await frame.queryAll(current.selector, queryOptions);
        } else {
          const collected: Element[] = [];
          const seen = new Set<number>();
          for (const parent of elements) {
            // Do not subtract `collected.length` before deduplicating: an overlapping parent may
            // re-emit already-seen nodes ahead of new ones. Because one queryAll returns distinct
            // nodes, requesting `next.index + 1` guarantees `|seen U found| >= next.index + 1`
            // whenever the parent has enough matches to satisfy the target index.
            const perParentLimit =
              isLast && single ? 1 : nextIsLastNth ? next.index + 1 : undefined;
            const found = await parent.queryAll(current.selector, {
              ...queryOptions,
              ...step(),
              ...(perParentLimit !== undefined ? { limit: perParentLimit } : {}),
            });
            for (const item of found) {
              if (seen.has(item.backendNodeId)) continue;
              seen.add(item.backendNodeId);
              collected.push(item);
              if (isLast && single) return collected;
              if (nextIsLastNth && collected.length > next.index) break;
            }
            if (nextIsLastNth && collected.length > next.index) break;
          }
          elements = collected;
        }
      } else if (current.kind === 'filter') {
        const { hasText, has, visible, enabled } = current.filter;
        const needed = isLast && single ? 1 : nextIsLastNth ? next.index + 1 : Infinity;
        const filtered: Element[] = [];
        const probeSpec = {
          text: hasText !== undefined,
          visible: visible !== undefined,
          enabled: enabled !== undefined,
        };
        const needsProbe = probeSpec.text || probeSpec.visible || probeSpec.enabled;
        if (needsProbe) {
          if (elements.length === 1 && !probeSpec.visible && !probeSpec.enabled && probeSpec.text) {
            const el = elements[0]!;
            const text = await el.text(step());
            if (matchesText(text, hasText!)) {
              if (
                has === undefined ||
                (await el.query(has, { ...(forceAttached ? { visible: false } : {}), ...step() }))
              )
                filtered.push(el);
            }
          } else {
            for await (const { offset, results } of batchProbeFilterChunks(
              elements,
              probeSpec,
              step(),
            )) {
              for (let j = 0; j < results.length; j++) {
                const el = elements[offset + j]!;
                const probe = results[j]!;
                // A vanished item cannot affect matches already decided ahead of it; only
                // re-query when a stale item could still occupy or precede the needed match.
                if (!probe.ok) throw new StaleElementError('Element was removed from its document');
                if (hasText !== undefined && !matchesText(probe.value.text ?? '', hasText))
                  continue;
                if (visible !== undefined && probe.value.visible !== visible) continue;
                if (enabled !== undefined && probe.value.enabled !== enabled) continue;
                if (has !== undefined) {
                  const match = await el.query(has, {
                    ...(forceAttached ? { visible: false } : {}),
                    ...step(),
                  });
                  if (!match) continue;
                }
                filtered.push(el);
                if (filtered.length >= needed) break;
              }
              if (filtered.length >= needed) break;
            }
          }
        } else if (has !== undefined) {
          for (const el of elements) {
            const match = await el.query(has, {
              ...(forceAttached ? { visible: false } : {}),
              ...step(),
            });
            if (!match) continue;
            filtered.push(el);
            if (filtered.length >= needed) break;
          }
        } else {
          filtered.push(...(needed === Infinity ? elements : elements.slice(0, needed)));
        }
        elements = filtered;
        if (isLast && single && elements.length) return elements.slice(0, 1);
      } else {
        elements = current.index < elements.length ? [elements[current.index]!] : [];
      }
      if (!elements.length) return [];
    }
    return single ? elements.slice(0, 1) : elements;
  }
  private describe(): string {
    return this.steps
      .map((s) => {
        if (s.kind === 'query') return JSON.stringify(s.selector);
        if (s.kind === 'nth') return s.index === 0 ? 'first()' : `nth(${s.index})`;
        const parts: string[] = [];
        if (s.filter.hasText !== undefined) parts.push(`hasText=${String(s.filter.hasText)}`);
        if (s.filter.has !== undefined) parts.push(`has=${JSON.stringify(s.filter.has)}`);
        if (s.filter.visible !== undefined) parts.push(`visible=${s.filter.visible}`);
        if (s.filter.enabled !== undefined) parts.push(`enabled=${s.filter.enabled}`);
        return `filter(${parts.join(', ')})`;
      })
      .join(' -> ');
  }
  private async hasVisibleMatch(
    matches: readonly Element[],
    step: () => WaitOptions,
  ): Promise<{ anyVisible: boolean; sawStale: boolean }> {
    if (!matches.length) return { anyVisible: false, sawStale: false };
    if (matches.length === 1)
      return { anyVisible: await matches[0]!.isVisible(step()), sawStale: false };
    let sawStale = false;
    for await (const { results } of batchEvaluateIsolatedChunks(
      matches,
      isElementVisible,
      undefined,
      step(),
    )) {
      if (results.some((entry) => entry.ok && entry.value)) return { anyVisible: true, sawStale };
      if (results.some((entry) => !entry.ok)) sawStale = true;
    }
    return { anyVisible: false, sawStale };
  }
  /** All current matches, without waiting. */
  async all(options: WaitOptions = {}): Promise<Element[]> {
    const step = budget(options, 'all');
    return this.resolveMatches(step);
  }
  /** Waits for the first match. The element itself goes stale if it is replaced. */
  async element(options: WaitOptions = {}): Promise<Element> {
    return poll(
      async (step) => {
        const frame = this.root();
        try {
          return (await this.resolveMatches(budget(step, 'locator'), { single: true }))[0];
        } catch (error) {
          if (this.pending(frame, error)) return undefined;
          throw error;
        }
      },
      options,
      `locator ${this.describe()}`,
    );
  }
  /**
   * Waits until the locator reaches the requested state (`'visible'` by default).
   * `'visible'` waits until at least one match is visible (complementing `'hidden'`, which waits
   * until no match is visible); chain `.first()` or `.nth(i)` to target a specific index.
   */
  async waitFor(options: LocatorWaitOptions = {}): Promise<void> {
    const state = options.state ?? 'visible';
    if (!WAIT_STATES.has(state)) throw new TypeError(`Invalid waitFor state: ${String(state)}`);
    await poll(
      async (step) => {
        const frame = this.root();
        const attempt = budget(step, `locator ${state}`);
        try {
          if (state === 'attached') {
            const matches = await this.resolveMatches(attempt, {
              single: true,
              forceAttached: true,
            });
            return matches.length > 0 ? true : undefined;
          }
          if (state === 'detached') {
            const matches = await this.resolveMatches(attempt, {
              single: true,
              forceAttached: true,
            });
            return matches.length === 0 ? true : undefined;
          }
          const matches = await this.resolveMatches(attempt);
          if (state === 'visible') {
            const { anyVisible } = await this.hasVisibleMatch(matches, attempt);
            return anyVisible ? true : undefined;
          }
          // 'hidden': waits until zero matches remain visible.
          if (!matches.length) return true;
          const { anyVisible, sawStale } = await this.hasVisibleMatch(matches, attempt);
          if (anyVisible) return undefined;
          if (sawStale) throw new StaleElementError('Element was removed from its document');
          return true;
        } catch (error) {
          if (this.pending(frame, error)) return undefined;
          throw error;
        }
      },
      options,
      `locator ${this.describe()} to be ${state}`,
    );
  }
  /** The number of current matches, without waiting. */
  async count(options: WaitOptions = {}): Promise<number> {
    return (await this.all(options)).length;
  }
  /**
   * Whether any current match is visible (or the indexed match when `.first()` / `.nth()` is
   * chained), using the same visibility predicate as `Element.isVisible()`. Strictly complementary
   * to `waitFor({ state: 'hidden' })`. Does not wait; returns `false` when nothing matches.
   */
  async isVisible(options: WaitOptions = {}): Promise<boolean> {
    const step = budget(options, 'isVisible');
    const frame = this.root();
    try {
      const matches = await this.resolveMatches(step);
      return (await this.hasVisibleMatch(matches, step)).anyVisible;
    } catch (error) {
      if (this.pending(frame, error)) return false;
      throw error;
    }
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
    return this.act('text', options, (element, o) => element.text(o));
  }
  attribute(name: string, options: WaitOptions = {}): Promise<string | null> {
    return this.act('attribute', options, (element, o) => element.attribute(name, o));
  }
  isEnabled(options: WaitOptions = {}): Promise<boolean> {
    return this.act('isEnabled', options, (element, o) => element.isEnabled(o));
  }
  isChecked(options: WaitOptions = {}): Promise<boolean> {
    return this.act('isChecked', options, (element, o) => element.isChecked(o));
  }
}
