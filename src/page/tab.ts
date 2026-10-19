import type { Protocol } from 'devtools-protocol';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Session } from '../protocol/connection.js';
import type { Browser } from '../browser/browser.js';
import type { BrowserContext } from '../browser/context.js';
import {
  FrameManager,
  type Frame,
  type EvaluateOptions,
  type JSHandle,
  type EvaluationInput,
} from './frames.js';
import { NavigationWatcher, type NavigationOptions } from './navigation.js';
import { Network } from './network.js';
import { Keyboard, Mouse } from '../input/input.js';
import { InputBehavior, type InputPolicy } from '../input/behavior.js';
import { StaleElementError } from '../errors.js';
import type { Selector, QueryOptions } from '../dom/query.js';
import type { Element } from '../dom/element.js';
import { EventHub, type WaitOptions } from '../utils.js';
import type { Download } from '../browser/download.js';
import { NodriverError } from '../errors.js';
import type { EnvironmentReport, InspectEnvironmentOptions } from './environment.js';
import {
  diagnoseEnvironment,
  alignEnvironment,
  type DiagnoseEnvironmentOptions,
  type AlignEnvironmentOptions,
  type GeoIPResolver,
} from './diagnostics.js';
export interface Environment {
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
    screenWidth?: number;
    screenHeight?: number;
  };
  timezone?: string;
  locale?: string;
  acceptLanguage?: string;
  userAgent?: string;
  userAgentMetadata?: Protocol.Emulation.UserAgentMetadata;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
}
export class Tab {
  readonly framesManager: FrameManager;
  readonly network: Network;
  readonly mouse: Mouse;
  readonly keyboard: Keyboard;
  readonly downloads = new EventHub<Download>();
  crashed = false;
  readonly inputBehavior: InputBehavior;
  private environment: Environment = {};
  private appliedLocale?: string;
  private environmentBaseline?: EnvironmentReport;
  private environmentApplications: Array<{
    sessionId: string;
    status: 'applied' | 'failed';
    error?: string;
  }> = [];
  private scripts: Array<{
    source: string;
    worldName?: string;
    identifiers: Map<Session, string>;
  }> = [];
  /** Per-tab world for isolated init scripts, distinct from the internal helper world. */
  private readonly scriptWorld = randomUUID();
  private closing?: Promise<void>;
  private disposed = false;
  constructor(
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly id: string,
    readonly session: Session,
  ) {
    this.environment = structuredClone(browser.baseEnvironment);
    this.framesManager = new FrameManager(this, session);
    this.framesManager.changes.on(({ frame, sameDocument }) => {
      if (!sameDocument) context.noteOrigin(frame.url);
    });
    this.network = new Network(this);
    this.inputBehavior = new InputBehavior(
      (task) => this.browser.input.run(task),
      () => {
        if (this.closed || this.crashed) throw new StaleElementError('Input tab closed/crashed');
      },
      () => {
        const frame = this.mainFrame,
          generation = frame.generation;
        return () => {
          if (frame.detached || frame.generation !== generation)
            throw new StaleElementError('Document changed during input');
        };
      },
      () => this.activate(),
    );
    this.mouse = new Mouse(session, this.inputBehavior);
    // The browser's own UA, not an override: key bindings follow the platform Chrome runs on.
    const mac = browser.version.userAgent.includes('Macintosh');
    this.keyboard = new Keyboard(session, this.inputBehavior, mac);
  }
  get cdp(): Session {
    return this.session;
  }
  get mainFrame(): Frame {
    return this.framesManager.mainFrame;
  }
  get frames(): Frame[] {
    return [...this.framesManager.frames.values()].filter((f) => !f.detached);
  }
  get url(): string {
    return this.mainFrame.url;
  }
  get closed(): boolean {
    return this.disposed || this.session.closed;
  }
  reportError(error: unknown): void {
    this.browser.reportError(error);
  }
  async initialize(): Promise<void> {
    await this.framesManager.initialize();
  }
  async configureSession(session: Session): Promise<void> {
    await this.network.configure(session);
    await this.applyEnvironment(session, this.environment);
    for (const script of this.scripts) {
      const { identifier } = await session.send('Page.addScriptToEvaluateOnNewDocument', {
        source: script.source,
        worldName: script.worldName,
      });
      script.identifiers.set(session, identifier);
    }
  }
  async withInput<T>(fn: () => Promise<T>): Promise<T> {
    return this.browser.input.run(fn);
  }
  setInputPolicy(policy: InputPolicy): void {
    this.inputBehavior.configure(policy);
  }
  waitEvent<T>(
    hub: EventHub<T>,
    predicate: (event: T) => boolean,
    options: WaitOptions,
    label: string,
  ): Promise<T> {
    return this.browser.waitEvent(hub, predicate, options, label, this.session);
  }
  async goto(url: string, options: NavigationOptions = {}): Promise<string> {
    const watcher = new NavigationWatcher(this, options, false);
    try {
      const result = await this.session.sendWith('Page.navigate', options, { url });
      if (result.errorText) throw new NodriverError(`Navigation failed: ${result.errorText}`);
      if (result.isDownload)
        throw new NodriverError('Navigation became a download; use waitForDownload()');
      watcher.expect(result.loaderId);
      return await watcher.promise;
    } catch (e) {
      watcher.cancel(e as Error);
      throw e;
    }
  }
  waitForNavigation(options: NavigationOptions = {}): Promise<string> {
    return new NavigationWatcher(this, options).promise;
  }
  async reload(options: NavigationOptions = {}): Promise<string> {
    const watcher = new NavigationWatcher(this, options);
    try {
      this.crashed = false;
      await this.session.sendWith('Page.reload', options, {});
      return await watcher.promise;
    } catch (e) {
      watcher.cancel(e as Error);
      throw e;
    }
  }
  async go(delta: number, options: NavigationOptions = {}): Promise<string | undefined> {
    const history = await this.session.send('Page.getNavigationHistory');
    const entry = history.entries[history.currentIndex + delta];
    if (!entry) return undefined;
    const watcher = new NavigationWatcher(this, options);
    try {
      await this.session.sendWith('Page.navigateToHistoryEntry', options, { entryId: entry.id });
      return await watcher.promise;
    } catch (e) {
      watcher.cancel(e as Error);
      throw e;
    }
  }
  async bringToFront(): Promise<void> {
    await this.session.send('Page.bringToFront');
    this.browser.frontTab = this;
  }
  /**
   * Brings the tab to front only when another tab may be in front, avoiding a focus/visibility
   * round trip (and window activation) before every input action.
   */
  async activate(): Promise<void> {
    if (this.browser.frontTab !== this) await this.bringToFront();
  }
  evaluate<T = unknown, A = unknown>(
    fn: string | ((arg: EvaluationInput<A>) => T | Promise<T>),
    arg?: A,
    options: EvaluateOptions = {},
  ): Promise<T> {
    return this.mainFrame.evaluate(fn, arg, options);
  }
  evaluateHandle<T = unknown, A = unknown>(
    fn: string | ((arg: EvaluationInput<A>) => T | Promise<T>),
    arg?: A,
    options: EvaluateOptions = {},
  ): Promise<JSHandle<T>> {
    return this.mainFrame.evaluateHandle(fn, arg, options);
  }
  query(selector: Selector, options?: QueryOptions): Promise<Element | undefined> {
    return this.mainFrame.query(selector, options);
  }
  queryAll(selector: Selector, options?: QueryOptions): Promise<Element[]> {
    return this.mainFrame.queryAll(selector, options);
  }
  waitForSelector(selector: Selector, options?: QueryOptions & WaitOptions): Promise<Element> {
    return this.mainFrame.waitForSelector(selector, options);
  }
  waitForFunction<T, A = unknown>(
    fn: string | ((arg: EvaluationInput<A>) => T | Promise<T>),
    arg?: A,
    options?: EvaluateOptions,
  ): Promise<T> {
    return this.mainFrame.waitForFunction(fn, arg, options);
  }
  async content(): Promise<string> {
    return this.mainFrame.content();
  }
  inspectEnvironment(options: InspectEnvironmentOptions = {}): Promise<EnvironmentReport> {
    return this.mainFrame.inspectEnvironment(options);
  }
  diagnoseEnvironment(options: DiagnoseEnvironmentOptions = {}) {
    return diagnoseEnvironment(this, options);
  }
  alignEnvironment(options: AlignEnvironmentOptions, resolver?: GeoIPResolver) {
    return alignEnvironment(this, options, resolver);
  }
  environmentState() {
    return structuredClone({
      requested: this.environment,
      nativeBaseline: this.environmentBaseline,
      applications: this.environmentApplications,
    });
  }
  async resources(): Promise<Protocol.Page.FrameResourceTree> {
    return (await this.session.send('Page.getResourceTree')).frameTree;
  }
  async resourceContent(url: string, frame = this.mainFrame): Promise<Buffer> {
    const result = await frame.session.send('Page.getResourceContent', { frameId: frame.id, url });
    return Buffer.from(result.content, result.base64Encoded ? 'base64' : 'utf8');
  }
  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.session.send('Page.handleJavaScriptDialog', { accept, promptText });
  }
  async stopLoading(): Promise<void> {
    await this.session.send('Page.stopLoading');
  }
  async setContent(html: string): Promise<void> {
    await this.session.send('Page.setDocumentContent', { frameId: this.mainFrame.id, html });
    this.mainFrame.invalidate();
  }
  async screenshot(
    options: {
      path?: string;
      format?: 'png' | 'jpeg' | 'webp';
      quality?: number;
      fullPage?: boolean;
      clip?: Protocol.Page.Viewport;
      /** Output scale; applies to the clip, full page or current viewport. */
      scale?: number;
    } = {},
  ): Promise<Buffer> {
    let clip = options.clip;
    if (options.fullPage) {
      const { cssContentSize } = await this.session.send('Page.getLayoutMetrics');
      clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
    } else if (!clip && options.scale !== undefined) {
      const { cssVisualViewport: v } = await this.session.send('Page.getLayoutMetrics');
      clip = { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 1 };
    }
    if (clip && options.scale !== undefined) clip = { ...clip, scale: options.scale };
    const { data } = await this.session.send('Page.captureScreenshot', {
      format: options.format ?? 'png',
      quality: options.quality,
      clip,
      captureBeyondViewport: options.fullPage ?? false,
    });
    const bytes = Buffer.from(data, 'base64');
    if (options.path) await writeFile(options.path, bytes);
    return bytes;
  }
  async pdf(options: Protocol.Page.PrintToPDFRequest & { path?: string } = {}): Promise<Buffer> {
    const { path, ...params } = options;
    const { data } = await this.session.send('Page.printToPDF', {
      ...params,
      transferMode: 'ReturnAsBase64',
    });
    const bytes = Buffer.from(data, 'base64');
    if (path) await writeFile(path, bytes);
    return bytes;
  }
  async setEnvironment(environment: Environment): Promise<void> {
    if (environment.timezone) new Intl.DateTimeFormat('en', { timeZone: environment.timezone });
    if (environment.locale) new Intl.Locale(environment.locale);
    if (
      environment.viewport &&
      (!Number.isSafeInteger(environment.viewport.width) ||
        !Number.isSafeInteger(environment.viewport.height) ||
        environment.viewport.width < 1 ||
        environment.viewport.height < 1)
    )
      throw new RangeError('Invalid viewport');
    if (environment.userAgentMetadata && !environment.userAgent && !this.environment.userAgent)
      throw new TypeError('UA metadata requires an explicit UA');
    this.environmentBaseline ??= await this.inspectEnvironment();
    if (environment.acceptLanguage && !environment.userAgent && !this.environment.userAgent) {
      const native = await this.inspectEnvironment();
      const ch = native.document.userAgentData;
      environment = {
        ...environment,
        userAgent: native.document.userAgent,
        userAgentMetadata: ch
          ? ({
              brands: ch.brands,
              fullVersionList: ch.fullVersionList,
              platform: ch.platform,
              platformVersion: ch.platformVersion,
              architecture: ch.architecture,
              model: ch.model,
              mobile: ch.mobile,
              bitness: ch.bitness,
              wow64: ch.wow64,
            } as Protocol.Emulation.UserAgentMetadata)
          : undefined,
      };
    }
    this.environment = { ...this.environment, ...environment };
    this.environmentApplications = [];
    for (const s of this.framesManager.sessions)
      if (!s.closed) {
        try {
          await this.applyEnvironment(s, this.environment);
          this.environmentApplications.push({ sessionId: s.id ?? 'root', status: 'applied' });
        } catch (error) {
          this.environmentApplications.push({
            sessionId: s.id ?? 'root',
            status: 'failed',
            error: String(error),
          });
          throw error;
        }
      }
  }
  private async applyEnvironment(session: Session, e: Environment): Promise<void> {
    if (e.viewport && session === this.session)
      await session.send('Emulation.setDeviceMetricsOverride', {
        ...e.viewport,
        mobile: e.viewport.mobile ?? false,
        deviceScaleFactor: e.viewport.deviceScaleFactor ?? 1,
      });
    if (e.timezone) await session.send('Emulation.setTimezoneOverride', { timezoneId: e.timezone });
    // Locale overrides share renderer state. Applying the same override through
    // nested OOPIF sessions can fail with "Another locale override". Apply at
    // the page root and verify each document/Worker rather than promise scope.
    if (e.locale && session === this.session && e.locale !== this.appliedLocale) {
      if (this.appliedLocale) await session.send('Emulation.setLocaleOverride', { locale: '' });
      await session.send('Emulation.setLocaleOverride', { locale: e.locale });
      this.appliedLocale = e.locale;
    }
    if (e.userAgent)
      await session.send('Emulation.setUserAgentOverride', {
        userAgent: e.userAgent,
        userAgentMetadata: e.userAgentMetadata,
        acceptLanguage: e.acceptLanguage ?? e.locale,
      });
    if (e.geolocation)
      await session.send('Emulation.setGeolocationOverride', {
        ...e.geolocation,
        accuracy: e.geolocation.accuracy ?? 1,
      });
  }
  async addInitScript(
    source: string,
    options: { world?: 'main' | 'isolated' } = {},
  ): Promise<() => Promise<void>> {
    const script = {
      source,
      worldName: options.world === 'isolated' ? this.scriptWorld : undefined,
      identifiers: new Map<Session, string>(),
    };
    this.scripts.push(script);
    for (const s of this.framesManager.sessions)
      if (!s.closed) {
        const { identifier } = await s.send('Page.addScriptToEvaluateOnNewDocument', {
          source,
          worldName: script.worldName,
        });
        script.identifiers.set(s, identifier);
      }
    return async () => {
      this.scripts = this.scripts.filter((item) => item !== script);
      for (const [s, identifier] of script.identifiers)
        if (!s.closed) await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    };
  }
  async windowBounds(bounds?: Protocol.Browser.Bounds): Promise<Protocol.Browser.Bounds> {
    const result = await this.browser.cdp.send('Browser.getWindowForTarget', { targetId: this.id });
    if (bounds) {
      await this.browser.cdp.send('Browser.setWindowBounds', { windowId: result.windowId, bounds });
      return (await this.browser.cdp.send('Browser.getWindowBounds', { windowId: result.windowId }))
        .bounds;
    }
    return result.bounds;
  }
  waitForDownload(options: WaitOptions = {}): Promise<Download> {
    return this.waitEvent(this.downloads, () => true, options, 'download');
  }
  async waitForPopup(options: WaitOptions = {}): Promise<Tab> {
    return this.browser.waitForTab(
      (tab) => this.browser.targetInfo.get(tab.id)?.openerId === this.id,
      options,
    );
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      if (!this.closed) await this.browser.cdp.send('Target.closeTarget', { targetId: this.id });
      this.dispose();
    })());
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.browser.frontTab === this) this.browser.frontTab = undefined;
    this.framesManager.dispose();
    this.network.dispose();
    this.downloads.clear();
    if (this.session.id) this.session.connection.detach(this.session.id);
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
