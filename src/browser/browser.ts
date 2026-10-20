import type { Protocol } from 'devtools-protocol';
import { Connection, type ConnectionOptions, type Session } from '../protocol/connection.ts';
import { BrowserProcess, type LaunchOptions } from './launcher.ts';
import { BrowserContext, type ContextOptions } from './context.ts';
import { Tab, type Environment } from '../page/tab.ts';
import { Download } from './download.ts';
import { ProxyForwarder } from '../optional/proxy.ts';
import { WebSocketTransport } from '../transport/websocket.ts';
import {
  abortReason,
  CONNECT_TIMEOUT,
  EventHub,
  poll,
  timeoutValue,
  type WaitOptions,
} from '../utils.ts';
import { DisconnectedError, NodriverError, TimeoutError } from '../errors.ts';
import { InputCoordinator } from '../input/behavior.ts';
/**
 * Which page targets a Browser attaches to. "all" adopts every page; "created" adopts only tabs
 * opened through this client and popups they open, leaving a user's existing tabs untouched.
 */
export type AttachPolicy = 'all' | 'created';
export interface ConnectOptions extends ConnectionOptions, WaitOptions {
  endpoint: string;
  /** Defaults to "all". Use "created" when sharing a user's everyday browser. */
  attach?: AttachPolicy;
}
export class Browser {
  readonly input = new InputCoordinator();
  networkPolicy: {
    proxyConfigured: boolean | 'unknown';
    webRtcIPHandlingPolicy: LaunchOptions['webRtcIPHandlingPolicy'] | 'native' | 'unknown';
  } = { proxyConfigured: 'unknown', webRtcIPHandlingPolicy: 'unknown' };
  readonly cdp: Session;
  readonly contextMap = new Map<string, BrowserContext>();
  readonly targetInfo = new Map<string, Protocol.Target.TargetInfo>();
  readonly tabCreated = new EventHub<Tab>();
  readonly errors = new EventHub<unknown>();
  readonly version: Protocol.Browser.GetVersionResponse;
  /** Tab last brought to front by this client; cleared when another page may have taken focus. */
  frontTab?: Tab;
  /** Environment applied to every page session before the tab's own overrides. */
  baseEnvironment: Environment = {};
  private tabMap = new Map<string, Tab>();
  private attaching = new Map<string, Promise<Tab>>();
  private downloads = new Map<string, Download>();
  private closing?: Promise<void>;
  private releasing?: Promise<string>;
  private disconnected = false;
  readonly connection: Connection;
  readonly process?: BrowserProcess;
  readonly endpoint?: string;
  readonly attachPolicy: AttachPolicy;
  private constructor(
    connection: Connection,
    version: Protocol.Browser.GetVersionResponse,
    process?: BrowserProcess,
    endpoint?: string,
    attachPolicy: AttachPolicy = 'all',
  ) {
    this.connection = connection;
    this.process = process;
    this.endpoint = endpoint;
    this.attachPolicy = attachPolicy;
    this.cdp = connection.root;
    this.version = version;
    this.contextMap.set('', new BrowserContext(this));
    connection.disconnected.on(() => {
      this.disconnected = true;
      for (const tab of this.tabMap.values()) tab.dispose();
      this.tabMap.clear();
      this.tabCreated.clear();
    });
  }
  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const launched = await BrowserProcess.start(options);
    const connection = new Connection(launched.transport, {
      timeout: options.timeout,
      onError: options.onError,
      trace: options.trace,
    });
    try {
      const version = await connection.root.sendWith('Browser.getVersion', {
        timeout: options.timeout ?? CONNECT_TIMEOUT,
        signal: options.signal,
      });
      const browser = new Browser(connection, version, launched.process, launched.endpoint);
      browser.networkPolicy = {
        proxyConfigured: !!(
          options.proxyServer || options.args?.some((a) => a.startsWith('--proxy-server'))
        ),
        webRtcIPHandlingPolicy: options.webRtcIPHandlingPolicy ?? 'native',
      };
      await browser.initialize();
      // With Pipe, CDP can answer before Chrome has created its startup window.
      // Let the command-line about:blank target finish attaching before callers
      // create another tab, otherwise late startup work can abort its navigation.
      await poll(
        async () => {
          const tab = browser.tabs.find((t) => t.mainFrame?.url === 'about:blank');
          if (!tab) return undefined;
          await browser.attaching.get(tab.id);
          return tab.closed ? undefined : true;
        },
        { timeout: options.timeout ?? CONNECT_TIMEOUT, signal: options.signal },
        'Chrome startup tab',
      );
      if ((options.maskHeadless ?? options.headless === true) && !options.userAgent)
        await browser.maskHeadless();
      return browser;
    } catch (e) {
      await connection.close();
      const { exited, exitCode, stderr } = launched.process.diagnostics;
      await launched.process.close();
      if (exited)
        throw new NodriverError(
          `Chrome ${exited ? `exited (${exitCode})` : 'failed'} during startup: ${e instanceof Error ? e.message : String(e)}${stderr.trim() ? `\n${stderr.trim()}` : ''}`,
          { cause: e },
        );
      throw e;
    }
  }
  static async connect(options: ConnectOptions): Promise<Browser> {
    let endpoint = options.endpoint;
    if (/^https?:/.test(endpoint)) {
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout ?? CONNECT_TIMEOUT)])
        : AbortSignal.timeout(options.timeout ?? CONNECT_TIMEOUT);
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/json/version`, { signal });
      if (!response.ok)
        throw new DisconnectedError(`Endpoint discovery returned HTTP ${response.status}`);
      endpoint = ((await response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    }
    const transport = await WebSocketTransport.connect(endpoint, options);
    const connection = new Connection(transport, options);
    try {
      const version = await connection.root.send('Browser.getVersion');
      const browser = new Browser(connection, version, undefined, endpoint, options.attach);
      await browser.initialize();
      return browser;
    } catch (e) {
      await connection.close();
      throw e;
    }
  }
  /**
   * Replaces "HeadlessChrome" with "Chrome" in the UA string and UA-CH brands through a base
   * per-session override. Dedicated workers inherit it; shared and service workers are separate
   * targets and may keep the native value, so prefer headful where that matters.
   */
  private async maskHeadless(): Promise<void> {
    if (!this.version.userAgent.includes('HeadlessChrome')) return;
    const userAgent = this.version.userAgent.replace('HeadlessChrome/', 'Chrome/');
    const rename = (list: unknown) =>
      Array.isArray(list)
        ? (list as Array<{ brand: string; version: string }>).map((b) => ({
            brand: b.brand === 'HeadlessChrome' ? 'Google Chrome' : b.brand,
            version: b.version,
          }))
        : undefined;
    // UA-CH is SecureContext-only and about:blank is not secure; read the native values from
    // a short-lived WebUI tab so the override keeps client hints consistent with the browser.
    const probe = await this.newTab('chrome://version');
    let ch: Record<string, unknown> | undefined;
    try {
      ch = (await probe.inspectEnvironment()).document.userAgentData;
    } finally {
      await probe.close();
    }
    if (!ch || !Array.isArray(ch.brands))
      throw new NodriverError('Cannot read native UA client hints to mask headless Chrome');
    const userAgentMetadata = {
      brands: rename(ch.brands),
      fullVersionList: rename(ch.fullVersionList),
      platform: ch.platform,
      platformVersion: ch.platformVersion ?? '',
      architecture: ch.architecture ?? '',
      model: ch.model ?? '',
      mobile: ch.mobile ?? false,
      bitness: ch.bitness,
      wow64: ch.wow64,
    } as Protocol.Emulation.UserAgentMetadata;
    this.baseEnvironment = { ...this.baseEnvironment, userAgent, userAgentMetadata };
    for (const t of this.tabs) await t.setEnvironment({ userAgent, userAgentMetadata });
  }
  get tabs(): Tab[] {
    return [...this.tabMap.values()].filter((t) => !t.closed);
  }
  get contexts(): BrowserContext[] {
    return [...new Set(this.contextMap.values())];
  }
  get defaultContext(): BrowserContext {
    return this.contextMap.get('')!;
  }
  get closed(): boolean {
    return this.disconnected || this.connection.closed;
  }
  get owned(): boolean {
    return !!this.process && !this.process.released;
  }
  reportError(error: unknown): void {
    try {
      this.connection.options.onError?.(error);
    } catch {}
    this.errors.emit(error);
  }
  private async initialize(): Promise<void> {
    this.cdp.on('Target.targetCreated', (e) => {
      this.targetInfo.set(e.targetInfo.targetId, e.targetInfo);
      if (e.targetInfo.type === 'page') this.frontTab = undefined;
      if (e.targetInfo.type === 'page' && this.shouldAttach(e.targetInfo))
        void this.attach(e.targetInfo).catch((error) => {
          // A page that closes while it is being set up (short-lived popups) is not an error.
          if (!this.closed && !(error instanceof DisconnectedError)) this.reportError(error);
        });
    });
    this.cdp.on('Target.targetInfoChanged', (e) => {
      this.targetInfo.set(e.targetInfo.targetId, e.targetInfo);
    });
    this.cdp.on('Target.targetDestroyed', (e) => {
      this.tabMap.get(e.targetId)?.dispose();
      this.tabMap.delete(e.targetId);
      this.targetInfo.delete(e.targetId);
    });
    this.cdp.on('Browser.downloadWillBegin', (e) => {
      const tab = this.tabs.find((t) => t.frames.some((f) => f.id === e.frameId));
      if (!tab?.context.downloadDirectory) return;
      const download = new Download(
        tab.context,
        e.guid,
        e.url,
        e.suggestedFilename,
        tab.context.downloadDirectory,
      );
      this.downloads.set(e.guid, download);
      tab.downloads.emit(download);
    });
    this.cdp.on('Browser.downloadProgress', (e) => {
      const download = this.downloads.get(e.guid);
      download?.progress(e.state);
      if (e.state !== 'inProgress') this.downloads.delete(e.guid);
    });
    const { browserContextIds } = await this.cdp.send('Target.getBrowserContexts');
    for (const id of browserContextIds) this.contextMap.set(id, new BrowserContext(this, id));
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    for (const info of targetInfos) this.targetInfo.set(info.targetId, info);
    await Promise.all(
      targetInfos
        .filter((t) => t.type === 'page' && this.shouldAttach(t))
        .map((t) => this.attach(t)),
    );
  }
  private shouldAttach(info: Protocol.Target.TargetInfo): boolean {
    if (this.attachPolicy === 'all') return true;
    if (info.openerId && this.tabMap.has(info.openerId)) return true;
    return (
      !!info.openerFrameId &&
      this.tabs.some((t) => t.frames.some((f) => f.id === info.openerFrameId))
    );
  }
  /** Page targets known to the browser, including ones not attached under the "created" policy. */
  get pageTargets(): Protocol.Target.TargetInfo[] {
    return [...this.targetInfo.values()].filter((t) => t.type === 'page');
  }
  /** Explicitly adopts an existing page target, e.g. one listed by pageTargets. */
  async attachTarget(targetId: string): Promise<Tab> {
    const info =
      this.targetInfo.get(targetId) ??
      (await this.cdp.send('Target.getTargetInfo', { targetId })).targetInfo;
    if (info.type !== 'page') throw new TypeError(`Target ${targetId} is not a page`);
    return this.attach(info);
  }
  private attach(info: Protocol.Target.TargetInfo): Promise<Tab> {
    const existing = this.attaching.get(info.targetId);
    if (existing) return existing;
    const ready = this.tabMap.get(info.targetId);
    if (ready) return Promise.resolve(ready);
    const task = (async () => {
      const { sessionId } = await this.cdp.send('Target.attachToTarget', {
        targetId: info.targetId,
        flatten: true,
      });
      const contextKey = info.browserContextId ?? '';
      let context = this.contextMap.get(contextKey);
      if (!context) {
        // Chrome reports an internal ID even for the default context, although
        // getBrowserContexts intentionally lists only non-default contexts.
        const { browserContextIds } = await this.cdp.send('Target.getBrowserContexts');
        context =
          info.browserContextId && browserContextIds.includes(info.browserContextId)
            ? new BrowserContext(this, info.browserContextId)
            : this.defaultContext;
        this.contextMap.set(contextKey, context);
      }
      const tab = new Tab(this, context, info.targetId, this.connection.session(sessionId));
      this.tabMap.set(info.targetId, tab);
      try {
        await tab.initialize();
        this.tabCreated.emit(tab);
        return tab;
      } catch (e) {
        tab.dispose();
        this.tabMap.delete(info.targetId);
        throw e;
      }
    })();
    this.attaching.set(info.targetId, task);
    void task.finally(() => this.attaching.delete(info.targetId)).catch(() => {});
    return task;
  }
  async newTab(url = 'about:blank', context = this.defaultContext): Promise<Tab> {
    const { targetId } = await this.cdp.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId: context.id,
    });
    try {
      const { targetInfo } = await this.cdp.send('Target.getTargetInfo', { targetId });
      this.targetInfo.set(targetId, targetInfo);
      const tab = await this.attach(targetInfo);
      if (url !== 'about:blank') await tab.goto(url);
      return tab;
    } catch (e) {
      await this.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      throw e;
    }
  }
  async newContext(options: ContextOptions = {}): Promise<BrowserContext> {
    const proxy = options.proxy ? await ProxyForwarder.create(options.proxy) : undefined;
    try {
      const { browserContextId } = await this.cdp.send('Target.createBrowserContext', {
        proxyServer: proxy?.url ?? options.proxyServer,
        proxyBypassList: options.proxyBypassList,
        originsWithUniversalNetworkAccess: options.originsWithUniversalNetworkAccess,
      });
      const context = new BrowserContext(
        this,
        browserContextId,
        proxy,
        !!(options.proxy || options.proxyServer),
      );
      this.contextMap.set(browserContextId, context);
      return context;
    } catch (e) {
      await proxy?.close();
      throw e;
    }
  }
  waitForTab(
    predicate: (tab: Tab) => boolean = () => true,
    options: WaitOptions = {},
  ): Promise<Tab> {
    return this.waitEvent(this.tabCreated, predicate, options, 'new tab');
  }
  waitEvent<T>(
    hub: EventHub<T>,
    predicate: (event: T) => boolean,
    options: WaitOptions = {},
    label: string,
    session = this.cdp,
  ): Promise<T> {
    if (session.closed) return Promise.reject(new DisconnectedError('Session closed'));
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    const timeout = timeoutValue(options.timeout ?? this.connection.timeout);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        off();
        offClose();
        options.signal?.removeEventListener('abort', abort);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const off = hub.on((e) => {
        try {
          if (predicate(e)) {
            cleanup();
            resolve(e);
          }
        } catch (error) {
          fail(error as Error);
        }
      });
      const offClose = session.disconnected.on(fail);
      const timer = setTimeout(
        () => fail(new TimeoutError(`Timed out waiting for ${label}`)),
        timeout,
      );
      const abort = () => fail(abortReason(options.signal!));
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  /** Disconnect CDP without relinquishing process ownership. Pipe Chrome exits on disconnect. */
  async disconnect(): Promise<void> {
    await this.connection.close();
  }
  /**
   * Leave Chrome running and return its WebSocket endpoint for Browser.connect().
   * Launched browsers require detached: true. Profiles are retained, including temporary ones.
   * Idempotent; subsequent close()/async disposal only disconnects.
   */
  release(): Promise<string> {
    if (this.releasing) return this.releasing;
    if (this.closing) return Promise.reject(new NodriverError('Browser is already closing'));
    if (!this.endpoint)
      return Promise.reject(
        new NodriverError(
          'release() requires WebSocket transport; Chrome exits when CDP pipes close',
        ),
      );
    if (this.process && !this.process.detached)
      return Promise.reject(new NodriverError('release() requires launch({ detached: true })'));
    if (this.contexts.some((context) => context.proxy))
      return Promise.reject(
        new NodriverError('release() cannot hand off an in-process proxy; close its context first'),
      );
    return (this.releasing = this.releaseInternal());
  }
  private async releaseInternal(): Promise<string> {
    try {
      await this.process?.release();
    } finally {
      await this.disconnect();
      this.downloads.clear();
    }
    return this.endpoint!;
  }
  close(): Promise<void> {
    return (this.closing ??= this.closeInternal());
  }
  private async closeInternal(): Promise<void> {
    await this.releasing?.catch(() => {});
    try {
      if (this.owned && !this.closed) {
        await this.cdp.sendWith('Browser.close', { timeout: 3000 }).catch(() => {});
        await this.process!.waitForExit(3000);
      }
    } finally {
      await this.connection.close();
      try {
        if (this.owned) await this.process!.close();
      } finally {
        for (const context of this.contexts) await context.proxy?.close();
        this.downloads.clear();
      }
    }
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
