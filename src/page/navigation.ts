import type { Protocol } from 'devtools-protocol';
import type { Tab } from './tab.ts';
import { abortReason, timeoutValue, type WaitOptions } from '../utils.ts';
import { DisconnectedError, TimeoutError } from '../errors.ts';
export interface NavigationOptions extends WaitOptions {
  /** "networkidle" waits for Chrome's networkIdle lifecycle event (no requests for 500ms). */
  waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle';
}
const lifecycleName = {
  domcontentloaded: 'DOMContentLoaded',
  load: 'load',
  networkidle: 'networkIdle',
} as const;
export class NavigationWatcher {
  readonly promise: Promise<string>;
  private resolve!: (url: string) => void;
  private reject!: (error: Error) => void;
  private cleanups: Array<() => void> = [];
  private expected?: string;
  private committed?: { loader: string; url: string; same: boolean; restored?: boolean };
  private lifecycle = new Map<string, Set<string>>();
  private armed = false;
  private settled = false;
  private options: NavigationOptions;
  /**
   * Cross-document commits of the main frame always count. `sameDocument` decides which
   * same-document navigations count before one; after one, they only update its URL.
   */
  constructor(
    tab: Tab,
    options: NavigationOptions = {},
    autoArm = true,
    sameDocument: (url: string) => boolean = () => true,
  ) {
    this.options = options;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    void this.promise.catch(() => {});
    const timeout = timeoutValue(options.timeout ?? tab.session.connection.timeout);
    if (tab.session.closed) {
      this.cancel(tab.session.closeReason ?? new DisconnectedError('Session closed'));
      return;
    }
    this.cleanups.push(
      tab.framesManager.changes.on(({ frame, sameDocument: same, restored }) => {
        if (frame !== tab.mainFrame) return;
        if (!same) this.committed = { loader: frame.loaderId, url: frame.url, same, restored };
        // For example history.replaceState() while the new document loads.
        else if (this.committed && !this.committed.same) this.committed.url = frame.url;
        else if (sameDocument(frame.url))
          this.committed = { loader: frame.loaderId, url: frame.url, same };
        else return;
        this.check();
      }),
    );
    this.cleanups.push(
      tab.session.on('Page.lifecycleEvent', (event) => {
        if (event.frameId !== tab.mainFrame.id) return;
        let events = this.lifecycle.get(event.loaderId);
        if (!events) {
          events = new Set();
          this.lifecycle.set(event.loaderId, events);
        }
        events.add(event.name);
        this.check();
      }),
    );
    this.cleanups.push(
      tab.session.on('Inspector.targetCrashed', () =>
        this.cancel(new DisconnectedError('Page crashed during navigation')),
      ),
    );
    this.cleanups.push(tab.session.disconnected.on((e) => this.cancel(e)));
    const timer = setTimeout(
      () =>
        this.cancel(
          new TimeoutError(
            `Navigation timed out after ${timeout}ms (${options.waitUntil ?? 'load'})`,
          ),
        ),
      timeout,
    );
    this.cleanups.push(() => clearTimeout(timer));
    if (options.signal) {
      const abort = () => this.cancel(abortReason(options.signal!));
      this.cleanups.push(() => options.signal!.removeEventListener('abort', abort));
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    }
    this.armed = autoArm;
  }
  expect(loaderId?: Protocol.Network.LoaderId): void {
    this.expected = loaderId;
    this.armed = true;
    this.check();
  }
  private check(): void {
    if (!this.armed || !this.committed || this.settled) return;
    const { loader, same, url } = this.committed;
    if (this.expected && loader !== this.expected) return;
    const until = this.options.waitUntil ?? 'load';
    if (
      same ||
      this.committed.restored ||
      until === 'commit' ||
      this.lifecycle.get(loader)?.has(lifecycleName[until])
    ) {
      this.settled = true;
      this.cleanup();
      this.resolve(url);
    }
  }
  cancel(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.reject(error);
  }
  private cleanup(): void {
    for (const off of this.cleanups.splice(0)) off();
  }
}
