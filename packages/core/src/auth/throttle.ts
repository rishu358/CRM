/**
 * Brute-force back-off (MVP_SPEC M1 acceptance).
 *
 * > Given 5 failed logins in 10 min, further attempts are delayed and an
 * > `auth_events` row is written.
 *
 * Pure arithmetic, kept here so the curve can be reasoned about and tested
 * without a database, a clock or a network.
 *
 * ## Why delay rather than lock out
 *
 * A hard lockout on a known address is a denial-of-service someone else can
 * trigger on your behalf: anyone who knows your email can lock you out of your
 * own CRM by failing five times. A delay costs an attacker almost everything —
 * an online guessing run slows to a crawl — and costs a real person who
 * mistyped their password a couple of seconds.
 *
 * The delay is also applied to attempts that would have *succeeded*. If it
 * were skipped on success, the response time would say "that password was
 * right", which is the oracle the whole mechanism exists to deny.
 */
export const FAILURE_THRESHOLD = 5;
export const FAILURE_WINDOW_SECONDS = 10 * 60;

/**
 * How long to wait before answering, given recent consecutive failures.
 *
 * Doubles per failure past the threshold and then flattens at the cap. The cap
 * matters: without it the delay reaches minutes, every one of which is a
 * request held open, which is its own denial of service against us.
 */
export function throttleDelayMs(recentFailures: number, maxDelayMs = 8000): number {
  if (recentFailures < FAILURE_THRESHOLD) return 0;
  const steps = recentFailures - FAILURE_THRESHOLD;
  const delay = 500 * 2 ** Math.min(steps, 20);
  return Math.min(delay, maxDelayMs);
}

/** Whether this attempt counts as throttled, for the `auth_events` row. */
export function isThrottled(recentFailures: number): boolean {
  return recentFailures >= FAILURE_THRESHOLD;
}
