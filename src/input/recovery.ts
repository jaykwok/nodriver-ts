import type { Connection, Session } from '../protocol/connection.ts';

/**
 * Asks Chrome to draw when an input request goes unanswered. A page that presents no frames, such
 * as one in a minimized window, holds input back until it draws again; a screenshot draws one
 * frame. Each request is recovered at most once, and input is never sent again.
 */
export class PresentationRecovery {
  private readonly after: number;
  private readonly recover: (session: Session) => void;
  private readonly paused: (session: Session) => boolean;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;
  /**
   * @param after milliseconds a request may go unanswered before its recovery
   * @param recover draws a frame of the session's page
   * @param paused whether replies are held for another reason, such as an open dialog, which a
   *   frame would not release; the request is checked again later
   */
  constructor(
    after: number,
    recover: (session: Session) => void,
    paused: (session: Session) => boolean,
  ) {
    this.after = after;
    this.recover = recover;
    this.paused = paused;
  }
  /** Recovers the request once if it is still unanswered after the threshold. */
  watch(connection: Connection, id: number, session: Session): void {
    if (this.disposed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed || session.closed || !connection.outstanding(new Set([id]))) return;
      if (this.paused(session)) this.watch(connection, id, session);
      else this.recover(session);
    }, this.after);
    this.timers.add(timer);
  }
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
