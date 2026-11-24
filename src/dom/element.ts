import type { Protocol } from 'devtools-protocol';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import {
  ON_LATE_REPLY,
  type Session,
  type Command,
  type Params,
  type Result,
  type LedgerOptions,
} from '../protocol/connection.ts';
import { argument, checkException, valueOf, type Frame, type World } from '../page/frames.ts';
import {
  formatExceptionDetails,
  releaseObjectGroup,
  releaseRemoteObjects,
} from '../page/runtime.ts';
import { isNodeGone, isNoLayoutObject } from '../protocol/errors.ts';
import { ActionabilityError, StaleElementError } from '../errors.ts';
import { abortReason, bounded, budget, delay, narrower, poll, type WaitOptions } from '../utils.ts';
import { isElementEnabled, isElementVisible, isInComposedTree } from './predicates.ts';
import { query, type QueryOptions, type Selector } from './query.ts';
import type { InputCheckpoint, InputOptions, InputReport } from '../input/behavior.ts';
import type { KeyboardTypeOptions } from '../input/input.ts';
import { targetCoordinate } from '../input/human.ts';
export { isElementVisible, isElementEnabled };
type Point = { x: number; y: number };
export interface ElementEvaluateOptions extends WaitOptions {
  /** Isolated by default; main exposes page-owned properties on the DOM wrapper. */
  world?: World;
}
export interface TypeOptions extends KeyboardTypeOptions {
  /** Select the whole value first, so the typed text replaces it. */
  replace?: boolean;
}
export interface SetCheckedResult {
  changed: boolean;
  /** What was clicked; absent when the input already had the requested state. */
  clicked?: 'control' | 'label';
}
let objectGroupId = 0;
/** The budget of an element operation outside an input action, shared by its CDP steps. */
const operation = new AsyncLocalStorage<() => WaitOptions>();
/** How long human-mode scrolling wheels toward an element before Chrome finishes. */
const WHEEL_INTO_VIEW = 3000;
function isNoLayoutActionability(error: unknown): boolean {
  return error instanceof ActionabilityError && isNoLayoutObject(error.cause);
}
/** @internal Per-element outcome from `batchEvaluateIsolated()`. */
export type BatchProbeResult<T> = { ok: true; value: T } | { ok: false; stale: true };
/** @internal Filter-probe fields returned per element by `batchProbeFilterChunks()`. */
export interface ElementFilterProbe {
  text?: string;
  visible?: boolean;
  enabled?: boolean;
}
const PROBE_FILTER_DECLARATION = `function(spec,...els){const isVisible=(${isElementVisible.toString()});const isEnabled=(${isElementEnabled.toString()});return els.map(el=>{if(!el||!el.isConnected)return{ok:false,stale:true};const value={};if(spec.text)value.text=el.textContent??'';if(spec.visible)value.visible=isVisible(el);if(spec.enabled)value.enabled=isEnabled(el);return{ok:true,value}})}`;
async function* batchEvaluateDeclarationChunks<T, A>(
  elements: readonly Element[],
  functionDeclaration: string,
  arg: A,
  options: WaitOptions = {},
  chunkSize = 256,
): AsyncGenerator<{ offset: number; results: Array<BatchProbeResult<T>> }, void, void> {
  if (!elements.length) return;
  const first = elements[0]!;
  const { frame, session, generation } = first;
  for (const el of elements) {
    el.assertValid();
    if (el.frame !== frame || el.session !== session || el.generation !== generation)
      throw new StaleElementError('Element belongs to an expired document/session');
  }
  const step = budget(options, 'batch element probe');
  const context = await frame.context('isolated', step());
  for (let offset = 0; offset < elements.length; offset += chunkSize) {
    const chunk = elements.slice(offset, offset + chunkSize);
    const group = `nodriver-batch-${++objectGroupId}`;
    let chunkResults: Array<BatchProbeResult<T>>;
    try {
      const wait = step();
      const resolved = await Promise.all(
        chunk.map(async (el) => {
          try {
            const { object } = await session.sendWith('DOM.resolveNode', wait, {
              backendNodeId: el.backendNodeId,
              executionContextId: context,
              objectGroup: group,
            });
            return object.objectId;
          } catch (error) {
            if (isNodeGone(error)) return undefined;
            throw error;
          }
        }),
      );
      const validIndices: number[] = [];
      const objectIds: string[] = [];
      for (let i = 0; i < resolved.length; i++) {
        const objectId = resolved[i];
        if (objectId) {
          validIndices.push(i);
          objectIds.push(objectId);
        }
      }
      chunkResults = Array.from({ length: chunk.length }, () => ({
        ok: false,
        stale: true,
      }));
      if (objectIds.length) {
        first.assertValid();
        const call = await session.sendWith('Runtime.callFunctionOn', step(), {
          executionContextId: context,
          objectGroup: group,
          functionDeclaration,
          arguments: [argument(arg), ...objectIds.map((objectId) => ({ objectId }))],
          returnByValue: true,
        });
        checkException(call);
        first.assertValid();
        const values = valueOf(call.result) as Array<BatchProbeResult<T>>;
        for (let j = 0; j < validIndices.length; j++)
          chunkResults[validIndices[j]!] = values[j] ?? { ok: false, stale: true };
      }
    } finally {
      void releaseObjectGroup(session, group);
    }
    yield { offset, results: chunkResults };
  }
}
/**
 * @internal Streams per-chunk isolated-world filter probes (`text`, `visible`, `enabled`) using
 * the single-source-of-truth predicates in `predicates.ts`.
 */
export function batchProbeFilterChunks(
  elements: readonly Element[],
  spec: { text: boolean; visible: boolean; enabled: boolean },
  options: WaitOptions = {},
  chunkSize = 256,
): AsyncGenerator<
  { offset: number; results: Array<BatchProbeResult<ElementFilterProbe>> },
  void,
  void
> {
  return batchEvaluateDeclarationChunks<ElementFilterProbe, typeof spec>(
    elements,
    PROBE_FILTER_DECLARATION,
    spec,
    options,
    chunkSize,
  );
}
/**
 * @internal Streams per-chunk isolated-world evaluations across `elements` of the same frame so
 * callers that already satisfied their target index (`first()` / `nth()`) or found a visible item
 * stop before resolving later chunks.
 */
export function batchEvaluateIsolatedChunks<T, A = undefined>(
  elements: readonly Element[],
  fn: (element: HTMLElement, arg: A) => T,
  arg: A,
  options: WaitOptions = {},
  chunkSize = 256,
): AsyncGenerator<{ offset: number; results: Array<BatchProbeResult<T>> }, void, void> {
  return batchEvaluateDeclarationChunks<T, A>(
    elements,
    `function(arg, ...els){const fn=(${fn.toString()});return els.map(el=>!el||!el.isConnected?{ok:false,stale:true}:{ok:true,value:fn(el,arg)})}`,
    arg,
    options,
    chunkSize,
  );
}
/**
 * @internal Evaluates `fn(element, arg)` across elements of the same frame in one isolated-world
 * call per chunk, sharing one objectGroup and one parallel `DOM.resolveNode` wave. Detached or
 * vanished nodes are reported per index rather than discarding valid results in the same batch.
 */
export async function batchEvaluateIsolated<T, A = undefined>(
  elements: readonly Element[],
  fn: (element: HTMLElement, arg: A) => T,
  arg: A,
  options: WaitOptions = {},
): Promise<Array<BatchProbeResult<T>>> {
  const results: Array<BatchProbeResult<T>> = [];
  for await (const chunk of batchEvaluateIsolatedChunks(elements, fn, arg, options))
    results.push(...chunk.results);
  return results;
}
/** Maps viewport coordinates through a perspective transformed iframe content quad. */
export function project(point: Point, width: number, height: number, q: number[]): Point {
  if (q.length !== 8 || width <= 0 || height <= 0)
    throw new ActionabilityError('Invalid frame geometry');
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const dx1 = x1 - x2,
    dx2 = x3 - x2,
    dx3 = x0 - x1 + x2 - x3,
    dy1 = y1 - y2,
    dy2 = y3 - y2,
    dy3 = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12)
    throw new ActionabilityError('Degenerate frame transform');
  const g = Math.abs(dx3) + Math.abs(dy3) < 1e-8 ? 0 : (dx3 * dy2 - dx2 * dy3) / det;
  const h = Math.abs(dx3) + Math.abs(dy3) < 1e-8 ? 0 : (dx1 * dy3 - dx3 * dy1) / det;
  const u = point.x / width,
    v = point.y / height,
    z = g * u + h * v + 1;
  const result = {
    x: ((x1 - x0 + g * x1) * u + (x3 - x0 + h * x3) * v + x0) / z,
    y: ((y1 - y0 + g * y1) * u + (y3 - y0 + h * y3) * v + y0) / z,
  };
  if (!Number.isFinite(result.x) || !Number.isFinite(result.y))
    throw new ActionabilityError('Degenerate frame transform');
  return result;
}
/** Inverse of `project()`: maps parent viewport coordinates back into an iframe's viewport. */
function unproject(point: Point, width: number, height: number, q: number[]): Point | undefined {
  if (q.length !== 8 || width <= 0 || height <= 0) return undefined;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const dx1 = x1 - x2,
    dx2 = x3 - x2,
    dx3 = x0 - x1 + x2 - x3,
    dy1 = y1 - y2,
    dy2 = y3 - y2,
    dy3 = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined;
  const g = Math.abs(dx3) + Math.abs(dy3) < 1e-8 ? 0 : (dx3 * dy2 - dx2 * dy3) / det;
  const h = Math.abs(dx3) + Math.abs(dy3) < 1e-8 ? 0 : (dx1 * dy3 - dx3 * dy1) / det;
  const a = x1 - x0 + g * x1,
    b = x3 - x0 + h * x3,
    d = y1 - y0 + g * y1,
    e = y3 - y0 + h * y3;
  const m00 = a - g * point.x,
    m01 = b - h * point.x,
    m10 = d - g * point.y,
    m11 = e - h * point.y;
  const invDet = m00 * m11 - m01 * m10;
  if (!Number.isFinite(invDet) || Math.abs(invDet) < 1e-12) return undefined;
  const rx = point.x - x0,
    ry = point.y - y0;
  const u = (rx * m11 - m01 * ry) / invDet,
    v = (m00 * ry - rx * m10) / invDet;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return undefined;
  return { x: u * width, y: v * height };
}
interface AncestorLayer {
  root: Frame;
  parent: Frame;
  backendNodeId: Protocol.DOM.BackendNodeId;
  ownerQuad: number[];
  size: { width: number; height: number };
}
export class Element {
  readonly frame: Frame;
  readonly backendNodeId: Protocol.DOM.BackendNodeId;
  readonly generation: number;
  readonly session: Session;
  constructor(
    frame: Frame,
    backendNodeId: Protocol.DOM.BackendNodeId,
    generation: number,
    session: Session,
  ) {
    this.frame = frame;
    this.backendNodeId = backendNodeId;
    this.generation = generation;
    this.session = session;
  }
  assertValid(): void {
    if (this.frame.detached)
      throw new StaleElementError('Element belongs to a detached frame', {
        reason: 'frame-detached',
      });
    if (
      this.session.closed ||
      this.frame.generation !== this.generation ||
      this.frame.session !== this.session
    )
      throw new StaleElementError('Element belongs to an expired document/session', {
        reason: 'context-gone',
      });
  }
  private send<M extends Command>(
    session: Session,
    method: M,
    ...params: Params<M>
  ): Promise<Result<M>> {
    const action = this.frame.tab.inputBehavior.current;
    const own = operation.getStore()?.();
    if (!action) return session.sendWith(method, own ?? {}, ...params);
    // Inside an input action, a read's own budget still applies, on top of the action's.
    const sending = action.send(session, method, ...params);
    return own ? bounded(sending, own, 'Element read') : sending;
  }
  private async releaseGroup(objectGroup: string): Promise<void> {
    const action = this.frame.tab.inputBehavior.current;
    if (action) await action.releaseReadObjects(this.session, { objectGroup });
    else await releaseObjectGroup(this.session, objectGroup);
  }
  /**
   * The remaining budget of the current input action and operation. Nested input calls take this,
   * not the caller's options: the action already calls the caller's guard at each checkpoint.
   */
  private step(): WaitOptions {
    const action = this.frame.tab.inputBehavior.current;
    action?.observe(this.session);
    const own = operation.getStore()?.();
    const outer = action?.step();
    return outer && own ? narrower(outer, own) : (outer ?? own ?? {});
  }
  private async input<T>(name: string, options: InputOptions, task: () => Promise<T>): Promise<T> {
    let result!: T;
    await this.frame.tab.inputBehavior.action(name, options, async (action) => {
      this.assertValid();
      for (let frame: Frame | undefined = this.frame; frame; frame = frame.parent)
        action.watch(frame.session, frame.id);
      result = await task();
    });
    return result;
  }
  /**
   * Runs `fn` with a handle to the element in the selected world (isolated by default). Objects
   * that `fn` creates in `group` are released together with the handle.
   */
  async withObject<T>(
    fn: (objectId: string, group: string) => Promise<T>,
    options: ElementEvaluateOptions = {},
  ): Promise<T> {
    if (options.world !== undefined && !['main', 'isolated'].includes(options.world))
      throw new TypeError('Invalid execution world');
    return this.read('element handle', options, () =>
      this.withWorldObject(options.world ?? 'isolated', fn),
    );
  }
  /** Internal probes never inherit the world selected by a public evaluation. */
  private withIsolatedObject<T>(fn: (objectId: string, group: string) => Promise<T>): Promise<T> {
    return this.withWorldObject('isolated', fn);
  }
  private async withWorldObject<T>(
    world: World,
    fn: (objectId: string, group: string) => Promise<T>,
  ): Promise<T> {
    this.assertValid();
    const context = await this.frame.context(world, this.step());
    const group = `nodriver-element-${++objectGroupId}`;
    try {
      let object: Protocol.Runtime.RemoteObject;
      try {
        ({ object } = await this.send(this.session, 'DOM.resolveNode', {
          backendNodeId: this.backendNodeId,
          executionContextId: context,
          objectGroup: group,
        }));
      } catch (error) {
        if (isNodeGone(error))
          throw new StaleElementError('Node no longer exists', {
            cause: error,
            reason: 'node-detached',
          });
        throw error;
      }
      if (!object.objectId)
        throw new StaleElementError('Node no longer exists', { reason: 'node-detached' });
      this.assertValid();
      const connected = await this.send(this.session, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function(){return this.isConnected}',
        returnByValue: true,
      });
      if (connected.result.value !== true)
        throw new StaleElementError('Element was removed from its document', {
          reason: 'node-detached',
        });
      const wait = this.step();
      return await bounded(fn(object.objectId, group), wait, 'Element callback');
    } finally {
      await this.releaseGroup(group);
    }
  }
  async evaluate<T = unknown, A = unknown>(
    fn: (element: HTMLElement, arg: A) => T | Promise<T>,
    arg?: A,
    options: ElementEvaluateOptions = {},
  ): Promise<T> {
    return this.withObject(async (objectId, objectGroup) => {
      const detachedSentinel = `__nodriver_detached_${randomUUID()}__`;
      const result = await this.send(this.session, 'Runtime.callFunctionOn', {
        objectId,
        objectGroup,
        functionDeclaration: `function(arg){if(!this.isConnected)throw ${JSON.stringify(detachedSentinel)};return (${fn.toString()})(this,arg)}`,
        arguments: [argument(arg)],
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        const desc = formatExceptionDetails(result.exceptionDetails);
        if (desc.includes(detachedSentinel)) {
          releaseRemoteObjects(this.session, [result.exceptionDetails.exception?.objectId]);
          throw new StaleElementError('Element was removed from its document');
        }
      }
      checkException(result);
      this.assertValid();
      return valueOf(result.result) as T;
    }, options);
  }
  private evaluateIsolated<T = unknown, A = unknown>(
    fn: (element: HTMLElement, arg: A) => T | Promise<T>,
    arg?: A,
  ): Promise<T> {
    return this.evaluate(fn, arg, { world: 'isolated' });
  }
  /** Runs a read under one timeout and signal shared by all of its CDP requests. */
  private read<T>(label: string, options: WaitOptions, fn: () => Promise<T>): Promise<T> {
    if (options.timeout === undefined && !options.signal) return fn();
    const own = budget(options, label),
      outer = operation.getStore();
    return operation.run(outer ? () => narrower(outer(), own()) : own, fn);
  }
  async text(options: WaitOptions = {}): Promise<string> {
    return this.read('text', options, () => this.evaluateIsolated((el) => el.textContent ?? ''));
  }
  async html(options: WaitOptions = {}): Promise<string> {
    return this.read('html', options, () => this.evaluateIsolated((el) => el.outerHTML));
  }
  async attribute(name: string, options: WaitOptions = {}): Promise<string | null> {
    return this.read('attribute', options, () =>
      this.evaluateIsolated((el, key) => el.getAttribute(key), name),
    );
  }
  /**
   * Read-only visibility probe aligned with actionability checks (computed `display`/`visibility`,
   * composed-tree `checkVisibility({ visibilityProperty: true })`, and non-empty bounding box).
   */
  async isVisible(options: WaitOptions = {}): Promise<boolean> {
    return this.read('isVisible', options, () => this.evaluateIsolated(isElementVisible));
  }
  /**
   * Read-only enabled probe aligned with `click()` and `setChecked()` (`:disabled`, including
   * ancestor `<fieldset disabled>`, and `aria-disabled="true"`).
   */
  async isEnabled(options: WaitOptions = {}): Promise<boolean> {
    return this.read('isEnabled', options, () => this.evaluateIsolated(isElementEnabled));
  }
  /**
   * Read-only checked probe for native checkboxes/radios and ARIA checkable elements
   * (`role="checkbox"|"radio"|"switch"|"menuitemcheckbox"|"menuitemradio"` or explicit
   * `aria-checked`). Throws `ActionabilityError` for non-checkable elements.
   */
  async isChecked(options: WaitOptions = {}): Promise<boolean> {
    return this.read('isChecked', options, async () => {
      const result = await this.evaluateIsolated((el) => {
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
          return { ok: true as const, checked: el.checked };
        const role = el.getAttribute('role')?.trim().toLowerCase();
        const aria = el.getAttribute('aria-checked');
        if (
          aria !== null ||
          (role !== undefined &&
            ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role))
        )
          return { ok: true as const, checked: aria === 'true' };
        return { ok: false as const };
      });
      if (!result.ok)
        throw new ActionabilityError(
          'isChecked() requires a checkbox, radio, or element with aria-checked',
        );
      return result.checked;
    });
  }
  async describe(): Promise<Protocol.DOM.Node> {
    this.assertValid();
    try {
      return (
        await this.send(this.session, 'DOM.describeNode', {
          backendNodeId: this.backendNodeId,
          depth: 1,
          pierce: true,
        })
      ).node;
    } catch (error) {
      if (isNodeGone(error)) throw new StaleElementError('Node no longer exists', { cause: error });
      throw error;
    }
  }
  async queryAll(selector: Selector, options?: QueryOptions): Promise<Element[]> {
    this.assertValid();
    return query(this.frame, selector, options, this.backendNodeId);
  }
  async query(selector: Selector, options?: QueryOptions): Promise<Element | undefined> {
    return (await this.queryAll(selector, { ...options, limit: 1 }))[0];
  }
  /**
   * One input action: the timeout, signal and guard cover reading the state, waiting while the
   * control is disabled, the click and waiting up to 1 s for the requested state. Clicks the
   * control, or its first rendered label when the control cannot be hit (a native control hidden
   * behind a styled label). The click is never repeated. A checked radio cannot be unchecked.
   */
  async setChecked(checked: boolean, options: InputOptions = {}): Promise<SetCheckedResult> {
    return this.input('setChecked', options, async () => {
      const read = async () => {
        const result = await this.evaluateIsolated((el) => {
          // setChecked requires checkbox or radio
          if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(el.type))
            return { ok: false as const };
          return {
            ok: true as const,
            checked: el.checked,
            radio: el.type === 'radio',
            rendered:
              typeof el.checkVisibility === 'function'
                ? el.checkVisibility({ visibilityProperty: true })
                : true,
            // Includes a control inside a disabled fieldset and aria-disabled="true".
            disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
          };
        });
        if (!result.ok)
          throw new ActionabilityError('setChecked() requires a checkbox or radio input');
        return result;
      };
      let state = await read();
      if (state.checked === checked) return { changed: false };
      if (state.radio && !checked)
        throw new ActionabilityError(
          'A radio cannot be unchecked by clicking it; check another radio of its group',
        );
      // A label would still run its own click handlers for a disabled control.
      if (state.disabled)
        state = await poll(
          async () => {
            const next = await read();
            return next.disabled && next.checked !== checked ? undefined : next;
          },
          this.step(),
          'enabled control',
        );
      if (state.checked === checked) return { changed: false };
      if (state.rendered) await this.scrollIntoView(this.step());
      const label = await this.labelToClick();
      const clickBudget = this.step();
      if (label)
        // The control can become disabled while the pointer moves; its label would still act.
        await label.clickElement(clickBudget, async () => {
          if ((await read()).disabled)
            throw new ActionabilityError(
              'Control became disabled during pointer movement; click not dispatched',
            );
        });
      else await this.click(clickBudget);
      try {
        await poll(
          async () =>
            (await this.evaluateIsolated((el) => (el as HTMLInputElement).checked)) === checked
              ? true
              : undefined,
          narrower(this.step(), { timeout: 1000 }),
          'requested checked state',
        );
      } catch (error) {
        if (error instanceof ActionabilityError) throw error;
        if (error instanceof Error && error.name === 'TimeoutError' && !this.step().signal?.aborted)
          throw new ActionabilityError(
            'Input did not reach requested checked state; the click was not repeated',
            { cause: error },
          );
        throw error;
      }
      return { changed: true, clicked: label ? 'label' : 'control' };
    });
  }
  /** The first rendered label of a control that a click at its center would not reach. */
  private labelToClick(): Promise<Element | undefined> {
    const declaration = `function(){const isVisible=(${isElementVisible.toString()});const inside=(${isInComposedTree.toString()});const box=target=>isVisible(target)?target.getBoundingClientRect():undefined;const el=this;const r=box(el);if(r){const x=r.left+r.width/2,y=r.top+r.height/2;const hit=el.getRootNode().elementFromPoint(x,y);if(inside(hit,el))return null;}return Array.from(el.labels??[]).find(label=>box(label))??null;}`;
    return this.withIsolatedObject(async (objectId, objectGroup) => {
      const result = await this.send(this.session, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: declaration,
        objectGroup,
      });
      checkException(result);
      if (!result.result.objectId) return undefined;
      const { node } = await this.send(this.session, 'DOM.describeNode', {
        objectId: result.result.objectId,
      });
      return new Element(this.frame, node.backendNodeId, this.generation, this.session);
    });
  }
  async screenshot(
    options: {
      path?: string;
      format?: 'png' | 'jpeg' | 'webp';
      quality?: number;
      scale?: number;
    } = {},
  ): Promise<Buffer> {
    this.assertValid();
    await this.scrollNodeIntoView();
    const point = await this.localPoint(0.5, 0.5, { requireEnabled: false, requireHit: false });
    if (!point) throw new ActionabilityError('Element is not visible');
    const rect = await this.evaluateIsolated((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    const metrics = await this.send(this.frame.tab.session, 'Page.getLayoutMetrics');
    return this.frame.tab.screenshot({
      path: options.path,
      format: options.format,
      quality: options.quality,
      clip: {
        x: point.x - rect.width / 2 + metrics.cssLayoutViewport.pageX,
        y: point.y - rect.height / 2 + metrics.cssLayoutViewport.pageY,
        width: rect.width,
        height: rect.height,
        scale: options.scale ?? 1,
      },
    });
  }
  async focus(): Promise<void> {
    this.assertValid();
    try {
      await this.send(this.session, 'DOM.focus', { backendNodeId: this.backendNodeId });
    } catch (error) {
      if (isNodeGone(error)) throw new StaleElementError('Node no longer exists', { cause: error });
      throw error;
    }
  }
  async upload(files: string[]): Promise<void> {
    this.assertValid();
    const paths = files.map((p) => resolve(p));
    for (const path of paths) await access(path);
    try {
      await this.send(this.session, 'DOM.setFileInputFiles', {
        backendNodeId: this.backendNodeId,
        files: paths,
      });
    } catch (error) {
      if (isNodeGone(error)) throw new StaleElementError('Node no longer exists', { cause: error });
      throw error;
    }
  }
  private async localPoint(
    u = 0.5,
    v = 0.5,
    {
      requireEnabled = true,
      requireHit = true,
    }: { requireEnabled?: boolean; requireHit?: boolean } = {},
  ): Promise<(Point & { targetWidth: number; layers: AncestorLayer[] }) | undefined> {
    this.assertValid();
    const state = await this.evaluateIsolated(
      (el, { u, v, requireEnabled, requireHit }) => {
        const style = getComputedStyle(el);
        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          (typeof el.checkVisibility !== 'function' ||
            el.checkVisibility({ visibilityProperty: true }));
        const rect = el.getBoundingClientRect();
        const x =
          Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) * u;
        const y =
          Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) * v;
        // The hit is retargeted to the element's tree; composed ancestors also cover a hit inside
        // the element's own shadow tree.
        let reaches = !requireHit;
        if (requireHit) {
          const hit = (el.getRootNode() as Document | ShadowRoot).elementFromPoint(x, y);
          for (let n: Node | null = hit; n && !reaches; n = n.parentNode ?? (n as ShadowRoot).host)
            reaches = n === el;
        }
        const enabled =
          !requireEnabled ||
          (!el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true');
        return {
          valid:
            rect.width > 0 &&
            rect.height > 0 &&
            x >= rect.left &&
            y >= rect.top &&
            x < rect.right &&
            y < rect.bottom &&
            x >= 0 &&
            y >= 0 &&
            x < innerWidth &&
            y < innerHeight &&
            visible &&
            enabled &&
            reaches,
          // The same point as a fraction of the whole element, which the quad below spans.
          u: (x - rect.left) / rect.width,
          v: (y - rect.top) / rect.height,
        };
      },
      { u, v, requireEnabled, requireHit },
    );
    if (!state.valid) return undefined;
    let quads: Protocol.DOM.Quad[];
    try {
      ({ quads } = await this.send(this.session, 'DOM.getContentQuads', {
        backendNodeId: this.backendNodeId,
      }));
    } catch (error) {
      if (isNoLayoutObject(error)) return undefined;
      if (isNodeGone(error)) throw new StaleElementError('Node no longer exists', { cause: error });
      throw error;
    }
    const quad = quads[0];
    if (!quad) return undefined;
    // CDP returns coordinates in the viewport of the session root, including in-process frame offsets.
    let point = project({ x: state.u, y: state.v }, 1, 1, quad);
    let edgeX = project({ x: 1, y: 0 }, 1, 1, quad);
    let edgeY = project({ x: 0, y: 1 }, 1, 1, quad);
    let corner = project({ x: 0, y: 0 }, 1, 1, quad);
    let session = this.session;
    const seen = new Set<string>();
    const layers: AncestorLayer[] = [];
    while (session !== this.frame.tab.session) {
      const root = [...this.frame.manager.frames.values()].find(
        (f) => !f.detached && f.session === session && f.parent && f.parent.session !== session,
      );
      if (!root?.parent || seen.has(root.id)) return undefined;
      seen.add(root.id);
      const parent = root.parent;
      let backendNodeId: Protocol.DOM.BackendNodeId;
      let ownerQuad: number[];
      try {
        ({ backendNodeId } = await this.send(parent.session, 'DOM.getFrameOwner', {
          frameId: root.id,
        }));
        const { model } = await this.send(parent.session, 'DOM.getBoxModel', { backendNodeId });
        ownerQuad = model.content;
      } catch (error) {
        if (isNoLayoutObject(error)) return undefined;
        if (isNodeGone(error))
          throw new StaleElementError('Frame owner no longer exists', { cause: error });
        throw error;
      }
      const size = await root.evaluate<{ width: number; height: number }>(
        '({width: innerWidth,height: innerHeight})',
        undefined,
        { world: 'isolated', ...this.step() },
      );
      if (point.x < 0 || point.y < 0 || point.x >= size.width || point.y >= size.height)
        return undefined;
      point = project(point, size.width, size.height, ownerQuad);
      edgeX = project(edgeX, size.width, size.height, ownerQuad);
      edgeY = project(edgeY, size.width, size.height, ownerQuad);
      corner = project(corner, size.width, size.height, ownerQuad);
      if (requireHit) {
        const hit = await this.hitTest(parent.session, point);
        if (hit?.backendNodeId !== backendNodeId && hit?.frameId !== root.id) return undefined;
      }
      layers.push({ root, parent, backendNodeId, ownerQuad, size });
      session = parent.session;
    }
    return {
      ...point,
      layers,
      targetWidth: Math.max(
        1,
        Math.min(
          Math.hypot(edgeX.x - corner.x, edgeX.y - corner.y),
          Math.hypot(edgeY.x - corner.x, edgeY.y - corner.y),
        ),
      ),
    };
  }
  /**
   * Re-verifies an exact root-viewport press coordinate (such as a `pointerGrid`-snapped
   * `checkpoint`) across every ancestor frame and inside the target OOPIF without moving the mouse.
   */
  private async verifyOopifPoint(point: Point, layers: AncestorLayer[]): Promise<boolean> {
    if (!layers.length) return false;
    let current: Point = point;
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]!;
      const hit = await this.hitTest(layer.parent.session, current);
      if (hit?.backendNodeId !== layer.backendNodeId && hit?.frameId !== layer.root.id)
        return false;
      const mapped = unproject(current, layer.size.width, layer.size.height, layer.ownerQuad);
      if (
        !mapped ||
        mapped.x < 0 ||
        mapped.y < 0 ||
        mapped.x >= layer.size.width ||
        mapped.y >= layer.size.height
      )
        return false;
      current = mapped;
    }
    const rootFrame = layers[0]!.root;
    if (this.frame === rootFrame) {
      return this.evaluateIsolated((el, { x, y }) => {
        const hit = (el.getRootNode() as Document | ShadowRoot).elementFromPoint(x, y);
        for (let n: Node | null = hit; n; n = n.parentNode ?? (n as ShadowRoot).host)
          if (n === el) return true;
        return false;
      }, current);
    }
    return this.unobscuredInSession(this.session, current);
  }
  /**
   * The topmost node at a viewport point of the session's root frame, possibly inside a shadow
   * tree but never a user-agent one; undefined where there is none.
   */
  private async hitTest(
    session: Session,
    point: Point,
  ): Promise<Protocol.DOM.GetNodeForLocationResponse | undefined> {
    // DOM hit testing uses page coordinates; Input dispatch and quads use viewport coordinates.
    const metrics = await this.send(session, 'Page.getLayoutMetrics');
    try {
      return await this.send(session, 'DOM.getNodeForLocation', {
        x: Math.round(point.x + metrics.cssLayoutViewport.pageX),
        y: Math.round(point.y + metrics.cssLayoutViewport.pageY),
        includeUserAgentShadowDOM: false,
      });
    } catch (error) {
      if (isNodeGone(error)) return undefined;
      throw error;
    }
  }
  private async receivesPointer(
    point: Point & { targetWidth?: number },
    options: WaitOptions,
  ): Promise<boolean> {
    return this.withIsolatedObject(async (objectId) => {
      // Arm the probe right before the final move to the snapped target so intermediate trajectory
      // samples crossing the element cannot report a hit when the resting press point misses it.
      // State gets its own explicit `stateGroup` (omitting `objectGroup` in CDP inherits the
      // receiver's group!) so `withIsolatedObject` releasing `group` cannot invalidate `state`
      // before late-reply cleanup calls `state.remove()`.
      const action = this.frame.tab.inputBehavior.current;
      const stateGroup = `nodriver-pointer-probe-${++objectGroupId}`;
      let stateId: string | undefined;
      let disposed = false;
      const cleaned = new Set<string>();
      const cleanupState = (id: string): Promise<void> => {
        if (cleaned.has(id)) return Promise.resolve();
        cleaned.add(id);
        const session = this.session;
        const remove = action
          ? action.sendCleanup(session, 'Runtime.callFunctionOn', {
              objectId: id,
              functionDeclaration: 'function(){this.remove()}',
              returnByValue: true,
            })
          : session.sendWith(
              'Runtime.callFunctionOn',
              { timeout: 1000 },
              {
                objectId: id,
                functionDeclaration: 'function(){this.remove()}',
                returnByValue: true,
              },
            );
        // Queued synchronously right after `remove` so CDP executes them in FIFO order and both
        // `InputAction.cleanup` and `Connection.drain()` wait for listener removal + group release.
        const release = action
          ? action.releaseReadObjects(session, { objectGroup: stateGroup })
          : releaseObjectGroup(session, stateGroup);
        return Promise.all([remove.catch(() => {}), release.catch(() => {})]).then(() => {});
      };
      const arm = async () => {
        if (stateId) {
          await this.send(this.session, 'Runtime.callFunctionOn', {
            objectId: stateId,
            functionDeclaration: 'function(){this.hit=false}',
            returnByValue: true,
          });
          return;
        }
        const params: Protocol.Runtime.CallFunctionOnRequest = {
          objectId,
          objectGroup: stateGroup,
          functionDeclaration:
            'function(){const el=this;const doc=el.ownerDocument;const inside=n=>{for(;n;n=n.parentNode??n.host)if(n===el)return true;return false};const state={hit:false,onElMove:()=>{state.hit=true},onDocMove:e=>{state.hit=inside(e.target)},onLeave:()=>{state.hit=false},remove:()=>{el.removeEventListener("mousemove",state.onElMove,true);el.removeEventListener("mouseleave",state.onLeave,false);if(doc&&doc.removeEventListener)doc.removeEventListener("mousemove",state.onDocMove,true)}};el.addEventListener("mousemove",state.onElMove,true);el.addEventListener("mouseleave",state.onLeave,false);if(doc&&doc.addEventListener)doc.addEventListener("mousemove",state.onDocMove,true);return state}',
        };
        const onLateReply = (reply: Protocol.Runtime.CallFunctionOnResponse) => {
          const id = reply?.result?.objectId;
          if (id) void cleanupState(id);
        };
        const own = operation.getStore()?.();
        const raw = action
          ? action.sendObserved(this.session, 'Runtime.callFunctionOn', { onLateReply }, params)
          : this.session.sendWith(
              'Runtime.callFunctionOn',
              { ...(own ?? {}), [ON_LATE_REPLY]: onLateReply } as LedgerOptions,
              params,
            );
        void raw.then(
          (reply) => {
            if (disposed && reply.result.objectId) void cleanupState(reply.result.objectId);
          },
          () => {},
        );
        const { result: state } = await (action && own ? bounded(raw, own, 'Element read') : raw);
        if (!state.objectId) throw new StaleElementError('Element pointer probe failed');
        stateId = state.objectId;
      };
      try {
        // OOPIF compositor hit-test data may lag layout after a transform or scroll.
        // Wait for real hover delivery at the final resting point before dispatching the press.
        await this.frame.tab.mouse.reach(point.x, point.y, {
          ...this.step(),
          targetWidth: point.targetWidth,
          beforeFinalMove: arm,
        });
        if (!stateId) return false;
        const end = performance.now() + 100;
        do {
          const r = await this.send(this.session, 'Runtime.callFunctionOn', {
            objectId: stateId,
            functionDeclaration: 'function(){return this.hit}',
            returnByValue: true,
          });
          if (r.result.value === true) return true;
          await delay(10, this.step().signal ?? options.signal);
        } while (performance.now() < end);
        return false;
      } finally {
        disposed = true;
        if (stateId) await cleanupState(stateId);
      }
    });
  }
  /** Root-viewport hit test: true when the point reaches this element (or, in OOPIFs, receives hover). */
  private async unobscured(
    point: Point & { targetWidth?: number },
    options: WaitOptions,
  ): Promise<boolean> {
    const tab = this.frame.tab;
    if (this.session !== tab.session) return this.receivesPointer(point, options);
    return this.unobscuredInSession(tab.session, point);
  }
  private async unobscuredInSession(session: Session, point: Point): Promise<boolean> {
    const hit = await this.hitTest(session, point);
    if (!hit) return false;
    if (hit.frameId === this.frame.id && hit.backendNodeId === this.backendNodeId) return true;
    let node = hit.backendNodeId;
    if (hit.frameId !== this.frame.id) {
      // A hit in a frame below this element's frame counts through that frame's owner element;
      // a hit in any other frame covers the element.
      let frame = this.frame.manager.frames.get(hit.frameId);
      while (frame?.parent && frame.parent !== this.frame) frame = frame.parent;
      if (!frame || frame.parent !== this.frame) return false;
      ({ backendNodeId: node } = await this.send(session, 'DOM.getFrameOwner', {
        frameId: frame.id,
      }));
    }
    return this.withIsolatedObject(async (objectId, group) => {
      let object: Protocol.Runtime.RemoteObject;
      try {
        ({ object } = await this.send(session, 'DOM.resolveNode', {
          backendNodeId: node,
          executionContextId: await this.frame.context('isolated', this.step()),
          objectGroup: group,
        }));
      } catch (error) {
        if (isNodeGone(error)) return false;
        throw error;
      }
      if (!object.objectId) return false;
      const result = await this.send(session, 'Runtime.callFunctionOn', {
        objectId,
        // Composed ancestors: the hit can be inside the element's shadow tree.
        functionDeclaration:
          'function(hit){for(let n=hit;n;n=n.parentNode??n.host)if(n===this)return true;return false}',
        arguments: [{ objectId: object.objectId }],
        returnByValue: true,
      });
      checkException(result);
      return result.result.value === true;
    });
  }
  private async scrollNodeIntoView(): Promise<void> {
    try {
      await this.send(this.session, 'DOM.scrollIntoViewIfNeeded', {
        backendNodeId: this.backendNodeId,
      });
    } catch (error) {
      if (isNodeGone(error)) throw new StaleElementError('Node no longer exists', { cause: error });
      if (isNoLayoutObject(error))
        throw new ActionabilityError('Element does not have a layout object', { cause: error });
      throw error;
    }
  }
  /**
   * Scrolls like a user (wheel at the pointer) in human mode when the element is in the main
   * frame, then lets Chrome finish if needed.
   */
  async scrollIntoView(options: WaitOptions = {}): Promise<void> {
    // One budget covers the geometry reads, the wheel and Chrome's scroll.
    await this.read('Scroll into view', options, async () => {
      this.assertValid();
      const { mode, scroll } = this.frame.tab.inputBehavior.policy;
      if (scroll === 'wheel' || (scroll === 'auto' && mode === 'human'))
        if (this.frame === this.frame.tab.mainFrame) await this.wheelIntoView();
      // A no-op when already visible; also covers clipped scroll containers and nested frames.
      await this.scrollNodeIntoView();
    });
  }
  private async wheelIntoView(): Promise<void> {
    const tab = this.frame.tab;
    const random = () => tab.inputBehavior.random();
    const box = () =>
      this.evaluateIsolated((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          w: innerWidth,
          h: innerHeight,
          hasBox: r.width > 0 || r.height > 0 || el.getClientRects().length > 0,
        };
      });
    const offset = (center: number, extent: number) =>
      center >= extent * 0.08 && center <= extent * 0.92
        ? 0
        : Math.max(-2 * extent, Math.min(2 * extent, center - extent * (0.3 + 0.3 * random())));
    let current = await box();
    // Skip wheeling when the element has no layout box (e.g. display: none); Chrome's scroll step
    // then surfaces the normalized ActionabilityError cleanly.
    if (current.hasBox === false) return;
    // Distant targets would spend the input budget on wheel packets; Chrome scrolls the rest.
    const until = performance.now() + WHEEL_INTO_VIEW;
    for (let attempt = 0; attempt < 12 && performance.now() < until; attempt++) {
      const dx = offset(current.x, current.w),
        dy = offset(current.y, current.h);
      if (!dx && !dy) return;
      // The wheel stops at the limit, also within a round; Chrome scrolls the rest.
      await tab.mouse.wheel(dx, dy, { ...this.step(), until });
      // The pause between rounds spends the same budget; the next read fails once it is spent.
      const { timeout = Infinity, signal } = this.step();
      await delay(Math.min(40 + 60 * random(), timeout), signal);
      const next = await box();
      if (next.hasBox === false) return;
      // The pointer is over a container that cannot scroll toward the target.
      if (Math.abs(next.x - current.x) < 1 && Math.abs(next.y - current.y) < 1) return;
      current = next;
    }
  }
  async click(
    options: InputOptions & { button?: Protocol.Input.MouseButton; clickCount?: number } = {},
  ): Promise<void> {
    await this.clickElement(options);
  }
  /** click(), with `check` run again right before the press. */
  private async clickElement(
    options: InputOptions & { button?: Protocol.Input.MouseButton; clickCount?: number },
    check?: () => Promise<void>,
  ): Promise<void> {
    await this.input('click', options, async () => {
      this.assertValid();
      const behavior = this.frame.tab.inputBehavior;
      const inset = behavior.policy.targetInset;
      const u =
        behavior.policy.mode === 'human'
          ? targetCoordinate(() => behavior.random(), inset, 0.5)
          : 0.5;
      const v =
        behavior.policy.mode === 'human'
          ? targetCoordinate(() => behavior.random(), inset, 0.45)
          : 0.5;
      const oopif = this.session !== this.frame.tab.session;
      const pollBudget =
        options.timeout === undefined ? narrower(this.step(), { timeout: 10_000 }) : this.step();
      let scrolled = false;
      let confirmedPointer: Point | undefined;
      const point = await poll(
        async (step) => {
          if (!scrolled) {
            try {
              await this.scrollIntoView(step);
            } catch (error) {
              if (isNoLayoutActionability(error)) return undefined;
              throw error;
            }
            scrolled = true;
          }
          const first = await this.localPoint(u, v);
          if (!first) return undefined;
          await delay(32, step.signal);
          const second = await this.localPoint(u, v);
          if (!second || Math.hypot(first.x - second.x, first.y - second.y) > 0.5) return undefined;
          // Root-session hit testing catches overlays covering iframe elements as well as local nodes.
          if (!(await this.unobscured(second, step))) return undefined;
          if (oopif) {
            const pos = this.frame.tab.mouse.position;
            confirmedPointer = { x: pos.x, y: pos.y };
          }
          return second;
        },
        pollBudget,
        'visible, enabled, stable and unobscured element',
      );
      this.assertValid();
      await this.frame.tab.mouse.click(point.x, point.y, {
        ...options,
        targetWidth: point.targetWidth,
        skipMoveIfAtTarget: oopif && confirmedPointer !== undefined,
        // OOPIF hit confirmation itself moves the pointer; never run it with a held button. A
        // failed check, such as a page removing the element on mousedown, only skips the slip.
        beforeSlip: (x, y) =>
          this.session === this.frame.tab.session
            ? this.unobscured({ x, y }, this.step()).catch(() => false)
            : Promise.resolve(false),
        guard: async (checkpoint) => {
          this.assertValid();
          if (checkpoint.type !== 'mouseDown') return;
          const current = await this.localPoint(u, v);
          if (!current || Math.hypot(current.x - point.x, current.y - point.y) > 0.5)
            throw new ActionabilityError(
              'Target moved or became obstructed during pointer movement; click not dispatched',
            );
          // For OOPIFs, poll() already delivered the pointer to `confirmedPointer` and verified
          // real hover delivery inside the same input lock. Always re-verify the actual press
          // coordinate across ancestor frames and inside the OOPIF (even without `pointerGrid`,
          // transformed/clipped elements can project a quad point away from the bbox hit point),
          // without moving the mouse again.
          const alreadyConfirmed =
            oopif &&
            confirmedPointer !== undefined &&
            Math.hypot(checkpoint.x - confirmedPointer.x, checkpoint.y - confirmedPointer.y) < 0.01;
          const pressPointOk = alreadyConfirmed
            ? await this.verifyOopifPoint({ x: checkpoint.x, y: checkpoint.y }, current.layers)
            : await this.unobscured({ x: checkpoint.x, y: checkpoint.y }, this.step());
          // The press goes where the pointer is, which a pointer grid can set apart from the point.
          if (!pressPointOk)
            throw new ActionabilityError(
              this.session === this.frame.tab.session
                ? 'Pointer is obstructed; click not dispatched'
                : 'Frame pointer hit was lost; click not dispatched',
            );
          await check?.();
        },
      });
    });
  }
  /** Moves the pointer over the element (visible and unobscured) without pressing. */
  async hover(options: InputOptions = {}): Promise<Point> {
    return this.input('hover', options, async () => {
      this.assertValid();
      const behavior = this.frame.tab.inputBehavior;
      const inset = behavior.policy.targetInset;
      const pick = (mean: number) =>
        behavior.policy.mode === 'human'
          ? targetCoordinate(() => behavior.random(), inset, mean)
          : 0.5;
      const u = pick(0.5),
        v = pick(0.45);
      const oopif = this.session !== this.frame.tab.session;
      const pollBudget =
        options.timeout === undefined ? narrower(this.step(), { timeout: 10_000 }) : this.step();
      let scrolled = false;
      const point = await poll(
        async (step) => {
          if (!scrolled) {
            try {
              await this.scrollIntoView(step);
            } catch (error) {
              if (isNoLayoutActionability(error)) return undefined;
              throw error;
            }
            scrolled = true;
          }
          const local = await this.localPoint(u, v, { requireEnabled: false, requireHit: true });
          return local && (await this.unobscured(local, step)) ? local : undefined;
        },
        pollBudget,
        'visible and unobscured element',
      );
      await this.frame.tab.mouse.move(point.x, point.y, {
        ...options,
        skipMoveIfAtTarget: oopif,
        guard: () => this.assertValid(),
      });
      return { x: point.x, y: point.y };
    });
  }
  /** Viewport point inside the element, scrolling it into view first. */
  async clickablePoint(options: WaitOptions = {}): Promise<Point> {
    const step = budget({ ...options, timeout: options.timeout ?? 10_000 }, 'clickablePoint');
    return operation.run(step, async () => {
      let scrolled = false;
      const point = await poll(
        async (remaining) => {
          if (!scrolled) {
            try {
              await this.scrollIntoView(remaining);
            } catch (error) {
              if (isNoLayoutActionability(error)) return undefined;
              throw error;
            }
            scrolled = true;
          }
          return this.localPoint();
        },
        step(),
        'visible element',
      );
      return { x: point.x, y: point.y };
    });
  }
  async fill(text: string, options: InputOptions = {}): Promise<void> {
    await this.input('fill', options, async () => {
      if (options.signal?.aborted) throw abortReason(options.signal);
      const problem = await this.evaluateIsolated((el) => {
        if (
          el.matches(':disabled') ||
          el.getAttribute('aria-disabled') === 'true' ||
          (el as HTMLInputElement).readOnly
        )
          return 'Element is disabled or read-only';
        el.focus();
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
        else if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
        } else return 'fill() requires an input, textarea or contenteditable element';
        return undefined;
      });
      if (typeof problem === 'string') throw new ActionabilityError(problem);
      this.assertValid();
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (
        !(await this.evaluateIsolated(
          (el) => (el.getRootNode() as Document | ShadowRoot).activeElement === el,
        ))
      )
        throw new ActionabilityError('Fill target lost focus before insertion');
      await this.frame.tab.keyboard.insertText(text, {
        ...options,
        guard: () => this.assertValid(),
      });
      if (options.signal?.aborted) throw abortReason(options.signal);
    });
  }
  /**
   * Types at the current caret/selection one grapheme at a time. With replace: true it first
   * selects the whole value, as fill() does, so the typed text replaces it; an empty text then
   * deletes the value with Backspace.
   */
  async type(text: string | string[], options: TypeOptions = {}): Promise<InputReport> {
    const { replace, ...input } = options;
    return this.input('type', input, async () => {
      if (input.signal?.aborted) throw abortReason(input.signal);
      this.assertValid();
      const outcome = await this.evaluateIsolated((el, replace) => {
        if (
          el.matches(':disabled') ||
          el.getAttribute('aria-disabled') === 'true' ||
          (el as HTMLInputElement).readOnly ||
          (!(el instanceof HTMLInputElement) &&
            !(el instanceof HTMLTextAreaElement) &&
            !el.isContentEditable)
        )
          return { error: 'type() requires an enabled editable element' };
        el.focus();
        if (!replace) return false;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.select();
          return el.value !== '';
        }
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return !range.collapsed;
      }, replace === true);
      if (typeof outcome === 'object' && outcome !== null && 'error' in outcome)
        throw new ActionabilityError(outcome.error);
      const selected = outcome === true;
      const guarded = {
        ...input,
        // Focus matters where text goes in: before each key, between a key and its character,
        // and before inserted text.
        guard: async (checkpoint: InputCheckpoint) => {
          this.assertValid();
          if (!['keyDown', 'char', 'text'].includes(checkpoint.type)) return;
          const focused = await this.evaluateIsolated(
            (el) => (el.getRootNode() as Document | ShadowRoot).activeElement === el,
          );
          if (!focused)
            throw new ActionabilityError('Typing target lost focus; no further text inserted');
        },
      };
      if (selected && (typeof text === 'string' ? text : text.join('')) === '')
        await this.frame.tab.keyboard.press('Backspace', guarded);
      return this.frame.tab.keyboard.type(text, guarded);
    });
  }
  async select(values: string | string[]): Promise<string[]> {
    return this.frame.tab.withInput(async () => {
      const outcome = await this.evaluateIsolated((el, values) => {
        if (!(el instanceof HTMLSelectElement))
          return { ok: false as const, error: 'select() requires a select element' };
        if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true')
          return { ok: false as const, error: 'select() target is disabled' };
        const wanted = new Set(Array.isArray(values) ? values : [values]);
        for (const option of el.options) option.selected = wanted.has(option.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          ok: true as const,
          values: Array.from(el.selectedOptions, (option) => option.value),
        };
      }, values);
      if (!outcome.ok) throw new ActionabilityError(outcome.error);
      return outcome.values;
    });
  }
}
