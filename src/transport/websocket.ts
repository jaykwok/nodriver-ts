import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { Transport } from './transport.ts';
import { DisconnectedError, TimeoutError } from '../errors.ts';
import {
  abortReason,
  CONNECT_TIMEOUT,
  positiveInt,
  timeoutValue,
  type WaitOptions,
} from '../utils.ts';
export class WebSocketTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason: Error) => void;
  private closed = false;
  private closing?: Promise<void>;
  private readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data: RawData, binary: boolean) => {
      if (this.closed) return;
      if (binary) {
        this.fail(new DisconnectedError('Expected a CDP text WebSocket message'));
        socket.terminate();
        return;
      }
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      this.onmessage?.(bytes.toString('utf8'));
    });
    socket.on('close', (code, reason) =>
      this.fail(new DisconnectedError(`WebSocket closed (${code}): ${reason.toString()}`)),
    );
    socket.on('error', (error) => {
      this.fail(
        new DisconnectedError(`WebSocket transport error: ${error.message}`, { cause: error }),
      );
      socket.terminate();
    });
  }
  private fail(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(reason);
  }
  static async connect(
    url: string,
    options: WaitOptions & { maxMessageBytes?: number } = {},
  ): Promise<WebSocketTransport> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError('Expected a ws:// or wss:// browser endpoint');
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
      throw new TypeError('Expected a ws:// or wss:// browser endpoint');
    timeoutValue(options.timeout ?? CONNECT_TIMEOUT);
    const maxPayload = positiveInt(options.maxMessageBytes ?? 256 * 1024 * 1024, 'maxMessageBytes');
    if (options.signal?.aborted) throw abortReason(options.signal);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload });
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.terminate();
        reject(error);
      };
      const abort = () => fail(abortReason(options.signal!));
      const timer = setTimeout(
        () => fail(new TimeoutError('WebSocket connection timed out')),
        options.timeout ?? CONNECT_TIMEOUT,
      );
      options.signal?.addEventListener('abort', abort, { once: true });
      // Retain through aborted handshakes to consume late EventEmitter errors.
      socket.on('error', (e) =>
        fail(
          new DisconnectedError(`Could not connect to browser WebSocket: ${e.message}`, {
            cause: e,
          }),
        ),
      );
      socket.once('close', () =>
        fail(new DisconnectedError('Browser WebSocket closed before opening')),
      );
      socket.once('open', () => {
        if (settled) {
          socket.terminate();
          return;
        }
        settled = true;
        cleanup();
        resolve(new WebSocketTransport(socket));
      });
    });
  }
  send(message: string): Promise<void> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new DisconnectedError('WebSocket is closed'));
    return new Promise((resolve, reject) =>
      this.socket.send(message, { binary: false, compress: false }, (error) =>
        error
          ? reject(
              error instanceof DisconnectedError
                ? error
                : new DisconnectedError(`WebSocket send failed: ${error.message}`, {
                    cause: error,
                  }),
            )
          : resolve(),
      ),
    );
  }
  close(): Promise<void> {
    return (this.closing ??= new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(() => this.socket.terminate(), 1000);
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    }));
  }
}
