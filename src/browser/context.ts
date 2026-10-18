import type { Protocol } from 'devtools-protocol';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from './browser.js';
import type { Tab } from '../page/tab.js';
import type { Frame } from '../page/frames.js';
import { ProxyForwarder } from '../optional/proxy.js';
import { NodriverError } from '../errors.js';
export interface ContextOptions {
  proxyServer?: string;
  proxyBypassList?: string;
  proxy?: string;
  originsWithUniversalNetworkAccess?: string[];
}
export interface StorageState {
  cookies: Protocol.Network.CookieParam[];
  origins: Array<{ origin: string; localStorage: Record<string, string> }>;
}
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
  constructor(
    readonly browser: Browser,
    readonly id?: string,
    readonly proxy?: ProxyForwarder,
    readonly proxyConfigured = false,
  ) {}
  get tabs(): Tab[] {
    return this.browser.tabs.filter((t) => t.context === this);
  }
  get closed(): boolean {
    return this.disposed || this.browser.closed;
  }
  async newTab(url = 'about:blank'): Promise<Tab> {
    if (this.closed) throw new NodriverError('BrowserContext is closed');
    return this.browser.newTab(url, this);
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
      // A registered service worker would otherwise answer the navigation with site code.
      await tab.cdp.send('Network.setBypassServiceWorker', { bypass: true });
      let target = '';
      await tab.network.route(/.*/, (route) =>
        route.request.request.url === target && route.request.resourceType === 'Document'
          ? route.fulfill({ headers: { 'content-type': 'text/html' }, body: '<!doctype html>' })
          : route.abort('BlockedByClient'),
      );
      for (const origin of list) {
        target = `${origin}/`;
        await tab.goto(target);
        await fn(tab.mainFrame, origin);
      }
    } finally {
      await tab.close();
    }
  }
  /**
   * Cookies plus first-party localStorage of every HTTP(S) origin any frame of this context has
   * committed, including iframes and tabs closed since. Origins with empty storage are omitted.
   * Storage partitioned under another top-level site (third-party iframes) is not included.
   */
  async storageState(path?: string): Promise<StorageState> {
    const origins = new Map<string, Record<string, string>>();
    const pending = new Set(this.usedOrigins);
    for (const tab of this.tabs)
      for (const frame of tab.frames) {
        const origin = httpOrigin(frame.url);
        if (origin) pending.add(origin);
      }
    // Live top-level documents hold their origin's first-party storage; read them in place.
    for (const tab of this.tabs) {
      const origin = httpOrigin(tab.url);
      if (!origin || origins.has(origin) || tab.crashed) continue;
      try {
        origins.set(origin, await tab.mainFrame.storage('local', origin));
        pending.delete(origin);
      } catch {
        // Navigated, sandboxed or closed meanwhile: read it from the temporary tab instead.
      }
    }
    await this.atOrigins(pending, async (frame, origin) => {
      origins.set(origin, await frame.storage('local', origin));
    });
    for (const [origin, values] of origins) if (!Object.keys(values).length) origins.delete(origin);
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
    const state = {
      cookies,
      origins: [...origins].map(([origin, localStorage]) => ({ origin, localStorage })),
    };
    if (path) await writeFile(path, JSON.stringify(state, null, 2));
    return state;
  }
  /** Sets the cookies, then replaces the localStorage of each listed origin. */
  async restoreStorage(state: StorageState): Promise<void> {
    const entries = new Map<string, Record<string, string>>();
    for (const entry of state.origins) {
      const origin = httpOrigin(entry.origin);
      if (!origin) throw new TypeError('Storage restore requires HTTP(S) origins');
      entries.set(origin, entry.localStorage);
    }
    await this.setCookies(state.cookies);
    await this.atOrigins(entries.keys(), (frame, origin) =>
      frame.setStorage(entries.get(origin)!, 'local', true, origin),
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
      if (!this.browser.closed)
        await this.browser.cdp.send('Target.disposeBrowserContext', { browserContextId: id });
      this.disposed = true;
      this.browser.contextMap.delete(this.id!);
      await this.proxy?.close();
    })());
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
