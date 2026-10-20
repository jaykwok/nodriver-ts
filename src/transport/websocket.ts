import { WebSocket } from './ws-runtime.ts';
import type { RawData } from 'ws';
import type { Transport } from './transport.ts';
import { DisconnectedError, TimeoutError } from '../errors.ts';
import { abortReason, CONNECT_TIMEOUT, timeoutValue, type WaitOptions } from '../utils.ts';
export class WebSocketTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason: Error) => void;
  private closing?: Promise<void>;
  private readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data: RawData, binary: boolean) => {
      if (binary) {
        this.onclose?.(new DisconnectedError('Expected a CDP text WebSocket message'));
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
      this.onclose?.(new DisconnectedError(`WebSocket closed (${code}): ${reason.toString()}`)),
    );
    socket.on('error', (error) => {
      this.onclose?.(new DisconnectedError(`WebSocket transport error: ${error.message}`));
      socket.terminate();
    });
  }
  static async connect(
    url: string,
    options: WaitOptions & { maxMessageBytes?: number } = {},
  ): Promise<WebSocketTransport> {
    if (!/^wss?:\/\//.test(url)) throw new TypeError('Expected a ws:// or wss:// browser endpoint');
    timeoutValue(options.timeout ?? CONNECT_TIMEOUT);
    const maxPayload = options.maxMessageBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(maxPayload) || maxPayload < 1)
      throw new RangeError('maxMessageBytes must be a positive integer');
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
        fail(new DisconnectedError(`Could not connect to browser WebSocket: ${e.message}`)),
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
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new DisconnectedError('WebSocket is closed'));
    return new Promise((resolve, reject) =>
      this.socket.send(message, { binary: false, compress: false }, (error) =>
        error ? reject(error) : resolve(),
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
