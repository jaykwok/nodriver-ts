import { rm } from 'node:fs/promises';
import { TimeoutError } from './errors.js';
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
export async function poll<T>(
  fn: () => Promise<T | undefined>,
  options: WaitOptions = {},
  label = 'condition',
): Promise<T> {
  const end = Date.now() + timeoutValue(options.timeout ?? 10_000);
  do {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() >= end) throw new TimeoutError(`Timed out waiting for ${label}`);
    await delay(Math.min(50, Math.max(0, end - Date.now())), options.signal);
  } while (true);
}
export type Listener<T> = (event: T) => void | Promise<void>;
export class EventHub<T> {
  private listeners = new Set<Listener<T>>();
  constructor(private readonly report: (error: unknown) => void = () => {}) {}
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
