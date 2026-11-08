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
  /** The main frame's cross-document commits, in order. */
  private commits: Array<{ loader: string; url: string; restored?: boolean }> = [];
  /** Loaders whose document a later commit replaced; their late lifecycle events do not count. */
  private replaced = new Set<string>();
  private lifecycle = new Map<string, Set<string>>();
  private armed = false;
  private settled = false;
  private options: NavigationOptions;
  /**
   * Cross-document commits of the main frame always count: the wait completes with the first of
   * them, from the expected one on, that reaches the awaited event before a later commit replaces
   * it. `sameDocument` decides which same-document navigations count before one; after one, they
   * only update the URL of the latest document.
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
        if (!same) {
          const previous = this.commits.at(-1);
          if (previous) this.replaced.add(previous.loader);
          this.committed = { loader: frame.loaderId, url: frame.url, same, restored };
          this.commits.push({ loader: frame.loaderId, url: frame.url, restored });
        }
        // For example history.replaceState() while the new document loads.
        else if (this.committed && !this.committed.same) this.commits.at(-1)!.url = frame.url;
        else if (sameDocument(frame.url))
          this.committed = { loader: frame.loaderId, url: frame.url, same };
        else return;
        this.check();
      }),
    );
    this.cleanups.push(
      tab.session.on('Page.lifecycleEvent', (event) => {
        if (event.frameId !== tab.mainFrame.id || this.replaced.has(event.loaderId)) return;
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
  /**
   * Waits for the document of `loaderId`, or for a document that replaced it in the main frame
   * before it reached the awaited event, as a page that redirects by script or form does.
   */
  expect(loaderId?: Protocol.Network.LoaderId): void {
    this.expected = loaderId;
    this.armed = true;
    this.check();
  }
  private check(): void {
    if (!this.armed || !this.committed || this.settled) return;
    if (this.committed.same) {
      if (!this.expected || this.committed.loader === this.expected)
        this.finish(this.committed.url);
      return;
    }
    const start = this.expected ? this.commits.findIndex((c) => c.loader === this.expected) : 0;
    if (start < 0) return;
    const until = this.options.waitUntil ?? 'load';
    const done = this.commits
      .slice(start)
      .find(
        (commit) =>
          until === 'commit' ||
          commit.restored ||
          this.lifecycle.get(commit.loader)?.has(lifecycleName[until]),
      );
    if (done) this.finish(done.url);
  }
  private finish(url: string): void {
    this.settled = true;
    this.cleanup();
    this.resolve(url);
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
