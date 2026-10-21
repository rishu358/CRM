import type { OutboxRelay } from '../relay.js';

/**
 * Run the relay until nothing is left that is about to be due.
 *
 * `tick()` returning zero used to end a drain, which assumed "nothing claimed"
 * meant "nothing to do". It does not: the relay claims
 * `available_at <= now()`, and both sides of that are the database's `now()` —
 * but taken in *different transactions*. If the database clock steps backwards
 * between the transaction that wrote an event and the one that claims it, the
 * event is briefly in the claimer's future, `tick()` finds nothing, and a drain
 * that stops there returns with the job still queued. The Docker VM these suites
 * run on steps its clock back by up to a second or so about every thirty
 * seconds (ADR-0036), which is what made `export.security.spec.ts` fail once in
 * a while with `expected 'queued' to be 'completed'`.
 *
 * In production this costs nothing worth noticing — the relay polls
 * continuously and picks the event up on the next pass. It only matters to a
 * test that asks "is it finished?" immediately after one empty pass.
 *
 * So an empty pass is followed by a question for the database: is anything
 * pending **and due within the next few seconds**? If so, wait and look again.
 * The window is deliberately short. A sweep that re-arms itself for tomorrow is
 * always pending, so "anything pending" would never let a drain end; only events
 * that are about to be claimable count.
 */
export interface PendingProbe {
  query(text: string): Promise<{ rows: unknown[] }>;
}

export interface DrainOptions {
  /** Most passes that may claim something. */
  readonly limit: number;
  /** Most times to wait for an event that is almost due. */
  readonly maxWaits?: number;
  /** How far ahead counts as "almost due". */
  readonly dueWithinSeconds?: number;
  /** Pause between a quiet pass and the next look. */
  readonly waitMs?: number;
}

export async function drainRelay(
  relay: OutboxRelay,
  pool: PendingProbe,
  options: DrainOptions,
): Promise<number> {
  const maxWaits = options.maxWaits ?? 20;
  const dueWithin = options.dueWithinSeconds ?? 3;
  const waitMs = options.waitMs ?? 250;

  let total = 0;
  let waits = 0;

  for (let pass = 0; pass < options.limit; pass += 1) {
    const processed = await relay.tick();
    if (processed > 0) {
      total += processed;
      continue;
    }

    const due = await pool.query(
      `select 1 from outbox_events
       where status = 'pending'
         and available_at <= clock_timestamp() + make_interval(secs => ${Number(dueWithin)})
       limit 1`,
    );
    if (due.rows.length === 0 || waits >= maxWaits) break;

    waits += 1;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  return total;
}
