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
  private readonly opening = new Set<Promise<unknown>>();
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
  /** Opens a tab in the scope's context. If close() starts meanwhile, the tab is closed too. */
  async newTab(url?: string): Promise<Tab> {
    if (this.closing) throw new NodriverError('Tab scope is closed');
    const opening = this.context.newTab(url);
    this.opening.add(opening);
    try {
      const tab = await opening;
      if (this.closing) {
        await tab.close().catch(() => {});
        throw new NodriverError('Tab scope closed while the tab was opening');
      }
      this.own(tab);
      return tab;
    } finally {
      this.opening.delete(opening);
    }
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
   * Waits for tabs still opening through the scope, then closes every owned page, including popups
   * that open meanwhile and popups that have not been attached yet. Idempotent.
   */
  close(): Promise<TabScopeCloseResult> {
    return (this.closing ??= (async () => {
      await Promise.allSettled(this.opening);
      const browser = this.context.browser;
      const closed: string[] = [];
      const errors: unknown[] = [];
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
