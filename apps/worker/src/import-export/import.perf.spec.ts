import { newId } from '@crm/core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { csv, startImportHarness, type WorkerHarness } from '../testing/import-harness.js';

/**
 * MVP_SPEC §M8 acceptance: "Importing 50,000 contacts completes without
 * blocking the UI and reports created/updated/skipped/failed counts."
 *
 * Both halves are tested, not asserted in prose:
 *
 *   - **Without blocking the UI.** Nothing in the request path parses a file or
 *     writes a record: the API only records the job and signs a URL. Here, the
 *     work is done by the worker alone, driven through the real relay, and the
 *     time the *request side* spends (create the job, mark it analyzing, start
 *     it) is measured separately and is milliseconds. `imports.security.spec.ts`
 *     in the API shows `start` returns `staging`, not `completed`.
 *   - **Reports the counts.** 50,000 real rows through every stage — analysis,
 *     staging, one hundred 500-row chunks, finish — including rows that fail,
 *     rows that duplicate each other, and the error file.
 *
 * It also checks the property that makes 50,000 safe rather than merely fast:
 * the counts add up exactly (`created + updated + skipped + failed =
 * processed`), which the database itself enforces with a CHECK constraint.
 */
let h: WorkerHarness;
let owner: string;

beforeAll(async () => {
  h = await startImportHarness(inject('dbUrls'), { name: 'Import Perf' });
  owner = await h.user('Owner');
});

afterAll(async () => {
  await h.close();
});

const ROWS = Number(process.env['PERF_ROWS'] ?? 50_000);

describe('importing 50,000 contacts (MVP_SPEC §M8)', () => {
  it('completes in the background and reports exact counts', async () => {
    const tag = newId().replaceAll('-', '').slice(-8);

    // 50,000 rows with a known mix: 49,000 clean, 500 invalid emails, 500 rows
    // that repeat an earlier email (skipped as duplicates).
    const rows: (string | number)[][] = [['First', 'Last', 'Email', 'Phone', 'Title']];
    for (let i = 0; i < ROWS; i += 1) {
      let email = `p${i}-${tag}@perf.example`;
      if (i % 100 === 7) email = `not-an-email-${i}`;
      else if (i % 100 === 8 && i > 100) email = `p8-${tag}@perf.example`; // a repeat of row 8
      rows.push([`First${i}`, `Last${i}`, email, `+9198${String(10_000_000 + i)}`, 'Engineer']);
    }
    const bytes = csv(rows);
    expect(bytes.length).toBeGreaterThan(ROWS * 40);

    // The request side: what the API does while the user waits.
    const requestStarted = Date.now();
    const jobId = await h.upload({ userId: owner, bytes });
    await h.confirmUpload(jobId);
    const requestSideMs = Date.now() - requestStarted;

    // The background: everything else.
    const workStarted = Date.now();
    await h.drain();
    const analyzed = await h.job(jobId);
    expect(analyzed.status, analyzed.failureReason ?? '').toBe('awaiting_mapping');
    expect(analyzed.totalRows).toBe(ROWS);

    await h.start(jobId, {
      mapping: [
        { column: 0, field: 'first_name' },
        { column: 1, field: 'last_name' },
        { column: 2, field: 'email' },
        { column: 3, field: 'phone' },
        { column: 4, field: 'title' },
      ],
      duplicateMode: 'skip',
      matchField: 'email',
    });

    // Tick the relay until the *job* is done, and no further. The import's own
    // events (stage, then one chunk event per 500 rows) sort ahead of the
    // side-effect events its records generate (`publishEvent` backdates them),
    // so this measures the import, not the 50,000 search-index and timeline
    // events it leaves behind for the relay to work through afterwards.
    let ticks = 0;
    for (;;) {
      await h.relay.tick();
      ticks += 1;
      const status = (await h.job(jobId)).status;
      if (status === 'completed' || status === 'failed' || status === 'rejected') break;
      if (ticks > 2_000) throw new Error('The import did not finish');
    }
    const workMs = Date.now() - workStarted;

    const job = await h.job(jobId);
    expect(job.status, job.failureReason ?? '').toBe('completed');
    expect(job.totalRows).toBe(ROWS);
    expect(job.processedRows).toBe(ROWS);

    // Exact, and derivable from how the file was built.
    const invalid = ROWS / 100; // i % 100 === 7
    const duplicates = ROWS / 100 - 1; // i % 100 === 8, except the first block
    expect(job.failedCount).toBe(invalid);
    expect(job.skippedCount).toBe(duplicates);
    expect(job.updatedCount).toBe(0);
    expect(job.createdCount).toBe(ROWS - invalid - duplicates);
    expect(job.createdCount + job.updatedCount + job.skippedCount + job.failedCount).toBe(ROWS);

    // The records are really there, owned by the importer, once each.
    const created = await h.pool.query(
      `select count(*)::int as n, count(distinct email)::int as distinct_emails,
              count(*) filter (where owner_id = $2)::int as owned
       from contacts where tenant_id = $1 and email::text like $3`,
      [h.tenantId, owner, `%-${tag}@perf.example`],
    );
    expect(created.rows[0]).toEqual({
      n: job.createdCount,
      distinct_emails: job.createdCount,
      owned: job.createdCount,
    });

    // The error file names the rows, as the user sees them, and says why.
    expect(job.errorFileKey).toBeTruthy();
    const errorLines = h
      .readText(job.errorFileKey as string)
      .trim()
      .split('\r\n');
    expect(errorLines).toHaveLength(invalid + 1);
    expect(errorLines[0]).toBe('Row,Field,Error,First,Last,Email,Phone,Title');
    expect(errorLines[1]).toMatch(/^9,email,Email: /); // i=7 is spreadsheet row 9

    // The side effects are queued for every record, not skipped: one audit entry
    // and one outbox event each. (They are *queued*: working through them is the
    // relay's separate, later business, which is the point of the outbox.)
    const audits = await h.pool.query(
      `select count(*)::int as n from audit_logs
       where tenant_id = $1 and action = 'create' and object_type = 'contact'
         and changes->'importJobId'->>'new' = $2`,
      [h.tenantId, jobId],
    );
    expect(audits.rows[0]?.['n']).toBe(job.createdCount);

    // Every created record has its event, in whatever state the relay has got it
    // to by now (it works through them while the import runs, a tick at a time).
    const events = await h.pool.query(
      `select count(*)::int as n from outbox_events
       where tenant_id = $1 and event_type = 'contact.created.v1'
         and record_id in (select id from contacts where tenant_id = $1 and email::text like $2)`,
      [h.tenantId, `%-${tag}@perf.example`],
    );
    expect(events.rows[0]?.['n']).toBe(job.createdCount);

    // Nothing of the file is kept.
    const staged = await h.pool.query(
      'select count(*)::int as n from import_rows where job_id = $1',
      [jobId],
    );
    expect(staged.rows[0]?.['n']).toBe(0);

    // Report, so a regression in throughput is visible in the log before it is
    // a failed budget.
    console.info(
      `[import perf] ${ROWS} rows: request side ${requestSideMs} ms, worker ${(workMs / 1000).toFixed(1)} s ` +
        `(${Math.round(ROWS / (workMs / 1000))} rows/s); created ${job.createdCount}, ` +
        `skipped ${job.skippedCount}, failed ${job.failedCount}`,
    );

    // Housekeeping for the tests that share this database: the relay claims
    // across tenants, so 49,000 undelivered events would be the next test's
    // problem. (Delivering them is a throughput question for the relay, not an
    // import one; see ADR-0029.)
    await h.pool.query(`delete from outbox_events where tenant_id = $1 and status = 'pending'`, [
      h.tenantId,
    ]);

    // The request path does no real work: it must not scale with the file.
    expect(requestSideMs).toBeLessThan(1_000);
    // And the whole import finishes in a reasonable time on a CI-class machine.
    expect(workMs).toBeLessThan(240_000);
  }, 600_000);
});
