import type { Protocol } from 'devtools-protocol';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from './browser.ts';
import type { Tab } from '../page/tab.ts';
import type { Session } from '../protocol/connection.ts';
import type { Frame } from '../page/frames.ts';
import type { NavigationOptions } from '../page/navigation.ts';
import { ProxyForwarder } from '../optional/proxy.ts';
import { ClearSiteDataError, NodriverError } from '../errors.ts';
import { bounded, budget, within, type WaitOptions } from '../utils.ts';
import { TabScope } from './tab-scope.ts';
import {
  blockedDatabase,
  exportIndexedDB,
  importIndexedDB,
  type IndexedDBDatabase,
} from './indexeddb.ts';
import { checkedInputPolicy, type InputPolicy } from '../input/behavior.ts';
export interface ContextOptions {
  proxyServer?: string;
  proxyBypassList?: string;
  proxy?: string;
  originsWithUniversalNetworkAccess?: string[];
  /** Input policy of the context's tabs and popups; see setDefaultInputPolicy(). */
  inputPolicy?: InputPolicy;
}
export interface StorageState {
  version: 2;
  cookies: Protocol.Network.CookieParam[];
  origins: Array<{
    origin: string;
    localStorage: Record<string, string>;
    indexedDB?: IndexedDBDatabase[];
  }>;
  sessionStorage?: Array<{ origin: string; values: Record<string, string> }>;
}
/** A state to restore; files saved before the format had a version have none. */
export type SavedStorageState = Omit<StorageState, 'version'> & { version?: 2 };
export interface StorageStateOptions {
  /** Also export these; cookies and localStorage always are. */
  include?: Array<'sessionStorage' | 'indexedDB'>;
  /** Fails the export when its JSON would be larger; 64 MiB by default. */
  maxBytes?: number;
  /** Also writes the state to this file. */
  path?: string;
}
export interface RestoreStorageOptions {
  /** Receives the state's sessionStorage, and is left on about:blank. */
  sessionStorageTab?: Tab;
}
export type SiteDataType =
  'cookies' | 'localStorage' | 'sessionStorage' | 'indexedDB' | 'cacheStorage' | 'serviceWorkers';
export interface ClearSiteDataOptions extends WaitOptions {
  /** Hosts whose data is cleared together with their subdomains, such as `example.com`. */
  domains?: string[];
  /** Exact HTTP(S) origins: their pages and storage, and the cookies of their host. */
  origins?: string[];
  /** Defaults to every type. */
  types?: SiteDataType[];
  /**
   * Tabs that show a matching origin could write its data back, and tabs that have shown one
   * keep its sessionStorage. "fail" (default) refuses before clearing anything, "close" closes
   * them, and "blank" clears their sessionStorage of matching origins and leaves them on
   * about:blank. Matching pages this client has not attached can only be closed. The call covers
   * the pages open when it starts, attached or not, and not pages that open during it.
   */
  openTabs?: 'fail' | 'close' | 'blank';
  /**
   * One deadline for the whole call, without one by default; each command keeps the connection's
   * command timeout. Restoring a tab after a visit has its own 5 s deadline per step, and a
   * temporary tab still open at the deadline closes after the call returns.
   */
  timeout?: number;
}
export interface ClearSiteDataResult {
  /** Deleted cookies, without their values. */
  cookies: Array<Pick<Protocol.Network.Cookie, 'name' | 'domain' | 'path' | 'partitionKey'>>;
  /** Origins whose storage was cleared. */
  origins: string[];
  /** Target IDs of the tabs and pages that were closed or blanked. */
  tabs: string[];
}
/** Deadline of each step that restores a tab after visiting origins in it. */
const RESTORE_TIMEOUT = 5_000;
const DEFAULT_STATE_BYTES = 64 * 1024 * 1024;
const STORAGE_TYPES: Partial<Record<SiteDataType, string>> = {
  localStorage: 'local_storage',
  indexedDB: 'indexeddb',
  cacheStorage: 'cache_storage',
  serviceWorkers: 'service_workers',
};
function httpOrigin(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
}
export class BrowserContext {
  downloadDirectory?: string;
  private readonly usedOrigins = new Set<string>();
  private closing?: Promise<void>;
  private disposed = false;
  private inputDefault?: InputPolicy;
  readonly browser: Browser;
  readonly id?: string;
  readonly proxy?: ProxyForwarder;
  readonly proxyConfigured: boolean;
  constructor(browser: Browser, id?: string, proxy?: ProxyForwarder, proxyConfigured = false) {
    this.browser = browser;
    this.id = id;
    this.proxy = proxy;
    this.proxyConfigured = proxyConfigured;
  }
  get tabs(): Tab[] {
    return this.browser.tabs.filter((t) => t.context === this);
  }
  get closed(): boolean {
    return this.disposed || this.browser.closed;
  }
  /** Input policy of tabs opened later in this context, if it has its own. */
  get defaultInputPolicy(): InputPolicy | undefined {
    return structuredClone(this.inputDefault);
  }
  /**
   * Sets the input policy of tabs that open later in this context, popups included, over the
   * browser's default; undefined falls back to it. Open tabs keep theirs.
   */
  setDefaultInputPolicy(policy: InputPolicy | undefined): void {
    this.inputDefault = policy && checkedInputPolicy(policy);
  }
  /** A scope for the pages of one task in this context; see TabScope. */
  tabScope(): TabScope {
    if (this.closed) throw new NodriverError('BrowserContext is closed');
    return new TabScope(this);
  }
  /** Opens a tab in this context; see Browser.newTab(). */
  async newTab(url = 'about:blank', options: NavigationOptions = {}): Promise<Tab> {
    if (this.closed) throw new NodriverError('BrowserContext is closed');
    return this.browser.newTab(url, this, options);
  }
  async cookies(): Promise<Protocol.Network.Cookie[]> {
    return (await this.browser.cdp.send('Storage.getCookies', { browserContextId: this.id }))
      .cookies;
  }
  async setCookies(cookies: Protocol.Network.CookieParam[]): Promise<void> {
    await this.browser.cdp.send('Storage.setCookies', { cookies, browserContextId: this.id });
  }
  async clearCookies(): Promise<void> {
    await this.browser.cdp.send('Storage.clearCookies', { browserContextId: this.id });
  }
  async saveCookies(path: string): Promise<void> {
    await writeFile(path, JSON.stringify(await this.cookies(), null, 2));
  }
  async loadCookies(path: string): Promise<void> {
    await this.setCookies(
      JSON.parse(await readFile(path, 'utf8')) as Protocol.Network.CookieParam[],
    );
  }
  async grantPermissions(
    permissions: Protocol.Browser.PermissionType[],
    origin?: string,
  ): Promise<void> {
    await this.browser.cdp.send('Browser.grantPermissions', {
      permissions,
      origin,
      browserContextId: this.id,
    });
  }
  async resetPermissions(): Promise<void> {
    await this.browser.cdp.send('Browser.resetPermissions', { browserContextId: this.id });
  }
  async setDownloadDirectory(path: string): Promise<void> {
    const directory = resolve(path);
    await mkdir(directory, { recursive: true });
    await this.browser.cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: directory,
      eventsEnabled: true,
      browserContextId: this.id,
    });
    this.downloadDirectory = directory;
  }
  /** Records an HTTP(S) origin committed by any frame, so storageState() covers it later. */
  noteOrigin(url: string): void {
    const origin = httpOrigin(url);
    if (origin) this.usedOrigins.add(origin);
  }
  /** @internal Drops an origin that only a library-owned page used. */
  forgetOrigin(origin: string): void {
    this.usedOrigins.delete(origin);
  }
  /**
   * Visits each origin in one owned temporary tab whose document requests are fulfilled with an
   * empty page: the site is never contacted, cannot redirect, and runs no script.
   */
  private async atOrigins(
    origins: Iterable<string>,
    fn: (frame: Frame, origin: string) => Promise<void>,
  ): Promise<void> {
    const list = [...origins];
    if (!list.length) return;
    const tab = await this.newTab();
    try {
      await this.visitOrigins(tab, list, fn);
    } catch (error) {
      // The visit's failure stands; a failure to close the tab as well is reported apart from it.
      await tab
        .close()
        .catch((failure: unknown) => this.browser.reportCloseFailure(tab.id, failure));
      throw error;
    }
    await tab.close();
  }
  /**
   * Navigates `tab` to each origin on an empty page that is fulfilled ahead of the tab's own
   * routes, so the site is never contacted, cannot redirect and runs no script, then to
   * about:blank.
   */
  private async visitOrigins(
    tab: Tab,
    origins: string[],
    fn: (frame: Frame, origin: string) => Promise<void>,
    step: () => WaitOptions = () => ({}),
  ): Promise<void> {
    if (!origins.length) return;
    let target = '';
    let route: { installed: Promise<void>; remove: () => Promise<void> } | undefined;
    // Whatever was sent is undone, also when Chrome applied it without answering in time.
    let bypassing = false;
    let failure: { error: unknown } | undefined;
    try {
      const wait = step();
      bypassing = true;
      // A registered service worker would otherwise answer the navigation with site code.
      await tab.cdp.sendWith('Network.setBypassServiceWorker', wait, { bypass: true });
      route = tab.network.routeFirst(/.*/, (route) =>
        route.request.request.url === target && route.request.resourceType === 'Document'
          ? route.fulfill({ headers: { 'content-type': 'text/html' }, body: '<!doctype html>' })
          : route.abort('BlockedByClient'),
      );
      void route.installed.catch(() => {});
      await bounded(route.installed, step(), 'Visiting origins');
      for (const origin of origins) {
        target = `${origin}/`;
        await tab.goto(target, step());
        await fn(tab.mainFrame, origin);
      }
      target = '';
      await tab.goto('about:blank', step());
    } catch (error) {
      failure = { error };
    }
    // remove() takes the route out before its first await, even while it is being installed.
    const removing = route?.remove();
    void removing?.catch(() => {});
    // Each step has its own deadline. A closed tab has nothing left to undo.
    const undo: unknown[] = [];
    if (removing && !tab.closed)
      await bounded(removing, { timeout: RESTORE_TIMEOUT }, 'Removing a route').catch(
        (error: unknown) => undo.push(error),
      );
    if (bypassing && !tab.closed)
      await tab.cdp
        .sendWith('Network.setBypassServiceWorker', { timeout: RESTORE_TIMEOUT }, { bypass: false })
        .catch((error: unknown) => undo.push(error));
    const failed = tab.closed ? [] : undo;
    // The visit's own failure stands; undoing it that fails as well is reported apart from it.
    if (failure) {
      for (const error of failed) tab.reportError(error);
      throw failure.error;
    }
    for (const error of failed.slice(1)) tab.reportError(error);
    if (failed.length) throw failed[0];
  }
  /** The page targets among `pages` that belong to this context. */
  private async inContext(
    pages: Protocol.Target.TargetInfo[],
    options: WaitOptions,
  ): Promise<Protocol.Target.TargetInfo[]> {
    if (!pages.length) return [];
    if (this.id) return pages.filter((info) => info.browserContextId === this.id);
    const { browserContextIds, defaultBrowserContextId } = await this.browser.cdp.sendWith(
      'Target.getBrowserContexts',
      options,
    );
    return pages.filter((info) =>
      defaultBrowserContextId
        ? !info.browserContextId || info.browserContextId === defaultBrowserContextId
        : !browserContextIds.includes(info.browserContextId ?? ''),
    );
  }
  /**
   * Deletes the cookies and storage of some sites, keeping everything else in the context.
   * Pages and storage match a listed origin exactly, or any origin under a listed domain.
   * Cookies ignore scheme and port: those of a listed origin's host, of a listed domain and its
   * subdomains, and cookies partitioned under such a site are deleted. Storage is cleared for the
   * listed origins, for `http(s)://<domain>`, and for every origin under a listed domain that this
   * context is known to have used. sessionStorage belongs to a tab: it is cleared in the tabs
   * that hold it, which openTabs must allow. Storage commands go to a page session, which Chrome
   * requires. Once it has started, a call that stops, by timeout, signal or a failed step, throws
   * ClearSiteDataError with what it did so far.
   */
  async clearSiteData(options: ClearSiteDataOptions): Promise<ClearSiteDataResult> {
    if (this.closed) throw new NodriverError('BrowserContext is closed');
    const domains = (options.domains ?? []).map((domain) => {
      const host = domain.toLowerCase().replace(/^\./, '');
      if (!host || !URL.canParse(`http://${host}/`) || new URL(`http://${host}/`).hostname !== host)
        throw new TypeError(`Not a domain: ${domain}`);
      return host;
    });
    const origins = new Set(
      (options.origins ?? []).map((origin) => {
        const normalized = httpOrigin(origin);
        if (!normalized) throw new TypeError(`Not an HTTP(S) origin: ${origin}`);
        return normalized;
      }),
    );
    if (!domains.length && !origins.size)
      throw new TypeError('clearSiteData requires domains or origins');
    const types = new Set(options.types ?? (Object.keys(STORAGE_TYPES) as SiteDataType[]));
    if (!options.types) types.add('cookies').add('sessionStorage');
    for (const type of types)
      if (!['cookies', 'sessionStorage', ...Object.keys(STORAGE_TYPES)].includes(type))
        throw new TypeError(`Unknown site data type: ${type}`);
    const openTabs = options.openTabs ?? 'fail';
    if (!['fail', 'close', 'blank'].includes(openTabs))
      throw new TypeError('openTabs must be fail, close or blank');

    const under = (host: string) =>
      domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    const originMatches = (url: string) => {
      const origin = httpOrigin(url);
      return origin !== undefined && (origins.has(origin) || under(new URL(origin).hostname));
    };
    const originHosts = new Set([...origins].map((origin) => new URL(origin).hostname));
    const hostMatches = (host: string) => originHosts.has(host) || under(host);
    const cookieMatches = (cookie: Protocol.Network.Cookie) => {
      if (hostMatches(cookie.domain.replace(/^\./, ''))) return true;
      const key = cookie.partitionKey as Protocol.Network.CookiePartitionKey | string | undefined;
      const site = typeof key === 'string' ? key : key?.topLevelSite;
      return !!site && URL.canParse(site) && hostMatches(new URL(site).hostname);
    };

    const step = budget(options, 'clearSiteData');
    // Filled in as steps complete, so that a call that stops reports what it did.
    const result: ClearSiteDataResult = { cookies: [], origins: [], tabs: [] };
    let refusal: NodriverError | undefined;
    try {
      // The call covers the pages of this context open when it starts, attached or not, fixed here
      // before the first wait. Pages that open during the call are left alone.
      const live = new Set(this.browser.tabs.map((tab) => tab.id));
      const pages = new Set(this.tabs.map((tab) => tab.id));
      const unattached = this.browser.pageTargets.filter((info) => !live.has(info.targetId));
      const known = new Set(this.usedOrigins);
      for (const info of await this.inContext(unattached, step())) {
        pages.add(info.targetId);
        const origin = httpOrigin(info.url);
        if (origin) known.add(origin);
      }
      // Collect every origin before any page changes: closing or blanking a tab loses its frames.
      // A page still being attached is waited for, and one attached meanwhile is read as a tab.
      const held = new Map<string, string[]>();
      // Reattaching keeps the target ID but replaces the Tab and its session.
      const collected = new Set<Tab>();
      for (;;) {
        const attaching = [...pages].flatMap((id) => this.browser.attachInProgress(id) ?? []);
        if (attaching.length) {
          await bounded(Promise.allSettled(attaching), step(), 'clearSiteData');
          continue;
        }
        const unread = this.tabs.filter((tab) => pages.has(tab.id) && !collected.has(tab));
        if (!unread.length) break;
        for (const tab of unread) {
          const committed = new Set(tab.origins);
          // History also names origins the tab committed before this client attached it.
          const history = await tab.cdp
            .sendWith('Page.getNavigationHistory', step())
            .catch(() => undefined);
          step();
          for (const entry of history?.entries ?? []) {
            const origin = httpOrigin(entry.url);
            if (origin) committed.add(origin);
          }
          const matching = new Set(held.get(tab.id));
          for (const origin of committed) {
            known.add(origin);
            if (originMatches(origin)) matching.add(origin);
          }
          held.set(tab.id, [...matching]);
          collected.add(tab);
        }
      }

      // Each page is handled by whether this client has it attached now, with no wait since the
      // last check above.
      const session = types.has('sessionStorage');
      const holds = (id: string) => session && !!held.get(id)?.length;
      const tabs = this.tabs.filter(
        (tab) =>
          pages.has(tab.id) &&
          (holds(tab.id) || tab.frames.some((frame) => originMatches(frame.url))),
      );
      const attached = new Set(this.tabs.map((tab) => tab.id));
      // Pages this client has not attached, or no longer has, are known by their target info.
      const foreign = [...pages].flatMap((id) => {
        const info = this.browser.targetInfo.get(id);
        return info && !attached.has(id) && (holds(id) || originMatches(info.url)) ? [info] : [];
      });
      for (const info of foreign) {
        const origin = httpOrigin(info.url);
        if (origin) known.add(origin);
      }
      if (openTabs === 'fail' && (tabs.length || foreign.length))
        throw (refusal = new NodriverError(
          `Tabs show these sites or hold their sessionStorage, and could keep or write their data back: ${[...tabs.map((tab) => tab.url), ...foreign.map((info) => info.url)].join(', ')}; pass openTabs: 'close' or 'blank'`,
        ));
      if (openTabs === 'blank' && foreign.length)
        throw (refusal = new NodriverError(
          `Pages this client has not attached show these sites or hold their sessionStorage: ${foreign.map((info) => info.url).join(', ')}; attach them with attachTarget() or pass openTabs: 'close'`,
        ));
      // By target ID, as a page attached or detached meanwhile is closed differently. A page that
      // closed by itself needs no closing.
      const close = async (targetId: string) => {
        try {
          // The budget is checked before the page is closed, not after.
          const wait = step();
          const tab = this.tabs.find((t) => t.id === targetId);
          if (tab) await bounded(tab.close(), wait, 'clearSiteData');
          else await this.browser.cdp.sendWith('Target.closeTarget', wait, { targetId });
        } catch (error) {
          if (this.browser.targetInfo.has(targetId)) throw error;
        }
        result.tabs.push(targetId);
      };
      const clearSession = (frame: Frame, origin: string) => {
        const wait = step();
        return bounded(frame.setStorage({}, 'session', true, origin), wait, 'clearSiteData');
      };
      for (const info of foreign) await close(info.targetId);
      for (const tab of tabs) {
        if (openTabs === 'close') {
          // Closing a tab also discards all of its sessionStorage.
          await close(tab.id);
          continue;
        }
        if (session)
          for (const frame of tab.frames) {
            const origin = httpOrigin(frame.url);
            if (origin && originMatches(origin)) await clearSession(frame, origin);
          }
        await tab.goto('about:blank', step());
        // A tab keeps an origin's sessionStorage after leaving it, and shows it again on return.
        if (session) await this.visitOrigins(tab, held.get(tab.id) ?? [], clearSession, step);
        result.tabs.push(tab.id);
      }

      const storageTypes = [...types].flatMap((type) => STORAGE_TYPES[type] ?? []).join(',');
      const cleared = new Set(origins);
      if (storageTypes) {
        for (const domain of domains) cleared.add(`https://${domain}`).add(`http://${domain}`);
        for (const origin of known) if (under(new URL(origin).hostname)) cleared.add(origin);
      }
      const jar = async () =>
        (
          await this.browser.cdp.sendWith('Storage.getCookies', step(), {
            browserContextId: this.id,
          })
        ).cookies.filter(cookieMatches);
      await this.withPageSession(async (session) => {
        if (storageTypes)
          for (const origin of cleared) {
            await session.sendWith('Storage.clearDataForOrigin', step(), { origin, storageTypes });
            result.origins.push(origin);
          }
        if (!types.has('cookies')) return;
        for (const { name, domain, path, partitionKey } of await jar()) {
          await session.sendWith('Network.deleteCookies', step(), {
            name,
            domain,
            path,
            partitionKey,
          });
          result.cookies.push(
            partitionKey ? { name, domain, path, partitionKey } : { name, domain, path },
          );
        }
      }, step);
      if (types.has('cookies')) {
        const remaining = await jar();
        if (remaining.length)
          throw new ClearSiteDataError(
            `Cookies were set again while clearing: ${remaining.map((c) => `${c.name} (${c.domain})`).join(', ')}`,
            result,
          );
      }
      return result;
    } catch (error) {
      if (error === refusal || error instanceof ClearSiteDataError) throw error;
      throw new ClearSiteDataError(
        `clearSiteData stopped: ${error instanceof Error ? error.message : String(error)}`,
        result,
        { cause: error },
      );
    }
  }
  /**
   * Runs `fn` on the session of an open tab of this context, or of an owned temporary tab. The tab
   * is closed within `step`'s budget; once that is spent, it closes after this returns, and a
   * failure to close it is reported through browser.errors.
   */
  private async withPageSession<T>(
    fn: (session: Session) => Promise<T>,
    step: () => WaitOptions,
  ): Promise<T> {
    const open = this.tabs.find((tab) => !tab.crashed);
    if (open) return fn(open.cdp);
    const tab = await this.newTab('about:blank', step());
    const report = (failure: unknown) => this.browser.reportCloseFailure(tab.id, failure);
    let result: T;
    try {
      result = await fn(tab.cdp);
    } catch (error) {
      await within(tab.close(), step, report).catch(report);
      throw error;
    }
    await within(tab.close(), step, report);
    return result;
  }
  /**
   * Cookies plus first-party localStorage of every HTTP(S) origin any frame of this context has
   * committed, including iframes and tabs closed since. Origins with empty storage are omitted.
   * Storage partitioned under another top-level site (third-party iframes) is not included.
   * `include` adds the sessionStorage of open tabs, read from their top-level documents, and the
   * IndexedDB databases of those origins. When several tabs show an origin, the first one's
   * sessionStorage is exported.
   */
  async storageState(options: StorageStateOptions = {}): Promise<StorageState> {
    if (typeof options !== 'object')
      throw new TypeError('storageState() takes options; use { path } to write a file');
    const maxBytes = options.maxBytes ?? DEFAULT_STATE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError('maxBytes must be a positive integer');
    const include = new Set(options.include);
    const origins = new Map<string, Record<string, string>>();
    const databases = new Map<string, IndexedDBDatabase[]>();
    const budget = { left: maxBytes };
    const pending = new Set(this.usedOrigins);
    for (const tab of this.tabs)
      for (const frame of tab.frames) {
        const origin = httpOrigin(frame.url);
        if (origin) pending.add(origin);
      }
    const all = [...pending];
    const sessionStorage = new Map<string, Record<string, string>>();
    // Live top-level documents hold their origin's first-party storage; read them in place.
    for (const tab of this.tabs) {
      const origin = httpOrigin(tab.url);
      if (!origin || tab.crashed) continue;
      if (include.has('sessionStorage') && !sessionStorage.has(origin))
        try {
          sessionStorage.set(origin, await tab.mainFrame.storage('session', origin));
        } catch {
          // Navigated, sandboxed or closed meanwhile: no document holds this tab's storage now.
        }
      if (origins.has(origin)) continue;
      try {
        origins.set(origin, await tab.mainFrame.storage('local', origin));
        pending.delete(origin);
      } catch {
        // Navigated, sandboxed or closed meanwhile: read it from the temporary tab instead.
      }
    }
    await this.atOrigins(include.has('indexedDB') ? all : pending, async (frame, origin) => {
      if (pending.has(origin)) origins.set(origin, await frame.storage('local', origin));
      if (!include.has('indexedDB')) return;
      const found = await exportIndexedDB(frame, origin, budget);
      if (found.length) databases.set(origin, found);
    });
    for (const [origin, values] of origins)
      if (!Object.keys(values).length && !databases.has(origin)) origins.delete(origin);
    const cookies = (await this.cookies()).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expires: c.session ? undefined : c.expires,
      partitionKey: c.partitionKey,
    }));
    const state: StorageState = {
      version: 2,
      cookies,
      origins: [...origins].map(([origin, localStorage]) => {
        const stored = databases.get(origin);
        return { origin, localStorage, ...(stored ? { indexedDB: stored } : {}) };
      }),
    };
    if (include.has('sessionStorage'))
      state.sessionStorage = [...sessionStorage]
        .filter(([, values]) => Object.keys(values).length)
        .map(([origin, values]) => ({ origin, values }));
    const text = JSON.stringify(state, null, 2);
    if (Buffer.byteLength(text) > maxBytes)
      throw new RangeError(`Storage state exceeds maxBytes (${maxBytes})`);
    if (options.path) await writeFile(options.path, text);
    return state;
  }
  /**
   * Sets the cookies, then replaces the localStorage of each listed origin. An open top-level
   * document of the origin sees the values on return; other open documents of that origin receive
   * the change asynchronously, as with a write from another tab. Listed IndexedDB databases are
   * replaced, which is refused while a page shows their origin. A state's sessionStorage goes to
   * `sessionStorageTab`, which is navigated through its origins on empty intercepted pages.
   */
  async restoreStorage(
    state: SavedStorageState,
    options: RestoreStorageOptions = {},
  ): Promise<void> {
    if (state.version !== undefined && state.version !== 2)
      throw new TypeError(`Unsupported storage state version: ${String(state.version)}`);
    const entries = new Map<string, Record<string, string>>();
    const databases = new Map<string, IndexedDBDatabase[]>();
    for (const entry of state.origins) {
      const origin = httpOrigin(entry.origin);
      if (!origin) throw new TypeError('Storage restore requires HTTP(S) origins');
      entries.set(origin, entry.localStorage);
      if (entry.indexedDB?.length) databases.set(origin, entry.indexedDB);
    }
    const session = new Map<string, Record<string, string>>();
    for (const entry of state.sessionStorage ?? []) {
      const origin = httpOrigin(entry.origin);
      if (!origin) throw new TypeError('Storage restore requires HTTP(S) origins');
      session.set(origin, entry.values);
    }
    const target = options.sessionStorageTab;
    if (session.size && !target)
      throw new TypeError('This state has sessionStorage; pass sessionStorageTab to receive it');
    if (target && target.context !== this)
      throw new TypeError('sessionStorageTab must belong to this context');
    const holders = this.tabs.filter((tab) =>
      tab.frames.some((frame) => databases.has(httpOrigin(frame.url) ?? '')),
    );
    if (holders.length)
      throw new NodriverError(
        `Pages of these origins may hold their IndexedDB databases open; close them before restoring: ${holders.map((tab) => tab.url).join(', ')}`,
      );
    await this.setCookies(state.cookies);
    // Write through a live top-level document of the origin where one exists: a write from the
    // temporary tab reaches other renderers asynchronously, after this method has returned.
    for (const tab of this.tabs) {
      const origin = httpOrigin(tab.url);
      const values = origin && entries.get(origin);
      if (!origin || !values || tab.crashed) continue;
      try {
        await tab.mainFrame.setStorage(values, 'local', true, origin);
        entries.delete(origin);
      } catch {
        // Navigated, sandboxed or closed meanwhile: write it from the temporary tab instead.
      }
    }
    const visits = new Set([...entries.keys(), ...databases.keys()]);
    await this.atOrigins(visits, async (frame, origin) => {
      const values = entries.get(origin);
      if (values) await frame.setStorage(values, 'local', true, origin);
      const stored = databases.get(origin);
      if (!stored) return;
      await importIndexedDB(frame, origin, stored).catch((error: unknown) => {
        const name = blockedDatabase(error);
        throw name === undefined
          ? error
          : new NodriverError(
              `Another page or worker of ${origin} keeps IndexedDB database ${name} open; it was not restored, and is deleted when that connection closes`,
              { cause: error },
            );
      });
    });
    if (target && session.size)
      await this.visitOrigins(target, [...session.keys()], (frame, origin) =>
        frame.setStorage(session.get(origin)!, 'session', true, origin),
      );
  }
  close(): Promise<void> {
    if (!this.id)
      return Promise.reject(
        new NodriverError(
          'The default context cannot be disposed; close individual tabs or the owned browser',
        ),
      );
    const id = this.id;
    return (this.closing ??= (async () => {
      try {
        if (!this.browser.closed)
          await this.browser.cdp.send('Target.disposeBrowserContext', { browserContextId: id });
      } finally {
        this.disposed = true;
        this.browser.contextMap.delete(this.id!);
        await this.proxy?.close();
      }
    })());
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
