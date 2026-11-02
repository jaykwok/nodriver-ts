import type { Protocol } from 'devtools-protocol';
import { TargetSession, type Connection, type Session } from '../protocol/connection.ts';
import { EventHub } from '../utils.ts';

/** A top-level target lifetime, shared by every attachment and known OOPIF below it. */
export interface InputPage {
  readonly id: string;
  destroyed: boolean;
  failure?: Error;
  /** A JavaScript dialog is open; Chrome holds the replies to input the page was handling. */
  dialog: boolean;
}

/** Uses existing discovery/attachment events; never enables a domain or guesses from openerId. */
export class InputTargets {
  private pages = new Map<string, InputPage>();
  private targets = new Map<string, InputPage>();
  private parents = new Map<string, string>();
  private sessions = new Map<string, { targetId?: string; page?: InputPage }>();
  /**
   * Sessions reporting an open dialog, with their page when known. A session that detaches can no
   * longer report the dialog closing, so it stops counting.
   */
  private dialogs = new Map<string, InputPage | undefined>();
  /** Emits after a page is destroyed, a dialog opens or closes, or the connection closes. */
  readonly changes = new EventHub<void>();

  constructor(connection: Connection) {
    const off = connection.events.on((event) => {
      if (event.method === 'Target.targetCreated' || event.method === 'Target.targetInfoChanged') {
        const { targetInfo } = event.params as Protocol.Target.TargetCreatedEvent;
        this.registerTarget(targetInfo);
      } else if (event.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = event.params as Protocol.Target.AttachedToTargetEvent;
        this.registerTarget(targetInfo);
        const page =
          targetInfo.type === 'page'
            ? this.registerPage(targetInfo.targetId)
            : targetInfo.type === 'iframe' && event.sessionId
              ? this.sessions.get(event.sessionId)?.page
              : undefined;
        if (page) this.targets.set(targetInfo.targetId, page);
        this.sessions.set(sessionId, {
          targetId: targetInfo.targetId,
          page: page ?? this.pageForTarget(targetInfo.targetId),
        });
      } else if (event.method === 'Target.detachedFromTarget') {
        const { sessionId } = event.params as Protocol.Target.DetachedFromTargetEvent;
        this.sessions.delete(sessionId);
        const page = this.dialogs.get(sessionId);
        if (this.dialogs.delete(sessionId)) this.dialogChanged(page);
      } else if (event.method === 'Target.targetDestroyed') {
        const { targetId } = event.params as Protocol.Target.TargetDestroyedEvent;
        const page = this.pages.get(targetId);
        if (page) {
          page.destroyed = true;
          page.failure = undefined;
          page.dialog = false;
          for (const [id, owner] of this.dialogs) if (owner === page) this.dialogs.delete(id);
          const children = [...this.parents.keys()].filter((id) => this.pageForTarget(id) === page);
          for (const id of children) this.parents.delete(id);
          this.pages.delete(targetId);
          for (const [id, owner] of this.targets) if (owner === page) this.targets.delete(id);
          for (const [id, owner] of this.sessions)
            if (owner.page === page) this.sessions.delete(id);
        }
        this.targets.delete(targetId);
        this.parents.delete(targetId);
        if (page) this.changes.emit();
      } else if (
        (event.method === 'Page.javascriptDialogOpening' ||
          event.method === 'Page.javascriptDialogClosed') &&
        event.sessionId
      ) {
        // Dialog events reach every attachment with Page events; any of them identifies the page.
        const id = event.sessionId;
        const page =
          event.method === 'Page.javascriptDialogOpening'
            ? this.pageForSession(id)
            : this.dialogs.get(id);
        if (event.method === 'Page.javascriptDialogOpening') this.dialogs.set(id, page);
        else this.dialogs.delete(id);
        this.dialogChanged(page);
      }
    });
    connection.disconnected.on(() => {
      off();
      this.pages.clear();
      this.targets.clear();
      this.parents.clear();
      this.sessions.clear();
      this.dialogs.clear();
      this.changes.emit();
      this.changes.clear();
    });
  }

  private dialogChanged(page: InputPage | undefined): void {
    if (page) page.dialog = [...this.dialogs.values()].includes(page);
    this.changes.emit();
  }

  registerTarget(info: Protocol.Target.TargetInfo): void {
    if (info.type === 'page') this.registerPage(info.targetId);
    else if (info.type === 'iframe' && info.parentId)
      this.parents.set(info.targetId, info.parentId);
  }

  private pageForTarget(id: string): InputPage | undefined {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const page = this.targets.get(id);
      if (page) return page;
      const parent = this.parents.get(id);
      if (!parent) return;
      id = parent;
    }
  }

  private pageForSession(id: string): InputPage | undefined {
    const attached = this.sessions.get(id);
    return attached && (attached.page ?? this.pageForTarget(attached.targetId ?? ''));
  }

  registerPage(id: string): InputPage {
    let page = this.pages.get(id);
    if (!page) {
      page = { id, destroyed: false, dialog: false };
      this.pages.set(id, page);
      this.targets.set(id, page);
    }
    return page;
  }

  registerSession(session: Session, pageId: string): void {
    if (!session.id) return;
    const previous = this.sessions.get(session.id);
    const page = this.registerPage(pageId);
    this.sessions.set(session.id, { ...previous, page });
    if (previous?.targetId) this.targets.set(previous.targetId, page);
  }

  pageFor(session: Session): InputPage | undefined {
    return (
      (session.id && this.pageForSession(session.id)) ||
      (session instanceof TargetSession ? this.pageForTarget(session.targetId) : undefined)
    );
  }

  /** Whether a JavaScript dialog is open on the page, by default the session's page. */
  dialogOpen(session: Session, page = this.pageFor(session)): boolean {
    return page ? page.dialog : !!session.id && this.dialogs.has(session.id);
  }

  get hasBlockedPage(): boolean {
    return [...this.pages.values()].some((page) => !!page.failure);
  }
}
