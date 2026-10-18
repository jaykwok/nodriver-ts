import type { Protocol } from 'devtools-protocol';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import type { Session } from '../protocol/connection.js';
import { argument, checkException, valueOf, type Frame } from '../page/frames.js';
import { ActionabilityError, StaleElementError } from '../errors.js';
import { delay, poll, type WaitOptions } from '../utils.js';
import { query, type QueryOptions, type Selector } from './query.js';
import type { InputOptions, InputReport } from '../input/behavior.js';
type Point = { x: number; y: number };
let pointerProbeId = 0;
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
  constructor(
    readonly frame: Frame,
    readonly backendNodeId: Protocol.DOM.BackendNodeId,
    readonly generation: number,
    readonly session: Session,
  ) {}
  assertValid(): void {
    if (
      this.frame.detached ||
      this.session.closed ||
      this.frame.generation !== this.generation ||
      this.frame.session !== this.session
    )
      throw new StaleElementError('Element belongs to an expired document/session');
  }
  async withObject<T>(fn: (objectId: string) => Promise<T>): Promise<T> {
    this.assertValid();
    const context = await this.frame.context('isolated');
    const { object } = await this.session.send('DOM.resolveNode', {
      backendNodeId: this.backendNodeId,
      executionContextId: context,
    });
    if (!object.objectId) throw new StaleElementError('Node no longer exists');
    try {
      this.assertValid();
      const connected = await this.session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function(){return this.isConnected}',
        returnByValue: true,
      });
      if (connected.result.value !== true)
        throw new StaleElementError('Element was removed from its document');
      return await fn(object.objectId);
    } finally {
      await this.session
        .send('Runtime.releaseObject', { objectId: object.objectId })
        .catch(() => {});
    }
  }
  async evaluate<T = unknown, A = unknown>(
    fn: (element: HTMLElement, arg: A) => T | Promise<T>,
    arg?: A,
  ): Promise<T> {
    return this.withObject(async (objectId) => {
      const result = await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(arg){if(!this.isConnected)throw new Error('Node is detached');return (${fn.toString()})(this,arg)}`,
        arguments: [argument(arg)],
        returnByValue: true,
        awaitPromise: true,
      });
      checkException(result);
      this.assertValid();
      return valueOf(result.result) as T;
    });
  }
  async text(): Promise<string> {
    return this.evaluate((el) => el.textContent ?? '');
  }
  async html(): Promise<string> {
    return this.evaluate((el) => el.outerHTML);
  }
  async attribute(name: string): Promise<string | null> {
    return this.evaluate((el, key) => el.getAttribute(key), name);
  }
  async describe(): Promise<Protocol.DOM.Node> {
    this.assertValid();
    return (
      await this.session.send('DOM.describeNode', {
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
  async setChecked(checked: boolean, options: WaitOptions = {}): Promise<void> {
    const current = await this.evaluate((el) => {
      if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(el.type))
        throw new Error('setChecked requires checkbox or radio');
      return el.checked;
    });
    if (current !== checked) await this.click(options);
    if ((await this.evaluate((el) => (el as HTMLInputElement).checked)) !== checked)
      throw new ActionabilityError('Input did not reach requested checked state');
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
    await this.session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: this.backendNodeId });
    const point = await this.localPoint();
    if (!point) throw new ActionabilityError('Element is not visible');
    const rect = await this.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    const metrics = await this.frame.tab.session.send('Page.getLayoutMetrics');
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
    await this.session.send('DOM.focus', { backendNodeId: this.backendNodeId });
  }
  async upload(files: string[]): Promise<void> {
    this.assertValid();
    const paths = files.map((p) => resolve(p));
    for (const path of paths) await access(path);
    await this.session.send('DOM.setFileInputFiles', {
      backendNodeId: this.backendNodeId,
      files: paths,
    });
  }
  private async localPoint(u = 0.5, v = 0.5): Promise<Point | undefined> {
    this.assertValid();
    const state = await this.evaluate(
      (el, { u, v }) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const x =
          Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) * u;
        const y =
          Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) * v;
        let root: Document | ShadowRoot = el.getRootNode() as Document | ShadowRoot;
        let hit = root.elementFromPoint(x, y);
        while (hit?.shadowRoot) {
          root = hit.shadowRoot;
          const next = root.elementFromPoint(x, y);
          if (!next || next === hit) break;
          hit = next;
        }
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
            !(el as HTMLButtonElement).disabled &&
            el.getAttribute('aria-disabled') !== 'true' &&
            !!hit &&
            (hit === el || el.contains(hit)),
          x,
          y,
        };
      },
      { u, v },
    );
    if (!state.valid) return undefined;
    const { quads } = await this.session.send('DOM.getContentQuads', {
      backendNodeId: this.backendNodeId,
    });
    const quad = quads[0];
    if (!quad) return undefined;
    // CDP returns coordinates in the viewport of the session root, including in-process frame offsets.
    let point = project({ x: u, y: v }, 1, 1, quad);
    let session = this.session;
    const seen = new Set<string>();
    while (session !== this.frame.tab.session) {
      const root = [...this.frame.manager.frames.values()].find(
        (f) => !f.detached && f.session === session && f.parent && f.parent.session !== session,
      );
      if (!root?.parent || seen.has(root.id)) return undefined;
      seen.add(root.id);
      const parent = root.parent;
      const { backendNodeId } = await parent.session.send('DOM.getFrameOwner', {
        frameId: root.id,
      });
      const { model } = await parent.session.send('DOM.getBoxModel', { backendNodeId });
      const ownerQuad = model.content;
      const size = await root.evaluate<{ width: number; height: number }>(
        '({width: innerWidth,height: innerHeight})',
        undefined,
        { world: 'isolated' },
      );
      if (point.x < 0 || point.y < 0 || point.x >= size.width || point.y >= size.height)
        return undefined;
      point = project(point, size.width, size.height, ownerQuad);
      const metrics = await parent.session.send('Page.getLayoutMetrics');
      const hit = await parent.session.send('DOM.getNodeForLocation', {
        x: Math.round(point.x + metrics.cssLayoutViewport.pageX),
        y: Math.round(point.y + metrics.cssLayoutViewport.pageY),
        includeUserAgentShadowDOM: true,
      });
      if (hit.backendNodeId !== backendNodeId && hit.frameId !== root.id) return undefined;
      session = parent.session;
    }
    return point;
  }
  private async receivesPointer(point: Point, options: WaitOptions): Promise<boolean> {
    return this.withObject(async (objectId) => {
      const key = `__nodriver_pointer_${++pointerProbeId}`;
      await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(key){const state={hit:false,listener:()=>{state.hit=true}};this[key]=state;this.addEventListener('mousemove',state.listener,true)}`,
        arguments: [{ value: key }],
        returnByValue: true,
      });
      try {
        // OOPIF compositor hit-test data may lag layout after a transform or scroll.
        // Wait for real hover delivery before dispatching the one irreversible press.
        const previous = this.frame.tab.mouse.position;
        // Only stationary re-hit needs a subpixel nudge. A real trajectory
        // already delivers hover; avoid an unconditional extra round trip.
        if (Math.hypot(previous.x - point.x, previous.y - point.y) < 0.01)
          await this.frame.tab.mouse.move(point.x + 0.25, point.y, options);
        await this.frame.tab.mouse.move(point.x, point.y, options);
        const end = Date.now() + 100;
        do {
          const r = await this.session.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: 'function(key){return this[key].hit}',
            arguments: [{ value: key }],
            returnByValue: true,
          });
          if (r.result.value === true) return true;
          await delay(10, options.signal);
        } while (Date.now() < end);
        return false;
      } finally {
        await this.session
          .send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration:
              'function(key){if(this[key]){this.removeEventListener("mousemove",this[key].listener,true);delete this[key]}}',
            arguments: [{ value: key }],
            returnByValue: true,
          })
          .catch(() => {});
      }
    });
  }
  /** Root-viewport hit test: true when the point reaches this element (or, in OOPIFs, receives hover). */
  private async unobscured(point: Point, options: WaitOptions): Promise<boolean> {
    const tab = this.frame.tab;
    if (this.session !== tab.session) return this.receivesPointer(point, options);
    const metrics = await tab.session.send('Page.getLayoutMetrics');
    // DOM hit testing uses page coordinates; Input dispatch and quads use viewport coordinates.
    const hit = await tab.session.send('DOM.getNodeForLocation', {
      x: Math.round(point.x + metrics.cssLayoutViewport.pageX),
      y: Math.round(point.y + metrics.cssLayoutViewport.pageY),
      includeUserAgentShadowDOM: true,
    });
    return this.withObject(async (objectId) => {
      const { object } = await this.session.send('DOM.resolveNode', {
        backendNodeId: hit.backendNodeId,
        executionContextId: await this.frame.context('isolated'),
      });
      try {
        const result = await this.session.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(hit){return this===hit||this.contains(hit)}',
          arguments: [{ objectId: object.objectId! }],
          returnByValue: true,
        });
        checkException(result);
        return result.result.value === true;
      } finally {
        if (object.objectId)
          await this.session
            .send('Runtime.releaseObject', { objectId: object.objectId })
            .catch(() => {});
      }
    });
  }
  /** Scrolls like a user (wheel at the pointer) in human mode, then lets Chrome finish if needed. */
  async scrollIntoView(options: WaitOptions = {}): Promise<void> {
    this.assertValid();
    const { mode, scroll } = this.frame.tab.inputBehavior.policy;
    if (scroll === 'wheel' || (scroll === 'auto' && mode === 'human'))
      if (this.frame === this.frame.tab.mainFrame) await this.wheelIntoView(options);
    // A no-op when already visible; also covers clipped scroll containers and nested frames.
    await this.session.sendWith('DOM.scrollIntoViewIfNeeded', options, {
      backendNodeId: this.backendNodeId,
    });
  }
  private async wheelIntoView(options: WaitOptions): Promise<void> {
    const tab = this.frame.tab;
    const random = () => tab.inputBehavior.random();
    const box = () =>
      this.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: innerWidth, h: innerHeight };
      });
    const offset = (center: number, extent: number) =>
      center >= extent * 0.08 && center <= extent * 0.92
        ? 0
        : Math.max(-2 * extent, Math.min(2 * extent, center - extent * (0.3 + 0.3 * random())));
    let current = await box();
    for (let attempt = 0; attempt < 12; attempt++) {
      const dx = offset(current.x, current.w),
        dy = offset(current.y, current.h);
      if (!dx && !dy) return;
      await tab.mouse.wheel(dx, dy, options);
      await delay(40 + 60 * random(), options.signal);
      const next = await box();
      // The pointer is over a container that cannot scroll toward the target.
      if (Math.abs(next.x - current.x) < 1 && Math.abs(next.y - current.y) < 1) return;
      current = next;
    }
  }
  async click(
    options: WaitOptions & { button?: Protocol.Input.MouseButton; clickCount?: number } = {},
  ): Promise<void> {
    await this.frame.tab.withInput(async () => {
      this.assertValid();
      await this.frame.tab.activate();
      await this.scrollIntoView(options);
      const behavior = this.frame.tab.inputBehavior;
      const inset = behavior.policy.targetInset;
      const u =
        behavior.policy.mode === 'human' ? inset + (1 - 2 * inset) * behavior.random() : 0.5;
      const v =
        behavior.policy.mode === 'human' ? inset + (1 - 2 * inset) * behavior.random() : 0.5;
      const deadline = performance.now() + (options.timeout ?? 10000);
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
        timeout: Math.max(0, deadline - performance.now()),
        guard: () => this.assertValid(),
        beforePress: async () => {
          const current = await this.localPoint(u, v);
          if (!current || Math.hypot(current.x - point.x, current.y - point.y) > 0.5)
            throw new ActionabilityError(
              'Target moved or became obstructed during pointer movement; click not dispatched',
            );
          if (!(await this.unobscured(point, options)))
            throw new ActionabilityError(
              this.session === this.frame.tab.session
                ? 'Pointer is obstructed; click not dispatched'
                : 'Frame pointer hit was lost; click not dispatched',
            );
        },
      });
    });
  }
  /** Moves the pointer over the element (visible, stable and unobscured) without pressing. */
  async hover(options: WaitOptions = {}): Promise<Point> {
    return this.frame.tab.withInput(async () => {
      this.assertValid();
      await this.frame.tab.activate();
      await this.scrollIntoView(options);
      const behavior = this.frame.tab.inputBehavior;
      const inset = behavior.policy.targetInset;
      const pick = () =>
        behavior.policy.mode === 'human' ? inset + (1 - 2 * inset) * behavior.random() : 0.5;
      const u = pick(),
        v = pick();
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
      return point;
    });
  }
  /** Viewport point inside the element, scrolling it into view first. */
  async clickablePoint(options: WaitOptions = {}): Promise<Point> {
    await this.scrollIntoView(options);
    return poll(() => this.localPoint(), options, 'visible element');
  }
  async fill(text: string, options: WaitOptions = {}): Promise<void> {
    await this.frame.tab.withInput(async () => {
      if (options.signal?.aborted) throw options.signal.reason;
      await this.frame.tab.activate();
      await this.evaluate((el) => {
        if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly)
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
        !(await this.evaluate(
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
  /** Types at the current caret/selection; unlike fill(), never selects all. */
  async type(text: string | string[], options: InputOptions = {}): Promise<InputReport> {
    return this.frame.tab.withInput(async () => {
      options.signal?.throwIfAborted();
      this.assertValid();
      await this.frame.tab.activate();
      await this.evaluate((el) => {
        if (
          (el as HTMLInputElement).disabled ||
          (el as HTMLInputElement).readOnly ||
          (!(el instanceof HTMLInputElement) &&
            !(el instanceof HTMLTextAreaElement) &&
            !el.isContentEditable)
        )
          throw new Error('type() requires an enabled editable element');
        el.focus();
      });
      return this.frame.tab.keyboard.type(text, {
        ...options,
        guard: async () => {
          this.assertValid();
          await options.guard?.();
          const focused = await this.evaluate(
            (el) => (el.getRootNode() as Document | ShadowRoot).activeElement === el,
          );
          if (!focused)
            throw new ActionabilityError('Typing target lost focus; no further text inserted');
        },
      });
    });
  }
  async select(values: string | string[]): Promise<string[]> {
    return this.frame.tab.withInput(() =>
      this.evaluate((el, values) => {
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
