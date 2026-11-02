import { abortReason } from '../utils.ts';

/** Cancellation removes queued work; running work retains the lock until settled. */
export class OperationQueue {
  private running = false;
  private waiting: Array<() => void> = [];
  private holds = new Set<Promise<void>>();
  readonly limit: number;
  constructor(limit = 32) {
    this.limit = limit;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid queue limit');
  }
  get size(): number {
    return this.waiting.length + Number(this.running);
  }
  /**
   * Keeps the running operation's slot after the operation settles, until `work` it left
   * running settles too. Its caller already has the result; the next operation waits.
   */
  hold(work: Promise<unknown>): void {
    const settled = work.then(
      () => {},
      () => {},
    );
    if (!this.running) {
      void this.run(new AbortController().signal, () => settled);
      return;
    }
    this.holds.add(settled);
    void settled.then(() => this.holds.delete(settled));
  }
  /** `released` runs once the operation neither waits for nor holds the queue. */
  run<T>(signal: AbortSignal, task: () => Promise<T>, released?: () => void): Promise<T> {
    if (signal.aborted) {
      released?.();
      return Promise.reject(abortReason(signal));
    }
    if (this.waiting.length >= this.limit) {
      released?.();
      return Promise.reject(new Error('Operation queue limit reached'));
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(start);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          reject(abortReason(signal));
          released?.();
        }
        signal.removeEventListener('abort', abort);
      };
      const start = () => {
        signal.removeEventListener('abort', abort);
        this.running = true;
        void (async () => {
          signal.throwIfAborted();
          return task();
        })()
          .then(resolve, reject)
          .finally(async () => {
            while (this.holds.size) await Promise.all(this.holds);
            this.running = false;
            this.waiting.shift()?.();
            released?.();
          });
      };
      if (this.running) {
        this.waiting.push(start);
        signal.addEventListener('abort', abort, { once: true });
      } else start();
    });
  }
}
