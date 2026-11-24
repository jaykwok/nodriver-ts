import { createHash, timingSafeEqual } from 'node:crypto';
import type { LaunchOptions } from '../browser/launcher.ts';
import { MAX_TIMEOUT, positiveInt } from '../utils.ts';

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const STATE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
export const LEASE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CredentialEntry = readonly [digest: Buffer, principal: string];

/** Fixed-length SHA-256 digest of a secret so constant-time comparison never leaks token length. */
export function digestSecret(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time comparison against a precomputed SHA-256 digest. */
export function matchesDigest(
  expected: Buffer | undefined,
  value: string | undefined | null,
): boolean {
  if (!expected || !value) return false;
  return timingSafeEqual(expected, digestSecret(value));
}

/** Validates local bearer token -> principal mappings and precomputes fixed-length digests. */
export function validateCredentials(tokens: Record<string, string>): readonly CredentialEntry[] {
  const credentials = Object.entries(tokens).map(([token, principal]) => {
    if (token.length < 32 || !principal || principal.length > 200)
      throw new TypeError('Provision tokens of at least 32 characters and a principal');
    return [digestSecret(token), principal] as const;
  });
  if (!credentials.length) throw new TypeError('At least one local bearer credential is required');
  return credentials;
}

/** Full-scan constant-time credential match that leaks neither token length nor credential index. */
export function matchCredential(
  credentials: readonly CredentialEntry[],
  token: string | undefined | null,
): string | undefined {
  const candidate = digestSecret(token ?? '');
  let matched: string | undefined;
  for (const [expected, principal] of credentials)
    if (timingSafeEqual(expected, candidate)) matched = principal;
  return token ? matched : undefined;
}

/** Whether the request media type is `application/json`, ignoring case and parameters. */
export function isJsonContentType(request: Request): boolean {
  return (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json'
  );
}

/** Uniform JSON error response across MCP HTTP and handoff endpoints. */
export function jsonError(status: number, message: string, headers?: HeadersInit): Response {
  return Response.json({ error: message }, { status, ...(headers ? { headers } : {}) });
}

/** Validates a positive integer millisecond duration bounded by `MAX_TIMEOUT`. */
export function positiveMs(value: number, label: string): number {
  const ms = positiveInt(value, label);
  if (ms > MAX_TIMEOUT) throw new RangeError(`${label} must not exceed ${MAX_TIMEOUT} ms`);
  return ms;
}

/** Unified default browser launch options shared by MCP CLI, pool, and standalone sessions. */
export function defaultMcpLaunchOptions(launch?: LaunchOptions): LaunchOptions {
  return { transport: 'pipe', preset: 'agent', ...launch };
}
