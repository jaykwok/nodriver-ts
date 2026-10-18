export interface Transport {
  onmessage?: (message: string) => void;
  onclose?: (reason: Error) => void;
  send(message: string): void | Promise<void>;
  close(): void | Promise<void>;
}
