/**
 * What every rate limit counts with (CLAUDE.md §5.14, ADR-0050).
 *
 * The tenant limit, the user limit and the two address limits all spend from one counter, so that
 * where the counts live (this process, or Redis shared by every API instance) is decided in one
 * place, and a limit cannot quietly be left per process.
 *
 * The window is fixed: the first hit starts it, it ends when the time is up, and the count starts
 * again at one. That is what the in-process counter always did, and it is cheap to share.
 */

/** One counter to spend from: a key and how long its window lasts. */
export interface RateLimitEntry {
  readonly key: string;
  readonly windowSeconds: number;
}

export interface RateLimitHit {
  /** How many times this key has been hit in the current window, this hit included. */
  readonly count: number;
  /** Whole seconds until the window ends and the count starts again; at least 1. */
  readonly retryAfterSeconds: number;
}

export interface RateLimitCounter {
  /**
   * Spend one from each entry and answer in the same order.
   *
   * Several at once, because a request is counted against its user and its tenant together and a
   * shared store should be asked once, not twice.
   */
  hitMany(entries: readonly RateLimitEntry[]): Promise<readonly RateLimitHit[]>;
}

/** What `RateLimitCounter` is provided as. */
export const RATE_LIMIT_COUNTER = 'RATE_LIMIT_COUNTER';

export type RateLimitKind = 'user' | 'tenant' | 'ip' | 'auth-ip';

/** The key for one subject. Only ids and addresses go in: nothing a person typed. */
export function rateLimitKey(kind: RateLimitKind, subject: string): string {
  return `${kind}:${subject}`;
}

export async function hitOnce(
  counter: RateLimitCounter,
  key: string,
  windowSeconds: number,
): Promise<RateLimitHit> {
  const [hit] = await counter.hitMany([{ key, windowSeconds }]);
  if (hit === undefined) throw new Error('A rate limit counter answered nothing');
  return hit;
}
