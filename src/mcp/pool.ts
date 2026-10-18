import { Browser } from '../browser/browser.js';
import type { BrowserContext } from '../browser/context.js';
import type { BrowserMcpOptions } from './session.js';
import { OperationQueue } from './queue.js';

export interface BrowserAllocation {
  browser: Browser;
  context?: BrowserContext;
  queue: OperationQueue;
  release(): Promise<void>;
}
interface Entry {
  browser: Browser;
  users: number;
  lastUsed: number;
  queue: OperationQueue;
}

export class BrowserPool {
  private entries = new Set<Entry>();
  private gate = new OperationQueue(128);
  private closed = false;
  readonly exclusive: boolean;
  constructor(
    readonly options: BrowserMcpOptions,
    readonly maxBrowsers: number,
    readonly contextsPerBrowser: number,
    readonly queueLimit: number,
  ) {
    this.exclusive = !!(options.connect || options.launch?.userDataDir);
    if (options.proxy) {
      const proxy = new URL(options.proxy);
      if (options.connect) throw new TypeError('A proxy cannot be applied to a connected browser');
      if ((proxy.username || proxy.password) && this.exclusive)
        throw new TypeError(
          'Authenticated proxies need per-lease contexts; omit userDataDir or use an unauthenticated proxy',
        );
    }
  }
  private launchOptions() {
    const launch = { timeout: 10000, transport: 'pipe' as const, ...this.options.launch };
    // A persistent profile has no per-lease context, so its proxy is browser-wide.
    if (this.options.proxy && this.exclusive) launch.proxyServer ??= this.options.proxy;
    return launch;
  }
  private contextOptions() {
    const proxy = this.options.proxy;
    if (!proxy) return {};
    const parsed = new URL(proxy);
    return parsed.username || parsed.password ? { proxy } : { proxyServer: proxy };
  }
  async acquire(signal: AbortSignal): Promise<BrowserAllocation> {
    return this.gate.run(signal, async () => {
      if (this.closed) throw new Error('Browser pool closed');
      for (const entry of this.entries)
        if (entry.browser.closed && !entry.users) {
          await entry.browser.close();
          this.entries.delete(entry);
        }
      let entry = [...this.entries].find(
        (e) => !e.browser.closed && e.users < (this.exclusive ? 1 : this.contextsPerBrowser),
      );
      if (!entry) {
        // A persistent profile or external connection has a single process owner.
        if (this.entries.size >= (this.exclusive ? 1 : this.maxBrowsers))
          throw new Error('Browser pool capacity reached');
        const browser = this.options.connect
          ? await Browser.connect({
              ...this.options.connect,
              attach:
                this.options.connect.attach ??
                (this.options.exposeExistingTabs ? 'all' : 'created'),
              signal,
            })
          : await Browser.launch({ ...this.launchOptions(), signal });
        entry = {
          browser,
          users: 0,
          lastUsed: Date.now(),
          queue: new OperationQueue(this.queueLimit),
        };
        this.entries.add(entry);
      }
      const selected = entry;
      const context = this.exclusive
        ? undefined
        : await selected.browser.newContext(this.contextOptions());
      selected.users++;
      let released = false;
      return {
        browser: selected.browser,
        context,
        queue: selected.queue,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await context?.close();
          } finally {
            if (this.exclusive || selected.browser.closed) {
              await selected.browser.close();
              this.entries.delete(selected);
            }
            selected.users--;
            selected.lastUsed = Date.now();
          }
        },
      };
    });
  }
  async reap(idleMs: number): Promise<void> {
    await this.gate.run(new AbortController().signal, async () => {
      for (const entry of this.entries)
        if (!entry.users && Date.now() - entry.lastUsed >= idleMs) {
          this.entries.delete(entry);
          await entry.browser.close();
        }
    });
  }
  stats() {
    return {
      browsers: this.entries.size,
      allocations: [...this.entries].reduce((n, e) => n + e.users, 0),
      exclusive: this.exclusive,
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.gate.run(new AbortController().signal, async () => {
      await Promise.all([...this.entries].map((e) => e.browser.close()));
      this.entries.clear();
    });
  }
}
