import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Protocol } from 'devtools-protocol';
import { Browser, type ConnectOptions } from '../browser/browser.ts';
import type { BrowserContext } from '../browser/context.ts';
import type { LaunchOptions } from '../browser/launcher.ts';
import type { Tab } from '../page/tab.ts';
import type { Frame } from '../page/frames.ts';
import { Element } from '../dom/element.ts';
import { DisconnectedError, StaleElementError, TimeoutError } from '../errors.ts';
import { abortReason, delay, EventHub, type WaitOptions } from '../utils.ts';
import { OperationQueue } from './queue.ts';
import type { BrowserAllocation } from './pool.ts';
import type { InputPolicy } from '../input/behavior.ts';
import type { DiagnoseEnvironmentOptions, GeoIPResolver } from '../page/diagnostics.ts';

export interface BrowserMcpOptions {
  /** Lazy launch; mutually exclusive with connect. */
  launch?: LaunchOptions;
  /** Disconnecting from this browser never terminates its process. */
  connect?: ConnectOptions;
  /**
   * Connect mode only: also expose tabs that existed before (or were opened outside) this
   * server. Off by default, so a user's everyday tabs stay invisible to the agent.
   */
  exposeExistingTabs?: boolean;
  /**
   * Upstream proxy URL (http, https or socks). Applied per lease context; credentials in the
   * URL are handled by a local forwarder. Not available with connect.
   */
  proxy?: string;
  /** Explicitly allow asking the user to operate an accessible browser window. */
  humanInteraction?: boolean;
  inputPolicy?: InputPolicy;
  /** Host-configured probes only; tools cannot supply arbitrary egress URLs. */
  environmentDiagnostics?: DiagnoseEnvironmentOptions;
  geoIPResolver?: GeoIPResolver;
  /** Files browser_upload may send; tools pass names relative to this directory. */
  uploadDir?: string;
  /** Enables browser_downloads; downloads are saved here under their GUID. */
  downloadDir?: string;
  /** Enables browser_storage_state; named JSON files live here and never reach the model. */
  stateDir?: string;
  /** Tool names that are not registered. */
  disabledTools?: string[];
  /** Registers only observation and navigation tools (no input, scripts, uploads or state). */
  readOnly?: boolean;
}
interface SessionOptions extends BrowserMcpOptions {
  acquire?: (signal: AbortSignal) => Promise<BrowserAllocation>;
  queueLimit?: number;
  operationTimeout?: number;
}
export type WaitFor = 'none' | 'auto' | 'load';
export interface SnapshotOptions {
  frameId?: string;
  limit: number;
  offset?: number;
  interactiveOnly?: boolean;
  /** Ref of an element whose subtree is returned instead of the whole frame. */
  root?: string;
}
export interface SnapshotNode {
  ref: string | null;
  role: string;
  name: string;
  depth: number;
  states: Record<string, unknown>;
  value?: string;
  url?: string;
}
export interface DownloadEntry {
  guid: string;
  /** Increases with each download this session observes; see waitForDownload(). */
  sequence: number;
  tabId: string;
  url: string;
  suggestedFilename: string;
  state: 'inProgress' | 'completed' | 'canceled';
  /** File name inside the configured download directory. */
  file: string;
}
export interface NetworkEntry {
  time: number;
  url: string;
  status: number;
  type: string;
  mimeType: string;
  fromCache: boolean;
}
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'listbox',
  'treeitem',
  'ListBoxOption',
  'MenuListOption',
  'PopUpButton',
]);
const STATES = [
  'disabled',
  'focused',
  'checked',
  'selected',
  'expanded',
  'pressed',
  'required',
  'readonly',
  'multiselectable',
  'level',
];
const VALUED = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const MAX_REFS = 2000;
const quote = (text: string) => JSON.stringify(text);

/** One browser and short-ref registry per MCP connection or lease. */
export class BrowserMcpSession {
  private browser?: Browser;
  private opening?: Promise<Browser>;
  private queue: OperationQueue;
  private tasks = new Set<Promise<unknown>>();
  private allocation?: BrowserAllocation;
  private lifetime = new AbortController();
  private closing?: Promise<void>;
  private refs = new Map<string, { element: Element; key: string }>();
  private refKeys = new Map<string, string>();
  private refCounter = 0;
  private dialogs = new Map<string, { type: string; message: string; defaultPrompt: string }>();
  private unwatch?: () => void;
  readonly changes = new EventHub<void>();
  private sequence = 0;
  private events: Array<{ sequence: number; type: string; tabId?: string; time: number }> = [];
  private handoffs = new Map<string, { tabId: string; expires: number; completed: boolean }>();
  private downloads: DownloadEntry[] = [];
  private downloadSequence = 0;
  private downloadCursors = new Map<string, number>();
  private downloadContexts = new WeakSet<BrowserContext>();
  private captures = new Map<string, { entries: NetworkEntry[]; off: () => void }>();
  readonly options: SessionOptions;
  constructor(options: SessionOptions) {
    this.options = options;
    if (options.launch && options.connect)
      throw new TypeError('Choose launch or connect, not both');
    this.queue = new OperationQueue(options.queueLimit ?? 32);
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  changed(type = 'state', tabId?: string): void {
    this.events.push({ sequence: ++this.sequence, type, tabId, time: Date.now() });
    if (this.events.length > 64) this.events.shift();
    this.changes.emit();
  }
  eventLog() {
    return { events: [...this.events], latestSequence: this.sequence, capacity: 64 };
  }
  run<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>, open = false): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Browser operation deadline exceeded')),
      this.options.operationTimeout ?? 30000,
    );
    const combined = AbortSignal.any([signal, this.lifetime.signal, controller.signal]);
    const result = this.queue.run(combined, async () => {
      combined.throwIfAborted();
      if (open) await this.getBrowser(combined);
      // All leases sharing a process coordinate browser focus/input together.
      const invoke = () => task(combined);
      return this.allocation ? this.allocation.queue.run(combined, invoke) : invoke();
    });
    // Never release serialization early when a cancelled operation may still
    // be finishing an input sequence. Commands already sent cannot be undone.
    return this.track(
      result.finally(() => {
        clearTimeout(timer);
        this.changed();
      }),
    );
  }
  interrupt<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    combined.throwIfAborted();
    return this.track(Promise.resolve().then(() => task(combined)));
  }
  async getBrowser(signal: AbortSignal): Promise<Browser> {
    signal.throwIfAborted();
    if (this.opening) return this.opening;
    if (this.browser) {
      if (this.browser.closed)
        throw new DisconnectedError('Browser disconnected; call browser_close before reopening');
      return this.browser;
    }
    const options = this.options.connect ?? this.options.launch;
    const signals = [signal, this.lifetime.signal];
    if (options?.signal) signals.push(options.signal);
    const combined = AbortSignal.any(signals);
    const opening = this.options.acquire
      ? this.options.acquire(combined).then((allocation) => {
          this.allocation = allocation;
          return allocation.browser;
        })
      : this.options.connect
        ? Browser.connect({
            ...this.options.connect,
            attach:
              this.options.connect.attach ?? (this.options.exposeExistingTabs ? 'all' : 'created'),
            signal: combined,
          })
        : Browser.launch({ ...this.options.launch, signal: combined });
    this.opening = opening;
    try {
      const browser = await opening;
      this.browser = browser;
      if (combined.aborted) {
        if (this.allocation) await this.allocation.release();
        else await browser.close();
        this.allocation = undefined;
        this.browser = undefined;
        throw abortReason(combined);
      }
      const watch = (tab: Tab) => {
        if (this.allocation?.context && tab.context !== this.allocation.context) return;
        tab.framesManager.changes.on(() => this.changed('navigation', tab.id));
        tab.session.on('Page.javascriptDialogOpening', (event) => {
          this.dialogs.set(tab.id, {
            type: event.type,
            message: event.message.slice(0, 2000),
            defaultPrompt: event.defaultPrompt ?? '',
          });
          this.changed('dialog', tab.id);
        });
        tab.session.on('Page.javascriptDialogClosed', () => {
          this.dialogs.delete(tab.id);
          this.changed('dialog-closed', tab.id);
        });
        tab.session.disconnected.on(() => {
          this.dialogs.delete(tab.id);
          this.captures.get(tab.id)?.off();
          this.captures.delete(tab.id);
          this.changed('tab-closed', tab.id);
        });
        tab.downloads.on((download) => {
          const entry: DownloadEntry = {
            guid: download.guid,
            sequence: ++this.downloadSequence,
            tabId: tab.id,
            url: download.url.slice(0, 2000),
            suggestedFilename: download.suggestedFilename.slice(0, 500),
            state: 'inProgress',
            file: download.guid,
          };
          this.downloads.push(entry);
          if (this.downloads.length > 100) this.downloads.shift();
          const off = download.updates.on(() => {
            if (download.status === 'inProgress') return;
            off();
            entry.state = download.status;
            this.changed('download', tab.id);
          });
          this.changed('download', tab.id);
        });
        if (this.options.inputPolicy) tab.setInputPolicy(this.options.inputPolicy);
        this.changed('tab-opened', tab.id);
      };
      for (const tab of browser.tabs) watch(tab);
      this.unwatch = browser.tabCreated.on(watch);
      return browser;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }
  status() {
    return {
      connected: !!this.browser && !this.browser.closed,
      owned: this.browser?.owned ?? false,
      contextId: this.allocation?.context?.id ?? null,
      queuedOperations: this.queue.size,
      retainedRefs: this.refs.size,
      tabs: this.tabs().map((t) => this.tabInfo(t)),
    };
  }
  private tabs(): Tab[] {
    return (this.browser?.tabs ?? []).filter(
      (t) => !this.allocation?.context || t.context === this.allocation.context,
    );
  }
  private async prepareContext(context: BrowserContext): Promise<void> {
    if (!this.options.downloadDir || this.downloadContexts.has(context)) return;
    await context.setDownloadDirectory(this.options.downloadDir);
    this.downloadContexts.add(context);
  }
  async newTab(signal: AbortSignal): Promise<Tab> {
    const browser = await this.getBrowser(signal);
    signal.throwIfAborted();
    const context = this.allocation?.context ?? browser.defaultContext;
    await this.prepareContext(context);
    const tab = await context.newTab();
    if (this.options.inputPolicy) tab.setInputPolicy(this.options.inputPolicy);
    return tab;
  }
  beginHandoff(tabId: string): string {
    const tab = this.tab(tabId);
    if (!this.options.humanInteraction && this.options.launch?.headless !== false)
      throw new Error('Human interaction requires an explicitly accessible browser UI');
    for (const [id, handoff] of this.handoffs)
      if (handoff.expires < Date.now()) this.handoffs.delete(id);
    if (this.handoffs.size >= 64) throw new Error('Handoff capacity reached');
    const id = randomUUID();
    this.handoffs.set(id, { tabId, expires: Date.now() + 300000, completed: false });
    // The user may switch tabs or windows; never assume this client still owns the front tab.
    tab.browser.frontTab = undefined;
    return id;
  }
  handoff(token: string, tabId: string, complete = false) {
    const state = this.handoffs.get(token);
    if (!state || state.tabId !== tabId || state.expires < Date.now())
      throw new Error('Invalid or expired handoff state');
    if (complete) {
      state.completed = true;
      this.tab(tabId).browser.frontTab = undefined;
    }
    return state;
  }
  tabInfo(tab: Tab) {
    return {
      tabId: tab.id,
      url: tab.url,
      inputPolicy: structuredClone(tab.inputBehavior.policy),
      lastInput: tab.inputBehavior.lastReport,
      dialog: this.dialogs.get(tab.id) ?? null,
      frames: tab.frames.map((f) => ({
        frameId: f.id,
        parentId: f.parentId ?? null,
        url: f.url,
        generation: f.generation,
      })),
    };
  }
  tab(id: string): Tab {
    const tab = this.tabs().find((t) => t.id === id);
    if (!tab) throw new DisconnectedError('Unknown or closed tab; call browser_tabs');
    return tab;
  }
  frame(tabId: string, frameId?: string): Frame {
    const tab = this.tab(tabId);
    const frame = frameId ? tab.frames.find((f) => f.id === frameId) : tab.mainFrame;
    if (!frame)
      throw new StaleElementError('Unknown frame; refresh browser_tabs or browser_snapshot');
    return frame;
  }
  /** Short ref ("e12") for a node; the same live node keeps the same ref. */
  addRef(element: Element): string {
    const key = `${element.frame.tab.id}|${element.frame.id}|${element.session.id ?? ''}|${element.generation}|${element.backendNodeId}`;
    const existing = this.refKeys.get(key);
    if (existing && this.refs.has(existing)) return existing;
    if (this.refs.size >= MAX_REFS) this.prune();
    // Bound retained backend references; no remote JS objects are kept here.
    while (this.refs.size >= MAX_REFS) {
      const [oldest, record] = this.refs.entries().next().value!;
      this.refs.delete(oldest);
      this.refKeys.delete(record.key);
    }
    const ref = `e${++this.refCounter}`;
    this.refs.set(ref, { element, key });
    this.refKeys.set(key, ref);
    return ref;
  }
  element(tabId: string, ref: string): Element {
    this.tab(tabId);
    const element = this.refs.get(ref)?.element;
    if (!element || element.frame.tab.id !== tabId)
      throw new StaleElementError('Unknown or expired ref; take a fresh snapshot or find');
    element.assertValid();
    return element;
  }
  private prune() {
    for (const [ref, { element, key }] of this.refs) {
      try {
        element.assertValid();
      } catch {
        this.refs.delete(ref);
        this.refKeys.delete(key);
      }
    }
  }
  /** Role, accessible name and a short visible-text excerpt for find/wait results. */
  async describe(element: Element) {
    const [dom, ax] = await Promise.all([
      element.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el);
        const password = el instanceof HTMLInputElement && el.type === 'password';
        return {
          tag: el.tagName.toLowerCase(),
          text: password
            ? ''
            : (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
          visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none',
          inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
        };
      }),
      element.session
        .send('Accessibility.getPartialAXTree', {
          backendNodeId: element.backendNodeId,
          fetchRelatives: false,
        })
        .catch(() => undefined),
    ]);
    const node =
      ax?.nodes.find((n) => n.backendDOMNodeId === element.backendNodeId) ?? ax?.nodes[0];
    return {
      ref: this.addRef(element),
      frameId: element.frame.id,
      role: String(node?.role?.value ?? '').slice(0, 100),
      name: String(node?.name?.value ?? '').slice(0, 300),
      ...dom,
    };
  }
  async snapshot(tabId: string, options: SnapshotOptions, wait: WaitOptions) {
    const rootElement = options.root ? this.element(tabId, options.root) : undefined;
    if (rootElement && options.frameId && rootElement.frame.id !== options.frameId)
      throw new StaleElementError('root ref belongs to a different frame');
    const frame = rootElement?.frame ?? this.frame(tabId, options.frameId);
    const session = frame.session,
      generation = frame.generation;
    // Keep complete reads even for root: queryAXTree can stall on complex frame pages,
    // and partial/depth-limited reads omit descendants. See benchmarks/ax-subtree.ts.
    const { nodes } = await session.sendWith('Accessibility.getFullAXTree', wait, {
      frameId: frame.id,
    });
    if (frame.detached || frame.session !== session || frame.generation !== generation)
      throw new StaleElementError('Frame changed while taking snapshot');
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const starts = rootElement
      ? nodes.filter((n) => n.backendDOMNodeId === rootElement.backendNodeId).slice(0, 1)
      : nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
    if (rootElement && !starts.length)
      throw new StaleElementError('root ref is not in the accessibility tree');
    const out: Array<{ node: Protocol.Accessibility.AXNode; depth: number }> = [];
    const seen = new Set<string>();
    const property = (node: Protocol.Accessibility.AXNode, name: string) =>
      node.properties?.find((p) => p.name === name)?.value.value;
    const visit = (node: Protocol.Accessibility.AXNode, depth: number, parentName: string) => {
      if (seen.has(node.nodeId) || out.length > 20_000) return;
      seen.add(node.nodeId);
      const role = String(node.role?.value ?? '');
      const name = String(node.name?.value ?? '');
      let include = !node.ignored && role !== 'InlineTextBox';
      // Unnamed wrappers add depth without information; text repeating its parent's name is noise.
      if (include && ['generic', 'none', 'presentation', 'LineBreak'].includes(role) && !name)
        include = false;
      if (include && role === 'StaticText' && (!name.trim() || name === parentName))
        include = false;
      if (include && options.interactiveOnly)
        include = INTERACTIVE.has(role) || property(node, 'focusable') === true;
      if (include) out.push({ node, depth });
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) visit(child, include ? depth + 1 : depth, include ? name : parentName);
      }
    };
    for (const start of starts) visit(start, 0, '');
    const offset = options.offset ?? 0;
    const page = out.slice(offset, offset + options.limit);
    const items: SnapshotNode[] = await Promise.all(
      page.map(async ({ node, depth }) => {
        const role = String(node.role?.value ?? '').slice(0, 100);
        const item: SnapshotNode = {
          ref: node.backendDOMNodeId
            ? this.addRef(new Element(frame, node.backendDOMNodeId, generation, session))
            : null,
          role,
          name: String(node.name?.value ?? '').slice(0, 300),
          depth,
          states: Object.fromEntries(
            (node.properties ?? [])
              .filter((p) => STATES.includes(p.name))
              .map((p) => [p.name, p.value.value]),
          ),
        };
        const url = property(node, 'url');
        if (typeof url === 'string' && url) item.url = url.slice(0, 2000);
        const value = node.value?.value;
        if (VALUED.has(role) && value !== undefined && value !== '' && node.backendDOMNodeId) {
          // Never echo password field contents into model context.
          const { node: dom } = await session
            .send('DOM.describeNode', { backendNodeId: node.backendDOMNodeId })
            .catch(() => ({ node: undefined }));
          const attributes = dom?.attributes ?? [];
          const type = attributes[attributes.indexOf('type') + 1]?.toLowerCase();
          const secret = !dom || (attributes.includes('type') && type === 'password');
          item.value = secret ? '••••' : String(value).slice(0, 500);
        }
        return item;
      }),
    );
    if (frame.detached || frame.session !== session || frame.generation !== generation)
      throw new StaleElementError('Frame changed while taking snapshot');
    const next = offset + page.length;
    return {
      ...this.tabInfo(frame.tab),
      frameId: frame.id,
      generation,
      nodes: items,
      offset,
      truncated: next < out.length,
      nextOffset: next < out.length ? next : null,
      totalNodes: out.length,
    };
  }
  /** Indented, model-friendly rendering of snapshot() output. */
  static snapshotText(snapshot: Awaited<ReturnType<BrowserMcpSession['snapshot']>>): string {
    const lines = [`Tab ${snapshot.tabId} frame ${snapshot.frameId}: ${snapshot.url}`];
    if (snapshot.dialog)
      lines.push(`Dialog open (${snapshot.dialog.type}): ${quote(snapshot.dialog.message)}`);
    for (const node of snapshot.nodes) {
      let line = `${'  '.repeat(Math.min(node.depth, 40))}- ${node.role || 'node'}`;
      if (node.name) line += ` ${quote(node.name)}`;
      if (node.ref) line += ` [${node.ref}]`;
      for (const [name, value] of Object.entries(node.states))
        if (value === true || value === 'true') line += ` ${name}`;
        else if (value !== false && value !== 'false' && value !== undefined && value !== '')
          line += ` ${name}=${String(value)}`;
      if (node.value !== undefined) line += ` value=${quote(node.value)}`;
      if (node.url) line += ` url=${node.url}`;
      lines.push(line);
    }
    const others = snapshot.frames.filter((f) => f.frameId !== snapshot.frameId);
    if (others.length && !snapshot.offset)
      lines.push(
        `Other frames (snapshot with frameId): ${others.map((f) => `${f.frameId} ${f.url}`).join('; ')}`,
      );
    if (snapshot.truncated)
      lines.push(
        `[${snapshot.offset + snapshot.nodes.length} of ${snapshot.totalNodes} nodes; continue with offset=${snapshot.nextOffset}]`,
      );
    return lines.join('\n');
  }
  /**
   * Runs an action, then optionally waits for a navigation it started: "auto" allows 250 ms
   * for the main frame to start loading, "load" expects one within the timeout. A JS dialog
   * ends the wait. Returns what changed so the agent need not re-observe blindly.
   */
  async act<T>(
    tab: Tab,
    options: { waitFor: WaitFor; timeout: number; signal: AbortSignal },
    action: () => Promise<T>,
  ): Promise<{ result: T; summary: ReturnType<BrowserMcpSession['summary']> }> {
    const before = {
      url: tab.url,
      generation: tab.mainFrame.generation,
      frame: tab.mainFrame,
      tabs: new Set(this.tabs().map((t) => t.id)),
    };
    let started = false,
      stopped = false;
    const end = performance.now() + options.timeout;
    const offs = [
      tab.session.on('Page.frameStartedLoading', (e) => {
        if (e.frameId === tab.mainFrame.id) {
          started = true;
          stopped = false;
        }
      }),
      tab.session.on('Page.frameStoppedLoading', (e) => {
        if (e.frameId === tab.mainFrame.id) stopped = true;
      }),
      tab.framesManager.changes.on(({ frame, sameDocument, restored }) => {
        if (frame === tab.mainFrame && (sameDocument || restored)) {
          started = true;
          stopped = true;
        }
      }),
    ];
    try {
      const result = await action();
      if (options.waitFor !== 'none') {
        const begin = performance.now();
        const grace = options.waitFor === 'auto' ? Math.min(begin + 250, end) : end;
        while (!tab.closed && !this.dialogs.has(tab.id)) {
          options.signal.throwIfAborted();
          const now = performance.now();
          if (started && stopped) break;
          if (now >= end && (started || options.waitFor === 'load'))
            throw new TimeoutError(
              `Action completed, but navigation ${started ? 'did not finish' : 'did not start'} within ${options.timeout}ms; the action was not replayed`,
            );
          if (!started && now >= grace) break;
          await delay(Math.max(0, Math.min(25, (started ? end : grace) - now)), options.signal);
        }
      }
      return { result, summary: this.summary(tab, before, started && !stopped) };
    } finally {
      for (const off of offs) off();
    }
  }
  private summary(
    tab: Tab,
    before: { url: string; generation: number; frame: Frame; tabs: Set<string> },
    loading: boolean,
  ) {
    const closed = tab.closed;
    return {
      tabId: tab.id,
      url: closed ? null : tab.url,
      navigated:
        !closed &&
        (tab.url !== before.url ||
          tab.mainFrame !== before.frame ||
          tab.mainFrame.generation !== before.generation),
      loading,
      tabClosed: closed,
      newTabs: this.tabs()
        .filter((t) => !before.tabs.has(t.id))
        .map((t) => ({ tabId: t.id, url: t.url })),
      dialog: this.dialogs.get(tab.id) ?? null,
    };
  }
  /** Resolves names inside the host upload directory, rejecting traversal and symlink escape. */
  async uploadPaths(files: string[]): Promise<string[]> {
    const base = this.options.uploadDir;
    if (!base) throw new Error('Uploads are disabled; the host must configure an upload directory');
    const root = await realpath(resolve(base));
    return Promise.all(
      files.map(async (file) => {
        if (isAbsolute(file))
          throw new TypeError('Use a file name relative to the upload directory');
        const path = await realpath(join(root, file));
        const inside = relative(root, path);
        if (!inside || inside.startsWith('..') || isAbsolute(inside))
          throw new TypeError(`File is outside the upload directory: ${file}`);
        return path;
      }),
    );
  }
  context(tab?: Tab): BrowserContext {
    if (tab) return tab.context;
    if (this.allocation?.context) return this.allocation.context;
    if (!this.browser || this.browser.closed)
      throw new DisconnectedError('No browser yet; call browser_open first');
    return this.browser.defaultContext;
  }
  downloadList(): DownloadEntry[] {
    if (!this.options.downloadDir)
      throw new Error('Downloads are disabled; the host must configure a download directory');
    const tabs = new Set(this.tabs().map((t) => t.id));
    return this.downloads.filter((d) => tabs.has(d.tabId) || d.state !== 'inProgress');
  }
  get latestDownload(): number {
    return this.downloadSequence;
  }
  /**
   * Waits until the first download of the tab with a sequence above `after` has completed or been
   * canceled. `after` defaults to the last download a wait returned for this tab, so a download
   * that began before the wait is still found. Takes no operation-queue slot: the action that
   * triggers the download may run concurrently.
   */
  async waitForDownload(
    tabId: string,
    after: number | undefined,
    wait: WaitOptions,
  ): Promise<DownloadEntry> {
    const { browser } = this.tab(tabId);
    this.downloadList();
    const cursor = after ?? this.downloadCursors.get(tabId) ?? 0;
    const next = () => this.downloads.find((d) => d.tabId === tabId && d.sequence > cursor);
    const settled = () => {
      const entry = next();
      return entry && entry.state !== 'inProgress' ? entry : undefined;
    };
    let entry = settled();
    if (!entry)
      try {
        await browser.waitEvent(this.changes, () => !!(entry = settled()), wait, 'download');
      } catch (error) {
        const pending = next();
        if (error instanceof TimeoutError && pending)
          throw new TimeoutError(
            `Download ${pending.sequence} (${pending.guid}) is still in progress; wait again to continue`,
          );
        throw error;
      }
    this.downloadCursors.set(
      tabId,
      Math.max(entry!.sequence, this.downloadCursors.get(tabId) ?? 0),
    );
    return entry!;
  }
  /** Opt-in per-tab ring buffer of recent responses (enables the Network domain). */
  async capture(tabId: string, action: 'start' | 'stop' | 'clear'): Promise<void> {
    const tab = this.tab(tabId);
    const existing = this.captures.get(tabId);
    if (action === 'clear') {
      if (existing) existing.entries.length = 0;
      return;
    }
    if (action === 'stop') {
      existing?.off();
      this.captures.delete(tabId);
      return;
    }
    if (existing) return;
    const entries: NetworkEntry[] = [];
    const off = tab.network.responses.on(({ event }) => {
      entries.push({
        time: Date.now(),
        url: event.response.url.slice(0, 2000),
        status: event.response.status,
        type: event.type,
        mimeType: event.response.mimeType.slice(0, 200),
        fromCache: !!(event.response.fromDiskCache || event.response.fromServiceWorker),
      });
      if (entries.length > 500) entries.shift();
    });
    this.captures.set(tabId, { entries, off });
    try {
      await tab.network.enable();
    } catch (error) {
      off();
      this.captures.delete(tabId);
      throw error;
    }
  }
  captured(tabId: string, filter: string | undefined, limit: number) {
    this.tab(tabId);
    const capture = this.captures.get(tabId);
    if (!capture) throw new Error('Network capture is off; call browser_network with action start');
    const entries = filter
      ? capture.entries.filter((e) => e.url.includes(filter))
      : capture.entries;
    return { capturing: true, total: entries.length, entries: entries.slice(-limit) };
  }
  async release(): Promise<void> {
    this.refs.clear();
    this.refKeys.clear();
    this.dialogs.clear();
    this.unwatch?.();
    this.unwatch = undefined;
    this.handoffs.clear();
    for (const capture of this.captures.values()) capture.off();
    this.captures.clear();
    const browser = this.browser;
    this.browser = undefined;
    const allocation = this.allocation;
    this.allocation = undefined;
    if (allocation) await allocation.release();
    else await browser?.close();
    this.changed('released');
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort(new DisconnectedError('MCP session closed'));
      // Also await a lazy launch that was in progress when stdin disconnected.
      await this.opening?.catch(() => {});
      await Promise.all([...this.tasks].map((t) => t.catch(() => {})));
      await this.release();
      this.changes.clear();
    })());
  }
}
