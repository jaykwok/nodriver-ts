import type { Protocol } from 'devtools-protocol';
import { TargetSession, type Connection, type Session } from '../protocol/connection.ts';

/** A top-level target lifetime, shared by every attachment and known OOPIF below it. */
export interface InputPage {
  readonly id: string;
  destroyed: boolean;
  failure?: Error;
}

/** Uses existing discovery/attachment events; never enables a domain or guesses from openerId. */
export class InputTargets {
  private pages = new Map<string, InputPage>();
  private targets = new Map<string, InputPage>();
  private parents = new Map<string, string>();
  private sessions = new Map<string, { targetId?: string; page?: InputPage }>();

  constructor(connection: Connection) {
    const off = connection.events?.on((event) => {
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
        this.sessions.delete((event.params as Protocol.Target.DetachedFromTargetEvent).sessionId);
      } else if (event.method === 'Target.targetDestroyed') {
        const { targetId } = event.params as Protocol.Target.TargetDestroyedEvent;
        const page = this.pages.get(targetId);
        if (page) {
          page.destroyed = true;
          page.failure = undefined;
          const children = [...this.parents.keys()].filter((id) => this.pageForTarget(id) === page);
          for (const id of children) this.parents.delete(id);
          this.pages.delete(targetId);
          for (const [id, owner] of this.targets) if (owner === page) this.targets.delete(id);
          for (const [id, owner] of this.sessions)
            if (owner.page === page) this.sessions.delete(id);
        }
        this.targets.delete(targetId);
        this.parents.delete(targetId);
      }
    });
    connection.disconnected?.on(() => {
      off?.();
      this.pages.clear();
      this.targets.clear();
      this.parents.clear();
      this.sessions.clear();
    });
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

  registerPage(id: string): InputPage {
    let page = this.pages.get(id);
    if (!page) {
      page = { id, destroyed: false };
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
    const attached = session.id && this.sessions.get(session.id);
    return (
      (attached && (attached.page ?? this.pageForTarget(attached.targetId ?? ''))) ||
      (session instanceof TargetSession ? this.pageForTarget(session.targetId) : undefined)
    );
  }

  get hasBlockedPage(): boolean {
    return [...this.pages.values()].some((page) => !!page.failure);
  }
}
