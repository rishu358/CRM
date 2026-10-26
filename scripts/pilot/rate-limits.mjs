#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJson } from './lib/findings.mjs';
import { parseArgs } from './lib/args.mjs';
import { rateLimitProbe } from './lib/ratelimit.mjs';

/**
 * node scripts/pilot/rate-limits.mjs --api-url http://localhost:3012
 *
 * Point it at a second API instance started WITHOUT the raised limits (its own Redis database number, so it
 * does not share counters with the main one). It signs in as a sales rep from the seeded state and keeps
 * asking for My Day until the answer is 429, then does the same with sign-ins.
 */
const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2), {
  state: resolve(here, '../../.pilot/state.json'),
  out: resolve(here, '../../.pilot/rate-limits.json'),
  business: 'repairs',
});
if (!args['api-url']) {
  console.error(
    'Usage: node scripts/pilot/rate-limits.mjs --api-url <default-limits API address> [--business repairs]',
  );
  process.exit(2);
}
const state = JSON.parse(readFileSync(args.state, 'utf8'));
const member = state.businesses[args.business].staff.rep1;
const result = await rateLimitProbe(args['api-url'], member);
writeJson(args.out, result);
console.log(JSON.stringify(result, null, 2));
