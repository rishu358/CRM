import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context (CLAUDE.md §8).
 *
 * Every log line carries requestId, tenantId and userId, and `X-Request-Id`
 * goes back on every response, so a user's report can be traced to exact log
 * lines without anyone guessing.
 *
 * Held in AsyncLocalStorage rather than passed through every signature. It is
 * **read-only context for observability**: authorization never reads the tenant
 * from here. Tenant scoping comes from the Actor the guard resolved and from
 * `withTenant`, so an empty context can never widen access — it only makes logs
 * less useful.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly tenantId: string | null;
  readonly userId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /**
   * Set when this request was answered from a remembered `Idempotency-Key` (ADR-0060), so the response
   * can say `Idempotent-Replayed: true`. A holder, not a flag: the context is copied when the identity
   * is attached, and the copies must share the one the response hook reads.
   */
  readonly replay: { replayed: boolean };
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, work: () => T): T {
  return storage.run(context, work);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Run `work` with the caller's network identity removed from the context: no address and no user agent
 * reach the audit entry or anything else that reads it.
 *
 * For the public lead-form routes, which store neither on purpose (ADR-0065 6): the address lives only in
 * the rate-limit counters, for the length of their window. The idempotency holder is shared, not copied.
 */
export function withoutNetworkIdentity<T>(work: () => T): T {
  const current = storage.getStore();
  if (current === undefined) return work();
  return storage.run({ ...current, ipAddress: null, userAgent: null }, work);
}

/** Note that this request is a replay of an earlier one with the same Idempotency-Key. */
export function markIdempotentReplay(): void {
  const context = storage.getStore();
  if (context !== undefined) context.replay.replayed = true;
}

export function wasIdempotentReplay(): boolean {
  return storage.getStore()?.replay.replayed === true;
}

export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? 'no-request-id';
}

/**
 * Attach the authenticated identity once the guard has resolved it.
 *
 * Replaces the store's contents in place so that log lines emitted later in the
 * same request carry the identity. Returns a new object rather than mutating a
 * frozen one.
 */
export function withIdentity(
  context: RequestContext,
  identity: { tenantId: string | null; userId: string | null },
): RequestContext {
  return { ...context, ...identity };
}
