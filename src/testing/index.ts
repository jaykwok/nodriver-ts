import type { AddressInfo } from 'node:net';
import type { WebSocketServer as Server } from 'ws';
import type { Protocol } from 'devtools-protocol';
import { Browser, type ConnectOptions } from '../browser/browser.ts';
import type { Command, Event, EventParams, Params, Result } from '../protocol/connection.ts';
import { ProtocolError } from '../errors.ts';
import { WebSocket, WebSocketServer } from '../transport/ws-runtime.ts';

/** Return this from a handler to leave a command pending for timeout/abort/disconnect tests. */
export const NO_REPLY = Symbol('NO_REPLY');

export interface RecordedCommand<M extends Command = Command> {
  id: number;
  method: M;
  params: Params<M>[0];
  sessionId?: string;
}
export type CommandHandler<M extends Command> = (
  params: Params<M>[0],
  command: RecordedCommand<M>,
) => Result<M> | typeof NO_REPLY | Promise<Result<M> | typeof NO_REPLY>;
export interface ScriptedChromeOptions {
  /** Defaults to one about:blank page. [] starts with no targets. */
  pages?: Array<{ url?: string; title?: string }>;
}
type Handler = (command: RecordedCommand) => unknown | Promise<unknown>;

/**
 * A strict, scripted CDP peer for real Browser/Tab/Session objects. No Chrome process or JS
 * engine is started. Only the library startup handshake and target lifecycle have defaults.
 * One controller connection at a time; close it before reconnecting.
 */
export class ScriptedChrome {
  readonly commands: RecordedCommand[] = [];
  readonly unexpectedCommands: RecordedCommand[] = [];
  readonly endpoint: string;
  private readonly server: Server;
  private socket?: WebSocket;
  private closing?: Promise<void>;
  private readonly handlers = new Map<Command, Handler>();
  private readonly queued = new Map<Command, Handler[]>();
  private readonly pages = new Map<string, Protocol.Target.TargetInfo>();
  private readonly sessions = new Map<string, string>();
  private readonly contexts = new Set<string>();
  private sequence = 0;
  private discovering = false;

  private constructor(server: Server, options: ScriptedChromeOptions) {
    this.server = server;
    this.endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/scripted`;
    for (const page of options.pages ?? [{}]) this.addPage(page);
    server.on('connection', (socket) => {
      if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
        socket.close(1013, 'ScriptedChrome supports one controller at a time');
        return;
      }
      this.socket = socket;
      this.sessions.clear();
      this.discovering = false;
      socket.on('error', () => socket.terminate());
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.sessions.clear();
        for (const info of this.pages.values()) info.attached = false;
        this.discovering = false;
      });
      socket.on('message', (data) => {
        void this.receive(socket, data.toString());
      });
    });
  }

  static async start(options: ScriptedChromeOptions = {}): Promise<ScriptedChrome> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return new ScriptedChrome(server, options);
  }

  connect(options: Omit<ConnectOptions, 'endpoint'> = {}): Promise<Browser> {
    return Browser.connect({ ...options, endpoint: this.endpoint });
  }

  /** Install a persistent handler; queued replies take precedence. Returns an unsubscribe. */
  handle<M extends Command>(method: M, handler: CommandHandler<M>): () => void {
    const wrapped: Handler = (command) => {
      const typed = command as RecordedCommand<M>;
      return handler(typed.params, typed);
    };
    this.handlers.set(method, wrapped);
    return () => {
      if (this.handlers.get(method) === wrapped) this.handlers.delete(method);
    };
  }

  /** Queue one result or handler, consumed in arrival order for this method across sessions. */
  replyOnce<M extends Command>(method: M, reply: Result<M> | CommandHandler<M>): void {
    const queue = this.queued.get(method) ?? [];
    queue.push((command) => {
      const typed = command as RecordedCommand<M>;
      return typeof reply === 'function' ? reply(typed.params, typed) : reply;
    });
    this.queued.set(method, queue);
  }

  /** Emit a raw event; this does not mutate the fake's target/frame model. */
  emit<E extends Event>(method: E, params: EventParams<E>, sessionId?: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw new Error('ScriptedChrome has no connected controller');
    socket.send(JSON.stringify({ method, params, sessionId }));
  }

  /** Add a page to the fake's target model and notify an active discovery subscription. */
  addPage(page: { url?: string; title?: string; browserContextId?: string } = {}): string {
    const targetId = `page-${++this.sequence}`;
    const info: Protocol.Target.TargetInfo = {
      targetId,
      type: 'page',
      title: page.title ?? '',
      url: page.url ?? 'about:blank',
      attached: false,
      canAccessOpener: false,
      browserContextId: page.browserContextId,
    };
    this.pages.set(targetId, info);
    if (this.discovering) this.emit('Target.targetCreated', { targetInfo: info });
    return targetId;
  }

  destroyTarget(targetId: string): void {
    if (!this.pages.delete(targetId)) throw new Error(`Unknown scripted target ${targetId}`);
    for (const [sessionId, target] of this.sessions) {
      if (target !== targetId) continue;
      this.sessions.delete(sessionId);
      this.emit('Target.detachedFromTarget', { sessionId, targetId });
    }
    if (this.discovering) this.emit('Target.targetDestroyed', { targetId });
  }

  crashTarget(targetId: string): void {
    if (!this.pages.has(targetId)) throw new Error(`Unknown scripted target ${targetId}`);
    for (const [sessionId, target] of this.sessions)
      if (target === targetId) this.emit('Inspector.targetCrashed', undefined, sessionId);
    if (this.discovering)
      this.emit('Target.targetCrashed', { targetId, status: 'crashed', errorCode: 1 });
  }

  /** Abruptly break the wire, rejecting real Connection requests and event waits. */
  disconnect(): void {
    this.socket?.terminate();
  }

  /** Fail a test if queued replies were unused or an unscripted command was received. */
  assertDone(): void {
    const remaining = [...this.queued].filter(([, replies]) => replies.length);
    if (remaining.length || this.unexpectedCommands.length)
      throw new Error(
        `ScriptedChrome: unused replies [${remaining.map(([method, replies]) => `${method}: ${replies.length}`).join(', ')}]; unexpected commands [${this.unexpectedCommands.map((c) => c.method).join(', ')}]`,
      );
  }

  close(): Promise<void> {
    return (this.closing ??= new Promise<void>((resolve, reject) => {
      for (const socket of this.server.clients) socket.terminate();
      this.server.close((error) => (error ? reject(error) : resolve()));
    }));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private async receive(socket: WebSocket, message: string): Promise<void> {
    let command: RecordedCommand;
    try {
      command = JSON.parse(message) as RecordedCommand;
    } catch {
      socket.close(1007, 'Invalid JSON');
      return;
    }
    // Keep the record independent of mutations a handler makes to its arguments.
    this.commands.push(structuredClone(command));
    try {
      const handler = this.queued.get(command.method)?.shift() ?? this.handlers.get(command.method);
      const result = await (handler ? handler(command) : this.defaultReply(command));
      if (result !== NO_REPLY && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, result }));
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            id: command.id,
            sessionId: command.sessionId,
            error: {
              code: error instanceof ProtocolError ? error.code : -32000,
              message: error instanceof Error ? error.message : String(error),
              data: error instanceof ProtocolError ? error.data : undefined,
            },
          }),
        );
    }
  }

  private defaultReply(command: RecordedCommand): unknown {
    const p = (command.params ?? {}) as Record<string, unknown>;
    const targetId = command.sessionId ? this.sessions.get(command.sessionId) : undefined;
    if (command.sessionId && !targetId) throw new Error(`Unknown session ${command.sessionId}`);
    switch (command.method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Scripted',
          revision: 'scripted',
          userAgent: 'ScriptedChrome',
          jsVersion: 'scripted',
        } satisfies Protocol.Browser.GetVersionResponse;
      case 'Target.getBrowserContexts':
        return { browserContextIds: [...this.contexts] };
      case 'Target.setDiscoverTargets':
        this.discovering = p.discover === true;
        return {};
      case 'Target.getTargets':
        return { targetInfos: [...this.pages.values()] };
      case 'Target.getTargetInfo': {
        const info = this.pages.get(String(p.targetId ?? targetId));
        if (!info) throw new Error(`Unknown target ${p.targetId}`);
        return { targetInfo: info };
      }
      case 'Target.attachToTarget': {
        const info = this.pages.get(String(p.targetId));
        if (!info) throw new Error(`Unknown target ${p.targetId}`);
        const sessionId = `session-${++this.sequence}`;
        this.sessions.set(sessionId, info.targetId);
        info.attached = true;
        return { sessionId };
      }
      case 'Page.getFrameTree': {
        const info = this.pages.get(targetId!);
        if (!info) throw new Error('Page.getFrameTree requires a page session');
        return {
          frameTree: {
            frame: {
              id: info.targetId,
              loaderId: `loader-${info.targetId}`,
              url: info.url,
              domainAndRegistry: '',
              securityOrigin: '://',
              mimeType: 'text/html',
              secureContextType: 'InsecureScheme',
              crossOriginIsolatedContextType: 'NotIsolated',
              gatedAPIFeatures: [],
            },
          },
        } satisfies Protocol.Page.GetFrameTreeResponse;
      }
      case 'Page.enable':
      case 'Page.setLifecycleEventsEnabled':
      case 'Target.setAutoAttach':
        return {};
      case 'Target.createTarget':
        return {
          targetId: this.addPage({
            url: String(p.url),
            browserContextId: p.browserContextId as string | undefined,
          }),
        };
      case 'Target.closeTarget':
        this.destroyTarget(String(p.targetId));
        return { success: true };
      case 'Target.createBrowserContext': {
        const browserContextId = `context-${++this.sequence}`;
        this.contexts.add(browserContextId);
        return { browserContextId };
      }
      case 'Target.disposeBrowserContext': {
        const id = String(p.browserContextId);
        if (!this.contexts.delete(id)) throw new Error(`Unknown context ${id}`);
        for (const page of this.pages.values())
          if (page.browserContextId === id) this.destroyTarget(page.targetId);
        return {};
      }
      default:
        this.unexpectedCommands.push(structuredClone(command));
        throw new ProtocolError(command.method, -32601, `Unscripted command ${command.method}`);
    }
  }
}
