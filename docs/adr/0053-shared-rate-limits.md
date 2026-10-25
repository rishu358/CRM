# ADR-0053: Rate limits are counted in Redis, once, for every API instance

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

CLAUDE.md §5.14 says: rate limit per tenant **and** per user, not just per IP. Three limiters existed, all
counting in the memory of one process, and each said so in a comment ("must move to Redis before the API is
scaled horizontally"). Hardening B listed it as a known gap. Reading the code to plan the move found two
defects that were not about Redis at all.

1. **The "per-user" limit was a per-address limit.** The general limiter was `@fastify/rate-limit`, registered
   in `bootstrap.ts` with a key generator that used `request.actor`. The plugin runs in `onRequest`; the
   `AuthGuard` sets `request.actor` much later, inside the route. So at the time the key was computed there
   was never an actor, and the key was always `ip:<address>`. An office of twenty people behind one NAT address
   shared one budget of 300 a minute; one person on two addresses had two. Only the per-tenant limit, which the
   guard checked itself, was what it claimed to be.
2. **A refused request was a 500.** The plugin rejected by throwing its own error object from a hook, which our
   exception filter did not know, so it became `500 INTERNAL "Something went wrong"` and a stack trace in the log.
   A client hitting the limit was told the server had failed, and had no `Retry-After`.

Both are asserted by `apps/api/src/platform/rate-limit.security.spec.ts`, which was written first and failed on
the code as it stood.

## Decision

### 1. One counter interface, and every limit spends from it

`RateLimitCounter.hitMany(entries)` takes keys and windows and answers a count and a `retryAfterSeconds` for
each, in order. The per-user, per-tenant, per-address and sign-in-address limits all use it, so where counts
live is decided in one place (`RATE_LIMIT_COUNTER`, provided by `PlatformModule`), and a limit cannot quietly be
left per process. The window is fixed (first hit starts it, it ends on time, the count starts again), which is
what the in-process counter always did and is the cheapest thing to share.

### 2. Redis, with an atomic script and one round trip

`RedisCounter` runs one script per key: `INCR`, then `PEXPIRE` on the first hit, and also when the key has no
expiry (`PTTL < 0`), so a crash between two commands cannot leave a key that never expires, which would be a
permanent lockout. A request is counted against its user and its tenant in a single pipeline, so sharing costs
one round trip, not two. Each key is its own script call, so it works on a clustered Redis too. Keys are
`crm:rl:v1:<kind>:<id>`: versioned, namespaced, and containing only ids and addresses, never anything a person
typed. Client: **`ioredis` 5.x** (approved; BullMQ, which CLAUDE.md §2 names for jobs, uses it, so there will be
one Redis client in the repository). It is configured so the limiter is never what makes a request wait: no
offline queue, one attempt, a 150 ms command timeout, background reconnection.

### 3. When Redis is down, limits become per process; they never disappear and never refuse

Three behaviours were possible. Refusing every request makes a Redis blip an outage, sign-in included. Letting
every request through removes the limit at the moment something may be wrong. Keeping limiting with what this
process knows is the only one that is neither. `FallbackCounter` does that: on a failure it answers from an
`InMemoryCounter`, does not ask Redis again for a second (a down Redis costs one slow request, not one per
request), logs one warning per 30 s with the error's name and code but never its message (a connection error can
carry a URL and a password), and logs once when Redis answers again. The cost is stated: during an outage each
instance allows its own limit, so N instances allow up to N times. The two-instance test takes Redis away and
brings it back and asserts exactly this.

### 4. The user limit moves into the guard; the general limiter becomes an address ceiling

`AuthGuard` now spends the user and tenant limits together, after the actor is resolved, from the session and the
membership that were proved, not from a header. The plugin is removed (and `@fastify/rate-limit` with it). What
remains of the general limiter is an `onRequest` hook, `AddressRateLimitService`, keyed on the address: the only
limit that can apply to a request with no valid session, which is also what a flood of made-up tokens looks like
(each costs a session lookup). It is sized for an office: **`RATE_LIMIT_MAX_PER_IP`, default 1,000 a minute**,
against 300 for a user. It skips `/api/v1/health`, which a load balancer polls and which must keep answering
whoever is asking.

**A behaviour change:** a person now has their own 300 a minute whatever address they come from, and an address
has 1,000. Before, an office shared 300 and a person on two addresses had 600. Anything that sends more than 1,000
requests a minute from one address (a load generator, a scripted integration) must raise the setting; CI, the
E2E rig and the perf rig already do.

### 5. A refusal is a 429 with `Retry-After`

`RateLimitedError` carries `retryAfterSeconds`; the exception filter sends it as `Retry-After`, and in no other
place. The body names whose budget it is ("this workspace", "you", "this address") and not the ceiling or what is
left, and no `X-RateLimit-*` header is sent: a limit's size tells an attacker how to pace themselves
(`auth-rate-limit.guard.ts` already said so for the sign-in routes). The plugin sent those headers on every
response; they are gone.

### 6. Production refuses to start without Redis, unless told it is one instance

Without Redis, N instances allow N times the limit: harmless for one, a quiet failure for any other number, and
nothing in the process can know how many there are. So `assertProductionConfig` (ADR-0041 §8) now refuses an
unset `REDIS_URL` for the API (not the worker, which counts no requests), unless `RATE_LIMIT_ALLOW_PER_PROCESS=true`
says exactly one API instance runs, in which case it starts and warns on every boot. A set `REDIS_URL` must be
`redis://` or `rediss://`, have a password, and not point at this machine; an unencrypted `redis://` to another
host is a warning. This was a warning in ADR-0041 §8; it was changed because a warning is how this gap survived.

## Consequences

- **One more request-path dependency, softened.** Every request now makes one Redis call in `onRequest` (the
  address) and, if authenticated, one in the guard (user and tenant together). Measured: about 2 to 3 ms per request, and a
  likely loss of some of the ceiling near 40 req/s that this machine could not resolve (`docs/PERF.md` §8). A Redis outage degrades limits; it does not degrade availability.
- **The limits are fixed windows**, so a caller can send up to twice the limit across a window boundary. That is
  how they behaved before. A sliding window or token bucket is a change to the Lua script, not to the callers.
- **Eviction resets a limit.** Counters live in Redis as ordinary keys with an expiry; an instance that evicts
  (`allkeys-*`) can silently reset them. RUNBOOK says to use `noeviction` or a `volatile-*` policy.
- **Keys are readable in Redis**: user and tenant ids and client addresses, for the length of a window. They are
  personal data in the GDPR sense for the address; the expiry is the retention.
- **Not covered:** the sign-in back-off (`AuthThrottleService`) already counts `auth_events` rows in Postgres and is
  shared; it is unchanged. The worker has no rate limit.

## Alternatives considered

- **`@fastify/rate-limit` with its Redis store.** The smallest change, and it would have kept both defects: it
  runs before authentication, so the per-user limit would have stayed per address, and a Redis error either fails
  the request or (`skipOnError`) removes the limit. It also sends the headers we decided against.
- **A custom store for the plugin.** Keeps the plugin and its hook ordering problem, to preserve features
  (allow lists, bans, per-route options) nothing here uses.
- **Fail closed when Redis is down.** Safest for the limit, worst for availability, and sign-in goes with it.
- **Fail open when Redis is down.** Simplest; the limit vanishes when it may matter most.
- **A sliding-window or token-bucket algorithm.** Smoother, and not what any limit here promised; deferred.
- **Counting in Postgres.** Already shared, and the wrong thing to write on every request.
- **Warn, not refuse, without `REDIS_URL`.** Rejected: it is the status quo that left the gap open.
