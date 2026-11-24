import type { AddressInfo } from 'node:net';
import type { Protocol } from 'devtools-protocol';
import { Browser, type ConnectOptions } from '../browser/browser.ts';
import type { Command, Event, EventParams, Params, Result } from '../protocol/connection.ts';
import type { InputReport, InputSent } from '../input/behavior.ts';
import { ProtocolError } from '../errors.ts';
import WebSocket, { WebSocketServer } from 'ws';

/** Partial overrides accepted by `createInputReport()`. */
export type InputReportOverrides = Partial<Omit<InputReport, 'sent'>> & {
  sent?: Partial<InputSent>;
};

/**
 * Builds a complete `InputReport` with safe defaults for unit tests (such as constructing
 * `InputActionError`), keeping downstream tests insulated from future telemetry fields.
 */
export function createInputReport(overrides: InputReportOverrides = {}): InputReport {
  const { sent, trace, cleanupErrors, finalPosition, ...rest } = overrides;
  return {
    action: 'input',
    status: 'completed',
    seed: 0,
    randomState: 0,
    completedSegments: 0,
    events: 0,
    dispatched: 0,
    skippedMoves: 0,
    lateReplies: 0,
    presentationRecoveries: 0,
    plannedMs: 0,
    actualMs: 0,
    phase: 'done',
    cleanup: 'completed',
    ...rest,
    sent: {
      moves: 0,
      wheels: 0,
      presses: 0,
      keys: 0,
      characters: 0,
      releases: 0,
      text: 0,
      composition: 0,
      ...sent,
    },
    ...(finalPosition !== undefined ? { finalPosition: { ...finalPosition } } : {}),
    trace: trace ? trace.map((entry) => ({ ...entry })) : [],
    cleanupErrors: cleanupErrors ? [...cleanupErrors] : [],
  };
}

/** Return this from a handler to leave a command pending for timeout/abort/disconnect tests. */
export const NO_REPLY = Symbol('NO_REPLY');
const UNKNOWN_SESSION = Symbol('UNKNOWN_SESSION');
/** The error object of a reply. A ProtocolError's message wraps Chrome's with method and data. */
function wireError(error: unknown): { code: number; message: string; data?: string } {
  if (!(error instanceof ProtocolError))
    return { code: -32000, message: error instanceof Error ? error.message : String(error) };
  return { code: error.code, message: error.protocolMessage, data: error.data };
}

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
export interface ScriptedPageOptions {
  url?: string;
  title?: string;
  browserContextId?: string;
  openerId?: string;
  openerFrameId?: string;
}
export interface ScriptedChromeOptions {
  /** Defaults to one about:blank page. [] starts with no targets. */
  pages?: ScriptedPageOptions[];
  /** Optional default browser context ID reported by `Target.getBrowserContexts`. */
  defaultBrowserContextId?: string;
}
export interface ScriptedNavigationOptions {
  /** Frame to navigate; defaults to the session's main frame (`targetId`). */
  frameId?: string;
  /**
   * Explicit parent frame ID for `Page.frameNavigated`. When omitted on a subframe (`frameId !== targetId`),
   * uses the parent recorded from `Page.frameAttached` or falls back to the session's main frame (`targetId`).
   */
  parentId?: string;
  /** Loader ID for the navigation; generated automatically if omitted. */
  loaderId?: string;
  /** Emit `Page.navigatedWithinDocument` instead of `Page.frameNavigated` and lifecycle events. */
  sameDocument?: boolean;
  /**
   * Lifecycle events emitted after `Page.frameNavigated` for cross-document navigations.
   * Defaults to `['DOMContentLoaded', 'load']`. Pass `[]` to emit no lifecycle events.
   */
  lifecycle?: readonly string[];
  /** Navigation type for `Page.frameNavigated`; defaults to `'Navigation'`. */
  type?: Protocol.Page.NavigationType;
}
export interface ScriptedNavigationDecision {
  url?: string;
  errorText?: string;
  isDownload?: boolean;
  sameDocument?: boolean;
  lifecycle?: readonly string[];
  delayMs?: number;
}
export interface ScriptedNavigationHandlerOptions {
  /** Delay in milliseconds before committing the navigation; defaults to `setImmediate`. */
  delayMs?: number;
  /** Default lifecycle events passed to `commitNavigation()`; defaults to `['DOMContentLoaded', 'load']`. */
  lifecycle?: readonly string[];
  /**
   * Optional callback invoked on each `Page.navigate` command. Return `errorText` or `isDownload`
   * to simulate a failed or download navigation (no commit events are emitted), or override
   * `url`, `sameDocument`, `lifecycle`, or `delayMs`.
   */
  onNavigate?: (
    params: Protocol.Page.NavigateRequest,
    command: RecordedCommand<'Page.navigate'>,
  ) => void | ScriptedNavigationDecision | Promise<void | ScriptedNavigationDecision>;
}
type Handler = (command: RecordedCommand) => unknown | Promise<unknown>;
function frameSecurityOrigin(url: string): string {
  if (!URL.canParse(url)) return '://';
  const parsed = new URL(url);
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '://';
}

/**
 * A strict, scripted CDP peer for real Browser/Tab/Session objects. No Chrome process or JS
 * engine is started. Only the library startup handshake and target lifecycle have defaults.
 * One controller connection at a time; close it before reconnecting.
 */
export class ScriptedChrome {
  readonly commands: RecordedCommand[] = [];
  readonly unexpectedCommands: RecordedCommand[] = [];
  readonly endpoint: string;
  private readonly server: WebSocketServer;
  private socket?: WebSocket;
  private closing?: Promise<void>;
  private readonly handlers = new Map<Command, Handler>();
  private readonly queued = new Map<Command, Handler[]>();
  private readonly pages = new Map<string, Protocol.Target.TargetInfo>();
  private readonly sessions = new Map<string, string>();
  private readonly frameParents = new Map<string, Map<string, string>>();
  private readonly contexts = new Set<string>();
  private readonly defaultBrowserContextId?: string;
  private sequence = 0;
  private discovering = false;
  /** Delay modeled attach replies (not attachment creation) to exercise cancelled late replies. */
  attachReplyDelayMs = 0;

  private constructor(server: WebSocketServer, options: ScriptedChromeOptions) {
    this.server = server;
    this.defaultBrowserContextId = options.defaultBrowserContextId;
    this.endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/scripted`;
    for (const page of options.pages ?? [{}]) this.addPage(page);
    server.on('connection', (socket) => {
      if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
        socket.close(1013, 'ScriptedChrome supports one controller at a time');
        return;
      }
      this.socket = socket;
      this.sessions.clear();
      this.frameParents.clear();
      this.discovering = false;
      socket.on('error', () => socket.terminate());
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.sessions.clear();
        this.frameParents.clear();
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

  /** Emit a raw event; records `Page.frameAttached`/`Page.frameDetached` parent links for `commitNavigation()`. */
  emit<E extends Event>(method: E, params: EventParams<E>, sessionId?: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      throw new Error('ScriptedChrome has no connected controller');
    if (sessionId) {
      if (method === 'Page.frameAttached') {
        const { frameId, parentFrameId } = params as Protocol.Page.FrameAttachedEvent;
        let parents = this.frameParents.get(sessionId);
        if (!parents) this.frameParents.set(sessionId, (parents = new Map()));
        parents.set(frameId, parentFrameId);
      } else if (method === 'Page.frameDetached') {
        const { frameId } = params as Protocol.Page.FrameDetachedEvent;
        const parents = this.frameParents.get(sessionId);
        if (parents) {
          const remove = new Set<string>([frameId]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const [child, parent] of parents) {
              if (remove.has(parent) && !remove.has(child)) {
                remove.add(child);
                grew = true;
              }
            }
          }
          for (const id of remove) parents.delete(id);
        }
      } else if (method === 'Page.frameNavigated') {
        const { frame } = params as Protocol.Page.FrameNavigatedEvent;
        if (frame.parentId) {
          let parents = this.frameParents.get(sessionId);
          if (!parents) this.frameParents.set(sessionId, (parents = new Map()));
          parents.set(frame.id, frame.parentId);
        }
      }
    }
    socket.send(JSON.stringify({ method, params, sessionId }));
  }

  /**
   * Add a page to the fake's target model and notify an active discovery subscription. An
   * `openerId` or `openerFrameId` models a popup of that page or frame.
   */
  addPage(page: ScriptedPageOptions = {}): string {
    const targetId = `page-${++this.sequence}`;
    const info: Protocol.Target.TargetInfo = {
      targetId,
      type: 'page',
      title: page.title ?? '',
      url: page.url ?? 'about:blank',
      attached: false,
      canAccessOpener: false,
      browserContextId: page.browserContextId,
      ...(page.openerId ? { openerId: page.openerId } : {}),
      ...(page.openerFrameId ? { openerFrameId: page.openerFrameId } : {}),
    };
    this.pages.set(targetId, info);
    if (this.discovering) this.emit('Target.targetCreated', { targetInfo: info });
    return targetId;
  }

  /**
   * Commits a navigation on a modeled session: updates the page's target info (for main-frame
   * navigations) and emits `Page.frameNavigated` + lifecycle events (or
   * `Page.navigatedWithinDocument` when `sameDocument: true`).
   */
  commitNavigation(
    sessionId: string,
    url: string,
    options: ScriptedNavigationOptions = {},
  ): { frameId: string; loaderId: string } {
    const targetId = this.sessions.get(sessionId);
    if (!targetId) throw new Error(`Unknown scripted session ${sessionId}`);
    const info = this.pages.get(targetId);
    if (!info) throw new Error(`Unknown scripted target ${targetId}`);
    const frameId = options.frameId ?? info.targetId;
    const loaderId = options.loaderId ?? `loader-${++this.sequence}`;
    if (frameId === info.targetId) {
      info.url = url;
      if (this.discovering) this.emit('Target.targetInfoChanged', { targetInfo: { ...info } });
    }
    if (options.sameDocument) {
      this.emit(
        'Page.navigatedWithinDocument',
        { frameId, url, navigationType: 'other' },
        sessionId,
      );
      return { frameId, loaderId };
    }
    const parentId =
      options.parentId !== undefined
        ? options.parentId || undefined
        : frameId !== info.targetId
          ? (this.frameParents.get(sessionId)?.get(frameId) ?? info.targetId)
          : undefined;
    this.emit(
      'Page.frameNavigated',
      {
        type: options.type ?? 'Navigation',
        frame: {
          id: frameId,
          ...(parentId ? { parentId } : {}),
          loaderId,
          url,
          domainAndRegistry: '',
          securityOrigin: frameSecurityOrigin(url),
          mimeType: 'text/html',
          secureContextType: url.startsWith('https:') ? 'Secure' : 'InsecureScheme',
          crossOriginIsolatedContextType: 'NotIsolated',
          gatedAPIFeatures: [],
        },
      },
      sessionId,
    );
    for (const name of options.lifecycle ?? ['DOMContentLoaded', 'load']) {
      this.emit('Page.lifecycleEvent', { frameId, loaderId, name, timestamp: 0 }, sessionId);
    }
    return { frameId, loaderId };
  }

  /**
   * Installs a persistent `Page.navigate` handler that commits each navigation through
   * `commitNavigation()`. Useful for testing `tab.goto()`, `newTab(url)`, `Tab.navigated`,
   * `Browser.tabNavigated`, and `TabScope.navigated` without hand-wiring frame/lifecycle events.
   */
  handleNavigation(options: ScriptedNavigationHandlerOptions = {}): () => void {
    return this.handle('Page.navigate', async (params, command) => {
      const sessionId = command.sessionId;
      const targetId = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!sessionId || !targetId) throw UNKNOWN_SESSION;
      const decision = (await options.onNavigate?.(params, command)) ?? undefined;
      const frameId = params.frameId ?? targetId;
      const loaderId = `loader-${++this.sequence}`;
      if (decision?.errorText || decision?.isDownload) {
        return {
          frameId,
          loaderId,
          ...(decision.errorText ? { errorText: decision.errorText } : {}),
          ...(decision.isDownload ? { isDownload: decision.isDownload } : {}),
        };
      }
      const targetUrl = decision?.url ?? params.url;
      const sameDocument = decision?.sameDocument ?? false;
      const lifecycle = decision?.lifecycle ?? options.lifecycle;
      const delayMs = decision?.delayMs ?? options.delayMs;
      const commit = () => {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        if (!this.sessions.has(sessionId)) return;
        this.commitNavigation(sessionId, targetUrl, {
          frameId,
          loaderId,
          sameDocument,
          lifecycle,
        });
      };
      if (delayMs !== undefined && delayMs > 0) setTimeout(commit, delayMs);
      else setImmediate(commit);
      return sameDocument ? { frameId } : { frameId, loaderId };
    });
  }

  destroyTarget(targetId: string): void {
    if (!this.pages.delete(targetId)) throw new Error(`Unknown scripted target ${targetId}`);
    for (const [sessionId, target] of this.sessions) {
      if (target !== targetId) continue;
      this.sessions.delete(sessionId);
      this.frameParents.delete(sessionId);
      this.emit('Target.detachedFromTarget', { sessionId, targetId });
    }
    if (this.discovering) this.emit('Target.targetDestroyed', { targetId });
  }

  /** Detach one modeled attachment, leaving its target and sibling attachments alive. */
  detachSession(sessionId: string): void {
    const targetId = this.sessions.get(sessionId);
    if (!targetId) throw new ProtocolError('Target.detachFromTarget', -32000, 'Session not found');
    this.sessions.delete(sessionId);
    this.frameParents.delete(sessionId);
    const info = this.pages.get(targetId);
    if (info) info.attached = [...this.sessions.values()].includes(targetId);
    this.emit('Target.detachedFromTarget', { sessionId, targetId });
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
      if (command.method === 'Target.attachToTarget' && this.attachReplyDelayMs > 0)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, this.attachReplyDelayMs);
          function done() {
            clearTimeout(timer);
            socket.off('close', done);
            resolve();
          }
          socket.once('close', done);
        });
      if (result !== NO_REPLY && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, result }));
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify(
            error === UNKNOWN_SESSION
              ? // Chrome answers for an unknown session itself, without the session's ID.
                {
                  id: command.id,
                  error: { code: -32001, message: 'Session with given id not found.' },
                }
              : { id: command.id, sessionId: command.sessionId, error: wireError(error) },
          ),
        );
    }
  }

  private defaultReply(command: RecordedCommand): unknown {
    const p = (command.params ?? {}) as Record<string, unknown>;
    const targetId = command.sessionId ? this.sessions.get(command.sessionId) : undefined;
    if (command.sessionId && !targetId) throw UNKNOWN_SESSION;
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
        return {
          browserContextIds: [...this.contexts],
          ...(this.defaultBrowserContextId
            ? { defaultBrowserContextId: this.defaultBrowserContextId }
            : {}),
        };
      case 'Target.setDiscoverTargets':
        this.discovering = p.discover === true;
        return {};
      case 'Target.getTargets':
        return { targetInfos: [...this.pages.values()] };
      case 'Target.getTargetInfo': {
        const info = this.pages.get(String(p.targetId ?? targetId));
        if (!info) throw new ProtocolError(command.method, -32602, 'No target with given id found');
        return { targetInfo: info };
      }
      case 'Target.attachToTarget': {
        const info = this.pages.get(String(p.targetId));
        if (!info) throw new ProtocolError(command.method, -32602, 'No target with given id found');
        const sessionId = `session-${++this.sequence}`;
        this.sessions.set(sessionId, info.targetId);
        info.attached = true;
        this.emit('Target.attachedToTarget', {
          sessionId,
          targetInfo: info,
          waitingForDebugger: false,
        });
        return { sessionId };
      }
      case 'Target.detachFromTarget':
        this.detachSession(String(p.sessionId));
        return {};
      case 'Page.getFrameTree': {
        const info = this.pages.get(targetId!);
        if (!info)
          throw new ProtocolError(
            command.method,
            -32602,
            'Page.getFrameTree requires a page session',
          );
        return {
          frameTree: {
            frame: {
              id: info.targetId,
              loaderId: `loader-${info.targetId}`,
              url: info.url,
              domainAndRegistry: '',
              securityOrigin: frameSecurityOrigin(info.url),
              mimeType: 'text/html',
              secureContextType: info.url.startsWith('https:') ? 'Secure' : 'InsecureScheme',
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
      case 'Target.closeTarget': {
        const id = String(p.targetId);
        if (!this.pages.has(id))
          throw new ProtocolError(command.method, -32602, 'No target with given id found');
        this.destroyTarget(id);
        return { success: true };
      }
      case 'Target.createBrowserContext': {
        const browserContextId = `context-${++this.sequence}`;
        this.contexts.add(browserContextId);
        return { browserContextId };
      }
      case 'Target.disposeBrowserContext': {
        const id = String(p.browserContextId);
        if (!this.contexts.delete(id))
          throw new ProtocolError(command.method, -32602, `Unknown context ${id}`);
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
