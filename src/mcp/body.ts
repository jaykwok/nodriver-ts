/** Tie a web body reader to a deadline without leaving a locked stream behind. */
export function cancellableBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  let stopped = false;
  let abort: () => void;
  const detach = () => signal.removeEventListener('abort', abort);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (stopped) return;
        stopped = true;
        void reader.cancel(signal.reason).catch(() => {});
        controller.error(signal.reason);
        detach();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (stopped) return;
        if (done) {
          stopped = true;
          detach();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          detach();
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      stopped = true;
      detach();
      await reader.cancel(reason).catch(() => {});
    },
  });
}
