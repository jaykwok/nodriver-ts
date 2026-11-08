import type { BrowserContext } from './context.ts';
import type { Tab } from '../page/tab.ts';
import { NodriverError, TimeoutError } from '../errors.ts';
import type { NavigationOptions } from '../page/navigation.ts';
import { bounded, budget, within } from '../utils.ts';
export interface TabScopeCloseResult {
  /**
   * IDs of the pages the scope closed: owned pages, popups included, and tabs that did not finish
   * opening through newTab().
   */
  closed: string[];
  /** IDs of tabs released with keep() that are still open. */
  kept: string[];
  /** IDs of borrowed tabs that are still open. */
  borrowed: string[];
}
/**
 * owned: closed with the scope. borrowed: left open, and popups it opens are owned. kept: left
 * open, and popups it opens are not owned.
 */
type Role = 'owned' | 'borrowed' | 'kept';
/**
 * The pages of one task in a shared browser: tabs opened through the scope, tabs it adopts, and
 * popups any of them or a borrowed tab open, transitively. close() closes those pages and leaves
 * every other tab, borrowed tabs and tabs released with keep() open.
 */
export class TabScope {
  readonly context: BrowserContext;
  /**
   * Role of each page by target ID, so that a page attached again as a new Tab keeps it. A popup
   * gets its role when Chrome reports it: owned if its opener was owned or borrowed at that time.
   */
  private readonly roles = new Map<string, Role>();
  /** Creations through newTab() and closes of tabs that did not finish opening, until settled. */
  private readonly pending = new Set<Promise<void>>();
  /** Closes in progress, by target ID, so that each page is closed once. */
  private readonly closes = new Map<string, Promise<void>>();
  /** IDs of the pages the scope closed. */
  private readonly closedIds = new Set<string>();
  /** IDs of the tabs Chrome created for newTab(). */
  private readonly created = new Set<string>();
  /** Set once close() no longer waits: at its deadline, or when it returns. */
  private finished = false;
  /** Pages whose close close() waits for, until finished; their failures go into its result. */
  private readonly awaited = new Set<string>();
  private readonly off: () => void;
  private closing?: Promise<TabScopeCloseResult>;
  constructor(context: BrowserContext) {
    this.context = context;
    this.off = context.browser.cdp.on('Target.targetCreated', ({ targetInfo: info }) => {
      const opener = info.openerId && this.roles.get(info.openerId);
      if (info.type === 'page' && (opener === 'owned' || opener === 'borrowed'))
        this.roles.set(info.targetId, 'owned');
    });
  }
  /** Open pages the scope owns. */
  get tabs(): Tab[] {
    return this.context.tabs.filter((tab) => this.roles.get(tab.id) === 'owned');
  }
  get closed(): boolean {
    return !!this.closing;
  }
  /**
   * Opens a tab in the scope's context. The tab is owned before it navigates to `url`, so popups
   * its page opens while loading belong to the scope too. `timeout` and `signal` cover opening
   * the tab and the navigation together; a tab that does not finish opening is closed again, also
   * when Chrome creates it after this call stopped waiting, and close() waits for that. If close()
   * starts while the tab is opening, close() closes it and this call rejects.
   */
  async newTab(url = 'about:blank', options: NavigationOptions = {}): Promise<Tab> {
    if (this.closing) throw new NodriverError('Tab scope is closed');
    const browser = this.context.browser;
    const step = budget(options, 'Opening a tab');
    const wait = { timeout: browser.connection.timeout, ...step() };
    // Owned as soon as Chrome reports it, also after this call stopped waiting.
    const created = browser.createPage(this.context).then((targetId) => {
      this.roles.set(targetId, 'owned');
      this.created.add(targetId);
      return targetId;
    });
    this.track(created);
    let targetId: string;
    try {
      targetId = await bounded(created, wait, 'Opening a tab');
    } catch (error) {
      this.track(created.then((targetId) => this.closePage(targetId)));
      throw error;
    }
    let tab: Tab | undefined;
    let failure: unknown;
    try {
      if (!this.closing) tab = await browser.openPage(targetId, url, options, step);
    } catch (error) {
      failure = error;
    }
    if (tab && !this.closing) return tab;
    // As Browser.newTab() does, a tab that does not finish opening is closed. closePage() reports
    // a failure, unless close() waits for it.
    const closing = this.closePage(targetId);
    this.track(closing);
    await within(closing, step).catch(() => {});
    if (this.closing)
      throw new NodriverError(
        'Tab scope closed while the tab was opening',
        failure === undefined ? undefined : { cause: failure },
      );
    throw failure;
  }
  /** Makes an existing tab, and popups it opens from now on, part of the scope. */
  adopt(tab: Tab): void {
    this.claim(tab, 'owned');
  }
  /**
   * Lends a tab to the scope, for example a start page that every task reuses: popups it opens
   * from now on belong to the scope and close with it, while close() leaves the tab itself open.
   */
  borrow(tab: Tab): void {
    this.claim(tab, 'borrowed');
  }
  /**
   * Releases a tab from the scope, for example a page left for a person to finish. close() leaves
   * it open, and popups it opens later are not owned; popups it opened before stay owned.
   */
  keep(tab: Tab): void {
    this.roles.set(tab.id, 'kept');
  }
  private claim(tab: Tab, role: Role): void {
    if (this.closing) throw new NodriverError('Tab scope is closed');
    if (tab.context !== this.context) throw new TypeError('Tab belongs to another context');
    this.roles.set(tab.id, role);
  }
  /** Keeps `task` among the work close() waits for until it settles. */
  private track(task: Promise<unknown>): void {
    const settled = task.then(
      () => {},
      () => {},
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
  }
  /** Whether Chrome still reports the page. */
  private open(targetId: string): boolean {
    return this.context.browser.targetInfo.has(targetId);
  }
  /** Closes a page once, attached or not. A page that closed by itself needs no closing. */
  private closePage(targetId: string): Promise<void> {
    if (this.closedIds.has(targetId)) return Promise.resolve();
    const existing = this.closes.get(targetId);
    if (existing) return existing;
    const browser = this.context.browser;
    const tab = this.context.tabs.find((tab) => tab.id === targetId);
    const closing = (async () => {
      try {
        // A tab the scope opened ends with its Tab even while being attached. A popup still being
        // attached is closed at once, as its page may not answer.
        if (this.created.has(targetId)) await browser.closeCreated(targetId);
        else if (tab) await tab.close();
        else await browser.cdp.send('Target.closeTarget', { targetId });
        this.closedIds.add(targetId);
      } catch (error) {
        if (!this.open(targetId)) return;
        // Unless close() waits for it, the caller has an error of its own or stopped waiting.
        if (this.finished || !this.awaited.has(targetId))
          browser.reportCloseFailure(targetId, error);
        throw error;
      } finally {
        this.closes.delete(targetId);
      }
    })();
    this.closes.set(targetId, closing);
    return closing;
  }
  /**
   * Waits for tabs still being created through the scope, then closes every owned page, including
   * popups that open meanwhile and popups that have not been attached yet. Resolves once all of
   * them are closed; failures reject together as an AggregateError. One deadline, the connection's
   * command timeout, covers the waiting and closing: a page not closed by then is reported as a
   * TimeoutError and closes in the background, where a failure goes to browser.errors. Idempotent.
   * A failure to close a tab that did not finish opening through newTab() goes to browser.errors
   * too, unless close() is waiting for that close.
   */
  close(): Promise<TabScopeCloseResult> {
    return (this.closing ??= (async () => {
      const browser = this.context.browser;
      const errors: unknown[] = [];
      // Shared by every wait, so that all of them end at the same moment.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          this.finished = true;
          resolve(false);
        }, browser.connection.timeout);
      });
      /** Whether `task` is done by the deadline; throws its failure. */
      const settles = (task: Promise<unknown>) => Promise.race([task.then(() => true), deadline]);
      try {
        // Creations settle first, so that every tab they made is owned.
        if (!(await settles(Promise.allSettled(this.pending))))
          errors.push(new TimeoutError('Waiting for tabs the scope is opening timed out'));
        const tried = new Set<string>();
        for (;;) {
          const pages = [...this.roles].flatMap(([id, role]) =>
            role === 'owned' && !tried.has(id) && !this.closedIds.has(id) && this.open(id)
              ? [id]
              : [],
          );
          if (!pages.length) break;
          await Promise.all(
            pages.map(async (id) => {
              tried.add(id);
              this.awaited.add(id);
              // Started also past the deadline, so that the page still closes, in the background.
              try {
                if (!(await settles(this.closePage(id))))
                  errors.push(new TimeoutError(`Closing tab ${id} timed out`));
              } catch (error) {
                errors.push(error);
              }
            }),
          );
        }
      } finally {
        clearTimeout(timer);
        this.finished = true;
        this.off();
      }
      if (errors.length) throw new AggregateError(errors, 'Some tabs of the scope did not close');
      const still = (role: Role) =>
        [...this.roles].flatMap(([id, r]) => (r === role && this.open(id) ? [id] : []));
      return { closed: [...this.closedIds], kept: still('kept'), borrowed: still('borrowed') };
    })());
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
