import type { Readable, Writable } from 'node:stream';
import type { Transport } from './transport.js';
import { DisconnectedError } from '../errors.js';
/** CDP pipe framing operates on bytes: UTF-8 characters may span arbitrary chunks. */
export class PipeDecoder {
  private chunks: Buffer[] = [];
  private length = 0;
  constructor(
    private readonly emit: (json: string) => void,
    private readonly maxBytes = 256 * 1024 * 1024,
  ) {}
  push(chunk: Uint8Array): void {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let i = 0; i < bytes.length; i++)
      if (bytes[i] === 0) {
        this.append(bytes.subarray(start, i));
        const message = Buffer.concat(this.chunks, this.length).toString('utf8');
        this.chunks = [];
        this.length = 0;
        start = i + 1;
        if (message) this.emit(message);
      }
    this.append(bytes.subarray(start));
  }
  private append(bytes: Buffer): void {
    if (!bytes.length) return;
    this.length += bytes.length;
    if (this.length > this.maxBytes)
      throw new DisconnectedError('CDP pipe message exceeds size limit');
    this.chunks.push(bytes);
  }
  end(): void {
    if (this.length) throw new DisconnectedError('Truncated CDP pipe message at EOF');
  }
}
export class PipeTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason: Error) => void;
  private closed = false;
  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
    maxBytes?: number,
  ) {
    const decoder = new PipeDecoder((m) => this.onmessage?.(m), maxBytes);
    readable.on('data', (b: Buffer) => {
      try {
        decoder.push(b);
      } catch (e) {
        this.fail(e as Error);
      }
    });
    readable.on('end', () => {
      try {
        decoder.end();
        this.fail(new DisconnectedError('CDP pipe EOF'));
      } catch (e) {
        this.fail(e as Error);
      }
    });
    readable.on('error', (e) => this.fail(e));
    writable.on('error', (e) => this.fail(e));
    readable.on('close', () => this.fail(new DisconnectedError('CDP pipe closed')));
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(error);
    this.readable.destroy();
    this.writable.destroy();
  }
  send(message: string): Promise<void> {
    if (this.closed) return Promise.reject(new DisconnectedError('CDP pipe is closed'));
    return new Promise((resolve, reject) => {
      this.writable.write(Buffer.from(`${message}\0`), (e) => (e ? reject(e) : resolve()));
    });
  }
  close(): void {
    this.fail(new DisconnectedError('CDP pipe closed by client'));
  }
}
