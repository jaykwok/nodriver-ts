import { randomUUID } from 'node:crypto';
import { EventHub } from '../utils.ts';
import { BrowserMcpSession, type BrowserMcpOptions } from './session.ts';
import { BrowserPool } from './pool.ts';

export interface BrowserSessionManagerOptions extends BrowserMcpOptions {
  maxLeases?: number;
  maxBrowsers?: number;
  contextsPerBrowser?: number;
  queueLimit?: number;
  operationTimeout?: number;
  leaseIdleMs?: number;
  browserIdleMs?: number;
  sweepIntervalMs?: number;
}
export interface BrowserLease {
  id: string;
  /** Client-chosen name for leases created through resolve(). */
  name?: string;
  principal: string;
  createdAt: number;
  lastUsed: number;
  active: number;
}
interface RecordLease extends BrowserLease {
  session: BrowserMcpSession;
  closing?: Promise<void>;
}
const LEASE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class LeaseError extends Error {
  override name = 'LeaseError';
  readonly code: 'invalid' | 'capacity' | 'unknown';
  constructor(code: 'invalid' | 'capacity' | 'unknown', message: string) {
    super(message);
    this.code = code;
  }
}
function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${label}`);
  return value;
}
/** Application lifetime state. Principal IDs must come from a trusted authenticator. */
export class BrowserSessionManager {
  private leases = new Map<string, RecordLease>();
  /** principal + "\n" + lease name -> lease id. */
  private names = new Map<string, string>();
  private pool: BrowserPool;
  private stopping = false;
  private closing?: Promise<void>;
  private timer: ReturnType<typeof setInterval>;
  readonly retired = new EventHub<string>();
  readonly limits;
  readonly options: BrowserSessionManagerOptions;
  constructor(options: BrowserSessionManagerOptions = {}) {
    this.options = options;
    if (options.launch && options.connect) throw new TypeError('Choose launch or connect');
    this.limits = {
      maxLeases: positive(options.maxLeases ?? 16, 'maxLeases'),
      queueLimit: positive(options.queueLimit ?? 32, 'queueLimit'),
      operationTimeout: positive(options.operationTimeout ?? 30000, 'operationTimeout'),
      leaseIdleMs: positive(options.leaseIdleMs ?? 1_800_000, 'leaseIdleMs'),
      browserIdleMs: positive(options.browserIdleMs ?? 30000, 'browserIdleMs'),
    };
    this.pool = new BrowserPool(
      options,
      positive(options.maxBrowsers ?? 2, 'maxBrowsers'),
      positive(options.contextsPerBrowser ?? 4, 'contextsPerBrowser'),
      this.limits.queueLimit,
    );
    this.timer = setInterval(
      () => {
        void this.sweep().catch(() => {});
      },
      positive(options.sweepIntervalMs ?? 1000, 'sweepIntervalMs'),
    );
    this.timer.unref();
  }
  create(principal: string, name?: string): BrowserLease {
    if (!principal || principal.length > 200)
      throw new TypeError('Invalid authenticated principal');
    if (this.stopping) throw new Error('Session manager stopping');
    if (this.leases.size >= this.limits.maxLeases)
      throw new LeaseError('capacity', 'Lease capacity reached');
    const id = randomUUID(),
      now = Date.now();
    const session = new BrowserMcpSession({
      ...this.options,
      acquire: (signal) => this.pool.acquire(signal),
      queueLimit: this.limits.queueLimit,
      operationTimeout: this.limits.operationTimeout,
    });
    const lease: RecordLease = {
      id,
      name,
      principal,
      createdAt: now,
      lastUsed: now,
      active: 0,
      session,
    };
    this.leases.set(id, lease);
    return this.view(lease);
  }
  /**
   * Resolves a lease ID, or a client-chosen lease name scoped to the principal. Names are
   * created on first use and recreated after their lease expires; IDs are never created.
   */
  resolve(principal: string, idOrName: string, create = true): BrowserLease {
    if (LEASE_ID.test(idOrName)) {
      try {
        return this.view(this.checked(principal, idOrName));
      } catch {
        throw new LeaseError('unknown', 'Unknown, unauthorized or expired browser lease');
      }
    }
    if (!LEASE_NAME.test(idOrName)) throw new LeaseError('invalid', 'Invalid lease name');
    const key = `${principal}\n${idOrName}`;
    const existing = this.names.get(key);
    if (existing)
      try {
        return this.view(this.checked(principal, existing));
      } catch {
        this.names.delete(key);
      }
    if (!create) throw new LeaseError('unknown', 'Unknown, unauthorized or expired browser lease');
    const lease = this.create(principal, idOrName);
    this.names.set(key, lease.id);
    return lease;
  }
  private view({ id, name, principal, createdAt, lastUsed, active }: BrowserLease): BrowserLease {
    return { id, ...(name ? { name } : {}), principal, createdAt, lastUsed, active };
  }
  private checked(principal: string, id: string): RecordLease {
    const lease = this.leases.get(id);
    if (
      !lease ||
      lease.principal !== principal ||
      lease.closing ||
      this.stopping ||
      (!lease.active && Date.now() - lease.lastUsed >= this.limits.leaseIdleMs)
    )
      throw new Error('Unknown, unauthorized or expired browser lease');
    return lease;
  }
  session(principal: string, id: string): BrowserMcpSession {
    return this.checked(principal, id).session;
  }
  retain(principal: string, id: string): () => void {
    const lease = this.checked(principal, id);
    lease.active++;
    lease.lastUsed = Date.now();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        lease.active--;
        lease.lastUsed = Date.now();
      }
    };
  }
  async run<T>(principal: string, id: string, task: () => Promise<T>): Promise<T> {
    const release = this.retain(principal, id);
    try {
      return await task();
    } finally {
      release();
    }
  }
  list(principal: string) {
    return [...this.leases.values()]
      .filter((l) => l.principal === principal && !l.closing)
      .map((l) => ({ ...this.view(l), status: l.session.status() }));
  }
  private retire(lease: RecordLease): Promise<void> {
    return (lease.closing ??= (async () => {
      this.retired.emit(lease.id);
      const key = `${lease.principal}\n${lease.name}`;
      if (lease.name && this.names.get(key) === lease.id) this.names.delete(key);
      try {
        await lease.session.dispose();
      } finally {
        this.leases.delete(lease.id);
      }
    })());
  }
  release(principal: string, id: string): Promise<void> {
    return this.retire(this.checked(principal, id));
  }
  async sweep(): Promise<void> {
    for (const lease of this.leases.values())
      if (!lease.active && Date.now() - lease.lastUsed >= this.limits.leaseIdleMs)
        await this.retire(lease);
    await this.pool.reap(this.limits.browserIdleMs);
  }
  stats() {
    return { leases: this.leases.size, ...this.pool.stats() };
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.stopping = true;
      clearInterval(this.timer);
      await Promise.all([...this.leases.values()].map((l) => this.retire(l)));
      await this.pool.close();
      this.retired.clear();
    })());
  }
}
