import { abortReason } from '../utils.js';

/** Cancellation removes queued work; running work retains the lock until settled. */
export class OperationQueue {
  private running = false;
  private waiting: Array<() => void> = [];
  constructor(readonly limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid queue limit');
  }
  get size(): number {
    return this.waiting.length + Number(this.running);
  }
  run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (this.waiting.length >= this.limit)
      return Promise.reject(new Error('Operation queue limit reached'));
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(start);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          reject(abortReason(signal));
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
          .finally(() => {
            this.running = false;
            this.waiting.shift()?.();
          });
      };
      if (this.running) {
        this.waiting.push(start);
        signal.addEventListener('abort', abort, { once: true });
      } else start();
    });
  }
}
