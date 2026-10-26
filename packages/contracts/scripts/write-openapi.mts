import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openApiJson } from '../src/openapi.js';

/**
 * Writes `docs/openapi.json`, or with `--check` fails when it is stale.
 *
 * The committed file is what makes an API change visible in review as a diff.
 * `packages/contracts/src/openapi.spec.ts` asserts the same thing, so the gate
 * holds even for somebody who runs only `pnpm test`; this script is here so
 * regenerating is one command rather than a hunt.
 */
const target = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url));
const generated = openApiJson();

if (process.argv.includes('--check')) {
  const existing = await readFile(target, 'utf8').catch(() => null);
  if (existing !== generated) {
    process.stderr.write(
      `docs/openapi.json is out of date.\nRun: pnpm openapi:generate\n`,
    );
    process.exit(1);
  }
  process.stdout.write('docs/openapi.json is up to date.\n');
} else {
  await writeFile(target, generated, 'utf8');
  process.stdout.write(`Wrote ${target}\n`);
}
