import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readRequestBody } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Tab } from '../page/tab.ts';
import { PresentationLease, type PresentationScreencastOptions } from '../page/presentation.ts';
import type { EventParams } from '../protocol/connection.ts';
import { delay } from '../utils.ts';

export interface RemoteHandoffAudit {
  event: 'started' | 'connected' | 'ended';
  handoffId: string;
  principal: string;
  leaseId: string;
  tabId: string;
  time: number;
  /** On `ended`. */
  reason?: HandoffEndReason;
  /** On `ended`: how many input events the user sent. Never their content. */
  inputs?: number;
}
export interface RemoteHandoffOptions {
  /** Longest a handoff can last; 15 minutes by default. */
  maxDuration?: number;
  /** How long the link can be opened for; 5 minutes by default, at most maxDuration. */
  tokenTtl?: number;
  /** Also return the link in the tool result, where the model can read it. Off by default. */
  linkInResult?: boolean;
  /** JPEG, at most 1920x1080, by default. */
  screencast?: PresentationScreencastOptions;
  audit?: (entry: RemoteHandoffAudit) => void;
}
export type HandoffEndReason =
  'condition' | 'completed' | 'cancelled' | 'expired' | 'tab-closed' | 'released';
export interface ResumeCondition {
  /** The whole URL of the main frame; `*` matches any characters. */
  url?: string;
  /** CSS selector that must match in the main frame. */
  selector?: string;
  /** Milliseconds from the start until the handoff expires. */
  timeout: number;
}
export interface HandoffStatus {
  handoffId: string;
  tabId: string;
  state: 'active' | 'ended';
  expiresAt: number;
  connected: boolean;
  inputs: number;
  reason?: HandoffEndReason;
}

const MAX_DURATION = 15 * 60_000;
const TOKEN_TTL = 5 * 60_000;
const MAX_HANDOFFS = 64;
/** How long the outcome of an ended handoff can still be read. */
const RETAIN_ENDED = 5 * 60_000;
const CONDITION_INTERVAL = 500;
const INPUT_TIMEOUT = 5_000;
const KEEP_ALIVE = 15_000;
const MAX_INPUT_BYTES = 128 * 1024;
const COOKIE = 'nodriver_handoff';
const MODIFIERS = z.number().int().min(0).max(15).default(0);
const unit = z.number().min(0).max(1);
const InputEvent = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('mouse'),
    action: z.enum(['down', 'up', 'move']),
    x: unit,
    y: unit,
    button: z.enum(['none', 'left', 'middle', 'right']).default('none'),
    buttons: z.number().int().min(0).max(31).default(0),
    clickCount: z.number().int().min(0).max(3).default(0),
    modifiers: MODIFIERS,
  }),
  z.strictObject({
    kind: z.literal('wheel'),
    x: unit,
    y: unit,
    deltaX: z.number().min(-100_000).max(100_000),
    deltaY: z.number().min(-100_000).max(100_000),
    modifiers: MODIFIERS,
  }),
  z.strictObject({
    kind: z.literal('key'),
    action: z.enum(['down', 'up']),
    key: z.string().max(64),
    code: z.string().max(64),
    keyCode: z.number().int().min(0).max(255),
    text: z.string().max(8).optional(),
    modifiers: MODIFIERS,
  }),
  z.strictObject({
    kind: z.literal('text'),
    text: z
      .string()
      .min(1)
      .max(64 * 1024),
  }),
]);
export type HandoffInput = z.output<typeof InputEvent>;
type FrameMetadata = EventParams<'Page.screencastFrame'>['metadata'];

const digest = (value: string) => createHash('sha256').update(value).digest();
function matches(expected: Buffer | undefined, value: string | undefined | null): boolean {
  if (!expected || !value) return false;
  return timingSafeEqual(expected, digest(value));
}
function urlMatches(pattern: string, url: string): boolean {
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'));
  return new RegExp(`^${source.join('.*')}$`, 's').test(url);
}

/** The point of the tab viewport under a position within a frame, each axis from 0 to 1. */
export function framePoint(
  x: number,
  y: number,
  metadata: Pick<FrameMetadata, 'deviceWidth' | 'deviceHeight' | 'offsetTop'>,
): { x: number; y: number } {
  return { x: x * metadata.deviceWidth, y: y * metadata.deviceHeight + metadata.offsetTop };
}

/**
 * The bytes of one server-sent stream. Holds what has been offered until the consumer reads it,
 * and push() settles only once the consumer has asked for what follows, so a slow viewer slows
 * the screencast down instead of filling memory.
 */
class FrameChannel {
  private readonly items: Array<{ bytes: Uint8Array; sent: () => void }> = [];
  private settle?: () => void;
  private wake?: () => void;
  private closed = false;
  readonly stream: ReadableStream<Uint8Array>;
  constructor(onCancel: () => void) {
    this.stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          this.settle?.();
          this.settle = undefined;
          while (!this.items.length && !this.closed)
            await new Promise<void>((resolve) => (this.wake = resolve));
          const item = this.items.shift();
          if (!item) {
            controller.close();
            return;
          }
          controller.enqueue(item.bytes);
          this.settle = item.sent;
        },
        cancel: () => {
          this.close();
          onCancel();
        },
      },
      { highWaterMark: 0 },
    );
  }
  get idle(): boolean {
    return !this.items.length;
  }
  push(event: string, data?: unknown): Promise<void> {
    const text =
      data === undefined ? `: ${event}\n\n` : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (this.closed) return Promise.resolve();
    return new Promise<void>((sent) => {
      this.items.push({ bytes: new TextEncoder().encode(text), sent });
      this.wake?.();
    });
  }
  /** What was pushed is still delivered; nothing waits for it any longer. */
  close(): void {
    this.closed = true;
    this.settle?.();
    this.settle = undefined;
    for (const item of this.items) item.sent();
    this.wake?.();
  }
}

export interface RemoteHandoffInit {
  tab: Tab;
  principal: string;
  leaseId: string;
  options: RemoteHandoffOptions;
  resume?: ResumeCondition;
  /** Keeps the lease from being reclaimed while idle; called when the handoff ends. */
  release: () => void;
  changed: (type: string) => void;
  onEnded: () => void;
}

/** One user operating one tab through the viewer page. */
export class RemoteHandoff {
  readonly id = randomUUID();
  readonly principal: string;
  readonly leaseId: string;
  readonly tab: Tab;
  readonly expiresAt: number;
  readonly ended: Promise<void>;
  private readonly init: RemoteHandoffInit;
  private tokenHash?: Buffer;
  private readonly tokenExpires: number;
  private sessionHash?: Buffer;
  private reason?: HandoffEndReason;
  private markEnded!: () => void;
  private connected = false;
  private inputs = 0;
  private metadata?: FrameMetadata;
  private channel?: FrameChannel;
  private lease?: PresentationLease;
  private keepAlive?: ReturnType<typeof setInterval>;
  private inputChain: Promise<unknown> = Promise.resolve();
  private checking = false;
  private readonly offs: Array<() => void> = [];
  private readonly timers: Array<ReturnType<typeof setTimeout>> = [];
  private ending?: Promise<void>;
  endedAt?: number;
  constructor(init: RemoteHandoffInit, token: string) {
    this.init = init;
    this.tab = init.tab;
    this.principal = init.principal;
    this.leaseId = init.leaseId;
    this.tokenHash = digest(token);
    const now = Date.now();
    const duration = Math.min(
      init.options.maxDuration ?? MAX_DURATION,
      init.resume?.timeout ?? Infinity,
    );
    this.expiresAt = now + duration;
    this.tokenExpires = now + Math.min(init.options.tokenTtl ?? TOKEN_TTL, duration);
    this.ended = new Promise((resolve) => (this.markEnded = resolve));
    const expiry = setTimeout(() => void this.end('expired'), duration);
    expiry.unref();
    this.timers.push(expiry);
    this.offs.push(this.tab.session.disconnected.on(() => void this.end('tab-closed')));
    if (init.resume) {
      const check = () => void this.checkCondition();
      const interval = setInterval(check, CONDITION_INTERVAL);
      interval.unref();
      this.offs.push(() => clearInterval(interval), this.tab.framesManager.changes.on(check));
      check();
    }
    this.audit('started');
    init.changed('handoff-started');
  }
  private audit(event: RemoteHandoffAudit['event'], extra: Partial<RemoteHandoffAudit> = {}) {
    try {
      this.init.options.audit?.({
        event,
        handoffId: this.id,
        principal: this.principal,
        leaseId: this.leaseId,
        tabId: this.tab.id,
        time: Date.now(),
        ...extra,
      });
    } catch {}
  }
  private async checkCondition(): Promise<void> {
    const { url, selector } = this.init.resume!;
    if (this.checking || this.reason) return;
    this.checking = true;
    try {
      if (url !== undefined && !urlMatches(url, this.tab.url)) return;
      if (selector !== undefined) {
        const found = await this.tab.mainFrame.evaluate(
          `!!document.querySelector(${JSON.stringify(selector)})`,
          undefined,
          { world: 'isolated', timeout: 2000 },
        );
        if (found !== true) return;
      }
      await this.end('condition');
    } catch {
      // Navigating, or the selector is not valid here; the next check decides.
    } finally {
      this.checking = false;
    }
  }
  get active(): boolean {
    return !this.reason;
  }
  status(): HandoffStatus {
    return {
      handoffId: this.id,
      tabId: this.tab.id,
      state: this.reason ? 'ended' : 'active',
      expiresAt: this.expiresAt,
      connected: this.connected,
      inputs: this.inputs,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
  /** The first valid use of the token returns the viewer's session secret; a token works once. */
  exchange(token: string): string | undefined {
    if (!this.active || Date.now() > this.tokenExpires || !matches(this.tokenHash, token))
      return undefined;
    this.tokenHash = undefined;
    const secret = randomBytes(32).toString('base64url');
    this.sessionHash = digest(secret);
    this.connected = true;
    this.audit('connected');
    this.init.changed('handoff-connected');
    return secret;
  }
  authorized(secret: string | undefined): boolean {
    return this.active && matches(this.sessionHash, secret);
  }
  /** Replaces any earlier stream: there is one viewer at a time. */
  async frames(signal: AbortSignal): Promise<Response> {
    await this.stopStream();
    const channel = new FrameChannel(() => void this.stopStream(channel));
    const screencast = this.init.options.screencast ?? {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1920,
      maxHeight: 1080,
    };
    const lease = new PresentationLease(this.tab.session, {
      screencast,
      maxDuration: Math.max(1, this.expiresAt - Date.now()),
      maxFrames: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
      ackTimeout: 5000,
      startTimeout: 5000,
      deliver: (frame) => {
        this.metadata = frame.metadata;
        return channel.push('frame', { data: frame.data });
      },
    });
    this.channel = channel;
    this.lease = lease;
    signal.addEventListener('abort', () => void this.stopStream(channel), { once: true });
    this.keepAlive = setInterval(() => {
      if (channel.idle) void channel.push('keep-alive');
    }, KEEP_ALIVE);
    this.keepAlive.unref();
    try {
      await lease.start();
    } catch (error) {
      await this.stopStream(channel);
      throw error;
    }
    return new Response(channel.stream, {
      headers: { 'content-type': 'text/event-stream', ...SECURITY_HEADERS },
    });
  }
  private async stopStream(only?: FrameChannel): Promise<void> {
    if (only && this.channel !== only) return;
    const { channel, lease } = this;
    this.channel = undefined;
    this.lease = undefined;
    clearInterval(this.keepAlive);
    channel?.close();
    await lease?.close().catch(() => {});
  }
  /** Sends input in the order it arrives. Rejects when the page could not be reached. */
  input(event: HandoffInput): Promise<void> {
    const sending = this.inputChain.then(() => this.dispatch(event));
    this.inputChain = sending.catch(() => {});
    return sending;
  }
  private async dispatch(event: HandoffInput): Promise<void> {
    if (!this.active) throw new HandoffEndedError();
    const session = this.tab.session;
    const wait = { timeout: INPUT_TIMEOUT };
    if ((event.kind === 'mouse' || event.kind === 'wheel') && !this.metadata)
      throw new HandoffNotReadyError();
    this.inputs++;
    if (event.kind === 'text') {
      await session.sendWith('Input.insertText', wait, { text: event.text });
      return;
    }
    if (event.kind === 'key') {
      await session.sendWith('Input.dispatchKeyEvent', wait, {
        type: event.action === 'up' ? 'keyUp' : event.text ? 'keyDown' : 'rawKeyDown',
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        modifiers: event.modifiers,
        ...(event.text ? { text: event.text, unmodifiedText: event.text } : {}),
      });
      return;
    }
    const point = framePoint(event.x, event.y, this.metadata!);
    if (event.kind === 'wheel') {
      await session.sendWith('Input.dispatchMouseEvent', wait, {
        type: 'mouseWheel',
        ...point,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: event.modifiers,
      });
      return;
    }
    await session.sendWith('Input.dispatchMouseEvent', wait, {
      type:
        event.action === 'down'
          ? 'mousePressed'
          : event.action === 'up'
            ? 'mouseReleased'
            : 'mouseMoved',
      ...point,
      button: event.button,
      buttons: event.buttons,
      clickCount: event.clickCount,
      modifiers: event.modifiers,
    });
  }
  /** The first call decides the outcome. Waits until the screencast has stopped. */
  end(reason: HandoffEndReason): Promise<void> {
    return (this.ending ??= (async () => {
      this.reason = reason;
      this.endedAt = Date.now();
      this.tokenHash = undefined;
      for (const timer of this.timers) clearTimeout(timer);
      for (const off of this.offs) off();
      void this.channel?.push('ended', { reason });
      await this.stopStream();
      this.init.release();
      this.init.onEnded();
      this.audit('ended', { reason, inputs: this.inputs });
      this.init.changed('handoff-ended');
      this.markEnded();
    })());
  }
}
class HandoffEndedError extends Error {}
class HandoffNotReadyError extends Error {}

export class HandoffRegistry {
  private readonly handoffs = new Map<string, RemoteHandoff>();
  private sweep(): void {
    for (const [id, handoff] of this.handoffs)
      if (handoff.endedAt !== undefined && Date.now() - handoff.endedAt >= RETAIN_ENDED)
        this.handoffs.delete(id);
  }
  /** The handoff and the one-time token of its link; the token is not kept. */
  create(init: RemoteHandoffInit): { handoff: RemoteHandoff; token: string } {
    this.sweep();
    if (this.handoffs.size >= MAX_HANDOFFS) throw new Error('Handoff capacity reached');
    const token = randomBytes(32).toString('base64url');
    const handoff = new RemoteHandoff(init, token);
    this.handoffs.set(handoff.id, handoff);
    return { handoff, token };
  }
  /** Only the lease that started a handoff can see it. */
  get(id: string, principal: string, leaseId: string): RemoteHandoff | undefined {
    const handoff = this.handoffs.get(id);
    return handoff?.principal === principal && handoff.leaseId === leaseId ? handoff : undefined;
  }
  byId(id: string): RemoteHandoff | undefined {
    return this.handoffs.get(id);
  }
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
const CSP =
  "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
function html(body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Browser handoff</title>${body}`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP,
        ...SECURITY_HEADERS,
      },
    },
  );
}
const refused = (status: number, message: string) =>
  Response.json({ error: message }, { status, headers: SECURITY_HEADERS });
function cookieOf(request: Request): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === COOKIE) return part.slice(at + 1).trim();
  }
  return undefined;
}
const PATH = /^\/handoff\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/([a-z.]+))?$/;

/**
 * Serves the viewer of a handoff, or returns undefined for any other path. The caller has already
 * validated the Host header. The viewer has no bearer token: it holds the session cookie that
 * the link's one-time token was exchanged for.
 */
export async function handoffResponse(
  request: Request,
  url: URL,
  registry: HandoffRegistry,
): Promise<Response | undefined> {
  const route = PATH.exec(url.pathname);
  if (!url.pathname.startsWith('/handoff/')) return undefined;
  const unknown = () => refused(404, 'Unknown or expired handoff');
  if (!route) return unknown();
  const handoff = registry.byId(route[1]!);
  if (!handoff) return unknown();
  const asset = route[2];
  const fetchSite = request.headers.get('sec-fetch-site');
  if (request.method === 'GET' && !asset && url.searchParams.has('token')) {
    const secret = handoff.exchange(url.searchParams.get('token')!);
    if (!secret) return refused(403, 'This link is expired or was already used');
    // Not a redirect: a browser withholds SameSite=Strict cookies along a redirect chain that a
    // link in another application started. A refresh from this page is a same-site navigation.
    const response = html(`<meta http-equiv="refresh" content="0;url=/handoff/${handoff.id}">`);
    response.headers.set(
      'set-cookie',
      `${COOKIE}=${secret}; HttpOnly; SameSite=Strict; Path=/handoff/${handoff.id}`,
    );
    return response;
  }
  if (!handoff.authorized(cookieOf(request))) return refused(403, 'Open the handoff link first');
  // Everything but the page itself is requested by the page.
  if (asset && fetchSite && fetchSite !== 'same-origin')
    return refused(403, 'Cross-site request rejected');
  if (request.method === 'GET') {
    if (!asset)
      return html(
        `<script src="/handoff/${handoff.id}/viewer.js" defer></script></head><body><div id="status">Connecting</div><button id="done" type="button">Done</button><textarea id="ime" aria-label="Keyboard input" autocomplete="off"></textarea><img id="screen" alt="Browser tab" draggable="false"></body></html>`,
      );
    if (asset === 'viewer.js')
      return new Response(VIEWER, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', ...SECURITY_HEADERS },
      });
    if (asset === 'frames') {
      try {
        return await handoff.frames(request.signal);
      } catch {
        return refused(502, 'The tab could not be shown');
      }
    }
    return unknown();
  }
  if (request.method !== 'POST') return refused(405, 'Method not allowed');
  if (request.headers.get('origin') !== url.origin) return refused(403, 'Origin rejected');
  if (asset === 'done') {
    await handoff.end('completed');
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  }
  if (asset !== 'input') return unknown();
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
    return refused(415, 'Use application/json');
  const read = await readRequestBody(request, MAX_INPUT_BYTES);
  if (read.tooLarge) return refused(413, 'Input too large');
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return refused(400, 'Invalid input');
  }
  const event = InputEvent.safeParse(body);
  if (!event.success) return refused(400, 'Invalid input');
  try {
    await handoff.input(event.data);
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  } catch (error) {
    if (error instanceof HandoffEndedError) return refused(410, 'The handoff has ended');
    if (error instanceof HandoffNotReadyError) return refused(409, 'No frame has been shown yet');
    return refused(502, 'The input did not reach the page');
  }
}

/** Waits for the end of a handoff, up to `timeout`; a handoff still active is not an error. */
export async function waitForHandoff(
  handoff: RemoteHandoff,
  timeout: number,
  signal: AbortSignal,
): Promise<void> {
  const stop = new AbortController();
  try {
    await Promise.race([handoff.ended, delay(timeout, AbortSignal.any([signal, stop.signal]))]);
  } finally {
    stop.abort();
  }
}

const VIEWER = `'use strict';
const base = location.pathname;
const screen_ = document.getElementById('screen');
const ime = document.getElementById('ime');
const status_ = document.getElementById('status');
const done = document.getElementById('done');
document.body.style.cssText = 'margin:0;background:#222;color:#eee;font:14px sans-serif';
status_.style.cssText = 'display:inline-block;padding:6px 12px';
screen_.style.cssText = 'display:block;max-width:100vw;max-height:calc(100vh - 40px);cursor:default';
ime.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0;padding:0';
let ended = false;
let queue = Promise.resolve();
const send = (event) => {
  if (ended) return;
  queue = queue.then(() => fetch(base + '/input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })).catch(() => {});
};
const finish = (text) => {
  ended = true;
  status_.textContent = text;
  done.disabled = true;
  source.close();
};
const source = new EventSource(base + '/frames');
source.addEventListener('frame', (message) => {
  const { data } = JSON.parse(message.data);
  screen_.src = 'data:image/jpeg;base64,' + data;
  status_.textContent = 'Connected';
});
source.addEventListener('ended', (message) => {
  finish('This handoff has ended (' + JSON.parse(message.data).reason + ').');
});
source.onerror = () => { if (!ended) status_.textContent = 'Reconnecting'; };
done.addEventListener('click', () => {
  void fetch(base + '/done', { method: 'POST' }).finally(() => finish('Finished. You can close this page.'));
});
const modifiers = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const position = (e) => {
  const r = screen_.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
};
const BUTTONS = ['left', 'middle', 'right'];
let moving;
screen_.addEventListener('mousemove', (e) => {
  const pending = !moving;
  moving = { kind: 'mouse', action: 'move', ...position(e), buttons: e.buttons, modifiers: modifiers(e),
    button: e.buttons & 1 ? 'left' : e.buttons & 4 ? 'middle' : e.buttons & 2 ? 'right' : 'none' };
  if (pending) requestAnimationFrame(() => { send(moving); moving = undefined; });
});
for (const [type, action] of [['mousedown', 'down'], ['mouseup', 'up']])
  screen_.addEventListener(type, (e) => {
    e.preventDefault();
    ime.focus();
    send({ kind: 'mouse', action, ...position(e), button: BUTTONS[e.button] ?? 'none', buttons: e.buttons, clickCount: e.detail > 0 ? Math.min(3, e.detail) : 1, modifiers: modifiers(e) });
  });
screen_.addEventListener('contextmenu', (e) => e.preventDefault());
screen_.addEventListener('wheel', (e) => {
  e.preventDefault();
  send({ kind: 'wheel', ...position(e), deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiers(e) });
}, { passive: false });
const key = (action) => (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  send({ kind: 'key', action, key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiers(e),
    ...(action === 'down' && e.key.length === 1 && !e.ctrlKey && !e.metaKey ? { text: e.key } : {}) });
};
ime.addEventListener('keydown', key('down'));
ime.addEventListener('keyup', key('up'));
ime.addEventListener('compositionend', (e) => {
  if (e.data) send({ kind: 'text', text: e.data });
  ime.value = '';
});
ime.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData.getData('text');
  if (text) send({ kind: 'text', text: text.slice(0, 65536) });
});
ime.focus();
`;
