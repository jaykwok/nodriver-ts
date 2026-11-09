import { randomUUID } from 'node:crypto';
import type { Frame } from './frames.ts';
import { FetchCancelledError } from '../errors.ts';
import { bounded, MAX_TIMEOUT, timeoutValue, type WaitOptions } from '../utils.ts';
export interface FetchOptions extends WaitOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** As for the page's fetch(): defaults to same-origin. */
  credentials?: 'omit' | 'same-origin' | 'include';
  mode?: 'cors' | 'no-cors' | 'same-origin';
  redirect?: 'follow' | 'error' | 'manual';
  referrer?: string;
  referrerPolicy?: string;
  /** How the body is returned: text (default), parsed JSON, or base64 for binary data. */
  responseType?: 'text' | 'json' | 'base64';
  /** Larger responses are aborted and rejected. Defaults to 10 MiB. */
  maxBytes?: number;
}
export interface FetchResponse<T = unknown> {
  url: string;
  status: number;
  statusText: string;
  ok: boolean;
  redirected: boolean;
  type: string;
  headers: Record<string, string>;
  body: T;
}
/** Runs in the isolated world, where the page cannot see or replace fetch or the registry. */
async function pageFetch({
  id,
  url,
  init,
  responseType,
  maxBytes,
}: {
  id: string;
  url: string;
  init: Record<string, unknown>;
  responseType: string;
  maxBytes: number;
}): Promise<FetchResponse> {
  const registry = ((
    globalThis as { __nodriverFetches?: Map<string, AbortController> }
  ).__nodriverFetches ??= new Map());
  const controller = new AbortController();
  registry.set(id, controller);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal } as RequestInit);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          controller.abort();
          throw new Error(`Response body exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let body: unknown;
    if (responseType === 'base64') {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      body = btoa(binary);
    } else {
      const text = new TextDecoder().decode(bytes);
      body = responseType === 'json' ? JSON.parse(text) : text;
    }
    return {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      redirected: response.redirected,
      type: response.type,
      headers: Object.fromEntries(response.headers),
      body,
    };
  } finally {
    registry.delete(id);
  }
}
/** @internal See Frame.fetch(). */
export async function frameFetch<T>(
  frame: Frame,
  url: string,
  options: FetchOptions,
): Promise<FetchResponse<T>> {
  const {
    timeout = 30_000,
    signal,
    responseType = 'text',
    maxBytes = 10 * 1024 * 1024,
    ...init
  } = options;
  if (!['text', 'json', 'base64'].includes(responseType))
    throw new TypeError('responseType must be text, json or base64');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('maxBytes must be a non-negative integer');
  timeoutValue(timeout);
  signal?.throwIfAborted();
  const id = randomUUID();
  const { generation, session } = frame;
  // The page request must outlive the caller's wait, so it is stopped explicitly below.
  const request = frame.evaluate(
    pageFetch,
    { id, url, init, responseType, maxBytes },
    { world: 'isolated', timeout: Math.min(timeout + 5_000, MAX_TIMEOUT) },
  );
  // Registered before bounded() subscribes, so it is set before the caller sees the outcome.
  let finished = false;
  void request.then(
    () => (finished = true),
    () => (finished = true),
  );
  try {
    return (await bounded(request, { timeout, signal }, 'Page fetch')) as FetchResponse<T>;
  } catch (error) {
    // Otherwise the caller stopped waiting: a timeout, or an abort with any reason.
    if (finished) throw error;
    let aborted: boolean;
    try {
      aborted = await frame.evaluate(
        (id: string) => {
          const controller = (
            globalThis as { __nodriverFetches?: Map<string, AbortController> }
          ).__nodriverFetches?.get(id);
          controller?.abort();
          return !!controller;
        },
        id,
        { world: 'isolated', timeout: 2_000 },
      );
    } catch {
      // A replaced document has cancelled its own requests.
      aborted = frame.generation !== generation || frame.session !== session || frame.detached;
    }
    throw new FetchCancelledError(
      aborted
        ? `Page fetch of ${url} was cancelled and aborted in the page`
        : `Page fetch of ${url} was cancelled; the page request had already finished or could not be reached`,
      aborted,
      { cause: error },
    );
  }
}
