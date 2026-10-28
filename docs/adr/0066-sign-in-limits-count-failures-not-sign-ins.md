# ADR-0066: Sign-in limits count failures, not sign-ins

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Finding F8 of the pilot simulation (docs/PILOT_SIMULATION.md): the sign-in routes had one limit, 50 requests per
15 minutes per address (`AUTH_RATE_LIMIT_MAX_PER_IP`, ADR-0053), and it counted every request, successful ones
included. The 50th **successful** sign-in from one address got a 429 with `Retry-After: 449`. A school, an office
or one mobile-carrier address is exactly where fifty people sign in within a quarter of an hour, so the product
would have locked its own customers out on a Monday morning.

What the code did, read before changing it:

- `AuthRateLimitGuard` counts each request to a public auth route against `auth-ip:<address>`. It cannot know
  the outcome, because it runs before the handler.
- `AuthThrottleService` delays an attempt after five recent failures for the same email **or** address (counted
  from `auth_events`), by up to `AUTH_THROTTLE_MAX_DELAY_MS`. A delay, not a refusal, and it reads the count before
  the attempt is recorded, so a burst of parallel guesses all reads "no failures yet".
- The only hard bound on guessing was therefore the address ceiling of 50, which is also the thing that
  locked people out.

CLAUDE.md §5.9 and §5.14 want failed attempts limited hard, per account and per address. The second sentence of
the task was the constraint: a right password must not spend the budget meant for wrong ones, and neither limit
may become a cheap way to lock an office out.

## Decision

### 1. Three budgets, kept apart

| Budget                                              | Counts                                   | Keyed on                        | Default (15 min) |
| --------------------------------------------------- | ---------------------------------------- | ------------------------------- | ---------------- |
| Flood ceiling `AUTH_RATE_LIMIT_MAX_PER_IP`          | every request to a public auth route     | address                         | **600** (was 50) |
| Failures per account `AUTH_FAILURE_MAX_PER_ACCOUNT` | wrong password or wrong second-step code | SHA-256 of the lowercased email | 10               |
| Failures per address `AUTH_FAILURE_MAX_PER_IP`      | wrong password or code, across accounts  | address                         | 100              |

The flood ceiling exists to bound the work (each attempt costs a password hash). It is sized for an office, and
it no longer decides who may sign in. The two failure budgets are what limit guessing.

### 2. Spend before the password is checked, give it back when it was right

`AuthAttemptLimiter.reserve()` takes one slot from both failure budgets in one atomic step **before** the
account is looked up. A right password calls `release()`, which gives the slot back. A wrong one does nothing,
so the slot stays spent. Reserving first is what makes the limit exact under concurrency: fifty parallel guesses
at one account take fifty slots, and only the first ten proceed. A "read the count, then record the failure"
limit lets the whole burst through. `release()` is a new operation on the shared counter (`releaseMany`: memory,
Redis script, and the fallback); it never takes a count below zero and never moves the end of the window.
A failure to give a slot back is swallowed: bookkeeping must not fail a correct sign-in, and the slot simply
stays spent until the window ends.

The second step of a sign-in (`/auth/mfa/verify`) takes a slot the same way, so a wrong code is a failed attempt.
A right password that stops at "enter your code" is not a failure, and gives its slot back.

### 3. Per account, whatever the address

The account budget's key has no address in it, so rotating addresses, or the `X-Forwarded-For` value that carries
one, buys no extra guesses at one account. The email is hashed in the key (ADR-0053: a key never holds what a
person typed), after trimming and lowercasing so `A@x` and `a@x` are one account.

### 4. Nothing says whether an account exists

The slot is taken before the lookup and is kept on every failure, so a name with no account runs out after the
same number of tries, with the same status, message and `Retry-After` shape as one with an account. The refusal
is the generic "Too many attempts. Try again in a few minutes." for every budget; it does not say which one.
`Retry-After` is the longer of the budgets that are spent, so it is never too short, and never more than the window.
The progressive delay of `AuthThrottleService` is unchanged and still runs after the slot is taken, so a
refused request does not hold a connection for the delay.

## Honest limits

- **One account can be locked by someone who knows its email.** Ten wrong tries a window from anywhere make
  that account refuse everyone, a right password included (answering it would tell a guesser which try was
  right), until the window ends. This is the price of a hard per-account limit; it is bounded to that one
  account, costs the attacker ten failures of their own address's budget each window, and leaves password reset
  open. The earlier "delay, not lock out" reasoning (`throttle.ts`) still governs the first nine tries.
- **Someone behind the same address can spend that address's failures.** A hundred a window, so one mistyping
  colleague never does it, and a determined insider can. It needs a presence on the network, and the answer is
  the same generic 429.
- **The address budgets are only as good as the address.** The API runs Fastify with `trustProxy: true` and
  takes the address from `X-Forwarded-For` (ADR-0042 listed this). If the API port is reachable directly rather
  than only through the web server and the proxy (RUNBOOK §1 keeps it on the private network), a caller can
  rotate that header and dodge the **address** budgets and the flood ceiling. The **account** budget does not
  depend on it. Replacing `trustProxy: true` with an explicit list of proxies is the proper fix and is a
  deployment and security decision, not made here. The requirement is written down as an operator rule in
  DEPLOYMENT.md ("Network requirement") and RUNBOOK §1.
- Per-process counting during a Redis outage (ADR-0053 §3) applies to these budgets too: each instance allows
  its own.

## Consequences

- `AUTH_RATE_LIMIT_MAX_PER_IP` default 50 -> 600; two new settings (`AUTH_FAILURE_MAX_PER_ACCOUNT`,
  `AUTH_FAILURE_MAX_PER_IP`) in the registry and the generated docs. The test and E2E rigs already set the ceiling
  high; the new budgets are far above what they fail on purpose.
- The counter interface gained `releaseMany`. The Redis hit script now starts a window only when the key has no
  expiry (`PTTL < 0`) instead of also on `count == 1`, which is the same for a new key and lets a refunded key
  keep its window.
- Rows in `auth_events` (`login_failed`, `login_throttled`) are unchanged, so what an administrator reads is as before.
- Not covered: the same budgets for the other public routes (reset request, sign-up). They stay under the flood
  ceiling only, as before.
- A wrong second-step code now counts against the account budget as well as the delay it always had.
