/**
 * What every rate limit counts with (CLAUDE.md §5.14, ADR-0053).
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

  /**
   * Give back one hit on each key: the reverse of a `hitMany` that turned out not to count.
   *
   * For a limit that spends before it knows the outcome and refunds a good one, so an attempt that
   * succeeds does not use up the budget meant for failures (ADR-0064). Never takes a count below
   * zero, and never moves the window's end; a key with nothing to give back is left alone.
   */
  releaseMany(keys: readonly string[]): Promise<void>;
}

/** What `RateLimitCounter` is provided as. */
export const RATE_LIMIT_COUNTER = 'RATE_LIMIT_COUNTER';

/**
 * What a limit counts. The `public-*` kinds belong to the website lead form (ADR-0065) and are
 * deliberately not `user` or `tenant`: a flood on a public form must never spend the budget the
 * workspace's own staff use, and the staff must never starve the form.
 */
export type RateLimitKind =
  | 'user'
  | 'tenant'
  | 'ip'
  | 'auth-ip'
  | 'auth-ip-fail'
  | 'auth-account-fail'
  | 'public-form-address'
  | 'public-address'
  | 'public-form'
  | 'public-tenant'
  | 'public-bad-key'
  | 'public-view-form'
  | 'public-repeat'
  | 'public-unsubscribe';

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
