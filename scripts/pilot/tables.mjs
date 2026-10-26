#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';

/**
 * node scripts/pilot/tables.mjs [--in .pilot/run-results.json]
 *
 * Prints the numbers of a finished run as Markdown tables, so the report is copied from the data rather than
 * retyped. Writes to standard output only.
 */
const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2), {
  in: resolve(here, '../../.pilot/run-results.json'),
});
const run = JSON.parse(readFileSync(args.in, 'utf8'));
const ms = (value) => (value === null || value === undefined ? '-' : String(Math.round(value)));
const table = (header, rows) =>
  [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');

console.log('### Overall\n');
console.log(
  table(
    ['Measure', 'Value'],
    [
      ['Simulated weeks', String(run.weeks)],
      ['Wall-clock time of the run', `${Math.round(run.seconds / 60)} min`],
      ['Requests to the API (all three businesses)', String(run.requests)],
      [
        'Median (p50) / p95 / p99 latency, ms',
        `${ms(run.overall.p50)} / ${ms(run.overall.p95)} / ${ms(run.overall.p99)}`,
      ],
      ['Requests slower than 1 s / 5 s', `${run.overall.over1s} / ${run.overall.over5s}`],
      ['Server errors (5xx or no answer)', String(run.serverErrors.length)],
      ['429 Too Many Requests (limits raised for this run)', String(run.rateLimited)],
    ],
  ),
);

console.log('\n### Errors by status and code\n');
console.log(
  table(
    ['Answer', 'Count'],
    Object.entries(run.errors).map(([name, count]) => [name, String(count)]),
  ),
);

console.log('\n### Latency by action (actions with 20 or more calls), milliseconds\n');
console.log(
  table(
    ['Action', 'Calls', 'p50', 'p95', 'p99', 'Slowest'],
    run.latency
      .filter((row) => row.count >= 20)
      .map((row) => [
        row.action,
        String(row.count),
        ms(row.p50),
        ms(row.p95),
        ms(row.p99),
        ms(row.max),
      ]),
  ),
);

console.log('\n### Records before and after six weeks (as the owner sees them)\n');
console.log(
  table(
    ['Business', 'Accounts', 'Contacts', 'Leads', 'Deals'],
    Object.entries(run.finalCounts).map(([name, value]) => [
      name,
      ...['account', 'contact', 'lead', 'deal'].map(
        (type) => `${value.before[type]} to ${value.after[type]}`,
      ),
    ]),
  ),
);

console.log('\n### Everyone at once (one request burst, all people of all three businesses)\n');
console.log(
  `${run.burst.users} people, ${run.burst.total} requests in ${run.burst.seconds.toFixed(1)} s.\n`,
);
console.log(
  table(
    ['Action', 'Calls', 'p50', 'p95', 'Slowest'],
    run.burst.summary.map((row) => [
      row.action,
      String(row.count),
      ms(row.p50),
      ms(row.p95),
      ms(row.max),
    ]),
  ),
);

console.log('\n### Search: time from saving a record until it can be found, ms\n');
console.log(
  table(
    ['Business', 'Three samples'],
    Object.entries(run.searchLag).map(([name, values]) => [
      name,
      values.map((value) => (value === null ? 'not found in 30 s' : value)).join(', '),
    ]),
  ),
);

console.log('\n### Slowest single requests (over 2 s)\n');
console.log(
  table(
    ['Action', 'ms', 'Status'],
    (run.slowRequests ?? [])
      .slice(0, 15)
      .map((row) => [row.action, String(row.ms), String(row.status)]),
  ),
);

console.log('\n### Checks that held (count of times each was made without a problem)\n');
console.log(
  table(
    ['Check', 'Times'],
    Object.entries(run.checksPassed ?? {}).map(([name, count]) => [name, String(count)]),
  ),
);

console.log('\n### What each person did (counts over six weeks)\n');
for (const [business, people] of Object.entries(run.actorCounts)) {
  console.log(`**${business}**\n`);
  const keys = [...new Set(Object.values(people).flatMap((counts) => Object.keys(counts)))].sort();
  console.log(
    table(
      ['Person', ...keys],
      Object.entries(people).map(([name, counts]) => [
        name,
        ...keys.map((key) => String(counts[key] ?? 0)),
      ]),
    ),
  );
  console.log('');
}
