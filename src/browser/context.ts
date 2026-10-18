import type { Protocol } from 'devtools-protocol';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from './browser.js';
import type { Tab } from '../page/tab.js';
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
export class BrowserContext {
  downloadDirectory?: string;
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
  async storageState(path?: string): Promise<StorageState> {
    const origins = new Map<string, Record<string, string>>();
    for (const tab of this.tabs) {
      const origin = new URL(tab.url).origin;
      if (origin !== 'null' && !origins.has(origin))
        origins.set(origin, await tab.mainFrame.storage());
    }
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
  async restoreStorage(state: StorageState): Promise<void> {
    await this.setCookies(state.cookies);
    // Explicitly navigates only to the origins supplied by the caller, using an owned temporary tab.
    for (const entry of state.origins) {
      const url = new URL(entry.origin);
      if (!['http:', 'https:'].includes(url.protocol))
        throw new TypeError('Storage restore requires HTTP(S) origins');
      const tab = await this.newTab();
      try {
        await tab.goto(url.origin);
        await tab.mainFrame.setStorage(entry.localStorage, 'local', true);
      } finally {
        await tab.close();
      }
    }
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
