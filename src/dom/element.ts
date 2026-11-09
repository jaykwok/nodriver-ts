import type { Protocol } from 'devtools-protocol';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import type { Session, Command, Params, Result } from '../protocol/connection.ts';
import { argument, checkException, valueOf, type Frame, type World } from '../page/frames.ts';
import { ActionabilityError, ProtocolError, StaleElementError } from '../errors.ts';
import { bounded, budget, delay, poll, type WaitOptions } from '../utils.ts';
import { query, type QueryOptions, type Selector } from './query.ts';
import type { InputCheckpoint, InputOptions, InputReport } from '../input/behavior.ts';
import { targetCoordinate } from '../input/human.ts';
type Point = { x: number; y: number };
export interface ElementEvaluateOptions extends WaitOptions {
  /** Isolated by default; main exposes page-owned properties on the DOM wrapper. */
  world?: World;
}
export interface TypeOptions extends InputOptions {
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
/** The earlier deadline and both signals: a nested budget can only shorten the outer one. */
function narrower(outer: WaitOptions, inner: WaitOptions): WaitOptions {
  const timeouts = [outer.timeout, inner.timeout].filter((t): t is number => t !== undefined);
  const signals = [outer.signal, inner.signal].filter((s): s is AbortSignal => !!s);
  return {
    ...(timeouts.length ? { timeout: Math.min(...timeouts) } : {}),
    ...(signals.length
      ? { signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] }
      : {}),
  };
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
    if (
      this.frame.detached ||
      this.session.closed ||
      this.frame.generation !== this.generation ||
      this.frame.session !== this.session
    )
      throw new StaleElementError('Element belongs to an expired document/session');
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
  /** Undoes a probe, best effort; inside an action, cleanup still awaits the reply. */
  private async undo<M extends Command>(
    session: Session,
    method: M,
    ...params: Params<M>
  ): Promise<void> {
    const action = this.frame.tab.inputBehavior.current;
    await (
      action
        ? action.sendCleanup(session, method, ...params)
        : session.sendWith(method, { timeout: 1000 }, ...params)
    ).catch(() => {});
  }
  private async releaseGroup(objectGroup: string): Promise<void> {
    const action = this.frame.tab.inputBehavior.current;
    if (action) await action.releaseObjects(this.session, { objectGroup });
    else
      await this.session
        .sendWith('Runtime.releaseObjectGroup', { timeout: 1000 }, { objectGroup })
        .catch(() => {});
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
      const { object } = await this.send(this.session, 'DOM.resolveNode', {
        backendNodeId: this.backendNodeId,
        executionContextId: context,
        objectGroup: group,
      });
      if (!object.objectId) throw new StaleElementError('Node no longer exists');
      this.assertValid();
      const connected = await this.send(this.session, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function(){return this.isConnected}',
        returnByValue: true,
      });
      if (connected.result.value !== true)
        throw new StaleElementError('Element was removed from its document');
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
      const result = await this.send(this.session, 'Runtime.callFunctionOn', {
        objectId,
        objectGroup,
        functionDeclaration: `function(arg){if(!this.isConnected)throw new Error('Node is detached');return (${fn.toString()})(this,arg)}`,
        arguments: [argument(arg)],
        returnByValue: true,
        awaitPromise: true,
      });
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
  async describe(): Promise<Protocol.DOM.Node> {
    this.assertValid();
    return (
      await this.send(this.session, 'DOM.describeNode', {
        backendNodeId: this.backendNodeId,
        depth: 1,
        pierce: true,
      })
    ).node;
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
      const read = () =>
        this.evaluateIsolated((el) => {
          if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(el.type))
            throw new Error('setChecked requires checkbox or radio');
          return {
            checked: el.checked,
            radio: el.type === 'radio',
            rendered: el.checkVisibility(),
            // Includes a control inside a disabled fieldset.
            disabled: el.matches(':disabled'),
          };
        });
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
      if (state.rendered) await this.scrollIntoView({ signal: options.signal });
      const label = await this.labelToClick();
      if (label)
        // The control can become disabled while the pointer moves; its label would still act.
        await label.clickElement({ signal: options.signal }, async () => {
          if ((await read()).disabled)
            throw new ActionabilityError(
              'Control became disabled during pointer movement; click not dispatched',
            );
        });
      else await this.click({ signal: options.signal });
      const settled = performance.now() + 1000;
      while ((await this.evaluateIsolated((el) => (el as HTMLInputElement).checked)) !== checked) {
        if (performance.now() >= settled)
          throw new ActionabilityError(
            'Input did not reach requested checked state; the click was not repeated',
          );
        await delay(50, this.step().signal);
      }
      return { changed: true, clicked: label ? 'label' : 'control' };
    });
  }
  /** The first rendered label of a control that a click at its center would not reach. */
  private labelToClick(): Promise<Element | undefined> {
    const pick = (el: HTMLInputElement) => {
      const box = (target: HTMLElement) => {
        if (!target.checkVisibility({ visibilityProperty: true })) return undefined;
        const r = target.getBoundingClientRect();
        return r.width >= 1 && r.height >= 1 ? r : undefined;
      };
      const r = box(el);
      if (r) {
        const x = r.left + r.width / 2,
          y = r.top + r.height / 2;
        const hit = (el.getRootNode() as Document | ShadowRoot).elementFromPoint(x, y);
        for (let n: Node | null = hit; n; n = n.parentNode ?? (n as ShadowRoot).host)
          if (n === el) return null;
      }
      return Array.from(el.labels ?? []).find((label) => box(label)) ?? null;
    };
    return this.withIsolatedObject(async (objectId, objectGroup) => {
      const result = await this.send(this.session, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(){return (${pick.toString()})(this)}`,
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
    await this.send(this.session, 'DOM.scrollIntoViewIfNeeded', {
      backendNodeId: this.backendNodeId,
    });
    const point = await this.localPoint();
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
    await this.send(this.session, 'DOM.focus', { backendNodeId: this.backendNodeId });
  }
  async upload(files: string[]): Promise<void> {
    this.assertValid();
    const paths = files.map((p) => resolve(p));
    for (const path of paths) await access(path);
    await this.send(this.session, 'DOM.setFileInputFiles', {
      backendNodeId: this.backendNodeId,
      files: paths,
    });
  }
  private async localPoint(
    u = 0.5,
    v = 0.5,
  ): Promise<(Point & { targetWidth: number }) | undefined> {
    this.assertValid();
    const state = await this.evaluateIsolated(
      (el, { u, v }) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const x =
          Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) * u;
        const y =
          Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) * v;
        // The hit is retargeted to the element's tree; composed ancestors also cover a hit inside
        // the element's own shadow tree.
        let reaches = false;
        const hit = (el.getRootNode() as Document | ShadowRoot).elementFromPoint(x, y);
        for (let n: Node | null = hit; n && !reaches; n = n.parentNode ?? (n as ShadowRoot).host)
          reaches = n === el;
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
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            !el.matches(':disabled') &&
            el.getAttribute('aria-disabled') !== 'true' &&
            reaches,
          // The same point as a fraction of the whole element, which the quad below spans.
          u: (x - rect.left) / rect.width,
          v: (y - rect.top) / rect.height,
        };
      },
      { u, v },
    );
    if (!state.valid) return undefined;
    const { quads } = await this.send(this.session, 'DOM.getContentQuads', {
      backendNodeId: this.backendNodeId,
    });
    const quad = quads[0];
    if (!quad) return undefined;
    // CDP returns coordinates in the viewport of the session root, including in-process frame offsets.
    let point = project({ x: state.u, y: state.v }, 1, 1, quad);
    let edgeX = project({ x: 1, y: 0 }, 1, 1, quad);
    let edgeY = project({ x: 0, y: 1 }, 1, 1, quad);
    let corner = project({ x: 0, y: 0 }, 1, 1, quad);
    let session = this.session;
    const seen = new Set<string>();
    while (session !== this.frame.tab.session) {
      const root = [...this.frame.manager.frames.values()].find(
        (f) => !f.detached && f.session === session && f.parent && f.parent.session !== session,
      );
      if (!root?.parent || seen.has(root.id)) return undefined;
      seen.add(root.id);
      const parent = root.parent;
      const { backendNodeId } = await this.send(parent.session, 'DOM.getFrameOwner', {
        frameId: root.id,
      });
      const { model } = await this.send(parent.session, 'DOM.getBoxModel', { backendNodeId });
      const ownerQuad = model.content;
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
      const hit = await this.hitTest(parent.session, point);
      if (hit?.backendNodeId !== backendNodeId && hit?.frameId !== root.id) return undefined;
      session = parent.session;
    }
    return {
      ...point,
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
      if (error instanceof ProtocolError && /No node found/i.test(error.message)) return undefined;
      throw error;
    }
  }
  private async receivesPointer(point: Point, options: WaitOptions): Promise<boolean> {
    return this.withIsolatedObject(async (objectId, group) => {
      // The probe state stays in the isolated world, held by a handle rather than on the node.
      const { result: state } = await this.send(this.session, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration:
          'function(){const state={hit:false,listener:()=>{state.hit=true}};this.addEventListener("mousemove",state.listener,true);return state}',
        objectGroup: group,
      });
      if (!state.objectId) throw new StaleElementError('Element pointer probe failed');
      try {
        // OOPIF compositor hit-test data may lag layout after a transform or scroll.
        // Wait for real hover delivery before dispatching the one irreversible press. Only a
        // pointer already resting there moves aside first; a real trajectory delivers hover.
        await this.frame.tab.mouse.reach(point.x, point.y, this.step());
        const end = performance.now() + 100;
        do {
          const r = await this.send(this.session, 'Runtime.callFunctionOn', {
            objectId: state.objectId,
            functionDeclaration: 'function(){return this.hit}',
            returnByValue: true,
          });
          if (r.result.value === true) return true;
          await delay(10, options.signal);
        } while (performance.now() < end);
        return false;
      } finally {
        await this.undo(this.session, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration:
            'function(state){this.removeEventListener("mousemove",state.listener,true)}',
          arguments: [{ objectId: state.objectId }],
        });
      }
    });
  }
  /** Root-viewport hit test: true when the point reaches this element (or, in OOPIFs, receives hover). */
  private async unobscured(point: Point, options: WaitOptions): Promise<boolean> {
    const tab = this.frame.tab;
    if (this.session !== tab.session) return this.receivesPointer(point, options);
    const hit = await this.hitTest(tab.session, point);
    if (!hit) return false;
    if (hit.frameId === this.frame.id && hit.backendNodeId === this.backendNodeId) return true;
    let node = hit.backendNodeId;
    if (hit.frameId !== this.frame.id) {
      // A hit in a frame below this element's frame counts through that frame's owner element;
      // a hit in any other frame covers the element.
      let frame = this.frame.manager.frames.get(hit.frameId);
      while (frame?.parent && frame.parent !== this.frame) frame = frame.parent;
      if (!frame || frame.parent !== this.frame) return false;
      ({ backendNodeId: node } = await this.send(this.session, 'DOM.getFrameOwner', {
        frameId: frame.id,
      }));
    }
    return this.withIsolatedObject(async (objectId, group) => {
      const { object } = await this.send(this.session, 'DOM.resolveNode', {
        backendNodeId: node,
        executionContextId: await this.frame.context('isolated', this.step()),
        objectGroup: group,
      });
      if (!object.objectId) return false;
      const result = await this.send(this.session, 'Runtime.callFunctionOn', {
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
      await this.send(this.session, 'DOM.scrollIntoViewIfNeeded', {
        backendNodeId: this.backendNodeId,
      });
    });
  }
  private async wheelIntoView(): Promise<void> {
    const tab = this.frame.tab;
    const random = () => tab.inputBehavior.random();
    const box = () =>
      this.evaluateIsolated((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: innerWidth, h: innerHeight };
      });
    const offset = (center: number, extent: number) =>
      center >= extent * 0.08 && center <= extent * 0.92
        ? 0
        : Math.max(-2 * extent, Math.min(2 * extent, center - extent * (0.3 + 0.3 * random())));
    let current = await box();
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
      await this.scrollIntoView(options);
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
      const point = await poll(
        async () => {
          const first = await this.localPoint(u, v);
          if (!first) return undefined;
          await delay(32, options.signal);
          const second = await this.localPoint(u, v);
          if (!second || Math.hypot(first.x - second.x, first.y - second.y) > 0.5) return undefined;
          // Root-session hit testing catches overlays covering iframe elements as well as local nodes.
          return (await this.unobscured(second, options)) ? second : undefined;
        },
        options,
        'visible, enabled, stable and unobscured element',
      );
      this.assertValid();
      await this.frame.tab.mouse.click(point.x, point.y, {
        ...options,
        targetWidth: point.targetWidth,
        // OOPIF hit confirmation itself moves the pointer; never run it with a held button. A
        // failed check, such as a page removing the element on mousedown, only skips the slip.
        beforeSlip: (x, y) =>
          this.session === this.frame.tab.session
            ? this.unobscured({ x, y }, options).catch(() => false)
            : Promise.resolve(false),
        guard: async (checkpoint) => {
          this.assertValid();
          if (checkpoint.type !== 'mouseDown') return;
          const current = await this.localPoint(u, v);
          if (!current || Math.hypot(current.x - point.x, current.y - point.y) > 0.5)
            throw new ActionabilityError(
              'Target moved or became obstructed during pointer movement; click not dispatched',
            );
          // The press goes where the pointer is, which a pointer grid can set apart from the point.
          if (!(await this.unobscured({ x: checkpoint.x, y: checkpoint.y }, options)))
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
      await this.scrollIntoView(options);
      const behavior = this.frame.tab.inputBehavior;
      const inset = behavior.policy.targetInset;
      const pick = (mean: number) =>
        behavior.policy.mode === 'human'
          ? targetCoordinate(() => behavior.random(), inset, mean)
          : 0.5;
      const u = pick(0.5),
        v = pick(0.45);
      const point = await poll(
        async () => {
          const local = await this.localPoint(u, v);
          return local && (await this.unobscured(local, options)) ? local : undefined;
        },
        options,
        'visible and unobscured element',
      );
      await this.frame.tab.mouse.move(point.x, point.y, {
        ...options,
        guard: () => this.assertValid(),
      });
      return { x: point.x, y: point.y };
    });
  }
  /** Viewport point inside the element, scrolling it into view first. */
  async clickablePoint(options: WaitOptions = {}): Promise<Point> {
    const step = budget({ ...options, timeout: options.timeout ?? 10_000 }, 'clickablePoint');
    return operation.run(step, async () => {
      await this.scrollIntoView(step());
      const point = await poll(() => this.localPoint(), step(), 'visible element');
      return { x: point.x, y: point.y };
    });
  }
  async fill(text: string, options: InputOptions = {}): Promise<void> {
    await this.input('fill', options, async () => {
      if (options.signal?.aborted) throw options.signal.reason;
      await this.evaluateIsolated((el) => {
        if (el.matches(':disabled') || (el as HTMLInputElement).readOnly)
          throw new Error('Element is disabled or read-only');
        el.focus();
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
        else if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
        } else throw new Error('fill() requires an input, textarea or contenteditable element');
      });
      this.assertValid();
      options.signal?.throwIfAborted();
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
      options.signal?.throwIfAborted();
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
      input.signal?.throwIfAborted();
      this.assertValid();
      const selected = await this.evaluateIsolated((el, replace) => {
        if (
          el.matches(':disabled') ||
          (el as HTMLInputElement).readOnly ||
          (!(el instanceof HTMLInputElement) &&
            !(el instanceof HTMLTextAreaElement) &&
            !el.isContentEditable)
        )
          throw new Error('type() requires an enabled editable element');
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
    return this.frame.tab.withInput(() =>
      this.evaluateIsolated((el, values) => {
        if (!(el instanceof HTMLSelectElement))
          throw new Error('select() requires a select element');
        const wanted = new Set(Array.isArray(values) ? values : [values]);
        for (const option of el.options) option.selected = wanted.has(option.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return Array.from(el.selectedOptions, (option) => option.value);
      }, values),
    );
  }
}
