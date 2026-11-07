import type { BrowserContext } from './context.ts';
import type { Tab } from '../page/tab.ts';
import { NodriverError } from '../errors.ts';
export interface TabScopeCloseResult {
  /** IDs of the pages that close() closed, popups included. */
  closed: string[];
  /** IDs of tabs released with keep() that are still open. */
  kept: string[];
}
/**
 * The pages of one task in a shared browser: tabs opened through the scope, tabs it adopts, and
 * popups any of them open, transitively. close() closes those pages and leaves every other tab,
 * and tabs released with keep(), open.
 */
export class TabScope {
  readonly context: BrowserContext;
  private readonly owned = new Set<Tab>();
  /** Target IDs of every page the scope owned, to find popups that are still attaching. */
  private readonly ownedIds = new Set<string>();
  private readonly kept = new Set<Tab>();
  /** Tabs being created through the scope, until they are owned or closed again. */
  private readonly opening = new Set<Promise<unknown>>();
  /** Tabs that finished opening after close() started, and what closing them did. */
  private readonly lateClosed: string[] = [];
  private readonly lateErrors: unknown[] = [];
  private readonly off: () => void;
  private closing?: Promise<TabScopeCloseResult>;
  constructor(context: BrowserContext) {
    this.context = context;
    this.off = context.browser.tabCreated.on((tab) => {
      const opener = context.browser.targetInfo.get(tab.id)?.openerId;
      if (opener && this.ownedIds.has(opener) && !this.kept.has(tab)) this.own(tab);
    });
  }
  /** Open pages the scope owns. */
  get tabs(): Tab[] {
    return [...this.owned].filter((tab) => !tab.closed);
  }
  get closed(): boolean {
    return !!this.closing;
  }
  private own(tab: Tab): void {
    this.owned.add(tab);
    this.ownedIds.add(tab.id);
  }
  /**
   * Opens a tab in the scope's context. The tab is owned before it navigates to `url`, so popups
   * its page opens while loading belong to the scope too. If close() starts while the tab is
   * being created, close() closes it and this call rejects.
   */
  async newTab(url = 'about:blank'): Promise<Tab> {
    if (this.closing) throw new NodriverError('Tab scope is closed');
    const creating = this.create();
    this.opening.add(creating);
    void creating.then(
      () => this.opening.delete(creating),
      () => this.opening.delete(creating),
    );
    const tab = await creating;
    if (url !== 'about:blank')
      try {
        await tab.goto(url);
      } catch (error) {
        // As Browser.newTab() does, a tab that cannot load its first page is closed.
        await tab.close().catch(() => {});
        throw error;
      }
    return tab;
  }
  private async create(): Promise<Tab> {
    const tab = await this.context.newTab();
    if (!this.closing) {
      this.own(tab);
      return tab;
    }
    try {
      await tab.close();
      this.lateClosed.push(tab.id);
    } catch (error) {
      if (this.context.browser.targetInfo.has(tab.id)) this.lateErrors.push(error);
    }
    throw new NodriverError('Tab scope closed while the tab was opening');
  }
  /** Makes an existing tab, and popups it opens from now on, part of the scope. */
  adopt(tab: Tab): void {
    if (this.closing) throw new NodriverError('Tab scope is closed');
    if (tab.context !== this.context) throw new TypeError('Tab belongs to another context');
    this.kept.delete(tab);
    this.own(tab);
  }
  /**
   * Releases a tab from the scope, for example a page left for a person to finish. close() leaves
   * it open, and popups it opens later are not owned.
   */
  keep(tab: Tab): void {
    this.owned.delete(tab);
    this.ownedIds.delete(tab.id);
    this.kept.add(tab);
  }
  /**
   * Waits for tabs still being created through the scope and closes them, then closes every owned
   * page, including popups that open meanwhile and popups that have not been attached yet. Resolves
   * once all of them are closed; failures reject together as an AggregateError. Idempotent.
   */
  close(): Promise<TabScopeCloseResult> {
    return (this.closing ??= (async () => {
      await Promise.allSettled(this.opening);
      const browser = this.context.browser;
      const closed = this.lateClosed;
      const errors = this.lateErrors;
      const done = new Set<string>();
      try {
        for (;;) {
          const pages = [...this.owned]
            .filter((tab) => !done.has(tab.id) && !tab.closed)
            .map((tab) => ({ id: tab.id, close: () => tab.close() }));
          // Popups Chrome reported but the browser has not attached as tabs yet.
          for (const info of browser.targetInfo.values())
            if (
              info.type === 'page' &&
              info.openerId &&
              this.ownedIds.has(info.openerId) &&
              !done.has(info.targetId) &&
              !pages.some((page) => page.id === info.targetId) &&
              ![...this.kept].some((tab) => tab.id === info.targetId)
            ) {
              this.ownedIds.add(info.targetId);
              pages.push({
                id: info.targetId,
                close: async () => {
                  await browser.cdp.send('Target.closeTarget', { targetId: info.targetId });
                },
              });
            }
          if (!pages.length) break;
          await Promise.all(
            pages.map(async (page) => {
              done.add(page.id);
              try {
                await page.close();
                closed.push(page.id);
              } catch (error) {
                if (browser.targetInfo.has(page.id)) errors.push(error);
              }
            }),
          );
        }
      } finally {
        this.off();
      }
      if (errors.length) throw new AggregateError(errors, 'Some tabs of the scope did not close');
      return { closed, kept: [...this.kept].filter((tab) => !tab.closed).map((tab) => tab.id) };
    })());
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
