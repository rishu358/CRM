import type pg from 'pg';

/**
 * Close a pool and wait for its connections to really be gone.
 *
 * `pool.end()` resolves as soon as every client has been *asked* to end, not
 * when it has: pg-pool removes each client from its list synchronously, calls
 * `client.end()` without awaiting it, and then — finding the list empty —
 * resolves the promise `end()` returned (`_pulseQueue` and `_remove` in
 * pg-pool). The backends are still alive for a moment after `await pool.end()`.
 *
 * On an idle machine that moment is too short to notice. Under load it is long
 * enough for whatever comes next — `drop database`, a container shutdown — to
 * terminate those backends, and the dying client then emits an `error` nobody
 * is listening for any more: `FATAL 57P01, terminating connection due to
 * administrator command`. Vitest reports that as an unhandled error and fails a
 * run in which every test passed, which is how this was found.
 *
 * `remove` is emitted from the callback of `client.end()`, so counting one per
 * client that existed when we asked is an exact wait and not a sleep.
 */
export async function closePool(pool: pg.Pool): Promise<void> {
  // Read before `end()`: both this and pg-pool's bookkeeping are synchronous,
  // so nothing can be added or removed in between.
  const outstanding = pool.totalCount;
  if (outstanding === 0) {
    await pool.end();
    return;
  }

  let seen = 0;
  let allClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    allClosed = resolve;
  });
  const onRemove = (): void => {
    seen += 1;
    if (seen >= outstanding) {
      pool.off('remove', onRemove);
      allClosed();
    }
  };
  pool.on('remove', onRemove);

  await pool.end();
  await closed;
}
