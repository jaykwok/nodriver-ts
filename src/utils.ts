import { rm } from 'node:fs/promises';
import { TimeoutError } from './errors.ts';
/** Default deadline for starting or reaching Chrome and completing the CDP handshake, in ms. */
export const CONNECT_TIMEOUT = 30_000;
export interface WaitOptions {
  timeout?: number;
  signal?: AbortSignal;
}
export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(String(signal.reason ?? 'Aborted'), 'AbortError');
}
export function timeoutValue(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError('timeout must be a finite, non-negative number');
  return value;
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const done = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
/**
 * One budget for a multi-step operation. Each call returns the options for the next step: the
 * caller's signal and only the time that remains, or throws once either is exhausted.
 */
export function budget(options: WaitOptions = {}, label = 'operation'): () => WaitOptions {
  const end =
    options.timeout === undefined ? undefined : Date.now() + timeoutValue(options.timeout);
  return () => {
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (end === undefined) return { signal: options.signal };
    const timeout = end - Date.now();
    if (timeout <= 0) throw new TimeoutError(`${label} timed out`);
    return { timeout, signal: options.signal };
  };
}
/** Settles with `promise`, or rejects on the caller's timeout/abort while `promise` continues. */
export function bounded<T>(
  promise: Promise<T>,
  options: WaitOptions = {},
  label = 'operation',
): Promise<T> {
  const { signal } = options;
  if (options.timeout === undefined && !signal) return promise;
  if (signal?.aborted) {
    // Starting the operation may synchronously abort its signal (e.g. a send observer).
    // Its eventual rejection must still be consumed.
    void promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(
            () => settle(() => reject(new TimeoutError(`${label} timed out`))),
            timeoutValue(options.timeout),
          );
    const abort = () => settle(() => reject(abortReason(signal!)));
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn();
    };
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}
/** Calls `fn` until it returns a value; each attempt receives the remaining time and signal. */
export async function poll<T>(
  fn: (step: WaitOptions) => Promise<T | undefined>,
  options: WaitOptions = {},
  label = 'condition',
): Promise<T> {
  const timeout = timeoutValue(options.timeout ?? 10_000);
  const end = Date.now() + timeout;
  const step = budget({ ...options, timeout }, label);
  do {
    let value: T | undefined;
    try {
      value = await fn(step());
    } catch (error) {
      // A step that ran out of the shared budget is this wait timing out.
      if (error instanceof TimeoutError && Date.now() >= end)
        throw new TimeoutError(`Timed out waiting for ${label}`);
      throw error;
    }
    if (value !== undefined) return value;
    if (Date.now() >= end) throw new TimeoutError(`Timed out waiting for ${label}`);
    await delay(Math.min(50, Math.max(0, end - Date.now())), options.signal);
  } while (true);
}
export type Listener<T> = (event: T) => void | Promise<void>;
export class EventHub<T> {
  private listeners = new Set<Listener<T>>();
  private readonly report: (error: unknown) => void;
  constructor(report: (error: unknown) => void = () => {}) {
    this.report = report;
  }
  private reportSafely(error: unknown): void {
    try {
      this.report(error);
    } catch {}
  }
  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        const result = listener(event);
        if (result) void result.catch((e) => this.reportSafely(e));
      } catch (e) {
        this.reportSafely(e);
      }
    }
  }
  clear(): void {
    this.listeners.clear();
  }
  get size(): number {
    return this.listeners.size;
  }
}

const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
/**
 * Recursively removes a directory, retrying while Windows reports files as busy (Chrome's
 * helper processes can outlive the browser process briefly). Bun ignores rm's own maxRetries.
 */
export async function removeTree(path: string, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  for (let wait = 50; ; wait = Math.min(wait * 2, 500)) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e) {
      if (!BUSY.has((e as NodeJS.ErrnoException).code ?? '') || Date.now() + wait > end) throw e;
      await delay(wait);
    }
  }
}
